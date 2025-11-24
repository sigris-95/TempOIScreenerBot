import { MarketDataAccessor, OIPoint } from '../../../domain/interfaces/market-data-accessor.interface';

export interface VelocityResult {
  pass: boolean;
  reason: string;
  velocity: number;           // % в минуту
  oiStart: number;
  oiEnd: number;
  durationMin: number;
  tags?: string[];            // ← НОВОЕ: ускорение, стабильность и т.д.
  acceleration?: number;      // ← НОВОЕ: вторая производная (%/мин²)
}

export class OIVelocityFilter {
  // === НАСТРОЙКИ — ТЮНИНГ ПОД ТОП-1 ===
  // private readonly MIN_DURATION_MIN = 3.8;        // минимум 3.8 минуты — отсекаем спайки
  // private readonly MAX_SAFE_VELOCITY = 4.2;       // > 4.2%/мин — 99% шорт-сквиз
  // private readonly MIN_VELOCITY_LONG = 0.78;      // минимум для лонга
  // private readonly MAX_VELOCITY_LONG = 3.8;       // максимум для лонга (выше — сквиз)
  // private readonly ACCELERATION_THRESHOLD = 0.06; // если ускорение > 0.06 — огонь!

  private readonly MIN_DURATION_MIN = 2.6;         // оптимум: отсекаем шум, но не режем ранние импульсы
  private readonly MAX_SAFE_VELOCITY = 5.3;        // > 5.3%/мин — почти всегда сквиз или ликвидации
  private readonly MIN_VELOCITY_LONG = 0.62;       // минимальная устойчивая скорость для нормального импульса
  private readonly MAX_VELOCITY_LONG = 4.7;        // выше — уже не вход, а сквиз зона
  private readonly ACCELERATION_THRESHOLD = 0.045; // оптимальная граница ускорения (чистые импульсы)

  public readonly ACCELERATING = 'ACCELERATING';
  public readonly DECELERATING = 'DECELERATING';

  public readonly SHORT_SPIKE = 'SHORT_SPIKE';
  public readonly SHORT_SQUEEZE = 'SHORT_SQUEEZE';

  public readonly STABLE_IMPULSE = 'STABLE_IMPULSE';
  public readonly STRONG_VELOCITY = 'STRONG_VELOCITY';

  evaluate(symbol: string, data: MarketDataAccessor, rule: { percent: number; oiIntervalMin: number }): VelocityResult {
    const minutes = rule.oiIntervalMin;
    const now = Date.now();
    const from = now - minutes * 60_000;

    const series: OIPoint[] = data.getOISeries(symbol, minutes + 5);
    if (series.length < 3) {
      return {
        pass: false,
        reason: `Недостаточно данных OI (${series.length} точек)`,
        velocity: 0,
        oiStart: 0,
        oiEnd: 0,
        durationMin: 0,
      };
    }

    let startIdx = series.findIndex(p => p.ts >= from);
    if (startIdx <= 0) startIdx = 0;

    const start = series[startIdx];
    const end = series[series.length - 1];

    if (!Number.isFinite(start.value) || start.value <= 0 || !Number.isFinite(end.value)) {
      return {
        pass: false,
        reason: `Некорректные данные OI`,
        velocity: 0,
        oiStart: start.value,
        oiEnd: end.value,
        durationMin: 0,
      };
    }

    const durationMin = (end.ts - start.ts) / 60_000;
    if (durationMin < 0.2) {
      return { pass: false, reason: 'Интервал слишком короткий', velocity: 0, oiStart: start.value, oiEnd: end.value, durationMin };
    }

    const totalChangePct = ((end.value - start.value) / start.value) * 100;
    const velocity = totalChangePct / durationMin;

    // === ОСНОВНЫЕ ФИЛЬТРЫ ===
    const tags: string[] = [];
    let acceleration: number | undefined;

    // 1. Достигнут ли целевой процент?
    if (Math.abs(totalChangePct) < rule.percent) {
      return {
        pass: false,
        reason: `OI изменение ${totalChangePct.toFixed(2)}% < ${rule.percent}%`,
        velocity,
        oiStart: start.value,
        oiEnd: end.value,
        durationMin,
      };
    }

    // 2. Слишком короткий импульс — спайк
    if (durationMin < this.MIN_DURATION_MIN) {
      return {
        pass: false,
        reason: `Импульс слишком короткий: ${durationMin.toFixed(1)}мин (мин. ${this.MIN_DURATION_MIN}мин)`,
        velocity,
        oiStart: start.value,
        oiEnd: end.value,
        durationMin,
        tags: [this.SHORT_SPIKE],
      };
    }

    // 3. Слишком высокая скорость — шорт-сквиз
    if (Math.abs(velocity) > this.MAX_SAFE_VELOCITY) {
      return {
        pass: false,
        reason: `Шорт-сквиз! OI velocity ${velocity.toFixed(2)}%/мин (макс. ${this.MAX_SAFE_VELOCITY})`,
        velocity,
        oiStart: start.value,
        oiEnd: end.value,
        durationMin,
        tags: [this.SHORT_SQUEEZE],
      };
    }

    // 4. Проверка на лонг: нормальная скорость
    if (velocity < this.MIN_VELOCITY_LONG || velocity > this.MAX_VELOCITY_LONG) {
      return {
        pass: false,
        reason: `OI velocity ${velocity.toFixed(2)}%/мин вне диапазона [${this.MIN_VELOCITY_LONG}–${this.MAX_VELOCITY_LONG}]`,
        velocity,
        oiStart: start.value,
        oiEnd: end.value,
        durationMin,
      };
    }

    // 5. Расчёт ускорения (вторая производная)
    if (series.length >= 5 && durationMin > 4) {
      const midIdx = startIdx + Math.floor((series.length - startIdx) / 2);
      const mid = series[Math.max(midIdx, startIdx + 2)];

      const v1 = ((mid.value - start.value) / start.value) * 100 / ((mid.ts - start.ts) / 60000);
      const v2 = ((end.value - mid.value) / mid.value) * 100 / ((end.ts - mid.ts) / 60000);
      acceleration = v2 - v1;

      if (acceleration > this.ACCELERATION_THRESHOLD) {
        tags.push(this.ACCELERATING);
      }
      if (acceleration < -0.05) {
        tags.push(this.DECELERATING);
      }
    }

    // === УСПЕШНО! ===
    tags.push(this.STABLE_IMPULSE);
    if (velocity > 1.8) tags.push(this.STRONG_VELOCITY);

    return {
      pass: true,
      reason: `OI velocity: ↑ ${velocity.toFixed(2)}%/мин за ${durationMin.toFixed(1)}мин`,
      velocity,
      oiStart: start.value,
      oiEnd: end.value,
      durationMin,
      tags,
      acceleration,
    };
  }
}