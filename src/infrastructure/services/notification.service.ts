import { Inject, Injectable } from '../../shared/decorators';
import { INotificationService, IMetricChanges } from '../../domain/interfaces/services.interface';
import { ISignalRepository } from '../../domain/interfaces/repositories.interface';
import { Trigger } from '../../domain/entities/trigger.entity';
import { SignalDto, SignalQuality } from '../../application/dto/signal.dto';
import { SignalHandler } from '../../presentation/telegram/handlers/signal.handler';
import { Logger } from '../../shared/logger';

@Injectable()
export class NotificationService implements INotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly notificationCooldowns = new Map<string, number>();

  constructor(
    private readonly signalHandler: SignalHandler,
    @Inject('ISignalRepository')
    private readonly signalRepository: ISignalRepository,
  ) {}

  public async processTrigger(
    trigger: Trigger,
    symbol: string,
    metrics: IMetricChanges,
  ): Promise<void> {
    const cooldownKey = `${trigger.userId}-${symbol}`;
    const lastNotification = this.notificationCooldowns.get(cooldownKey);
    const now = Date.now();

    if (lastNotification && now - lastNotification < trigger.notificationLimitSeconds * 1000) {
      return;
    }

    this.logger.info(
      `Trigger #${trigger.id} fired for user ${trigger.userId} on symbol ${symbol}. OI change: ${metrics.oiChangePercent.toFixed(2)}%`,
    );

    this.notificationCooldowns.set(cooldownKey, now);

    const deltaPercent = metrics.oiChangePercent - metrics.priceChangePercent;

    // Quality scoring
    const absoluteStrength = Math.min(Math.abs(metrics.oiChangePercent) / 10, 1.0);
    const alignment =
      1 - Math.min(Math.abs(deltaPercent) / (Math.abs(metrics.oiChangePercent) + 0.1), 1);
    const deltaStrength =
      deltaPercent > 0 ? Math.min(deltaPercent / 5, 1.0) : Math.max(1 + deltaPercent / 10, 0.3);

    const qualityScore = Math.min(
      1,
      0.6 * absoluteStrength + 0.3 * alignment + 0.1 * deltaStrength,
    );

    let quality: SignalQuality;
    if (qualityScore > 0.7) quality = 'strong';
    else if (qualityScore > 0.4) quality = 'medium';
    else quality = 'weak';

    // FIXED: Don't query for signal count here - SignalHandler will do it
    // This was causing double database queries!

    // Use price from metrics (same calculation that triggered the alert)
    const currentPrice = metrics.currentPrice > 0 ? metrics.currentPrice : 0;

    if (currentPrice === 0) {
      this.logger.error(
        `🚨 ZERO PRICE BUG DETECTED! Symbol: ${symbol}, ` +
          `OI Change: ${metrics.oiChangePercent.toFixed(2)}%, ` +
          `Price Change: ${metrics.priceChangePercent.toFixed(2)}%, ` +
          `CurrentOI: ${metrics.currentOI}, ` +
          `Trigger: #${trigger.id}`,
      );
      return;
    }

    // FIXED: Pass 0 as signal number - SignalHandler will set the correct one
    const signalDto = new SignalDto(
      0, // Placeholder - SignalHandler will query and set correct number
      symbol,
      metrics.priceChangePercent,
      metrics.oiChangePercent,
      deltaPercent,
      currentPrice,
      new Date(),
      quality,
      trigger.timeIntervalMinutes,
    );

    await this.signalHandler.handleSignal(signalDto, [trigger.userId], trigger.timeIntervalMinutes);
  }
}
