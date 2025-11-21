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

const BINANCE_SPOT_STREAM_URL = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';
const BINANCE_FUTURES_STREAM_URL = 'wss://fstream.binance.com/ws/!ticker@arr';
const BINANCE_EXCHANGE_INFO_URL = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const BINANCE_OI_URL = 'https://fapi.binance.com/fapi/v1/openInterest';

const RECONNECT_DELAY = 5000; // base delay
const OI_POLL_INTERVAL_MS_MIN = 13_000;
const OI_BATCH_SIZE = 25; // as before
const DELTA_FLUSH_INTERVAL_MS = 120;
const AGGTRADE_BATCH_SIZE = 30;
const OI_REQUEST_TIMEOUT = 7000;
const LOAD_SYMBOLS_RETRIES = 5;
const DELTA_MIN_QUOTE_THRESHOLD = 250; // configurable noise filter

interface BinanceOpenInterestResponse {
  symbol: string;
  openInterest: string;
  time: number;
}

@Injectable()
export class BinanceMarketDataProvider implements IMarketDataProvider {
  public readonly providerId: string;
  public readonly marketType: MarketType;
  private readonly logger: Logger;

  private ws: WebSocket | null = null;
  private connected = false;
  private reconnecting = false;
  private intentionalDisconnect = false;
  private callback: PriceUpdateCallback | null = null;

  private usdtPerpetuals = new Set<string>();
  private oiCache = new Map<string, { oi: number; ts: number }>();
  private oiPollingTimer: NodeJS.Timeout | null = null;

  private aggTradeWsList: WebSocket[] = [];
  private aggTradeReconnectTimers = new Set<NodeJS.Timeout>();
  private aggTradeCache = new Map<
    string,
    {
      takerBuyBase: number;
      takerBuyQuote: number;
      takerSellBase: number;
      takerSellQuote: number;
      lastReset: number;
    }
  >();
  private deltaFlushTimer: NodeJS.Timeout | null = null;

  private messageCount = 0;
  private errorCount = 0;
  private reconnectAttempts = 0;
  private lastUpdateTime = 0;

  // keep track whether we've subscribed agg trades to avoid duplicates
  private aggSubscribed = false;

  // wait for symbols load when futures
  private readyPromise: Promise<void>;

  constructor(marketType: MarketType = 'spot') {
    this.marketType = marketType;
    this.providerId = `binance-${marketType}`;
    this.logger = new Logger(this.providerId);

    if (marketType === 'futures') {
      this.readyPromise = this.loadUsdtPerpetualsWithRetry();
    } else {
      this.readyPromise = Promise.resolve();
    }
  }

  // retry wrapper for loading symbols
  private async loadUsdtPerpetualsWithRetry(): Promise<void> {
    let lastErr: any;
    for (let attempt = 1; attempt <= LOAD_SYMBOLS_RETRIES; attempt++) {
      try {
        await this.loadUsdtPerpetuals();
        return;
      } catch (e) {
        lastErr = e;
        this.logger.warn(`loadUsdtPerpetuals attempt ${attempt} failed`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    this.logger.error('Failed to load perpetual symbols after retries', lastErr);
    throw lastErr;
  }

  private async loadUsdtPerpetuals(): Promise<void> {
    const res = await fetch(BINANCE_EXCHANGE_INFO_URL, {
      headers: { 'User-Agent': 'BinanceMarketDataProvider/1.0' },
      signal: (AbortSignal as any).timeout ? AbortSignal.timeout(10_000) : undefined,
    });
    if (!res.ok) throw new Error(`Exchange info fetch failed: ${res.status}`);
    const data: any = await res.json();
    this.usdtPerpetuals.clear();
    for (const s of data.symbols || []) {
      if (s.contractType === 'PERPETUAL' && s.marginAsset === 'USDT' && s.status === 'TRADING') {
        this.usdtPerpetuals.add(s.symbol);
      }
    }
    this.logger.info(`Loaded ${this.usdtPerpetuals.size} USDT perpetual symbols`);
  }

  // OI polling with dynamic safe interval & small delay per batch to respect rate limits
  private startOiPolling(): void {
    if (this.marketType !== 'futures') return;

    const poll = async () => {
      const symbols = Array.from(this.usdtPerpetuals);
      if (symbols.length === 0) return;

      // dynamic interval calculation — keep base but adapt to symbol count
      const estimatedMsPerRequest = 80; // small spacing to avoid hitting bursts
      const safeInterval = Math.max(
        OI_POLL_INTERVAL_MS_MIN,
        Math.ceil((symbols.length / OI_BATCH_SIZE) * estimatedMsPerRequest * (symbols.length / OI_BATCH_SIZE))
      );

      for (let i = 0; i < symbols.length; i += OI_BATCH_SIZE) {
        const batch = symbols.slice(i, i + OI_BATCH_SIZE);
        await Promise.allSettled(
          batch.map(async (sym) => {
            try {
              const url = `${BINANCE_OI_URL}?symbol=${sym}`;
              const res = await fetch(url, {
                headers: { 'User-Agent': 'BinanceMarketDataProvider/1.0' },
                signal: (AbortSignal as any).timeout ? AbortSignal.timeout(OI_REQUEST_TIMEOUT) : undefined,
              });
              if (!res.ok) {
                // if rate limited, skip and continue
                this.logger.debug(`OI request for ${sym} returned ${res.status}`);
                return;
              }
              const data = (await res.json()) as BinanceOpenInterestResponse;
              const oi = parseFloat(data.openInterest);
              if (!isNaN(oi) && oi >= 0) {
                this.oiCache.set(sym, { oi, ts: Date.now() });
              }
            } catch (err) {
              // swallow per-symbol errors
            }
          })
        );
        // small spacing between batches to reduce burst risk
        if (i + OI_BATCH_SIZE < symbols.length) await new Promise((r) => setTimeout(r, 60));
      }

      // reschedule next poll using dynamic interval
      if (this.oiPollingTimer) clearTimeout(this.oiPollingTimer);
      if (!this.intentionalDisconnect && this.connected) {
        this.oiPollingTimer = setTimeout(() => poll().catch((e) => this.logger.debug('OI poll failed', e)), safeInterval);
      }
    };

    // kick first run immediately
    poll().catch((e) => this.logger.debug('Initial OI poll failed', e));
  }

  private stopOiPolling(): void {
    if (this.oiPollingTimer) clearTimeout(this.oiPollingTimer);
    this.oiPollingTimer = null;
    this.oiCache.clear();
  }

  private getOi(symbol: string): { oi?: number; ts?: number } {
    const entry = this.oiCache.get(symbol);
    if (!entry || Date.now() - entry.ts > 90_000) {
      if (entry) this.oiCache.delete(symbol);
      return {};
    }
    return { oi: entry.oi, ts: entry.ts };
  }

  // create per-batch WS with self-reconnect logic — preserves backward compatibility
  private createAggTradeWS(batch: string[]): WebSocket {
    const url = `wss://fstream.binance.com/stream?streams=${batch.join('/')}`;
    const ws = new WebSocket(url);
    let closedByUs = false;

    ws.on('open', () => this.logger.debug(`AggTrade batch connected (${batch.length} symbols)`));
    ws.on('message', (data) => this.handleAggTradeMessage(data.toString()));
    ws.on('error', (err) => this.logger.error('AggTrade WS error', err));

    ws.on('close', () => {
      if (closedByUs) return;
      this.logger.warn('AggTrade batch WS closed — reconnecting this batch in 3s');
      const timer = setTimeout(() => {
        this.aggTradeReconnectTimers.delete(timer);
        if (this.intentionalDisconnect) return; // предотвращаем reconnect после disconnect
        try {
          const newWs = this.createAggTradeWS(batch);
          const idx = this.aggTradeWsList.indexOf(ws);
          if (idx !== -1) this.aggTradeWsList[idx] = newWs;
          else this.aggTradeWsList.push(newWs);
        } catch (e) {
          this.logger.error('Failed to recreate aggTrade ws', e);
        }
      }, 3000);
      this.aggTradeReconnectTimers.add(timer);
    });

    // attach marker for graceful termination
    Object.defineProperty(ws, '_closeGracefully', {
      value: () => {
        closedByUs = true;
        try { ws.terminate(); } catch (e) {}
      },
      writable: false,
    });

    return ws;
  }

  private subscribeToAggTrades(): void {
    if (this.marketType !== 'futures') return;

    // terminate existing batch sockets gracefully
    this.aggTradeWsList.forEach((s: any) => {
      try {
        if (typeof s._closeGracefully === 'function') s._closeGracefully();
        else s.terminate();
      } catch (e) {}
    });
    this.aggTradeWsList = [];

    const streams = Array.from(this.usdtPerpetuals).map((s) => `${s.toLowerCase()}@aggTrade`);
    for (let i = 0; i < streams.length; i += AGGTRADE_BATCH_SIZE) {
      const batch = streams.slice(i, i + AGGTRADE_BATCH_SIZE);
      const ws = this.createAggTradeWS(batch);
      this.aggTradeWsList.push(ws);
    }

    this.aggSubscribed = true;
    this.logger.info(`Subscribed to aggTrade for ${streams.length} symbols in ${this.aggTradeWsList.length} batches`);
  }

  private handleAggTradeMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);
      const d = msg.data;
      if (!d?.s || !this.usdtPerpetuals.has(d.s)) return;

      const symbol = d.s;
      const qty = parseFloat(d.q);
      const price = parseFloat(d.p);
      const quoteQty = qty * price;
      const isBuyerMaker = d.m; // true = taker sell

      let cache = this.aggTradeCache.get(symbol);
      if (!cache) {
        cache = {
          takerBuyBase: 0,
          takerBuyQuote: 0,
          takerSellBase: 0,
          takerSellQuote: 0,
          lastReset: Date.now(),
        };
        this.aggTradeCache.set(symbol, cache);
      }

      // accumulate
      if (isBuyerMaker) {
        cache.takerSellBase += qty;
        cache.takerSellQuote += quoteQty;
      } else {
        cache.takerBuyBase += qty;
        cache.takerBuyQuote += quoteQty;
      }

      cache.lastReset = Date.now();
    } catch (e) {
      // ignore malformed messages
    }
  }

  private flushDeltaVolume(): void {
    if (!this.callback || this.aggTradeCache.size === 0) return;

    const now = Date.now();

    for (const [symbol, cache] of this.aggTradeCache.entries()) {
      // Если таргетный символ не получал трейдов долго — удаляем только если нет накопленного объема
      if (now - cache.lastReset > 3000 && cache.takerBuyBase + cache.takerSellBase === 0) {
        this.aggTradeCache.delete(symbol);
        continue;
      }

      const totalBase = cache.takerBuyBase + cache.takerSellBase;
      const totalQuote = cache.takerBuyQuote + cache.takerSellQuote;

      if (totalBase === 0 || totalQuote < DELTA_MIN_QUOTE_THRESHOLD) {
        // маленький шум — пропускаем
        continue;
      }

      const update: MarketUpdate = {
        providerId: this.providerId,
        marketType: this.marketType,
        symbol,
        timestamp: now,
        volumeBuy: cache.takerBuyBase,
        volumeSell: cache.takerSellBase,
        volumeBuyQuote: cache.takerBuyQuote,
        volumeSellQuote: cache.takerSellQuote,
      };

      const oiData = this.getOi(symbol);
      if (oiData.oi !== undefined) {
        update.openInterest = oiData.oi;
        update.openInterestTimestamp = oiData.ts;
      }

      try {
        this.callback(update);
      } catch (e) {
        this.logger.error('Callback error while flushing delta', e);
      }

      // сбрасываем аккумулированные значения, но не удаляем запись — сохраняем lastReset
      cache.takerBuyBase = 0;
      cache.takerBuyQuote = 0;
      cache.takerSellBase = 0;
      cache.takerSellQuote = 0;
      cache.lastReset = now;
    }
  }

  public async connect(): Promise<void> {
    if (this.connected) return;

    await this.readyPromise;

    return new Promise((resolve, reject) => {
      const url = this.marketType === 'futures' ? BINANCE_FUTURES_STREAM_URL : BINANCE_SPOT_STREAM_URL;
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.connected = true;
        this.reconnecting = false;
        this.reconnectAttempts = 0;
        this.intentionalDisconnect = false; // разрешаем автоматический reconnect
        this.logger.info(`Connected to Binance ${this.marketType}`);

        if (this.marketType === 'futures') {
          this.startOiPolling();
          this.subscribeToAggTrades();
          if (this.deltaFlushTimer) clearInterval(this.deltaFlushTimer);
          this.deltaFlushTimer = setInterval(() => this.flushDeltaVolume(), DELTA_FLUSH_INTERVAL_MS);
        }
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const messages: any[] = JSON.parse(data.toString());
          this.handleMessages(messages);
        } catch (e) {
          this.errorCount++;
          this.logger.error('Parse error', e);
        }
      });

      this.ws.on('error', (err) => {
        this.errorCount++;
        this.logger.error('WS error', err);
        if (!this.connected) reject(err);
      });

      this.ws.on('close', () => {
        this.connected = false;
        this.logger.warn('Main connection closed');
        // только автоматический reconnect если не было намеренного disconnect
        if (!this.intentionalDisconnect) {
          this.handleReconnection().catch((e) => this.logger.error('Reconnection scheduling failed', e));
        }
      });
    });
  }

  public async disconnect(): Promise<void> {
    this.intentionalDisconnect = true; // предотвращаем автоматический reconnect
    this.connected = false;
    this.reconnecting = false;
    
    this.stopOiPolling();

    if (this.deltaFlushTimer) clearInterval(this.deltaFlushTimer);
    this.deltaFlushTimer = null;
    this.aggTradeCache.clear();

    // очищаем все pending reconnect таймеры для aggTrade
    this.aggTradeReconnectTimers.forEach((timer) => clearTimeout(timer));
    this.aggTradeReconnectTimers.clear();

    this.aggTradeWsList.forEach((s: any) => {
      try {
        if (typeof s._closeGracefully === 'function') s._closeGracefully();
        else s.terminate();
      } catch (e) {}
    });
    this.aggTradeWsList = [];
    this.aggSubscribed = false;

    if (this.ws) {
      try { this.ws.terminate(); } catch (e) {}
    }
    this.ws = null;

    this.logger.info('Disconnected');
  }

  // Backwards-compatible aliases
  public async unsubscribe(): Promise<void> {
    // keep behavior same as disconnect for compatibility
    await this.disconnect();
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public async subscribe(): Promise<void> {
    // kept for backward compatibility — subscribe doesn't need to do anything specific here
    if (this.marketType === 'futures' && !this.aggSubscribed) this.subscribeToAggTrades();
  }

  public async getAvailableSymbols(): Promise<string[]> {
    return this.marketType === 'futures' ? Array.from(this.usdtPerpetuals) : [];
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

  private handleMessages(messages: any[]): void {
    if (!this.callback) return;
    const now = Date.now();

    for (const msg of messages) {
      try {
        const symbol: string = msg.s || msg.S;
        if (!symbol?.endsWith('USDT')) continue;

        if (this.marketType === 'futures') {
          if (symbol.includes('_') || !this.usdtPerpetuals.has(symbol)) continue;
        }

        const price = parseFloat(msg.c || msg.C);
        if (isNaN(price) || price <= 0) continue;

        this.messageCount++;
        this.lastUpdateTime = now;

        const update: MarketUpdate = {
          providerId: this.providerId,
          marketType: this.marketType,
          symbol,
          price,
          timestamp: msg.E || now,
          // НЕ передаем 24h volume из ticker — он смешивается с delta volume!
          // volume: msg.v ? parseFloat(msg.v) : undefined,
          // quoteVolume: msg.q ? parseFloat(msg.q) : undefined,
        };

        if (this.marketType === 'futures') {
          if (msg.p) update.markPrice = parseFloat(msg.p);
          if (msg.r) update.fundingRate = parseFloat(msg.r);

          const oiData = this.getOi(symbol);
          if (oiData.oi !== undefined) {
            update.openInterest = oiData.oi;
            update.openInterestTimestamp = oiData.ts;
          }
        }

        try { this.callback(update); } catch (e) { this.logger.error('Callback error in handleMessages', e); }
      } catch (e) {
        this.errorCount++;
      }
    }
  }

  private async handleReconnection(): Promise<void> {
    if (this.reconnecting || this.intentionalDisconnect) return;
    this.reconnecting = true;
    this.reconnectAttempts++;
    const attempt = this.reconnectAttempts;
    const backoff = Math.min(RECONNECT_DELAY * Math.pow(2, attempt - 1), 60_000);
    this.logger.info(`Reconnecting in ${Math.round(backoff / 1000)}s (attempt ${attempt})`);

    await new Promise((r) => setTimeout(r, backoff));

    // проверяем еще раз после задержки
    if (this.intentionalDisconnect) {
      this.reconnecting = false;
      return;
    }

    try {
      await this.connect();
      this.reconnecting = false;
    } catch (e) {
      this.logger.error('Reconnection failed', e);
      this.reconnecting = false;
      // schedule another reconnect attempt (счетчик уже увеличен выше)
      if (!this.intentionalDisconnect) {
        setTimeout(() => { this.handleReconnection().catch(() => {}); }, Math.min(backoff * 1.5, 60_000));
      }
    }
  }
}
