import WebSocket from 'ws';
import { Injectable } from '../../../shared/decorators';
import { Logger } from '../../../shared/logger';
import {
  IMarketDataProvider,
  MarketType,
  PriceUpdateCallback,
  MarketUpdate,
  ProviderHealthStatus,
} from '../../../domain/interfaces/market-data-provider.interface';

const BYBIT_SPOT_STREAM_URL = 'wss://stream.bybit.com/v5/public/spot';
const BYBIT_FUTURES_STREAM_URL = 'wss://stream.bybit.com/v5/public/linear';
const BYBIT_INSTRUMENTS_URL = 'https://api.bybit.com/v5/market/instruments-info';
const RECONNECT_DELAY = 5000;
const PING_INTERVAL = 20000;
const OI_STALE_THRESHOLD_MS = 90_000; // 90 seconds - similar to Binance
const LOAD_SYMBOLS_RETRIES = 5;

@Injectable()
export class BybitMarketDataProvider implements IMarketDataProvider {
  public readonly providerId: string;
  public readonly marketType: MarketType;
  private readonly logger: Logger;
  private readonly streamUrl: string;

  private ws: WebSocket | null = null;
  private connected = false;
  private reconnecting = false;
  private callback: PriceUpdateCallback | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  private messageCount = 0;
  private errorCount = 0;
  private reconnectAttempts = 0;
  private lastUpdateTime = 0;
  private subscribedSymbols: string[] = [];

  // OI integration
  private usdtLinearContracts = new Set<string>();
  private oiCache = new Map<string, { oi: number; oiValue: number; ts: number }>();
  private readyPromise: Promise<void>;

  constructor(marketType: MarketType = 'spot') {
    this.marketType = marketType;
    this.providerId = `bybit-${marketType}`;
    this.logger = new Logger(this.providerId);
    this.streamUrl = marketType === 'futures' ? BYBIT_FUTURES_STREAM_URL : BYBIT_SPOT_STREAM_URL;

    // Load USDT linear contracts if futures
    if (marketType === 'futures') {
      this.readyPromise = this.loadUsdtLinearContractsWithRetry();
    } else {
      this.readyPromise = Promise.resolve();
    }
  }

  // Retry wrapper for loading symbols
  private async loadUsdtLinearContractsWithRetry(): Promise<void> {
    let lastErr: any;
    for (let attempt = 1; attempt <= LOAD_SYMBOLS_RETRIES; attempt++) {
      try {
        await this.loadUsdtLinearContracts();
        return;
      } catch (e) {
        lastErr = e;
        this.logger.warn(`loadUsdtLinearContracts attempt ${attempt} failed`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    this.logger.error('Failed to load linear contracts after retries', lastErr);
    throw lastErr;
  }

  // Load all USDT linear perpetual contracts from Bybit REST API
  private async loadUsdtLinearContracts(): Promise<void> {
    this.logger.info('Loading USDT linear contracts from Bybit...');
    const res = await fetch(`${BYBIT_INSTRUMENTS_URL}?category=linear`, {
      headers: { 'User-Agent': 'BybitMarketDataProvider/1.0' },
    });

    if (!res.ok) {
      throw new Error(`Instruments info fetch failed: ${res.status}`);
    }

    const data: any = await res.json();
    if (data.retCode !== 0) {
      throw new Error(`Bybit API error: ${data.retMsg}`);
    }

    this.usdtLinearContracts.clear();
    let invalidCount = 0;

    for (const instrument of data.result?.list || []) {
      if (
        instrument.quoteCoin === 'USDT' &&
        instrument.status === 'Trading' &&
        instrument.contractType === 'LinearPerpetual'
      ) {
        const symbol = instrument.symbol;

        // Filter out invalid symbols (e.g., starting with digits like "0GUSDT")
        if (this.isValidSymbol(symbol)) {
          this.usdtLinearContracts.add(symbol);
        } else {
          invalidCount++;
          this.logger.debug(`Skipping invalid symbol: ${symbol}`);
        }
      }
    }

    this.logger.info(
      `Loaded ${this.usdtLinearContracts.size} USDT linear perpetual contracts` +
      (invalidCount > 0 ? ` (skipped ${invalidCount} invalid symbols)` : '')
    );
  }

  // Validate symbol format - must start with a letter and contain only alphanumeric characters
  private isValidSymbol(symbol: string): boolean {
    if (!symbol || symbol.length === 0) return false;

    // Symbol must start with a letter (not a digit)
    if (!/^[A-Z]/.test(symbol)) return false;

    // Symbol should only contain letters and digits (and end with USDT)
    if (!/^[A-Z0-9]+USDT$/.test(symbol)) return false;

    return true;
  }

  // Get cached OI with staleness check
  private getOi(symbol: string): { oi?: number; oiValue?: number; ts?: number } {
    const entry = this.oiCache.get(symbol);
    if (!entry || Date.now() - entry.ts > OI_STALE_THRESHOLD_MS) {
      if (entry) this.oiCache.delete(symbol);
      return {};
    }
    return entry;
  }

  public async connect(): Promise<void> {
    if (this.connected) return;

    // Wait for symbols to load if futures
    await this.readyPromise;

    return new Promise((resolve, reject) => {
      try {
        this.logger.info(`Connecting to ${this.streamUrl}...`);
        this.ws = new WebSocket(this.streamUrl);

        this.ws.on('open', async () => {
          this.connected = true;
          this.reconnecting = false;
          this.reconnectAttempts = 0;
          this.startPingInterval();
          this.logger.info(`Connected to Bybit ${this.marketType}`);

          // Auto-subscribe to all USDT linear contracts if futures
          if (this.marketType === 'futures' && this.usdtLinearContracts.size > 0) {
            const symbols = Array.from(this.usdtLinearContracts);
            this.logger.info(`Auto-subscribing to ${symbols.length} USDT linear contracts...`);
            await this.subscribe(symbols);
          } else if (this.subscribedSymbols.length > 0) {
            this.subscribe(this.subscribedSymbols);
          }

          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const message = JSON.parse(data.toString());

            // Log first few messages to see what Bybit sends
            if (this.messageCount < 10 || this.messageCount % 100 === 0) {
              this.logger.debug(`Raw WS message #${this.messageCount}:`, {
                op: message.op,
                topic: message.topic,
                hasData: !!message.data,
                success: message.success,
                type: message.type,
              });
            }

            this.handleMessage(message);
          } catch (error) {
            this.errorCount++;
            this.logger.error('Parse error:', error);
          }
        });

        this.ws.on('error', (error) => {
          this.errorCount++;
          this.logger.error('WebSocket error:', error);
          if (!this.connected) reject(error);
        });

        this.ws.on('close', () => {
          this.connected = false;
          this.stopPingInterval();
          this.logger.warn('Connection closed');
          this.handleReconnection();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  public async disconnect(): Promise<void> {
    this.connected = false;
    this.stopPingInterval();
    this.oiCache.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.logger.info('Disconnected');
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public async subscribe(symbols: string[]): Promise<void> {
    if (!this.connected || !this.ws) {
      this.subscribedSymbols = symbols;
      return;
    }

    // Bybit has limits on subscription batch size and some symbols might not be available
    // Subscribe in smaller batches to handle errors better
    const BATCH_SIZE = 50; // Smaller batches for better error handling

    this.logger.info(`Subscribing to ${symbols.length} symbols in batches of ${BATCH_SIZE}...`);

    for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
      const batch = symbols.slice(i, i + BATCH_SIZE);
      const topics = batch.map((symbol) => `tickers.${symbol}`);

      const subscribeMsg = {
        op: 'subscribe',
        args: topics,
      };

      this.ws.send(JSON.stringify(subscribeMsg));

      // Small delay between batches to avoid overwhelming the server
      if (i + BATCH_SIZE < symbols.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    this.subscribedSymbols = symbols;
    this.logger.info(`Subscription requests sent for ${symbols.length} symbols`);
  }

  public async unsubscribe(symbols: string[]): Promise<void> {
    if (!this.connected || !this.ws) return;

    const topics = symbols.map((symbol) => `tickers.${symbol}`);

    const unsubscribeMsg = {
      op: 'unsubscribe',
      args: topics,
    };

    this.ws.send(JSON.stringify(unsubscribeMsg));
    this.subscribedSymbols = this.subscribedSymbols.filter((s) => !symbols.includes(s));
  }

  public async getAvailableSymbols(): Promise<string[]> {
    return this.marketType === 'futures' ? Array.from(this.usdtLinearContracts) : [];
  }

  public onPriceUpdate(callback: PriceUpdateCallback): void {
    this.callback = callback;
  }

  public getHealthStatus(): ProviderHealthStatus {
    return {
      providerId: this.providerId,
      marketType: this.marketType,
      isConnected: this.connected,
      lastUpdateTime: this.lastUpdateTime,
      messageCount: this.messageCount,
      reconnectAttempts: this.reconnectAttempts,
      errorCount: this.errorCount,
    };
  }

  private handleMessage(message: any): void {
    // Handle pong responses
    if (message.op === 'pong') return;

    // Handle subscription confirmations
    if (message.op === 'subscribe' && message.success) {
      // Success - no need to log every confirmation to reduce noise
      return;
    }

    // Handle subscription errors (some symbols may not be available in ticker stream)
    if (message.op === 'subscribe' && !message.success) {
      // Extract symbol from error message if possible
      const topicMatch = message.ret_msg?.match(/topic:tickers\.([A-Z0-9]+)/);
      const rejectedSymbol = topicMatch ? topicMatch[1] : 'unknown';

      // Just warn - some symbols in REST API aren't available in WS
      this.logger.warn(`Symbol ${rejectedSymbol} not available in ticker stream (skipping)`);
      return;
    }

    // Handle ticker data (Bybit uses 'tickers.' prefix, plural)
    if (message.topic?.startsWith('tickers.') && message.data) {
      // Detailed logging of raw ticker data for debugging (reduced frequency)
      if (this.messageCount % 500 === 0) {
        this.logger.debug(`Ticker data sample (msg #${this.messageCount}):`, {
          symbol: message.data.symbol,
          lastPrice: message.data.lastPrice,
          openInterest: message.data.openInterest,
          openInterestValue: message.data.openInterestValue,
          volume24h: message.data.volume24h,
          timestamp: message.data.time,
        });
      }
      this.handleTickerData(message.data);
    }
  }

  private handleTickerData(data: any): void {
    if (!this.callback) return;

    // Log first ticker data to verify we're receiving them
    if (this.messageCount === 0) {
      this.logger.info('🎯 First ticker data received!', data);
    }

    try {
      const symbol = data.symbol;
      if (!symbol?.endsWith('USDT')) return;

      // Filter to only process USDT linear contracts for futures
      if (this.marketType === 'futures' && !this.usdtLinearContracts.has(symbol)) {
        return;
      }

      const price = parseFloat(data.lastPrice);
      const timestamp = parseInt(data.time) || Date.now();

      if (symbol && price > 0) {
        this.messageCount++;
        this.lastUpdateTime = Date.now();

        const updateData: MarketUpdate = {
          providerId: this.providerId,
          marketType: this.marketType,
          symbol,
          price,
          timestamp,
          volume: data.volume24h ? parseFloat(data.volume24h) : undefined,
          quoteVolume: data.turnover24h ? parseFloat(data.turnover24h) : undefined,
        };

        // Futures-specific fields
        if (this.marketType === 'futures') {
          updateData.markPrice = data.markPrice ? parseFloat(data.markPrice) : undefined;
          updateData.fundingRate = data.fundingRate ? parseFloat(data.fundingRate) : undefined;

          // Extract and cache Open Interest
          if (data.openInterest) {
            const oi = parseFloat(data.openInterest);
            const oiValue = data.openInterestValue ? parseFloat(data.openInterestValue) : 0;

            if (!isNaN(oi) && oi > 0) {
              this.oiCache.set(symbol, {
                oi,
                oiValue,
                ts: Date.now(),
              });

              // Log OI data for first few symbols to verify
              if (this.oiCache.size <= 5) {
                this.logger.info(`OI cached for ${symbol}: OI=${oi.toFixed(2)}, OI Value=${oiValue.toFixed(2)} USDT`);
              }
            }
          }

          // Mix cached OI into the update
          const oiData = this.getOi(symbol);
          if (oiData.oi !== undefined) {
            updateData.openInterest = oiData.oi;
            updateData.openInterestTimestamp = oiData.ts;

            // Log OI injection for debugging (every 200 messages)
            if (this.messageCount % 200 === 0) {
              this.logger.debug(`OI injected into update for ${symbol}: ${oiData.oi.toFixed(2)}`);
            }
          } else if (this.messageCount % 500 === 0) {
            // Warn if OI is missing (but not too often)
            this.logger.debug(`No OI data available for ${symbol} (cache size: ${this.oiCache.size})`);
          }
        }

        this.callback(updateData);
      }
    } catch (error) {
      this.errorCount++;
      this.logger.debug('Ticker processing error:', error);
    }
  }

  private startPingInterval(): void {
    this.pingTimer = setInterval(() => {
      if (this.connected && this.ws) {
        this.ws.send(JSON.stringify({ op: 'ping' }));
      }
    }, PING_INTERVAL);
  }

  private stopPingInterval(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private async handleReconnection(): Promise<void> {
    if (this.reconnecting || !this.connected) return;

    this.reconnecting = true;
    this.reconnectAttempts++;
    this.logger.info(`Reconnecting... (attempt ${this.reconnectAttempts})`);

    await this.disconnect();
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY));

    try {
      await this.connect();
    } catch (error) {
      this.logger.error('Reconnection failed:', error);
      this.reconnecting = false;
      this.handleReconnection();
    }
  }
}
