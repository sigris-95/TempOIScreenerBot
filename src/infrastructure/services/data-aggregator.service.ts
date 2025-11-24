import { Injectable } from "../../shared/decorators";
import {
    IDataAggregatorService,
    IMetricChanges,
    ITriggerEngineService,
} from "../../domain/interfaces/services.interface";
import { Logger } from "../../shared/logger";
import { MarketUpdatePayload, HealthStats } from "./aggregators/aggregator.types";
import { MarketStateManager } from "./aggregators/market-state.manager";
import { BucketRepository } from "./aggregators/bucket.repository";
import { MetricsCalculator } from "./aggregators/metrics-calculator";
import { MarketDataAccessor } from "../../domain/interfaces/market-data-accessor.interface";
import { AggregatorDataAccessor } from "../../infrastructure/adapters/aggregator-data-accessor.adapter";

@Injectable()
export class DataAggregatorService implements IDataAggregatorService {
    private readonly logger = new Logger("DataAggregator");

    // Components
    private readonly stateManager: MarketStateManager;
    private readonly bucketRepo: BucketRepository;
    private readonly calculator: MetricsCalculator;

    private triggerEngine?: ITriggerEngineService | null = null;

    // Statistics
    private totalUpdates = 0;
    private metricsCalculated = 0;
    private warmupRejects = 0;
    private lastHealthCheck = 0;
    private readonly HEALTH_CHECK_INTERVAL = 5 * 60 * 1000;
    private readonly DEBUG = process.env.DEBUG === 'true';

    constructor() {
        this.stateManager = new MarketStateManager(this.logger);
        this.bucketRepo = new BucketRepository(this.logger);
        this.calculator = new MetricsCalculator();
    }

    public getStateManager() {
        return this.stateManager;
    }

    public getBucketRepo() {
        return this.bucketRepo;
    }

    public createAccessor(): MarketDataAccessor {
        return new AggregatorDataAccessor(this);
    }

    // ---------------- PUBLIC API ----------------

    public updatePrice(symbol: string, price: number, timestamp: number): void {
        this.updateMarketData(symbol, { timestamp, price });
    }

    public updateMarketData(symbol: string, payload: MarketUpdatePayload): void {
        if (!symbol) return;

        const ts = Number.isFinite(payload.timestamp) ? Math.floor(payload.timestamp) : Date.now();

        // 1. Update State (Price, OI, Last Seen)
        this.stateManager.updateState(symbol, ts, payload.price, payload.openInterest);

        // 2. Ingest Data into Buckets
        const lastPrice = this.stateManager.lastKnownPrices.get(symbol);
        const lastOI = this.stateManager.lastKnownOI.get(symbol);

        this.bucketRepo.addRawPoint(symbol, { ...payload, timestamp: ts }, lastPrice, lastOI);

        // 3. Trigger Engine Notification
        if (this.triggerEngine?.onPriceUpdate) {
            try {
                const priceForCallback = payload.price ?? lastPrice ?? 0;
                void this.triggerEngine.onPriceUpdate(symbol, priceForCallback);
            } catch (err) {
                this.logger.error(`Trigger error: ${err}`);
            }
        }

        this.totalUpdates++;
        this.performMaintenanceTasks();
    }

    public getMetricChanges(symbol: string, timeIntervalMinutes: number): IMetricChanges | null {
        if (!symbol || timeIntervalMinutes <= 0) return null;

        const resolution = timeIntervalMinutes <= 2 ? '15s' : '1m';
        const store = this.bucketRepo.getStore(resolution);
        const bucketMap = store.get(symbol);

        if (!bucketMap || bucketMap.size === 0) {
            if (this.DEBUG) this.logger.debug(`❌ No data for ${symbol}`);
            return null;
        }

        const firstSeen = this.stateManager.firstSeen.get(symbol) ?? Date.now();
        const neededHistory = timeIntervalMinutes * 60_000;
        if ((Date.now() - firstSeen) < neededHistory) {
            this.warmupRejects++;
            return null;
        }

        const currentPrice = this.stateManager.lastKnownPrices.get(symbol);
        const currentOI = this.stateManager.lastKnownOI.get(symbol);
        const bucketSize = resolution === '15s' ? 15_000 : 60_000;

        const result = this.calculator.calculateWindow(
            bucketMap,
            timeIntervalMinutes,
            bucketSize,
            currentPrice,
            currentOI
        );

        if (result) this.metricsCalculated++;
        return result;
    }

    public getAllKnownSymbols(): string[] {
        return this.stateManager.getAllSymbols();
    }

    public getHistoryLength(symbol: string): number {
        const m1 = this.bucketRepo.buckets1m.get(symbol)?.size ?? 0;
        const m15 = this.bucketRepo.buckets15s.get(symbol)?.size ?? 0;
        return Math.max(m1, m15);
    }

    public getCurrentPrice(symbol: string): number {
        return this.stateManager.lastKnownPrices.get(symbol) ?? 0;
    }

    public setTriggerEngine(engine: ITriggerEngineService): void {
        this.triggerEngine = engine;
    }

    // --------------- Monitoring & Maintenance ---------------

    private performMaintenanceTasks(): void {
        const now = Date.now();

        this.stateManager.checkLimits(now, (evictedSymbol) => {
            this.bucketRepo.cleanupSymbol(evictedSymbol);
        });

        if (now - this.lastHealthCheck > this.HEALTH_CHECK_INTERVAL) {
            this.lastHealthCheck = now;
            this.logHealth();
        }
    }

    public getHealthStats(): HealthStats {
        let buckets15Count = 0;
        let buckets1mCount = 0;
        let oldestTs = Date.now();
        let newestTs = 0;

        for (const map of this.bucketRepo.buckets15s.values()) {
            buckets15Count += map.size;
            for (const [ts] of map) {
                oldestTs = Math.min(oldestTs, ts);
                newestTs = Math.max(newestTs, ts);
            }
        }

        for (const map of this.bucketRepo.buckets1m.values()) {
            buckets1mCount += map.size;
            for (const [ts] of map) {
                oldestTs = Math.min(oldestTs, ts);
                newestTs = Math.max(newestTs, ts);
            }
        }

        const bytesPerBucket = 120;
        const memoryEstimateMB = ((buckets15Count + buckets1mCount) * bytesPerBucket) / (1024 * 1024);

        return {
            totalSymbols: this.stateManager.lastUpdateTs.size,
            buckets15s: buckets15Count,
            buckets1m: buckets1mCount,
            memoryEstimateMB: Math.round(memoryEstimateMB * 100) / 100,
            oldestData: oldestTs === Date.now() ? 0 : oldestTs,
            newestData: newestTs,
            warmupRejects: this.warmupRejects,
            fallbacksUsed: this.calculator.getStats().fallbacksUsed,
        };
    }

    private logHealth(): void {
        const stats = this.getHealthStats();
        const outOfOrderTotal = Array.from(this.bucketRepo.outOfOrderCount.values()).reduce((a, b) => a + b, 0);

        this.logger.info(
            `Health: symbols=${stats.totalSymbols} buckets(15s=${stats.buckets15s}, 1m=${stats.buckets1m}) ` +
            `mem≈${stats.memoryEstimateMB}MB ups=${this.totalUpdates} ooo=${outOfOrderTotal} ` +
            `warmup=${stats.warmupRejects} fb=${stats.fallbacksUsed}`
        );

        if (this.DEBUG) {
            const oldestAge = stats.oldestData ? ((Date.now() - stats.oldestData) / 60000).toFixed(1) : 'N/A';
            this.logger.debug(`   Oldest data: ${oldestAge} minutes ago`);
        }
    }

    public getBucketHealth(symbol: string, minutes: number) {
        const bucketSize = minutes <= 2 ? 15_000 : 60_000;
        const store = this.bucketRepo.getStore(minutes <= 2 ? '15s' : '1m');
        const map = store.get(symbol);
        if (!map) return { availableBuckets: 0, expectedBuckets: 0, coveragePercent: 0, missingBuckets: 0 };

        const now = Date.now();
        const durationMs = minutes * 60_000;
        const endBucket = Math.floor(now / bucketSize) * bucketSize;
        const startBucket = Math.floor((now - durationMs) / bucketSize) * bucketSize;
        const expected = Math.round((endBucket - startBucket) / bucketSize) + 1;
        const keys = map.getSortedKeys();
        const available = keys.filter(k => k >= startBucket && k <= endBucket).length;

        return {
            availableBuckets: available,
            expectedBuckets: expected,
            coveragePercent: expected === 0 ? 0 : Math.round((available / expected) * 100),
            missingBuckets: expected - available
        };
    }

    public visualizeBuckets(symbol: string): void {
        const m15 = this.bucketRepo.buckets15s.get(symbol);
        const m1 = this.bucketRepo.buckets1m.get(symbol);

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
        return this.stateManager.getOutOfOrderStats(symbol);
    }
}