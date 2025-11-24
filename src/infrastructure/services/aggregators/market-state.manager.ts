import { Logger } from "../../../shared/logger";

export class MarketStateManager {
    public readonly lastKnownPrices: Map<string, number> = new Map();
    public readonly lastKnownOI: Map<string, number> = new Map();
    public readonly lastUpdateTs: Map<string, number> = new Map();
    public readonly firstSeen: Map<string, number> = new Map();
    public readonly outOfOrderCount: Map<string, number> = new Map(); // FIX: добавлен для избежания утечки памяти

    // LRU Config
    private readonly MAX_TRACKED_SYMBOLS = Number(process.env.MAX_TRACKED_SYMBOLS) || 2000;
    private readonly SYMBOL_TTL_MS = 24 * 60 * 60 * 1000;

    private lastSymbolCheck = 0;
    private readonly SYMBOL_CHECK_INTERVAL = 5_000;

    constructor(private logger: Logger) { }

    public updateState(symbol: string, ts: number, price?: number, oi?: number): void {
        if (Number.isFinite(price) && price! > 0) this.lastKnownPrices.set(symbol, price!);
        if (Number.isFinite(oi) && oi! >= 0) this.lastKnownOI.set(symbol, oi!);
        this.lastUpdateTs.set(symbol, ts);

        if (!this.firstSeen.has(symbol)) {
            this.firstSeen.set(symbol, ts);
        }
    }

    public checkLimits(now: number, evictCallback: (symbol: string) => void): void {
        if (now - this.lastSymbolCheck <= this.SYMBOL_CHECK_INTERVAL) return;
        this.lastSymbolCheck = now;

        // 1. TTL Eviction
        for (const [symbol, lastUpdate] of this.lastUpdateTs.entries()) {
            if (now - lastUpdate > this.SYMBOL_TTL_MS) {
                this.evict(symbol, evictCallback);
            }
        }

        // 2. Max Size Eviction
        if (this.lastUpdateTs.size > this.MAX_TRACKED_SYMBOLS) {
            const arr = Array.from(this.lastUpdateTs.entries()).sort((a, b) => a[1] - b[1]);
            const removeCount = this.lastUpdateTs.size - this.MAX_TRACKED_SYMBOLS;

            this.logger.warn(`LRU evicting ${removeCount} symbols`);
            for (let i = 0; i < removeCount; i++) {
                this.evict(arr[i][0], evictCallback);
            }
        }
    }

    public evict(symbol: string, cleanupCallback: (symbol: string) => void): void {
        this.lastKnownPrices.delete(symbol);
        this.lastKnownOI.delete(symbol);
        this.lastUpdateTs.delete(symbol);
        this.firstSeen.delete(symbol);
        this.outOfOrderCount.delete(symbol); // FIX: удаляем outOfOrderCount
        cleanupCallback(symbol);
    }

    public getAllSymbols(): string[] {
        return Array.from(this.lastUpdateTs.keys());
    }

    public getOI(symbol: string): number | undefined {
        return this.lastKnownOI.get(symbol);
    }

    public getPrice(symbol: string): number | undefined {
        return this.lastKnownPrices.get(symbol);
    }

    public getOutOfOrderStats(symbol?: string): Record<string, number> | number {
        if (symbol) return this.outOfOrderCount.get(symbol) ?? 0;
        return Object.fromEntries(this.outOfOrderCount);
    }
}