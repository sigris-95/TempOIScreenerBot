// infrastructure/SortedBucketMap.ts

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
    volumeBuyQuote?: number; // buyer-initiated volume in quote currency
    volumeSellQuote?: number; // seller-initiated volume in quote currency
    markPrice?: number;
    fundingRate?: number;
};

export type HealthStats = {
    totalSymbols: number;
    buckets15s: number;
    buckets1m: number;
    memoryEstimateMB: number;
    oldestData: number;
    newestData: number;
    warmupRejects: number;
    fallbacksUsed: number;
};

export type Bucket = {
    oiOpen: number;
    oiClose: number;
    oiHigh: number;
    oiLow: number;
    volumeBuy: number;
    volumeSell: number;
    totalVolume: number;
    volumeBuyQuote: number;
    volumeSellQuote: number;
    totalQuoteVolume: number;
    priceOpen: number | null;
    priceClose: number | null;
    count: number;
    firstTs: number;
    lastTs: number;
};

/**
 * Высокопроизводительная карта с сохранением порядка ключей по возрастанию.
 * Вставка: O(log n)
 * Удаление: O(n) → но в нашем случае удаляем только старые (с начала) → O(1) amortized
 * getSortedKeys(): O(1)
 */
export class SortedBucketMap {
    private readonly map = new Map<number, Bucket>();
    private readonly sortedKeys: number[] = [];

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
        const existed = this.map.has(key);
        this.map.set(key, value);

        // Если ключ уже был — ничего не делаем с sortedKeys
        if (!existed) {
            this.insertKeySorted(key);
        }
    }

    delete(key: number): boolean {
        const existed = this.map.delete(key);
        if (existed) {
            const idx = this.binarySearch(key);
            if (idx !== -1 && this.sortedKeys[idx] === key) {
                this.sortedKeys.splice(idx, 1);
            }
        }
        return existed;
    }

    /**
     * Возвращает уже отсортированный массив ключей.
     * Повторные вызовы — O(1)
     */
    getSortedKeys(): readonly number[] {
        return this.sortedKeys;
    }

    entries(): IterableIterator<[number, Bucket]> {
        return this.map.entries();
    }

    values(): IterableIterator<Bucket> {
        return this.map.values();
    }

    keys(): IterableIterator<number> {
        return this.map.keys();
    }

    [Symbol.iterator](): IterableIterator<[number, Bucket]> {
        return this.map[Symbol.iterator]();
    }

    /** Удаляет первые N ключей (самые старые) — используется при cleanup */
    deleteOldest(count: number): void {
        for (let i = 0; i < count && this.sortedKeys.length > 0; i++) {
            const key = this.sortedKeys.shift()!;
            this.map.delete(key);
        }
    }

    /** Вставляет ключ в отсортированный массив */
    private insertKeySorted(key: number): void {
        const idx = this.upperBound(key);
        this.sortedKeys.splice(idx, 0, key);
    }

    /**
     * Бинарный поиск: возвращает индекс, куда вставить key,
     * чтобы сохранить порядок (аналог lower_bound в C++)
     */
    private upperBound(target: number): number {
        let left = 0;
        let right = this.sortedKeys.length;

        while (left < right) {
            const mid = (left + right) >>> 1;
            if (this.sortedKeys[mid]! <= target) {
                left = mid + 1;
            } else {
                right = mid;
            }
        }

        return left;
    }

    /** Бинарный поиск точного совпадения ключа */
    private binarySearch(target: number): number {
        let left = 0;
        let right = this.sortedKeys.length - 1;

        while (left <= right) {
            const mid = (left + right) >>> 1;
            const val = this.sortedKeys[mid]!;

            if (val === target) return mid;
            if (val < target) left = mid + 1;
            else right = mid - 1;
        }

        return -1;
    }

    /** Полная очистка (для тестов или экстренного сброса) */
    clear(): void {
        this.map.clear();
        this.sortedKeys.length = 0;
    }
}