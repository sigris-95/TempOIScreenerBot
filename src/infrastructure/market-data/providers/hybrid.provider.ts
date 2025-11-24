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

const BINANCE_FUTURES_WS_URL = 'wss://fstream.binance.com/stream';
const BINANCE_EXCHANGE_INFO_URL = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const BYBIT_FUTURES_WS_URL = 'wss://stream.bybit.com/v5/public/linear';
const BYBIT_INSTRUMENTS_URL = 'https://api.bybit.com/v5/market/instruments-info';

const RECONNECT_DELAY = 5000;
const PING_INTERVAL = 20000;
const PARTIAL_DATA_STALE_MS = 10000; // 10 seconds max age for partial data
const LOAD_SYMBOLS_RETRIES = 5;

interface PartialUpdate {
    symbol: string;
    lastUpdateTime: number;
    binanceData?: {
        price: number;
        volumeBuy?: number;
        volumeSell?: number;
        volumeBuyQuote?: number;
        volumeSellQuote?: number;
        timestamp: number;
    };
    bybitData?: {
        openInterest: number;
        openInterestValue: number;
        oiTimestamp: number;
        markPrice?: number;
        fundingRate?: number;
    };
}

@Injectable()
export class HybridMarketDataProvider implements IMarketDataProvider {
    public readonly providerId: string;
    public readonly marketType: MarketType;
    private readonly logger: Logger;

    // WebSocket connections
    private binanceWs: WebSocket | null = null;
    private bybitWs: WebSocket | null = null;

    // Connection states
    private binanceConnected = false;
    private bybitConnected = false;
    private reconnecting = false;

    private callback: PriceUpdateCallback | null = null;
    private binancePingTimer: NodeJS.Timeout | null = null;
    private bybitPingTimer: NodeJS.Timeout | null = null;

    // Metrics
    private messageCount = 0;
    private binanceMessageCount = 0;
    private bybitMessageCount = 0;
    private errorCount = 0;
    private reconnectAttempts = 0;
    private lastUpdateTime = 0;

    // Symbol management
    private binanceSymbols = new Set<string>();
    private bybitSymbols = new Set<string>();
    private commonSymbols = new Set<string>();
    private readyPromise: Promise<void>;

    // Data merging
    private partialDataCache = new Map<string, PartialUpdate>();

    constructor(marketType: MarketType = 'futures') {
        this.marketType = marketType;
        this.providerId = `hybrid-${marketType}`;
        this.logger = new Logger(this.providerId);

        if (marketType !== 'futures') {
            throw new Error('HybridMarketDataProvider only supports futures market type');
        }

        // Load symbols from both exchanges
        this.readyPromise = this.loadSymbolsWithRetry();
    }

    // ==================== SYMBOL DISCOVERY ====================

    private async loadSymbolsWithRetry(): Promise<void> {
        let lastErr: any;
        for (let attempt = 1; attempt <= LOAD_SYMBOLS_RETRIES; attempt++) {
            try {
                await this.loadSymbols();
                return;
            } catch (e) {
                lastErr = e;
                this.logger.warn(`loadSymbols attempt ${attempt} failed`);
                await new Promise((r) => setTimeout(r, 2000 * attempt));
            }
        }
        this.logger.error('Failed to load symbols after retries', lastErr);
        throw lastErr;
    }

    private async loadSymbols(): Promise<void> {
        this.logger.info('Loading active USDT perpetuals from both exchanges...');

        // Load in parallel
        const [binanceSymbols, bybitSymbols] = await Promise.all([
            this.loadBinanceSymbols(),
            this.loadBybitSymbols(),
        ]);

        this.binanceSymbols = binanceSymbols;
        this.bybitSymbols = bybitSymbols;

        // Find intersection
        this.commonSymbols = new Set(
            Array.from(binanceSymbols).filter((symbol) => bybitSymbols.has(symbol))
        );

        // Log statistics
        this.logger.info('Symbol discovery complete:', {
            binanceTotal: binanceSymbols.size,
            bybitTotal: bybitSymbols.size,
            commonSymbols: this.commonSymbols.size,
            binanceUnique: binanceSymbols.size - this.commonSymbols.size,
            bybitUnique: bybitSymbols.size - this.commonSymbols.size,
        });

        if (this.commonSymbols.size === 0) {
            throw new Error('No common symbols found between Binance and Bybit!');
        }

        this.logger.info(
            `✅ Found ${this.commonSymbols.size} common USDT perpetuals across both exchanges`
        );
    }

    private async loadBinanceSymbols(): Promise<Set<string>> {
        this.logger.debug('Fetching Binance USDT perpetuals...');
        const res = await fetch(BINANCE_EXCHANGE_INFO_URL, {
            headers: { 'User-Agent': 'HybridMarketDataProvider/1.0' },
        });

        if (!res.ok) {
            throw new Error(`Binance exchangeInfo fetch failed: ${res.status}`);
        }

        const data: any = await res.json();
        const symbols = new Set<string>();

        for (const symbol of data.symbols || []) {
            if (
                symbol.status === 'TRADING' &&
                symbol.contractType === 'PERPETUAL' &&
                symbol.quoteAsset === 'USDT'
            ) {
                symbols.add(symbol.symbol);
            }
        }

        this.logger.debug(`Binance: ${symbols.size} active USDT perpetuals`);
        return symbols;
    }

    private async loadBybitSymbols(): Promise<Set<string>> {
        this.logger.debug('Fetching Bybit USDT perpetuals...');
        const res = await fetch(`${BYBIT_INSTRUMENTS_URL}?category=linear`, {
            headers: { 'User-Agent': 'HybridMarketDataProvider/1.0' },
        });

        if (!res.ok) {
            throw new Error(`Bybit instruments info fetch failed: ${res.status}`);
        }

        const data: any = await res.json();
        if (data.retCode !== 0) {
            throw new Error(`Bybit API error: ${data.retMsg}`);
        }

        const symbols = new Set<string>();

        for (const instrument of data.result?.list || []) {
            if (
                instrument.quoteCoin === 'USDT' &&
                instrument.status === 'Trading' &&
                instrument.contractType === 'LinearPerpetual'
            ) {
                // Apply same validation as Bybit provider
                if (this.isValidSymbol(instrument.symbol)) {
                    symbols.add(instrument.symbol);
                }
            }
        }

        this.logger.debug(`Bybit: ${symbols.size} active USDT perpetuals`);
        return symbols;
    }

    private isValidSymbol(symbol: string): boolean {
        if (!symbol || symbol.length === 0) return false;
        if (!/^[A-Z]/.test(symbol)) return false; // Must start with letter
        if (!/^[A-Z0-9]+USDT$/.test(symbol)) return false; // Only alphanumeric + USDT
        return true;
    }

    // ==================== CONNECTION MANAGEMENT ====================

    public async connect(): Promise<void> {
        if (this.binanceConnected && this.bybitConnected) return;

        // Wait for symbols to load
        await this.readyPromise;

        this.logger.info(`Connecting to both Binance and Bybit WebSockets...`);

        // Connect to both in parallel
        await Promise.all([
            this.connectBinance(),
            this.connectBybit(),
        ]);

        this.logger.info('✅ Hybrid provider connected to both exchanges');
    }

    private async connectBinance(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.logger.info(`Connecting to Binance futures WebSocket...`);
                this.binanceWs = new WebSocket(BINANCE_FUTURES_WS_URL);

                this.binanceWs.on('open', async () => {
                    this.binanceConnected = true;
                    this.logger.info(`✅ Binance WebSocket connected`);

                    // Subscribe to aggTrade for all common symbols
                    await this.subscribeBinanceAggTrade();

                    // Start ping interval
                    this.startBinancePing();

                    resolve();
                });

                this.binanceWs.on('message', (data: WebSocket.Data) => {
                    try {
                        const message = JSON.parse(data.toString());
                        this.handleBinanceMessage(message);
                    } catch (error) {
                        this.errorCount++;
                        this.logger.error('Binance parse error:', error);
                    }
                });

                this.binanceWs.on('error', (error) => {
                    this.errorCount++;
                    this.logger.error('Binance WebSocket error:', error);
                    if (!this.binanceConnected) reject(error);
                });

                this.binanceWs.on('close', () => {
                    this.binanceConnected = false;
                    this.stopBinancePing();
                    this.logger.warn('Binance WebSocket closed');
                    this.handleBinanceReconnection();
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    private async connectBybit(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.logger.info(`Connecting to Bybit futures WebSocket...`);
                this.bybitWs = new WebSocket(BYBIT_FUTURES_WS_URL);

                this.bybitWs.on('open', async () => {
                    this.bybitConnected = true;
                    this.logger.info(`✅ Bybit WebSocket connected`);

                    // Subscribe to ticker for all common symbols
                    await this.subscribeBybitTicker();

                    // Start ping interval
                    this.startBybitPing();

                    resolve();
                });

                this.bybitWs.on('message', (data: WebSocket.Data) => {
                    try {
                        const message = JSON.parse(data.toString());
                        this.handleBybitMessage(message);
                    } catch (error) {
                        this.errorCount++;
                        this.logger.error('Bybit parse error:', error);
                    }
                });

                this.bybitWs.on('error', (error) => {
                    this.errorCount++;
                    this.logger.error('Bybit WebSocket error:', error);
                    if (!this.bybitConnected) reject(error);
                });

                this.bybitWs.on('close', () => {
                    this.bybitConnected = false;
                    this.stopBybitPing();
                    this.logger.warn('Bybit WebSocket closed');
                    this.handleBybitReconnection();
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    public async disconnect(): Promise<void> {
        this.binanceConnected = false;
        this.bybitConnected = false;
        this.stopBinancePing();
        this.stopBybitPing();
        this.partialDataCache.clear();

        if (this.binanceWs) {
            this.binanceWs.close();
            this.binanceWs = null;
        }

        if (this.bybitWs) {
            this.bybitWs.close();
            this.bybitWs = null;
        }

        this.logger.info('Disconnected from both exchanges');
    }

    public isConnected(): boolean {
        return this.binanceConnected && this.bybitConnected;
    }

    // ==================== SUBSCRIPTIONS ====================

    private async subscribeBinanceAggTrade(): Promise<void> {
        if (!this.binanceWs || !this.binanceConnected) return;

        const symbols = Array.from(this.commonSymbols);
        const streams = symbols.map((symbol) => `${symbol.toLowerCase()}@aggTrade`);

        this.logger.info(`Subscribing to Binance aggTrade for ${symbols.length} symbols...`);

        const subscribeMsg = {
            method: 'SUBSCRIBE',
            params: streams,
            id: 1,
        };

        this.binanceWs.send(JSON.stringify(subscribeMsg));
        this.logger.info(`✅ Binance subscription request sent for ${symbols.length} symbols`);
    }

    private async subscribeBybitTicker(): Promise<void> {
        if (!this.bybitWs || !this.bybitConnected) return;

        const symbols = Array.from(this.commonSymbols);
        const BATCH_SIZE = 50;

        this.logger.info(`Subscribing to Bybit ticker for ${symbols.length} symbols in batches...`);

        for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
            const batch = symbols.slice(i, i + BATCH_SIZE);
            const topics = batch.map((symbol) => `tickers.${symbol}`);

            const subscribeMsg = {
                op: 'subscribe',
                args: topics,
            };

            this.bybitWs.send(JSON.stringify(subscribeMsg));

            if (i + BATCH_SIZE < symbols.length) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }

        this.logger.info(`✅ Bybit subscription request sent for ${symbols.length} symbols`);
    }

    public async subscribe(symbols: string[]): Promise<void> {
        // Not implemented - hybrid provider subscribes to all common symbols automatically
        this.logger.warn('subscribe() not supported for hybrid provider');
    }

    public async unsubscribe(symbols: string[]): Promise<void> {
        // Not implemented
        this.logger.warn('unsubscribe() not supported for hybrid provider');
    }

    public async getAvailableSymbols(): Promise<string[]> {
        return Array.from(this.commonSymbols);
    }

    // ==================== MESSAGE HANDLING ====================

    private handleBinanceMessage(message: any): void {
        // Handle subscription responses
        if (message.result === null && message.id) {
            return; // Subscription confirmation
        }

        // Handle aggTrade data
        if (message.e === 'aggTrade' && message.data) {
            this.handleBinanceAggTrade(message.data);
        } else if (message.data?.e === 'aggTrade') {
            this.handleBinanceAggTrade(message.data);
        }
    }

    private handleBinanceAggTrade(data: any): void {
        const symbol = data.s; // BTCUSDT
        if (!this.commonSymbols.has(symbol)) return;

        this.binanceMessageCount++;

        const price = parseFloat(data.p);
        const qty = parseFloat(data.q);
        const isBuyerMaker = data.m;
        const timestamp = data.T;

        // Aggregate volume
        let partial = this.partialDataCache.get(symbol);
        if (!partial) {
            partial = {
                symbol,
                lastUpdateTime: Date.now(),
            };
            this.partialDataCache.set(symbol, partial);
        }

        if (!partial.binanceData) {
            partial.binanceData = {
                price,
                volumeBuy: 0,
                volumeSell: 0,
                volumeBuyQuote: 0,
                volumeSellQuote: 0,
                timestamp,
            };
        }

        // Update price
        partial.binanceData.price = price;
        partial.binanceData.timestamp = timestamp;

        // Aggregate volume
        const quoteQty = price * qty;
        if (isBuyerMaker) {
            // Seller is taker (aggressive sell)
            partial.binanceData.volumeSell! += qty;
            partial.binanceData.volumeSellQuote! += quoteQty;
        } else {
            // Buyer is taker (aggressive buy)
            partial.binanceData.volumeBuy! += qty;
            partial.binanceData.volumeBuyQuote! += quoteQty;
        }

        partial.lastUpdateTime = Date.now();

        // Try to emit merged update
        this.tryEmitMergedUpdate(symbol);
    }

    private handleBybitMessage(message: any): void {
        // Handle pong
        if (message.op === 'pong') return;

        // Handle subscription responses
        if (message.op === 'subscribe') {
            if (!message.success) {
                const topicMatch = message.ret_msg?.match(/topic:tickers\.([A-Z0-9]+)/);
                const symbol = topicMatch ? topicMatch[1] : 'unknown';
                this.logger.warn(`Bybit: Symbol ${symbol} rejected (not available in stream)`);
            }
            return;
        }

        // Handle ticker data
        if (message.topic?.startsWith('tickers.') && message.data) {
            this.handleBybitTicker(message.data);
        }
    }

    private handleBybitTicker(data: any): void {
        const symbol = data.symbol;
        if (!this.commonSymbols.has(symbol)) return;

        this.bybitMessageCount++;

        const oi = parseFloat(data.openInterest);
        const oiValue = data.openInterestValue ? parseFloat(data.openInterestValue) : 0;
        const markPrice = data.markPrice ? parseFloat(data.markPrice) : undefined;
        const fundingRate = data.fundingRate ? parseFloat(data.fundingRate) : undefined;

        if (isNaN(oi) || oi <= 0) return;

        // Get or create partial data
        let partial = this.partialDataCache.get(symbol);
        if (!partial) {
            partial = {
                symbol,
                lastUpdateTime: Date.now(),
            };
            this.partialDataCache.set(symbol, partial);
        }

        partial.bybitData = {
            openInterest: oi,
            openInterestValue: oiValue,
            oiTimestamp: Date.now(),
            markPrice,
            fundingRate,
        };

        partial.lastUpdateTime = Date.now();

        // Try to emit merged update
        this.tryEmitMergedUpdate(symbol);
    }

    // ==================== DATA MERGING ====================

    private tryEmitMergedUpdate(symbol: string): void {
        if (!this.callback) return;

        const partial = this.partialDataCache.get(symbol);
        if (!partial) return;

        const now = Date.now();
        const age = now - partial.lastUpdateTime;

        // Check if data is too stale
        if (age > PARTIAL_DATA_STALE_MS) {
            this.partialDataCache.delete(symbol);
            return;
        }

        // Need at least one data source
        if (!partial.binanceData && !partial.bybitData) return;

        // Emit update with available data
        this.messageCount++;
        this.lastUpdateTime = now;

        const update: MarketUpdate = {
            providerId: this.providerId,
            marketType: this.marketType,
            symbol,
            timestamp: now,
        };

        // Add Binance data
        if (partial.binanceData) {
            update.price = partial.binanceData.price;
            update.volumeBuy = partial.binanceData.volumeBuy;
            update.volumeSell = partial.binanceData.volumeSell;
            update.volumeBuyQuote = partial.binanceData.volumeBuyQuote;
            update.volumeSellQuote = partial.binanceData.volumeSellQuote;
        }

        // Add Bybit data
        if (partial.bybitData) {
            update.openInterest = partial.bybitData.openInterest;
            update.openInterestTimestamp = partial.bybitData.oiTimestamp;
            update.markPrice = partial.bybitData.markPrice;
            update.fundingRate = partial.bybitData.fundingRate;
        }

        // Log first few merged updates
        if (this.messageCount <= 5) {
            this.logger.info(`🎯 Merged update for ${symbol}:`, {
                hasPrice: !!update.price,
                hasOI: !!update.openInterest,
                hasVolume: !!update.volumeBuy,
            });
        }

        this.callback(update);
    }

    // ==================== PING/PONG ====================

    private startBinancePing(): void {
        this.binancePingTimer = setInterval(() => {
            if (this.binanceConnected && this.binanceWs) {
                // Binance uses WS-level ping frames
                this.binanceWs.ping();
            }
        }, PING_INTERVAL);
    }

    private stopBinancePing(): void {
        if (this.binancePingTimer) {
            clearInterval(this.binancePingTimer);
            this.binancePingTimer = null;
        }
    }

    private startBybitPing(): void {
        this.bybitPingTimer = setInterval(() => {
            if (this.bybitConnected && this.bybitWs) {
                this.bybitWs.send(JSON.stringify({ op: 'ping' }));
            }
        }, PING_INTERVAL);
    }

    private stopBybitPing(): void {
        if (this.bybitPingTimer) {
            clearInterval(this.bybitPingTimer);
            this.bybitPingTimer = null;
        }
    }

    // ==================== RECONNECTION ====================

    private async handleBinanceReconnection(): Promise<void> {
        if (this.reconnecting) return;

        this.reconnecting = true;
        this.reconnectAttempts++;
        this.logger.info(`Reconnecting to Binance... (attempt ${this.reconnectAttempts})`);

        await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY));

        try {
            await this.connectBinance();
            this.reconnecting = false;
        } catch (error) {
            this.logger.error('Binance reconnection failed:', error);
            this.reconnecting = false;
            this.handleBinanceReconnection();
        }
    }

    private async handleBybitReconnection(): Promise<void> {
        if (this.reconnecting) return;

        this.reconnecting = true;
        this.reconnectAttempts++;
        this.logger.info(`Reconnecting to Bybit... (attempt ${this.reconnectAttempts})`);

        await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY));

        try {
            await this.connectBybit();
            this.reconnecting = false;
        } catch (error) {
            this.logger.error('Bybit reconnection failed:', error);
            this.reconnecting = false;
            this.handleBybitReconnection();
        }
    }

    // ==================== HEALTH & CALLBACKS ====================

    public onPriceUpdate(callback: PriceUpdateCallback): void {
        this.callback = callback;
    }

    public getHealthStatus(): ProviderHealthStatus {
        return {
            providerId: this.providerId,
            marketType: this.marketType,
            isConnected: this.binanceConnected && this.bybitConnected,
            lastUpdateTime: this.lastUpdateTime,
            messageCount: this.messageCount,
            reconnectAttempts: this.reconnectAttempts,
            errorCount: this.errorCount,
        };
    }
}
