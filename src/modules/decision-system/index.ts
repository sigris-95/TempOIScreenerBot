/**
 * Decision System Module
 * 
 * Полная система принятия торговых решений на основе:
 * - Корреляции с BTC
 * - Анализа рыночных режимов
 * - Фильтрации по различным параметрам
 * - Оценки скорости изменения Open Interest
 */

// Core coordinat or
export { DecisionCoordinator } from './decision-coordinator';

// Services
export { MarketRegimeService } from './services/market-regime.service';

// Filters
export { CorrelationFilter } from './filters/correlation.filter';
export { OIVelocityFilter } from './filters/oi-velocity.filter';

// Decision Engine
export {
    LongShortDecisionEngine,
    type MarketRegime,
    type EngineConfig,
    type Decision
} from './engines/long-short-decision.engine';

// Types
export {
    type MarketKline,
    type RegimeOutput,
    type TriggerContext,
    type AnalysisResult
} from './interfaces/interfaces';

// Utilities
export {
    clamp,
    pctChange,
    stddev
} from './utilities';

export { RollingBuffer } from './rolling-buffer';
