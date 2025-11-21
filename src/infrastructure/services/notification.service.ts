import { Inject, Injectable } from '../../shared/decorators';
import { INotificationService, IMetricChanges } from '../../domain/interfaces/services.interface';
import { ISignalRepository } from '../../domain/interfaces/repositories.interface';
import { Trigger } from '../../domain/entities/trigger.entity';
import { SignalDto } from '../../application/dto/signal.dto';
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
  ) {
    // Cleanup old cooldowns every 10 minutes
    setInterval(() => this.cleanupCooldowns(), 10 * 60 * 1000);
  }

  public async processTrigger(
    trigger: Trigger,
    symbol: string,
    metrics: IMetricChanges,
  ): Promise<void> {
    const cooldownKey = `${trigger.userId}-${symbol}`;
    const lastNotification = this.notificationCooldowns.get(cooldownKey);
    const now = Date.now();

    // Простой кулдаун без увеличения - как настроил пользователь
    const cooldownMs = trigger.notificationLimitSeconds * 1000;

    if (lastNotification && now - lastNotification < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - (now - lastNotification)) / 1000);
      this.logger.debug(
        `⏰ Cooldown active for ${symbol} (${remaining}s remaining)`,
      );
      return;
    }

    // Log primary metric (OI)
    this.logger.info(
      `Trigger #${trigger.id} fired for ${symbol}. OI change: ${metrics.oiChangePercent.toFixed(2)}%`,
    );

    this.notificationCooldowns.set(cooldownKey, now);

    this.logger.debug(
      `📤 Preparing signal for user ${trigger.userId}: ${symbol} OI:${metrics.oiChangePercent.toFixed(2)}%`,
    );

    // Build SignalDto (OI primary, price secondary)
    const signalDto = new SignalDto(
      0,
      symbol,
      metrics.oiChangePercent,
      metrics.oiStart,
      metrics.oiEnd,
      metrics.totalVolume,
      metrics.deltaVolume,
      metrics.totalQuoteVolume,
      metrics.deltaQuoteVolume,
      metrics.volumeBaseline,
      metrics.volumeBaselineQuote,
      metrics.volumeRatio ?? null,
      metrics.volumeRatioQuote ?? null,
      metrics.priceChangePercent ?? 0,
      metrics.currentPrice ?? 0,
      metrics.previousPrice ?? 0,
      new Date(),
      trigger.timeIntervalMinutes,
    );

    await this.signalHandler.handleSignal(
      signalDto,
      trigger.id,
      trigger.userId,
      trigger.timeIntervalMinutes,
    );
  }

  // Cleanup old cooldowns to prevent memory leak
  private cleanupCooldowns(): void {
    const now = Date.now();
    const staleThreshold = 60 * 60 * 1000; // 1 hour

    let cleaned = 0;
    for (const [key, lastNotification] of this.notificationCooldowns.entries()) {
      if (now - lastNotification > staleThreshold) {
        this.notificationCooldowns.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug(
        `🧹 Cleaned ${cleaned} stale cooldowns. Active: ${this.notificationCooldowns.size}`,
      );
    }
  }
}
