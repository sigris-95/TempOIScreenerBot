export class SignalDto {
  constructor(
    public readonly signalNumber: number,
    public readonly symbol: string,

    // Primary metric: Open Interest change in percent (signed: + up, - down)
    public readonly oiChangePercent: number,

    // Additional OI info
    public readonly oiStart?: number,
    public readonly oiEnd?: number,

    // Volume metrics
    public readonly totalVolume?: number,
    public readonly deltaVolume?: number, // buy - sell when available

    // Secondary (auxiliary): price percent change
    public readonly priceChangePercent?: number,
    public readonly currentPrice?: number,
    public readonly previousPrice?: number,

    public readonly timestamp?: Date,
    public readonly triggerIntervalMinutes?: number,
  ) {}
}
