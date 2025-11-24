// --------------------------- DecisionCoordinator ---------------------------

import { CorrelationFilter } from './filters/correlation.filter';
import { AnalysisResult, TriggerContext } from './interfaces/interfaces';
import { MarketRegimeService } from './services/market-regime.service';
import { clamp } from './utilities';
import { LongShortDecisionEngine, MarketRegime } from './engines/long-short-decision.engine';
import { IDataAggregatorService } from '../../domain/interfaces/services.interface';
import { OIVelocityFilter } from './filters/oi-velocity.filter';

// Координирует pipeline: on trigger match -> compute regime (corr) -> filter -> combine metrics -> final DecisionEngine
export class DecisionCoordinator {
  private regimeServices = new Map<string, MarketRegimeService>();
  private corrFilter = new CorrelationFilter();
  private decisionEngine: LongShortDecisionEngine;
  private oiFilter = new OIVelocityFilter();

  constructor(
    private readonly aggregator: IDataAggregatorService,
    longShortEngine: LongShortDecisionEngine
  ) {
    this.decisionEngine = longShortEngine;
  }

  ensureRegimeService(symbol: string) {
    if (!this.regimeServices.has(symbol))
      this.regimeServices.set(symbol, new MarketRegimeService(symbol));
    return this.regimeServices.get(symbol)!;
  }

  // call on each kline update to keep buffers up-to-date
  onKline(symbol: string, close: number, btcClose: number) {
    const s = this.ensureRegimeService(symbol);
    s.pushPrices(close, btcClose);
  }

  // Active analysis method: fetches data, checks filters, decides
  async processCandidate(symbol: string, rule: TriggerContext): Promise<AnalysisResult> {
    // 1. Fetch History & Warmup
    // We use a transient service to avoid state issues if onKline is not running
    const svc = new MarketRegimeService(symbol);
    const accessor = this.aggregator.createAccessor();

    // Get 60m history for correlation
    const historyMinutes = 60;
    const targetHistory = accessor.getPriceSeries ? accessor.getPriceSeries(symbol, historyMinutes) : [];
    const btcHistory = accessor.getPriceSeries ? accessor.getPriceSeries('BTCUSDT', historyMinutes) : [];

    // Align and push to service
    for (let i = 0; i < Math.min(targetHistory.length, btcHistory.length); i++) {
      svc.pushPrices(targetHistory[i].value, btcHistory[i].value);
    }

    // 2. Check OI Velocity (Rule Condition)
    const oiResult = this.oiFilter.evaluate(symbol, accessor, rule);
    if (!oiResult.pass) {
      return {
        symbol,
        direction: 'NO_TRADE',
        score: 0,
        confidence: 'LOW',
        reasons: [`OI Filter failed: ${oiResult.reason}`],
        debug: { oiResult }
      };
    }

    // 3. Compute Regime & Correlation
    const corrWindow = clamp(Math.max(2 * rule.oiIntervalMin, 10), 10, 45);
    const regime = svc.compute(corrWindow);

    // 4. Prepare Engine Input
    const currentPrice = accessor.getCurrentPrice(symbol) || 0;
    const btcPrice = accessor.getCurrentPrice('BTCUSDT') || 0;
    const btcRecentReturn = 0; // TODO: calculate from history if needed

    const engineInput: MarketRegime = {
      marketRegime: regime.marketRegime === 'BTC_DOMINANT' ? 'RISK_OFF' :
        regime.marketRegime === 'ALT_SEASON' ? 'RISK_ON' :
          regime.marketRegime === 'HIGH_VOL' ? 'HIGH_VOL' : 'NEUTRAL',
      btcRegime: regime.btcVolatility > 0.02 ? 'VOLATILE' : 'STABLE',
      ethRegime: 'NEUTRAL',
      altRegime: regime.marketRegime === 'ALT_SEASON' ? 'ACTIVE' : 'UNSTABLE',
      sector: null,
      confidence: regime.confidence
    };

    const decision = this.decisionEngine.decide(engineInput, {
      asset: symbol,
      altCorrelation: regime.pearsonCorr,
      btcRecentReturn: btcRecentReturn,
      liquidityScore: 1,
    });

    // 5. Map to AnalysisResult
    const confLabel = decision.confidence > 0.7 ? 'HIGH' : decision.confidence > 0.4 ? 'MEDIUM' : 'LOW';

    return {
      symbol,
      direction: decision.side,
      score: decision.score,
      confidence: confLabel as 'LOW' | 'MEDIUM' | 'HIGH',
      reasons: [...(oiResult.reason ? [oiResult.reason] : []), ...decision.reason],
      debug: { regime, decision, oiResult }
    };
  }
}