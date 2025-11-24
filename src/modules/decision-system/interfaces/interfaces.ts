export type MarketKline = { timestamp: number; open: number; high: number; low: number; close: number; volume: number };

export type RegimeOutput = {
  symbol: string;
  timestamp: number;
  pearsonCorr: number;
  ewmaCorr: number;
  leadLag: { offset: number; corr: number } | null;
  btcVolatility: number;
  volRatio: number; // targetVol / btcVol
  marketRegime: 'BTC_DOMINANT' | 'ALT_SEASON' | 'NEUTRAL' | 'HIGH_VOL';
  confidence: number; // 0..1
  reasons: string[];
};

export type TriggerContext = {
  symbol: string; // ex: SUPERUSDT
  direction: 'UP' | 'DOWN';
  percent: number; // % OI change to detect 1..100
  oiIntervalMin: number; // 1..30
};

export type AnalysisResult = {
  symbol: string;
  direction: 'LONG' | 'SHORT' | 'NO_TRADE';
  score: number; // 0..1
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  reasons: string[];
  debug?: any;
};

export interface ITaggableResult {
  tags: string[];
}