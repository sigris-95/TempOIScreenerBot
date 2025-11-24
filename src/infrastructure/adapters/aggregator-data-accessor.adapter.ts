import { DataAggregatorService } from "../services/data-aggregator.service";
import { MarketDataAccessor, OIPoint } from "../../domain/interfaces/market-data-accessor.interface";
import { Injectable } from "../../shared/decorators";

@Injectable()
export class AggregatorDataAccessor implements MarketDataAccessor {
  constructor(private readonly aggregator: DataAggregatorService) { }

  getOISeries(symbol: string, minutes: number): OIPoint[] {
    const now = Date.now();
    const from = now - minutes * 60_000;

    const buckets = this.aggregator.getBucketRepo().getBucketsInRange(
      symbol,
      from,
      now,
      '1m'
    );

    return buckets
      .map(b => ({
        ts: b.ts,
        value: b.bucket.oiClose,
      }))
      .filter(p => Number.isFinite(p.value) && p.value > 0);
  }

  getCurrentOI(symbol: string): number | undefined {
    return this.aggregator.getStateManager().getOI(symbol);
  }

  getCurrentPrice(symbol: string): number | undefined {
    return this.aggregator.getStateManager().getPrice(symbol);
  }

  // Опцион ально: цены
  getPriceSeries(symbol: string, minutes: number): { ts: number; value: number }[] {
    const now = Date.now();
    const from = now - minutes * 60_000;
    const buckets = this.aggregator.getBucketRepo().getBucketsInRange(symbol, from, now, '1m');

    return buckets
      .map(b => ({
        ts: b.ts,
        value: b.bucket.priceClose ?? b.bucket.priceOpen ?? 0,
      }))
      .filter(p => p.value > 0);
  }
}