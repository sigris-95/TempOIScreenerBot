export type SignalQuality = 'weak' | 'medium' | 'strong';

export class SignalDto {
  constructor(
    public readonly signalNumber: number,
    public readonly symbol: string,
    public readonly priceChangePercent: number,
    public readonly oiGrowthPercent: number,
    public readonly deltaPercent: number,
    public readonly currentPrice: number,
    public readonly timestamp: Date,
    public readonly quality: SignalQuality,
    public readonly triggerIntervalMinutes?: number,
  ) {}
}
