// LongShortDecisionEngine.ts
// Ready-to-use TypeScript module for making LONG/SHORT/NO-TRADE decisions
// based on a Market Regime Detection input. Designed to be integrated into
// a trigger/pump engine or trading bot. (ESM / CommonJS compatible)

export type MarketRegime = {
    marketRegime: "RISK_ON" | "RISK_OFF" | "NEUTRAL" | "HIGH_VOL";
    btcRegime: "STABLE" | "VOLATILE" | "TRENDING_UP" | "TRENDING_DOWN";
    ethRegime: "STRONG" | "WEAK" | "NEUTRAL";
    altRegime: "ACTIVE" | "DEAD" | "UNSTABLE";
    sector: string | null; // e.g. "ETH", "SOL", "MEME", null
    confidence: number; // 0..1
    timestamp?: number; // unix ms
};

export type EngineConfig = {
    // thresholds
    minConfidence?: number; // below -> NO_TRADE
    allowLongInNeutral?: boolean;
    allowShortInNeutral?: boolean;
    // volatility cutoffs (in fractional returns, e.g. 0.02 = 2%)
    btcVolatilityHigh?: number;
    btcVolatilityLow?: number;
    // correlation influence (0..1)
    maxAltCorrelationForLong?: number; // if alt corr > this -> avoid long on alts
    maxAltCorrelationForShort?: number; // similar logical guard
    // size/weighting for combined score
    weights?: {
        marketRegime?: number; // how strong RISK_ON/OFF affects
        trendBias?: number; // btc/eth trending
        altActivity?: number; // altRegime
        confidence?: number; // pass-through
    };
};

export type Decision = {
    side: "LONG" | "SHORT" | "NO_TRADE";
    reason: string[]; // human-readable reasons
    score: number; // -1..1 (negative = short bias, positive = long bias)
    confidence: number; // 0..1 (copied from regime input or adjusted)
    metadata?: Record<string, any>;
};

const DEFAULT_CONFIG: Required<EngineConfig> = {
    minConfidence: 0.25,
    allowLongInNeutral: true,
    allowShortInNeutral: true,
    btcVolatilityHigh: 0.03,
    btcVolatilityLow: 0.008,
    maxAltCorrelationForLong: 0.7,
    maxAltCorrelationForShort: 0.9,
    weights: {
        marketRegime: 0.5,
        trendBias: 0.3,
        altActivity: 0.15,
        confidence: 0.05,
    },
};

export class LongShortDecisionEngine {
    private cfg: Required<EngineConfig> & { weights: Required<NonNullable<EngineConfig['weights']>> };

    constructor(config?: EngineConfig) {
        const weights = { ...DEFAULT_CONFIG.weights, ...(config?.weights || {}) };
        this.cfg = { ...DEFAULT_CONFIG, ...(config || {}), weights } as any;
    }

    /**
     * Main method. Accepts the current MarketRegime and optional asset-specific
     * metrics (liquidity, altCorrelation, recent returns) and returns a decision.
     */
    public decide(regime: MarketRegime, opts?: {
        asset?: string; // e.g. "SOL/USDT"
        baseAsset?: string; // "SOL"
        quote?: string; // "USDT"
        altCorrelation?: number; // 0..1 correlation with BTC (optional)
        btcRecentReturn?: number; // fractional (e.g. 0.01)
        ethRecentReturn?: number;
        spread?: number;
        liquidityScore?: number; // 0..1
        additionalTags?: string[];
    }): Decision {
        const reasons: string[] = [];

        // Basic confidence guard
        const confidence = regime.confidence ?? 0;
        if (confidence < this.cfg.minConfidence) {
            reasons.push(`regime confidence too low (${confidence.toFixed(2)} < ${this.cfg.minConfidence})`);
            return this._noTrade(reasons, 0, confidence, { regime, opts });
        }

        // Build a composite score [-1..1]
        // Start neutral
        let score = 0;

        // 1) Market regime weight (RISK_ON -> +1, RISK_OFF -> -1)
        const marketFactor = (() => {
            switch (regime.marketRegime) {
                case "RISK_ON": return 1;
                case "RISK_OFF": return -1;
                case "NEUTRAL": return 0;
                case "HIGH_VOL": return -0.6; // slightly bias to avoid longs
            }
        })();
        score += marketFactor * this.cfg.weights.marketRegime;
        reasons.push(`marketRegime=${regime.marketRegime}`);

        // 2) Trend bias from BTC/ETH
        let trendBias = 0;
        if (regime.btcRegime === "TRENDING_UP") trendBias += 0.8;
        if (regime.btcRegime === "TRENDING_DOWN") trendBias -= 0.9;
        if (regime.ethRegime === "STRONG") trendBias += 0.4;
        if (regime.ethRegime === "WEAK") trendBias -= 0.4;

        score += trendBias * this.cfg.weights.trendBias;
        reasons.push(`trendBias=${trendBias.toFixed(2)}`);

        // 3) Alt activity
        let altFactor = 0;
        switch (regime.altRegime) {
            case "ACTIVE": altFactor = 0.7; break;
            case "UNSTABLE": altFactor = -0.2; break;
            case "DEAD": altFactor = -0.6; break;
        }
        score += altFactor * this.cfg.weights.altActivity;
        reasons.push(`altRegime=${regime.altRegime}`);

        // 4) Volatility guard: prefer avoid if BTC highly volatile
        // (optional: btcRecentReturn passed in opts)
        if (opts?.btcRecentReturn !== undefined) {
            const absBtc = Math.abs(opts.btcRecentReturn);
            if (absBtc > this.cfg.btcVolatilityHigh) {
                reasons.push(`btc recent return high ${absBtc.toFixed(3)} -> lowering score`);
                score -= 0.6; // penalty
            } else if (absBtc < this.cfg.btcVolatilityLow) {
                score += 0.1; // slight positive for stability
            }
        }

        // 5) Alt correlation guard: if altCorrelation high, avoid longs on small alts
        if (opts?.altCorrelation !== undefined) {
            if (opts.altCorrelation > this.cfg.maxAltCorrelationForLong) {
                reasons.push(`altCorrelation ${opts.altCorrelation.toFixed(2)} too high for confident long`);
                score -= 0.4;
            }
        }

        // 6) Liquidity & spread guards
        if (opts?.liquidityScore !== undefined && opts.liquidityScore < 0.2) {
            reasons.push(`low liquidity (${opts.liquidityScore.toFixed(2)}) -> avoid`);
            score -= 0.5;
        }
        if (opts?.spread !== undefined && opts.spread > 0.01) { // 1% spread
            reasons.push(`wide spread (${(opts.spread * 100).toFixed(2)}%) -> avoid`);
            score -= 0.3;
        }

        // 7) incorporate regime confidence as a small multiplier
        score += (regime.confidence - 0.5) * this.cfg.weights.confidence;

        // normalize score into -1..1
        score = Math.max(-1, Math.min(1, score));

        // Final decision rules
        // Priority: NO_TRADE if neutral and both disallowed, or if score close to 0
        const absScore = Math.abs(score);
        if (absScore < 0.12) {
            reasons.push(`score too weak (${score.toFixed(2)})`);
            return this._noTrade(reasons, score, confidence, { regime, opts });
        }

        if (score > 0) {
            // Long bias — check correlation guard
            if (opts?.altCorrelation !== undefined && opts.altCorrelation > this.cfg.maxAltCorrelationForLong) {
                reasons.push('correlation guard blocks long');
                return this._noTrade(reasons, score, confidence, { regime, opts });
            }

            // allow long only if regime allows
            if (regime.marketRegime === "RISK_OFF") {
                reasons.push('market regime RISK_OFF -> avoid longs');
                return this._noTrade(reasons, score, confidence, { regime, opts });
            }

            if (regime.marketRegime === "NEUTRAL" && !this.cfg.allowLongInNeutral) {
                reasons.push('neural regime configured to block longs');
                return this._noTrade(reasons, score, confidence, { regime, opts });
            }

            reasons.push(`LONG (score=${score.toFixed(2)})`);
            return {
                side: 'LONG',
                reason: reasons,
                score,
                confidence,
                metadata: { regime, opts },
            };
        }

        // score < 0 -> short bias
        if (score < 0) {
            if (regime.marketRegime === 'RISK_ON') {
                reasons.push('market regime RISK_ON -> avoid shorts');
                return this._noTrade(reasons, score, confidence, { regime, opts });
            }

            if (regime.marketRegime === 'NEUTRAL' && !this.cfg.allowShortInNeutral) {
                reasons.push('neutral regime configured to block shorts');
                return this._noTrade(reasons, score, confidence, { regime, opts });
            }

            reasons.push(`SHORT (score=${score.toFixed(2)})`);
            return {
                side: 'SHORT',
                reason: reasons,
                score,
                confidence,
                metadata: { regime, opts },
            };
        }

        // fallback
        return this._noTrade(['fallback'], score, confidence, { regime, opts });
    }

    private _noTrade(reasons: string[], score: number, confidence: number, metadata?: any): Decision {
        return {
            side: 'NO_TRADE',
            reason: reasons,
            score,
            confidence,
            metadata,
        };
    }

    // helper: update config at runtime
    public updateConfig(cfg: EngineConfig) {
        const weights = { ...this.cfg.weights, ...(cfg?.weights || {}) };
        this.cfg = { ...this.cfg, ...(cfg || {}), weights } as any;
    }

    public getConfig(): Required<EngineConfig> {
        return this.cfg;
    }
}
