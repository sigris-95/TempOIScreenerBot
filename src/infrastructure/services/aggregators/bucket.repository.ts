import { SortedBucketMap } from "./aggregator.types";
import { MarketUpdatePayload } from "./aggregator.types";
import { Logger } from "../../../shared/logger";

export class BucketRepository {
    public buckets15s: Map<string, SortedBucketMap> = new Map();
    public buckets1m: Map<string, SortedBucketMap> = new Map();
    public outOfOrderCount: Map<string, number> = new Map();

    private readonly MAX_MINUTE_BUCKETS = Number(process.env.MAX_MINUTE_BUCKETS) || 70;
    private readonly MAX_15S_BUCKETS = Number(process.env.MAX_15S_BUCKETS) || 300;

    constructor(private logger: Logger) { }

    public getStore(resolution: '15s' | '1m'): Map<string, SortedBucketMap> {
        return resolution === '15s' ? this.buckets15s : this.buckets1m;
    }

    public cleanupSymbol(symbol: string): void {
        this.buckets15s.delete(symbol);
        this.buckets1m.delete(symbol);
        this.outOfOrderCount.delete(symbol);
    }

    public addRawPoint(
        symbol: string,
        payload: MarketUpdatePayload,
        lastPrice: number | undefined,
        lastOI: number | undefined
    ): void {
        this.updateBucket(symbol, payload, 15_000, this.buckets15s, lastPrice, lastOI);
        this.updateBucket(symbol, payload, 60_000, this.buckets1m, lastPrice, lastOI);
    }

    private updateBucket(
        symbol: string,
        payload: MarketUpdatePayload,
        bucketSize: number,
        store: Map<string, SortedBucketMap>,
        lastPriceFallback?: number,
        lastOIFallback?: number
    ): void {
        let map = store.get(symbol);
        if (!map) {
            map = new SortedBucketMap();
            store.set(symbol, map);
        }

        const ts = payload.timestamp;
        const bucketTime = Math.floor(ts / bucketSize) * bucketSize;
        let b = map.get(bucketTime);

        const oi = Number.isFinite(payload.openInterest) ? payload.openInterest! : undefined;
        const price = Number.isFinite(payload.price) ? payload.price! : undefined;

        if (!b) {
            const initialOI = oi ?? (lastOIFallback ?? NaN);
            const initialPrice = price ?? lastPriceFallback;

            b = {
                oiOpen: Number.isFinite(initialOI) ? initialOI : NaN,
                oiClose: Number.isFinite(initialOI) ? initialOI : NaN,
                oiHigh: Number.isFinite(initialOI) ? initialOI : NaN,
                oiLow: Number.isFinite(initialOI) ? initialOI : NaN,
                volumeBuy: 0,
                volumeSell: 0,
                totalVolume: 0,
                volumeBuyQuote: 0,
                volumeSellQuote: 0,
                totalQuoteVolume: 0,
                priceOpen: initialPrice ?? null,
                priceClose: initialPrice ?? null,
                count: 0,
                firstTs: ts,
                lastTs: ts,
            };
            map.set(bucketTime, b);
        }

        // Out of order logic
        if (ts < b.firstTs) {
            if (b.count > 0) {
                this.outOfOrderCount.set(symbol, (this.outOfOrderCount.get(symbol) ?? 0) + 1);
            }
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

        // Update high/low for OI (только если значение валидное)
        if (Number.isFinite(oi)) {
            if (Number.isNaN(b.oiHigh) || oi! > b.oiHigh) {
                b.oiHigh = oi!;
            }
            if (Number.isNaN(b.oiLow) || oi! < b.oiLow) {
                b.oiLow = oi!;
            }
        }

        // Accumulate volumes - используем ?? вместо || для корректности с 0
        const volB = Number.isFinite(payload.volumeBuy) ? payload.volumeBuy! : 0;
        const volS = Number.isFinite(payload.volumeSell) ? payload.volumeSell! : 0;
        const volBQ = Number.isFinite(payload.volumeBuyQuote) ? payload.volumeBuyQuote! : 0;
        const volSQ = Number.isFinite(payload.volumeSellQuote) ? payload.volumeSellQuote! : 0;

        if (volB) b.volumeBuy += volB;
        if (volS) b.volumeSell += volS;
        if (volBQ) b.volumeBuyQuote += volBQ;
        if (volSQ) b.volumeSellQuote += volSQ;

        // Пересчитываем total из компонентов (не накапливаем) - избегаем ошибок округления
        b.totalVolume = b.volumeBuy + b.volumeSell;
        b.totalQuoteVolume = b.volumeBuyQuote + b.volumeSellQuote;

        // ensure price open/close exist
        if (Number.isFinite(price)) {
            if (b.priceOpen === null) b.priceOpen = price!;
            b.priceClose = price!;
        }

        b.count++;
        this.enforceLimit(map, symbol, bucketSize);
    }

    private enforceLimit(map: SortedBucketMap, symbol: string, bucketSize: number): void {
        const limit = bucketSize === 15_000 ? this.MAX_15S_BUCKETS : this.MAX_MINUTE_BUCKETS;
        const keys = map.getSortedKeys();
        if (keys.length <= limit) return;

        const removing = keys.length - limit;
        for (let i = 0; i < removing; i++) map.delete(keys[i]);
    }

    public getBucketsInRange(
        symbol: string,
        from: number,
        to: number,
        resolution: '15s' | '1m'
    ): { ts: number; bucket: import("./aggregator.types").Bucket }[] {
        const store = this.getStore(resolution);
        const map = store.get(symbol);

        if (!map) return [];

        const keys = map.getSortedKeys();
        const result: { ts: number; bucket: import("./aggregator.types").Bucket }[] = [];

        for (const ts of keys) {
            if (ts >= from && ts <= to) {
                const b = map.get(ts);
                if (b) result.push({ ts, bucket: b });
            }
            if (ts > to) break;
        }

        return result;
    }
}