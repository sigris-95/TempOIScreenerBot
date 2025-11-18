// DataAggregatorServiceV3.ts
// Production-ready aggregator v3 — primary signal: Open Interest (OI)
// Backwards compatible with updatePrice(symbol, price, ts)

import { Injectable } from "../../shared/decorators";
import {
  IDataAggregatorService,
  IMetricChanges,
  ITriggerEngineService,
} from "../../domain/interfaces/services.interface";
import { Logger } from "../../shared/logger";

/**
 * Extended PriceUpdate shape we expect providers to gradually adopt.
 * Note: we do NOT change provider interface here — MarketDataGateway may
 * still call updatePrice; but providers that support OI/volumeBuy/volumeSell
 * should pass these into updateMarketData (see method below).
 */
export type MarketUpdatePayload = {
  timestamp: number;
  price?: number; // optional (we can operate on OI-only signals)
  openInterest?: number; // cumulative OI at this timestamp (preferred)
  volume?: number; // total volume in update (if only this is present)
  volumeBuy?: number; // buyer-initiated volume
  volumeSell?: number; // seller-initiated volume
  markPrice?: number;
  fundingRate?: number;
};

type Bucket = {
  // OI-centric fields
  oiOpen: number;
  oiClose: number;
  oiHigh: number;
  oiLow: number;

  // Volume fields (aggregated)
  volumeBuy: number;
  volumeSell: number;
  totalVolume: number;

  // Price kept for price% calculations
  priceOpen: number | null;
  priceClose: number | null;

  count: number;
  firstTs: number;
  lastTs: number;
};

type HealthStats = {
  totalSymbols: number;
  buckets15s: number;
  buckets1m: number;
  memoryEstimateMB: number;
  oldestData: number;
  newestData: number;
  warmupRejects: number;
  fallbacksUsed: number;
};

class SortedBucketMap {
  private map: Map<number, Bucket> = new Map();
  private sortedKeys: number[] | null = null;

  get size(): number {
    return this.map.size;
  }

  has(key: number): boolean {
    return this.map.has(key);
  }

  get(key: number): Bucket | undefined {
    return this.map.get(key);
  }

  set(key: number, value: Bucket): void {
    const isNew = !this.map.has(key);
    this.map.set(key, value);
    if (isNew) this.sortedKeys = null;
  }

  delete(key: number): boolean {
    const existed = this.map.delete(key);
    if (existed) this.sortedKeys = null;
    return existed;
  }

  getSortedKeys(): number[] {
    if (this.sortedKeys === null) {
      this.sortedKeys = [...this.map.keys()].sort((a, b) => a - b);
    }
    return this.sortedKeys;
  }

  keys(): IterableIterator<number> {
    return this.map.keys();
  }

  values(): IterableIterator<Bucket> {
    return this.map.values();
  }

  entries(): IterableIterator<[number, Bucket]> {
    return this.map.entries();
  }

  [Symbol.iterator](): IterableIterator<[number, Bucket]> {
    return this.map[Symbol.iterator]();
  }
}

@Injectable()
export class DataAggregatorService implements IDataAggregatorService {
  private readonly logger = new Logger("DataAggregatorV3");

  private buckets15s: Map<string, SortedBucketMap> = new Map();
  private buckets1m: Map<string, SortedBucketMap> = new Map();

  private lastKnownPrices: Map<string, number> = new Map();
  private lastKnownOI: Map<string, number> = new Map();
  private lastUpdateTs: Map<string, number> = new Map();
  private firstSeen: Map<string, number> = new Map();
  private outOfOrderCount: Map<string, number> = new Map();

  private triggerEngine?: ITriggerEngineService | null = null;

  // Config (same defaults as your v2)
  private readonly MAX_MINUTE_BUCKETS = Number(process.env.MAX_MINUTE_BUCKETS) || 70;
  private readonly MAX_15S_BUCKETS = Number(process.env.MAX_15S_BUCKETS) || 300;
  private readonly MIN_BUCKET_SAMPLES = Number(process.env.MIN_BUCKET_SAMPLES) || 2;
  private readonly MAX_TRACKED_SYMBOLS = Number(process.env.MAX_TRACKED_SYMBOLS) || 2000;
  private readonly SYMBOL_CHECK_INTERVAL = Number(process.env.SYMBOL_CHECK_INTERVAL) || 5_000;
  private readonly FALLBACK_SHIFT_MULTIPLIER = Number(process.env.FALLBACK_SHIFT_MULTIPLIER) || 2;
  private readonly DEBUG = process.env.DEBUG === 'true';

  private lastSymbolCheck = 0;
  private readonly SYMBOL_TTL_MS = 24 * 60 * 60 * 1000;

  private totalUpdates = 0;
  private lastHealthCheck = 0;
  private readonly HEALTH_CHECK_INTERVAL = 5 * 60 * 1000;

  private metricsCalculated = 0;
  private fallbacksUsed = 0;
  private warmupRejects = 0;

  // ---------------- PUBLIC API ----------------

  /**
   * Backwards-compatible method used by existing gateway:
   * updatePrice(symbol, price, timestamp)
   * We'll translate it into the extended market update with only price.
   */
  public updatePrice(symbol: string, price: number, timestamp: number): void {
    this.updateMarketData(symbol, { timestamp, price });
  }

  /**
   * New recommended entry point for providers that can supply
   * openInterest, volumeBuy/volumeSell, etc.
   */
  public updateMarketData(symbol: string, payload: MarketUpdatePayload): void {
    if (!symbol) return;

    const ts = Number.isFinite(payload.timestamp) ? Math.floor(payload.timestamp) : Date.now();
    // Update last seen price / oi if present
    if (Number.isFinite(payload.price) && payload.price! > 0) {
      this.lastKnownPrices.set(symbol, payload.price!);
    }
    if (Number.isFinite(payload.openInterest) && payload.openInterest! >= 0) {
      this.lastKnownOI.set(symbol, payload.openInterest!);
    }
    this.lastUpdateTs.set(symbol, ts);

    if (!this.firstSeen.has(symbol)) {
      this.firstSeen.set(symbol, ts);
      if (this.DEBUG) this.logger.debug(`New symbol tracked: ${symbol}`);
    }

    // Add to both bucket stores (15s and 1m)
    this.addRawPoint(symbol, {
      timestamp: ts,
      price: payload.price,
      openInterest: payload.openInterest,
      volume: payload.volume,
      volumeBuy: payload.volumeBuy,
      volumeSell: payload.volumeSell,
    });

    // trigger engine: preserve original onPriceUpdate hook for compatibility
    if (this.triggerEngine && typeof this.triggerEngine.onPriceUpdate === 'function') {
      try {
        // call with price if available
        const priceForCallback = payload.price ?? this.lastKnownPrices.get(symbol);
        void this.triggerEngine.onPriceUpdate(symbol, priceForCallback ?? 0);
      } catch (err) {
        this.logger.error(`Trigger engine notification failed: ${err}`);
      }
    }

    this.totalUpdates++;
    const now = Date.now();

    if (now - this.lastSymbolCheck > this.SYMBOL_CHECK_INTERVAL) {
      this.lastSymbolCheck = now;
      try {
        this.ensureSymbolLimit();
      } catch (err) {
        this.logger.error(`Symbol limit check failed: ${err}`);
      }
    }

    if (now - this.lastHealthCheck > this.HEALTH_CHECK_INTERVAL) {
      this.lastHealthCheck = now;
      this.logHealth();
    }
  }

  /**
   * Get metric changes for window (minutes).
   * Returns richer structure with OI metrics + volume/delta + price% (if price available).
   */
  public getMetricChanges(symbol: string, timeIntervalMinutes: number): IMetricChanges | null {
    if (!symbol || timeIntervalMinutes <= 0) return null;

    if (timeIntervalMinutes <= 2) {
      return this.calculateBuckets(symbol, timeIntervalMinutes, 15_000, this.buckets15s);
    }
    return this.calculateBuckets(symbol, timeIntervalMinutes, 60_000, this.buckets1m);
  }

  public getAllKnownSymbols(): string[] {
    const set = new Set<string>();
    for (const s of this.buckets15s.keys()) set.add(s);
    for (const s of this.buckets1m.keys()) set.add(s);
    for (const s of this.lastKnownPrices.keys()) set.add(s);
    for (const s of this.lastKnownOI.keys()) set.add(s);
    return Array.from(set);
  }

  public getHistoryLength(symbol: string): number {
    const m1 = this.buckets1m.get(symbol)?.size ?? 0;
    const m15 = this.buckets15s.get(symbol)?.size ?? 0;
    return Math.max(m1, m15);
  }

  public getCurrentPrice(symbol: string): number {
    return this.lastKnownPrices.get(symbol) ?? 0;
  }

  public setTriggerEngine(engine: ITriggerEngineService): void {
    this.triggerEngine = engine;
  }

  // --------------- Monitoring helpers (unchanged semantics) ---------------

  public getBucketHealth(symbol: string, minutes: number): {
    availableBuckets: number;
    expectedBuckets: number;
    coveragePercent: number;
    missingBuckets: number;
  } {
    const bucketSize = minutes <= 2 ? 15_000 : 60_000;
    const store = bucketSize === 15_000 ? this.buckets15s : this.buckets1m;
    const map = store.get(symbol);

    if (!map) return { availableBuckets: 0, expectedBuckets: 0, coveragePercent: 0, missingBuckets: 0 };

    const now = Date.now();
    const durationMs = minutes * 60_000;
    const endBucket = Math.floor(now / bucketSize) * bucketSize;
    const startBucket = Math.floor((now - durationMs) / bucketSize) * bucketSize;

    const expected = Math.round((endBucket - startBucket) / bucketSize) + 1;
    const keys = map.getSortedKeys();
    const available = keys.filter(k => k >= startBucket && k <= endBucket).length;
    const coverage = expected === 0 ? 0 : Math.round((available / expected) * 100);
    const missing = expected - available;

    return { availableBuckets: available, expectedBuckets: expected, coveragePercent: coverage, missingBuckets: missing };
  }

  public visualizeBuckets(symbol: string): void {
    const m15 = this.buckets15s.get(symbol);
    const m1 = this.buckets1m.get(symbol);

    this.logger.info(`=== BUCKETS: ${symbol} ===`);

    if (!m15 && !m1) {
      this.logger.info(`No buckets for ${symbol}`);
      return;
    }

    if (m15) {
      this.logger.info(`15s buckets (${m15.size}):`);
      const keys = m15.getSortedKeys();
      keys.slice(-10).forEach(ts => {
        const b = m15.get(ts)!;
        this.logger.info(
          `  ${new Date(ts).toISOString()} | OI: O:${b.oiOpen.toFixed(6)} H:${b.oiHigh.toFixed(6)} ` +
          `L:${b.oiLow.toFixed(6)} C:${b.oiClose.toFixed(6)} | volBuy:${b.volumeBuy.toFixed(6)} volSell:${b.volumeSell.toFixed(6)} cnt:${b.count}`
        );
      });
    }

    if (m1) {
      this.logger.info(`1m buckets (${m1.size}):`);
      const keys = m1.getSortedKeys();
      keys.slice(-10).forEach(ts => {
        const b = m1.get(ts)!;
        this.logger.info(
          `  ${new Date(ts).toISOString()} | OI: O:${b.oiOpen.toFixed(6)} H:${b.oiHigh.toFixed(6)} ` +
          `L:${b.oiLow.toFixed(6)} C:${b.oiClose.toFixed(6)} | volBuy:${b.volumeBuy.toFixed(6)} volSell:${b.volumeSell.toFixed(6)} cnt:${b.count}`
        );
      });
    }
  }

  public getOutOfOrderStats(symbol?: string): Record<string, number> | number {
    if (symbol) return this.outOfOrderCount.get(symbol) ?? 0;
    return Object.fromEntries(this.outOfOrderCount);
  }

  public getHealthStats(): HealthStats {
    let buckets15Count = 0;
    let buckets1mCount = 0;
    let oldestTs = Date.now();
    let newestTs = 0;

    for (const map of this.buckets15s.values()) {
      buckets15Count += map.size;
      for (const [ts] of map) {
        oldestTs = Math.min(oldestTs, ts);
        newestTs = Math.max(newestTs, ts);
      }
    }

    for (const map of this.buckets1m.values()) {
      buckets1mCount += map.size;
      for (const [ts] of map) {
        oldestTs = Math.min(oldestTs, ts);
        newestTs = Math.max(newestTs, ts);
      }
    }

    const bytesPerBucket = 120; // more fields -> larger estimate
    const memoryEstimateMB = ((buckets15Count + buckets1mCount) * bytesPerBucket) / (1024 * 1024);

    return {
      totalSymbols: this.getAllKnownSymbols().length,
      buckets15s: buckets15Count,
      buckets1m: buckets1mCount,
      memoryEstimateMB: Math.round(memoryEstimateMB * 100) / 100,
      oldestData: oldestTs === Date.now() ? 0 : oldestTs,
      newestData: newestTs,
      warmupRejects: this.warmupRejects,
      fallbacksUsed: this.fallbacksUsed,
    };
  }

  // ---------------- Ingestion and bucket aggregation ----------------

  private addRawPoint(symbol: string, point: {
    timestamp: number;
    price?: number;
    openInterest?: number;
    volume?: number;
    volumeBuy?: number;
    volumeSell?: number;
  }): void {
    const { timestamp: ts, price, openInterest, volume, volumeBuy, volumeSell } = point;
    this.updateBucket(symbol, ts, { price, openInterest, volume, volumeBuy, volumeSell }, 15_000, this.buckets15s);
    this.updateBucket(symbol, ts, { price, openInterest, volume, volumeBuy, volumeSell }, 60_000, this.buckets1m);
  }

  private updateBucket(
    symbol: string,
    ts: number,
    payload: { price?: number; openInterest?: number; volume?: number; volumeBuy?: number; volumeSell?: number },
    bucketSize: number,
    store: Map<string, SortedBucketMap>,
  ): void {
    let map = store.get(symbol);
    if (!map) {
      map = new SortedBucketMap();
      store.set(symbol, map);
    }

    const bucketTime = Math.floor(ts / bucketSize) * bucketSize;
    let b = map.get(bucketTime);

    const oi = Number.isFinite(payload.openInterest) ? payload.openInterest! : undefined;
    const price = Number.isFinite(payload.price) ? payload.price! : undefined;
    const vol = Number.isFinite(payload.volume) ? payload.volume! : undefined;
    const volB = Number.isFinite(payload.volumeBuy) ? payload.volumeBuy! : 0;
    const volS = Number.isFinite(payload.volumeSell) ? payload.volumeSell! : 0;

    if (!b) {
      // initialize bucket with fallbacks
      const initialOI = oi ?? (this.lastKnownOI.get(symbol) ?? NaN);
      const initialPrice = price ?? this.lastKnownPrices.get(symbol);

      b = {
        oiOpen: Number.isFinite(initialOI) ? initialOI : 0,
        oiClose: Number.isFinite(initialOI) ? initialOI : 0,
        oiHigh: Number.isFinite(initialOI) ? initialOI : -Infinity,
        oiLow: Number.isFinite(initialOI) ? initialOI : Infinity,

        volumeBuy: volB,
        volumeSell: volS,
        totalVolume: vol ?? (volB + volS),

        priceOpen: initialPrice ?? null,  // ← ИСПРАВЛЕНО: добавлено ?? null
        priceClose: initialPrice ?? null, // ← ИСПРАВЛЕНО: добавлено ?? null

        count: 0,
        firstTs: ts,
        lastTs: ts,
      };
      map.set(bucketTime, b);
    }

    // Out-of-order check relative to bucket's firstTs
    if (ts < b.firstTs) {
      if (b.count > 0) {
        const prev = this.outOfOrderCount.get(symbol) ?? 0;
        this.outOfOrderCount.set(symbol, prev + 1);
      }
      // We treat earlier sample as opening if earlier than previous firstTs
      if (Number.isFinite(oi)) {
        b.oiOpen = oi!;
        b.firstTs = ts;
      }
      if (Number.isFinite(price)) {
        b.priceOpen = price!;
        b.firstTs = ts;
      }
    }

    // Update close if this is the newest in bucket
    if (ts >= b.lastTs) {
      if (Number.isFinite(oi)) b.oiClose = oi!;
      if (Number.isFinite(price)) b.priceClose = price!;
      b.lastTs = ts;
    }

    // Update high/low for OI
    if (Number.isFinite(oi)) {
      b.oiHigh = Math.max(b.oiHigh, oi!);
      b.oiLow = Math.min(b.oiLow, oi!);
    }

    // Update volumes
    if (vol !== undefined) {
      // only total volume is present: accumulate to totalVolume
      b.totalVolume += vol;
    }
    // if buy/sell split provided, add them
    if (volB) b.volumeBuy += volB;
    if (volS) b.volumeSell += volS;

    // ensure price open/close exist
    if (Number.isFinite(price)) {
      if (b.priceOpen === null) b.priceOpen = price!;
      b.priceClose = price!;
    }

    b.count++;

    this.cleanupBuckets(store, symbol, bucketSize);
  }

  private cleanupBuckets(
    store: Map<string, SortedBucketMap>,
    symbol: string,
    bucketSize: number,
  ): void {
    const map = store.get(symbol);
    if (!map) return;

    const limit = bucketSize === 15_000 ? this.MAX_15S_BUCKETS : this.MAX_MINUTE_BUCKETS;
    const keys = map.getSortedKeys();

    if (keys.length <= limit) return;

    const removing = keys.length - limit;
    for (let i = 0; i < removing; i++) {
      map.delete(keys[i]);
    }

    if (this.DEBUG) {
      this.logger.debug(`Cleaned ${removing} old buckets for ${symbol} (${bucketSize/1000}s)`);
    }
  }

  // ---------------- Coverage thresholds (kept) ----------------

  private getCoverageThreshold(minutes: number): number {
    if (minutes <= 1) return 90;
    if (minutes <= 2) return 80;
    if (minutes <= 5) return 75;
    if (minutes <= 15) return 78;
    if (minutes <= 30) return 80;
    return 82;
  }

  // ---------------- Calculation ----------------

  private calculateBuckets(
    symbol: string,
    minutes: number,
    bucketSize: number,
    store: Map<string, SortedBucketMap>,
  ): IMetricChanges | null {
    const map = store.get(symbol);
    if (!map || map.size === 0) {
      if (this.DEBUG) this.logger.debug(`❌ No data for ${symbol}`);
      return null;
    }

    const now = Date.now();
    const durationMs = minutes * 60_000;
    const currentPrice = this.lastKnownPrices.get(symbol);
    const currentOI = this.lastKnownOI.get(symbol);

    // Warmup: require wall-clock firstSeen >= window
    const firstSeenTs = this.firstSeen.get(symbol) ?? now;
    const hasWallClockHistory = (now - firstSeenTs) >= durationMs;

    if (!hasWallClockHistory) {
      if (this.DEBUG) this.logger.debug(`Warmup: not enough wall-clock history for ${symbol} ${minutes}m`);
      this.warmupRejects++;
      return null;
    }

    const windowStart = now - durationMs;
    const windowEnd = now;

    // Find movements within window: returns best OI up/down and aggregated volume
    const movement = this.findOIAndVolumeWithinWindow(map, windowStart, windowEnd);

    // If no OI movement and we have price data, fallback to price-based change (interpolation/fallback too)
    let oiChangePercent = 0;
    let oiStart = movement?.oiStart ?? 0;
    let oiEnd = movement?.oiEnd ?? 0;
    let totalVolume = movement?.totalVolume ?? 0;
    let deltaVolume = movement?.deltaVolume ?? 0;

    let priceChangePercent = 0;
    let priceStart = 0;
    let priceEnd = currentPrice ?? 0;

    if (movement && movement.hasOI) {
      oiChangePercent = movement.oiChangePercent;
      oiStart = movement.oiStart;
      oiEnd = movement.oiEnd;
    } else {
      // try fallback interpolation for OI (if any historical OI exists)
      if (map.getSortedKeys().length > 0) {
        const fallback = this.fallbackInterpolationForOI(map, windowStart, windowEnd, bucketSize, durationMs, minutes);
        if (fallback) {
          oiChangePercent = fallback.oiChangePercent;
          oiStart = fallback.oiStart;
          oiEnd = fallback.oiEnd;
        }
      }
    }

    // Price%: compute from boundary prices (interpolate if needed)
    const startPrice = this.getPriceAtBoundary(map, windowStart);
    const endPrice = this.getPriceAtBoundary(map, windowEnd) ?? (currentPrice ?? undefined);

    if (startPrice !== null && endPrice !== undefined && startPrice > 0) {
      priceStart = startPrice;
      priceEnd = endPrice!;
      priceChangePercent = Number((((priceEnd - priceStart) / priceStart) * 100).toFixed(6));
    } else if (currentPrice && movement && movement.priceFallbackStart !== undefined) {
      // best-effort using movement price info
      priceStart = movement.priceFallbackStart ?? currentPrice;
      priceEnd = currentPrice;
      if (priceStart > 0) {
        priceChangePercent = Number((((priceEnd - priceStart) / priceStart) * 100).toFixed(6));
      }
    }

    // Compose result
    const result: any = {
      // OI metrics (primary)
      oiChangePercent: Number(oiChangePercent.toFixed(6)),
      oiStart,
      oiEnd,

      // Volume metrics
      totalVolume,
      deltaVolume, // buy - sell when available; 0 otherwise

      // Price metrics (secondary)
      priceChangePercent: Number(priceChangePercent),

      timeWindowSeconds: Math.max(1, Math.floor(durationMs / 1000)),
    };

    this.metricsCalculated++;
    return result as IMetricChanges;
  }

  // Find OI movements and aggregate volume within window (single pass)
  private findOIAndVolumeWithinWindow(
    map: SortedBucketMap,
    windowStart: number,
    windowEnd: number,
  ) {
    const keys = map.getSortedKeys();
    if (keys.length === 0) return null;

    let seenAny = false;
    let oiMin = Infinity;
    let oiMinTs = 0;
    let oiMax = -Infinity;
    let oiMaxTs = 0;

    let bestRise = 0;
    let bestRiseStart = 0;
    let bestRiseEnd = 0;
    let bestRiseStartTs = 0;
    let bestRiseEndTs = 0;

    let bestDrop = 0;
    let bestDropStart = 0;
    let bestDropEnd = 0;
    let bestDropStartTs = 0;
    let bestDropEndTs = 0;

    let totalVolume = 0;
    let totalBuy = 0;
    let totalSell = 0;

    let priceFallbackStart: number | undefined;

    for (let i = 0; i < keys.length; i++) {
      const bucketTime = keys[i];

      if (bucketTime < windowStart) continue;
      if (bucketTime > windowEnd) break;

      const b = map.get(bucketTime)!;
      if (b.count === 0) continue;

      seenAny = true;

      // aggregate volume fields
      totalVolume += (b.totalVolume ?? 0);
      totalBuy += (b.volumeBuy ?? 0);
      totalSell += (b.volumeSell ?? 0);

      // OI extremes detection (if OI data is present inside bucket)
      if (Number.isFinite(b.oiLow) && !isNaN(b.oiLow)) {
        if (b.oiLow < oiMin) {
          oiMin = b.oiLow;
          oiMinTs = b.firstTs;
        }
      }
      if (Number.isFinite(b.oiHigh) && !isNaN(b.oiHigh)) {
        if (b.oiHigh > oiMax) {
          oiMax = b.oiHigh;
          oiMaxTs = b.firstTs;
        }
      }

      // compute candidate rise: from minimum OI seen so far -> bucket's oiHigh
      if (oiMin < Infinity && Number.isFinite(b.oiHigh)) {
        const rise = ((b.oiHigh - oiMin) / oiMin) * 100;
        if (rise > bestRise) {
          bestRise = rise;
          bestRiseStart = oiMin;
          bestRiseEnd = b.oiHigh;
          bestRiseStartTs = oiMinTs;
          bestRiseEndTs = b.lastTs;
        }
      }

      // compute candidate drop: from max OI seen so far -> bucket's oiLow
      if (oiMax > -Infinity && Number.isFinite(b.oiLow)) {
        const drop = ((oiMax - b.oiLow) / oiMax) * 100;
        if (drop > bestDrop) {
          bestDrop = drop;
          bestDropStart = oiMax;
          bestDropEnd = b.oiLow;
          bestDropStartTs = oiMaxTs;
          bestDropEndTs = b.lastTs;
        }
      }

      // price fallback start: earliest bucket priceOpen in window
      if (priceFallbackStart === undefined && b.priceOpen !== null) {
        priceFallbackStart = b.priceOpen!;
      }
    }

    if (!seenAny) return null;

    const up = bestRise > 0 ? {
      percent: Number(bestRise.toFixed(6)),
      startPrice: bestRiseStart,
      endPrice: bestRiseEnd,
      duration: Math.max(1, Math.floor((bestRiseEndTs - bestRiseStartTs) / 1000)),
      startTs: bestRiseStartTs,
      endTs: bestRiseEndTs,
    } : null;

    const down = bestDrop > 0 ? {
      percent: Number(bestDrop.toFixed(6)),
      startPrice: bestDropStart,
      endPrice: bestDropEnd,
      duration: Math.max(1, Math.floor((bestDropEndTs - bestDropStartTs) / 1000)),
      startTs: bestDropStartTs,
      endTs: bestDropEndTs,
    } : null;

    // choose the dominant OI movement by absolute percent (same semantics as v2)
    let chosenPercent = 0;
    let chosenStart = 0;
    let chosenEnd = 0;
    if (up && down) {
      if (up.percent >= down.percent) {
        chosenPercent = up.percent;
        chosenStart = up.startPrice;
        chosenEnd = up.endPrice;
      } else {
        chosenPercent = -down.percent; // negative indicates drop
        chosenStart = down.startPrice;
        chosenEnd = down.endPrice;
      }
    } else if (up) {
      chosenPercent = up.percent;
      chosenStart = up.startPrice;
      chosenEnd = up.endPrice;
    } else if (down) {
      chosenPercent = -down.percent;
      chosenStart = down.startPrice;
      chosenEnd = down.endPrice;
    }

    return {
      hasOI: (oiMin !== Infinity && oiMax !== -Infinity),
      oiChangePercent: chosenPercent,
      oiStart: chosenStart,
      oiEnd: chosenEnd,
      totalVolume,
      deltaVolume: (totalBuy && totalSell) ? (totalBuy - totalSell) : 0,
      priceFallbackStart,
    };
  }

  // ---------------- Boundary interpolation helpers (kept, adapted) ----------------

  private getPriceAtBoundary(map: SortedBucketMap, boundary: number): number | null {
    const keys = map.getSortedKeys();
    if (keys.length === 0) return null;

    let left = 0;
    let right = keys.length - 1;
    let idx = -1;
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      if (keys[mid] <= boundary) {
        idx = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    const leftKey = idx >= 0 ? keys[idx] : null;
    const rightKey = (idx + 1) < keys.length ? keys[idx + 1] : null;

    if (leftKey !== null && leftKey === rightKey) {
      const b = map.get(leftKey)!;
      if (b.firstTs <= boundary && boundary <= b.lastTs && b.priceOpen !== null && b.priceClose !== null) {
        return this.interpolate(b.firstTs, b.priceOpen!, b.lastTs, b.priceClose!, boundary);
      }
      if (boundary < b.firstTs) return b.priceOpen;
      return b.priceClose;
    }

    const leftBucket = leftKey !== null ? map.get(leftKey) : undefined;
    const rightBucket = rightKey !== null ? map.get(rightKey) : undefined;

    if (leftBucket && leftBucket.firstTs <= boundary && boundary <= leftBucket.lastTs && leftBucket.priceOpen !== null && leftBucket.priceClose !== null) {
      return this.interpolate(leftBucket.firstTs, leftBucket.priceOpen!, leftBucket.lastTs, leftBucket.priceClose!, boundary);
    }

    if (rightBucket && rightBucket.firstTs <= boundary && boundary <= rightBucket.lastTs && rightBucket.priceOpen !== null && rightBucket.priceClose !== null) {
      return this.interpolate(rightBucket.firstTs, rightBucket.priceOpen!, rightBucket.lastTs, rightBucket.priceClose!, boundary);
    }

    if (leftBucket && rightBucket) {
      const prevTime = leftBucket.lastTs;
      const prevPrice = leftBucket.priceClose ?? leftBucket.priceOpen ?? null;
      const nextTime = rightBucket.firstTs;
      const nextPrice = rightBucket.priceOpen ?? rightBucket.priceClose ?? null;

      if (prevPrice === null || nextPrice === null) {
        return prevPrice ?? nextPrice;
      }

      if (prevTime <= boundary && boundary <= nextTime && nextTime > prevTime) {
        return this.interpolate(prevTime, prevPrice, nextTime, nextPrice, boundary);
      }

      const leftDelta = Math.abs(boundary - prevTime);
      const rightDelta = Math.abs(nextTime - boundary);
      return leftDelta <= rightDelta ? prevPrice : nextPrice;
    }

    if (leftBucket) return leftBucket.priceClose ?? leftBucket.priceOpen ?? null;
    if (rightBucket) return rightBucket.priceOpen ?? rightBucket.priceClose ?? null;

    return null;
  }

  private interpolate(t0: number, p0: number, t1: number, p1: number, t: number): number {
    if (t1 === t0) return p0;
    const ratio = (t - t0) / (t1 - t0);
    return p0 + (p1 - p0) * ratio;
  }

  private findNearestBucketAtOrBefore(map: SortedBucketMap, boundary: number): number | null {
    const keys = map.getSortedKeys();
    if (keys.length === 0) return null;

    let left = 0;
    let right = keys.length - 1;
    let result: number | null = null;
    
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const key = keys[mid];
      
      if (key <= boundary) {
        result = key;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }
    
    return result;
  }

  private effectiveMinSamples(minutes: number): number {
    if (minutes >= 5) return Math.max(3, this.MIN_BUCKET_SAMPLES);
    return this.MIN_BUCKET_SAMPLES;
  }

  private fallbackInterpolationForOI(
    map: SortedBucketMap,
    startBucket: number,
    endBucket: number,
    bucketSize: number,
    durationMs: number,
    minutes: number,
  ) {
    this.fallbacksUsed++;
    const keys = map.getSortedKeys();
    if (keys.length === 0) return null;

    const maxShift = Math.min(
      this.FALLBACK_SHIFT_MULTIPLIER * bucketSize,
      durationMs * 0.05
    );

    const beforeStart = keys.filter(k => k <= startBucket);
    const afterStart = keys.filter(k => k > startBucket);

    let startKey: number | null = null;
    if (beforeStart.length > 0) {
      startKey = beforeStart[beforeStart.length - 1];
      const shiftBack = startBucket - startKey;
      if (shiftBack > maxShift) {
        startKey = null;
      }
    }

    if (startKey === null && afterStart.length > 0) {
      const candidate = afterStart[0];
      const shift = candidate - startBucket;
      if (shift <= maxShift) {
        startKey = candidate;
      } else {
        return null;
      }
    }

    const beforeEnd = keys.filter(k => k <= endBucket);
    let endKey: number | null = null;
    
    if (beforeEnd.length > 0) {
      endKey = beforeEnd[beforeEnd.length - 1];
      const shiftBack = endBucket - endKey;
      if (shiftBack > maxShift) {
        endKey = null;
      }
    }

    if (endKey === null) {
      const candidate = keys[keys.length - 1];
      const shift = endBucket - candidate;
      if (shift <= maxShift) {
        endKey = candidate;
      } else {
        return null;
      }
    }

    if (startKey === null || endKey === null || startKey > endKey) {
      return null;
    }

    const s = map.get(startKey)!;
    const e = map.get(endKey)!;

    const startOI = (this.getOIAtBoundary(map, startBucket) ?? s.oiOpen);
    const endOI = (this.getOIAtBoundary(map, endBucket) ?? e.oiClose);

    if (!Number.isFinite(startOI) || !Number.isFinite(endOI) || startOI <= 0) {
      return null;
    }

    const oiChangePercent = Number((((endOI - startOI) / startOI) * 100).toFixed(6));

    return {
      oiChangePercent,
      oiStart: startOI,
      oiEnd: endOI,
    };
  }

  private getOIAtBoundary(map: SortedBucketMap, boundary: number): number | null {
    // Reuse same binary search logic as price but for OI fields
    const keys = map.getSortedKeys();
    if (keys.length === 0) return null;

    let left = 0;
    let right = keys.length - 1;
    let idx = -1;
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      if (keys[mid] <= boundary) {
        idx = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    const leftKey = idx >= 0 ? keys[idx] : null;
    const rightKey = (idx + 1) < keys.length ? keys[idx + 1] : null;

    if (leftKey !== null && leftKey === rightKey) {
      const b = map.get(leftKey)!;
      if (b.firstTs <= boundary && boundary <= b.lastTs) {
        // interpolate between open/close OI by time
        return this.interpolate(b.firstTs, b.oiOpen, b.lastTs, b.oiClose, boundary);
      }
      if (boundary < b.firstTs) return b.oiOpen;
      return b.oiClose;
    }

    const leftBucket = leftKey !== null ? map.get(leftKey) : undefined;
    const rightBucket = rightKey !== null ? map.get(rightKey) : undefined;

    if (leftBucket && leftBucket.firstTs <= boundary && boundary <= leftBucket.lastTs) {
      return this.interpolate(leftBucket.firstTs, leftBucket.oiOpen, leftBucket.lastTs, leftBucket.oiClose, boundary);
    }

    if (rightBucket && rightBucket.firstTs <= boundary && boundary <= rightBucket.lastTs) {
      return this.interpolate(rightBucket.firstTs, rightBucket.oiOpen, rightBucket.lastTs, rightBucket.oiClose, boundary);
    }

    if (leftBucket && rightBucket) {
      const prevTime = leftBucket.lastTs;
      const prevOI = leftBucket.oiClose;
      const nextTime = rightBucket.firstTs;
      const nextOI = rightBucket.oiOpen;

      if (prevTime <= boundary && boundary <= nextTime && nextTime > prevTime) {
        return this.interpolate(prevTime, prevOI, nextTime, nextOI, boundary);
      }

      const leftDelta = Math.abs(boundary - prevTime);
      const rightDelta = Math.abs(nextTime - boundary);
      return leftDelta <= rightDelta ? prevOI : nextOI;
    }

    if (leftBucket) return leftBucket.oiClose;
    if (rightBucket) return rightBucket.oiOpen;

    return null;
  }

  // ---------------- LRU / symbol eviction (same semantics) ----------------

  private ensureSymbolLimit(): void {
    const now = Date.now();
    let ttlEvicted = 0;
    for (const [symbol, lastUpdate] of this.lastUpdateTs.entries()) {
      if (now - lastUpdate > this.SYMBOL_TTL_MS) {
        this.evictSymbol(symbol);
        ttlEvicted++;
      }
    }

    if (ttlEvicted > 0 && this.DEBUG) {
      this.logger.info(`TTL evicted ${ttlEvicted} symbols`);
    }

    const total = this.lastUpdateTs.size;
    if (total <= this.MAX_TRACKED_SYMBOLS) return;

    const arr: Array<{ s: string; ts: number }> = [];
    for (const [s, ts] of this.lastUpdateTs.entries()) {
      arr.push({ s, ts });
    }

    arr.sort((a, b) => a.ts - b.ts);
    const removeCount = total - this.MAX_TRACKED_SYMBOLS;

    for (let i = 0; i < removeCount; i++) {
      this.evictSymbol(arr[i].s);
    }

    this.logger.warn(`LRU evicted ${removeCount} symbols (total: ${this.MAX_TRACKED_SYMBOLS})`);
  }

  private evictSymbol(symbol: string): void {
    this.buckets15s.delete(symbol);
    this.buckets1m.delete(symbol);
    this.lastKnownPrices.delete(symbol);
    this.lastKnownOI.delete(symbol);
    this.lastUpdateTs.delete(symbol);
    this.firstSeen.delete(symbol);
    this.outOfOrderCount.delete(symbol);
  }

  // ---------------- Monitoring ----------------

  private logHealth(): void {
    const stats = this.getHealthStats();
    const outOfOrderTotal = Array.from(this.outOfOrderCount.values()).reduce((a, b) => a + b, 0);

    this.logger.info(
      `Health: symbols=${stats.totalSymbols} buckets(15s=${stats.buckets15s}, 1m=${stats.buckets1m}) ` +
      `memory≈${stats.memoryEstimateMB}MB updates=${this.totalUpdates} outOfOrder=${outOfOrderTotal} ` +
      `warmupRejects=${stats.warmupRejects} fallbacks=${stats.fallbacksUsed}`
    );

    if (this.DEBUG) {
      const oldestAge = stats.oldestData ? ((Date.now() - stats.oldestData) / 60000).toFixed(1) : 'N/A';
      this.logger.debug(`   Oldest data: ${oldestAge} minutes ago`);
    }
  }
}
