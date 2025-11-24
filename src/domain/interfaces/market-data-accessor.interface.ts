export interface OIPoint {
  ts: number;      // timestamp в ms
  value: number;   // OI значение
}

export interface MarketDataAccessor {
  /** Получить последние N минут закрывающих значений OI (1m resolution) */
  getOISeries(symbol: string, minutes: number): OIPoint[];

  /** Опционально: получить цены (для комбо-фильтров) */
  getPriceSeries?(symbol: string, minutes: number): { ts: number; value: number }[];

  /** Текущее значение OI (быстрый доступ) */
  getCurrentOI(symbol: string): number | undefined;

  /** Текущее значение цены */
  getCurrentPrice(symbol: string): number | undefined;
}