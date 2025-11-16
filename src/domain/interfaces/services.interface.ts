import { Trigger } from '../entities/trigger.entity';

export interface IDataPoint {
  readonly timestamp: number;
  readonly price: number;
  readonly openInterest: number;
}

export interface IMetricChanges {
  readonly priceChangePercent: number;
  readonly oiChangePercent: number;
  readonly currentPrice: number;  // NEW: Include current price in metrics
  readonly currentOI: number;      // NEW: Include current OI in metrics
}

export interface IDataAggregatorService {
  updatePrice(symbol: string, price: number, timestamp: number): void;
  updateOpenInterest(symbol: string, openInterest: number, timestamp: number): void;
  getMetricChanges(symbol: string, timeIntervalMinutes: number): IMetricChanges | null;
  getAllKnownSymbols(): string[];
  getHistoryLength(symbol: string): number;
}

export interface IMarketDataGateway {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface ITriggerEngineService {
  start(): void;
  stop(): void;
}

export interface INotificationService {
  processTrigger(trigger: Trigger, symbol: string, metrics: IMetricChanges): Promise<void>;
}