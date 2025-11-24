import { RollingBuffer } from '../rolling-buffer';
import { clamp, stddev } from '../utilities';
import { RegimeOutput } from '../interfaces/interfaces';

export class MarketRegimeService {
  private targetBuf = new RollingBuffer(240); // stores prices
  private btcBuf = new RollingBuffer(240);
  private ewmaProd = 0; // ewma of product of returns
  private cfg = {
    window: 60, // default points (usually 1m -> 60m window)
    pearsonHigh: 0.75,
    pearsonLow: 0.30,
    ewmaAlpha: 0.15,
    btcVolHigh: 0.02, // 2% per period (adjust per timeframe)
    volRatioThresh: 1.5,
    minWindow: 10,
    maxWindow: 180
  };

  constructor(private symbol: string, cfg?: Partial<typeof MarketRegimeService.prototype['cfg']>) {
    if (cfg) Object.assign(this.cfg, cfg);
  }

  // push latest close prices (call every kline update)
  pushPrices(targetClose: number, btcClose: number) {
    this.targetBuf.push(targetClose);
    this.btcBuf.push(btcClose);
  }

  // compute percent returns array from price array
  private static returnsFromPrices(prices: number[]) {
    const r: number[] = [];
    for (let i = 1; i < prices.length; i++) r.push((prices[i] - prices[i - 1]) / (Math.abs(prices[i - 1]) || 1));
    return r;
  }

  // pearson correlation for arrays of same length (trims to min length)
  private static pearson(a: number[], b: number[]) {
    const n = Math.min(a.length, b.length);
    if (n < 2) return 0;
    let sumA = 0, sumB = 0, sumA2 = 0, sumB2 = 0, sumAB = 0;
    for (let i = 0; i < n; i++) { const x = a[a.length - n + i]; const y = b[b.length - n + i]; sumA += x; sumB += y; sumA2 += x * x; sumB2 += y * y; sumAB += x * y; }
    const num = (n * sumAB - sumA * sumB);
    const den = Math.sqrt((n * sumA2 - sumA * sumA) * (n * sumB2 - sumB * sumB));
    if (den === 0) return 0; return num / den;
  }

  // compute regime with a given window size (points)
  compute(windowOverride?: number): RegimeOutput {
    const ts = Date.now();
    const window = clamp(windowOverride ?? this.cfg.window, this.cfg.minWindow, this.cfg.maxWindow);
    const targetPrices = this.targetBuf.toArray().slice(-window);
    const btcPrices = this.btcBuf.toArray().slice(-window);

    const targetR = MarketRegimeService.returnsFromPrices(targetPrices);
    const btcR = MarketRegimeService.returnsFromPrices(btcPrices);

    const corr = MarketRegimeService.pearson(targetR, btcR);

    // ewma on latest product of returns
    const lastProd = (targetR.length && btcR.length) ? targetR[targetR.length - 1] * btcR[btcR.length - 1] : 0;
    this.ewmaProd = this.cfg.ewmaAlpha * lastProd + (1 - this.cfg.ewmaAlpha) * this.ewmaProd;
    const ewmaCorr = this.ewmaProd; // proxy (signed)

    // lead-lag: test small offsets [-3..3]
    let best = { offset: 0, corr };
    for (let offset = -3; offset <= 3; offset++) {
      if (offset === 0) continue;
      const a = offset < 0 ? targetR.slice(0, offset) : targetR.slice(offset);
      const b = offset < 0 ? btcR.slice(-offset) : btcR.slice(0, btcR.length - offset);
      if (a.length < 2 || b.length < 2) continue;
      const c = MarketRegimeService.pearson(a, b);
      if (Math.abs(c) > Math.abs(best.corr)) best = { offset, corr: c };
    }

    const btcVol = btcR.length ? stddev(btcR) : 0;
    const targetVol = targetR.length ? stddev(targetR) : 0;
    const volRatio = btcVol > 1e-12 ? targetVol / btcVol : 0;

    // simple scoring and regime mapping
    let score = 0; const reasons: string[] = [];
    if (corr >= this.cfg.pearsonHigh) { score += 2; reasons.push(`High correlation with BTC (${corr.toFixed(2)})`); }
    else if (corr <= this.cfg.pearsonLow) { score -= 1; reasons.push(`Low correlation with BTC (${corr.toFixed(2)})`); }
    else reasons.push(`Moderate correlation with BTC (${corr.toFixed(2)})`);

    if (btcVol > this.cfg.btcVolHigh) { score -= 2; reasons.push(`BTC volatility high (${(btcVol * 100).toFixed(2)}%)`); }
    else reasons.push(`BTC volatility normal (${(btcVol * 100).toFixed(2)}%)`);

    if (volRatio > this.cfg.volRatioThresh) reasons.push(`Target vol > BTC (ratio ${volRatio.toFixed(2)})`);

    let regime: 'BTC_DOMINANT' | 'ALT_SEASON' | 'NEUTRAL' | 'HIGH_VOL' = 'NEUTRAL';
    if (btcVol > this.cfg.btcVolHigh) regime = 'HIGH_VOL';
    else if (corr >= this.cfg.pearsonHigh) regime = 'BTC_DOMINANT';
    else if (corr <= this.cfg.pearsonLow) regime = 'ALT_SEASON';

    // compute confidence: combine |corr| and |score|
    const confidence = clamp((Math.abs(corr) * 0.7 + clamp((Math.abs(score) / 3), 0, 1) * 0.3), 0, 1);

    return {
      symbol: this.symbol,
      timestamp: ts,
      pearsonCorr: corr,
      ewmaCorr,
      leadLag: best.corr === corr ? null : { offset: best.offset, corr: best.corr },
      btcVolatility: btcVol,
      volRatio,
      marketRegime: regime,
      confidence,
      reasons,
    };
  }
}