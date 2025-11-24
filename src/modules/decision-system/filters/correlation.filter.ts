import { RegimeOutput, TriggerContext } from "../interfaces/interfaces";
import { clamp } from "../utilities";

export class CorrelationFilter {
  cfg = {
    // thresholds
    longCorrThreshold: 0.55, // if corr>this and BTC is moving up -> ignore LONG
    shortCorrThreshold: 0.40, // if corr<shortCorrThreshold and BTC not moving -> ignore SHORT
    btcMovePctForBlocking: 0.0025, // 0.25% (0.0025 fraction)
    minCorrWindowFactor: 2, // correlation window = max(2*oiInterval, 10)
    minCorrWindowFixed: 10,
    maxCorrWindow: 45,
  };

  shouldBlock(trigger: TriggerContext, regime: RegimeOutput, btcDeltaRecent: number, oiDirection: 'UP' | 'DOWN') {
    // choose dynamic window (not necessary for decision but logged)
    const corrWindow = clamp(Math.max(this.cfg.minCorrWindowFactor * trigger.oiIntervalMin, this.cfg.minCorrWindowFixed), 0, this.cfg.maxCorrWindow);

    // Blocking logic for LONG triggers
    if (trigger.direction === 'UP' && oiDirection === 'UP') {
      // if coin highly correlated and BTC moved up recently -> likely false long
      if (regime.pearsonCorr > this.cfg.longCorrThreshold && btcDeltaRecent > this.cfg.btcMovePctForBlocking) {
        return { block: true, reason: `Block LONG: corr=${regime.pearsonCorr.toFixed(2)} > ${this.cfg.longCorrThreshold} and BTC moved +${(btcDeltaRecent * 100).toFixed(2)}%` };
      }
    }

    // Blocking logic for SHORT triggers
    if (trigger.direction === 'DOWN' && oiDirection === 'DOWN') {
      // if coin NOT correlated and BTC not moving down -> suspicious short
      if (regime.pearsonCorr < this.cfg.shortCorrThreshold && btcDeltaRecent > -this.cfg.btcMovePctForBlocking) {
        return { block: true, reason: `Block SHORT: corr=${regime.pearsonCorr.toFixed(2)} < ${this.cfg.shortCorrThreshold} and BTC not falling` };
      }
    }

    return { block: false, reason: 'Passed correlation filter' };
  }
}