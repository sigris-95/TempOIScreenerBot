import WebSocket from 'ws';
import { Inject, Injectable } from '../../shared/decorators';
import {
  IMarketDataGateway,
  IDataAggregatorService,
} from '../../domain/interfaces/services.interface';
import { Logger } from '../../shared/logger';

const SPOT_STREAM_URL = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';
const FUTURES_STREAM_URL = 'wss://fstream.binance.com/ws/!markPrice@arr@1s';
const RECONNECT_DELAY = 5000;

@Injectable()
export class BinanceWebSocketService implements IMarketDataGateway {
  private readonly logger = new Logger(BinanceWebSocketService.name);
  private spotWs: WebSocket | null = null;
  private futuresWs: WebSocket | null = null;
  private isConnected = false;
  private isReconnecting = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  constructor(
    @Inject('IDataAggregatorService')
    private readonly dataAggregator: IDataAggregatorService,
  ) {}

  public async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    try {
      await this.connectToSpotStream();
      await this.connectToFuturesStream();
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.logger.info('WebSocket connections established successfully');
    } catch (error) {
      this.logger.error('Failed to establish WebSocket connections:', error);
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    this.isConnected = false;

    if (this.spotWs) {
      this.spotWs.close();
      this.spotWs = null;
    }

    if (this.futuresWs) {
      this.futuresWs.close();
      this.futuresWs = null;
    }

    this.logger.info('WebSocket connections closed');
  }

  private async connectToSpotStream(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.spotWs = new WebSocket(SPOT_STREAM_URL);

      this.spotWs.on('open', () => {
        this.logger.info('Spot WebSocket connection opened');
        resolve();
      });

      this.spotWs.on('message', (data: WebSocket.Data) => {
        try {
          const messages = JSON.parse(data.toString());
          this.handleSpotMessages(messages);
        } catch (error) {
          this.logger.error('Error parsing spot WebSocket message:', error);
        }
      });

      this.spotWs.on('error', (error) => {
        this.logger.error('Spot WebSocket error:', error);
        reject(error);
      });

      this.spotWs.on('close', (code, reason) => {
        this.logger.warn(`Spot WebSocket closed: ${code} - ${reason}`);
        this.handleReconnection();
      });
    });
  }

  private async connectToFuturesStream(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.futuresWs = new WebSocket(FUTURES_STREAM_URL);

      this.futuresWs.on('open', () => {
        this.logger.info('Futures WebSocket connection opened');
        resolve();
      });

      this.futuresWs.on('message', (data: WebSocket.Data) => {
        try {
          const messages = JSON.parse(data.toString());
          this.handleFuturesMessages(messages);
        } catch (error) {
          this.logger.error('Error parsing futures WebSocket message:', error);
        }
      });

      this.futuresWs.on('error', (error) => {
        this.logger.error('Futures WebSocket error:', error);
        reject(error);
      });

      this.futuresWs.on('close', (code, reason) => {
        this.logger.warn(`Futures WebSocket closed: ${code} - ${reason}`);
        this.handleReconnection();
      });
    });
  }

  private handleSpotMessages(messages: any[]): void {
    for (const message of messages) {
      try {
        const symbol = message.s;
        
        // Filter ONLY USDT pairs
        if (!symbol.endsWith('USDT')) {
          continue;
        }

        const price = parseFloat(message.c);
        const timestamp = message.E;

        if (symbol && price > 0) {
          this.dataAggregator.updatePrice(symbol, price, timestamp);
        }
      } catch (error) {
        this.logger.debug('Error processing spot message:', error);
      }
    }
  }

  private handleFuturesMessages(messages: any[]): void {
    for (const message of messages) {
      try {
        const symbol = message.s;

        // Filter ONLY USDT pairs
        if (!symbol.endsWith('USDT')) {
          continue;
        }

        // CRITICAL FIX: Extract BOTH price and OI from futures stream
        const markPrice = parseFloat(message.p);
        const openInterest = parseFloat(message.i || message.openInterest);
        const timestamp = message.E || Date.now();

        if (symbol && openInterest >= 0) {
          this.dataAggregator.updateOpenInterest(symbol, openInterest, timestamp);
          
          // CRITICAL FIX: Also update price from futures stream
          // This fixes the $0 bug for futures-only pairs that don't exist in spot
          if (markPrice > 0) {
            this.dataAggregator.updatePrice(symbol, markPrice, timestamp);
          }
        }
      } catch (error) {
        this.logger.debug('Error processing futures message:', error);
      }
    }
  }

  private async handleReconnection(): Promise<void> {
    if (this.isReconnecting || !this.isConnected || this.reconnectAttempts >= this.maxReconnectAttempts) {
      return;
    }
    
    this.isReconnecting = true;
    this.reconnectAttempts++;
    
    this.logger.info(`Reconnecting... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    // Close existing connections
    await this.disconnect();
    
    // Wait before reconnecting
    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));
    
    try {
      await this.connect();
      this.isReconnecting = false;
    } catch (error) {
      this.logger.error('Reconnection failed:', error);
      this.isReconnecting = false;
      // Schedule next attempt
      this.handleReconnection();
    }
  }
}