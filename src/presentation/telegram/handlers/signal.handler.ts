import { Inject, Injectable } from '../../../shared/decorators';
import { TelegramBotService } from '../../../infrastructure/telegram/telegram.bot';
import { SignalDto } from '../../../application/dto/signal.dto';
import { ISignalRepository } from '../../../domain/interfaces/repositories.interface';
import { Signal } from '../../../domain/entities/signal.entity';
import { Logger } from '../../../shared/logger';

@Injectable()
export class SignalHandler {
  private readonly logger = new Logger(SignalHandler.name);

  constructor(
    private readonly telegramBotService: TelegramBotService,
    @Inject('ISignalRepository')
    private readonly signalRepository: ISignalRepository,
  ) {}

  async handleSignal(signalDto: SignalDto, userIds: number[], triggerIntervalMinutes?: number): Promise<void> {
    try {
      // ✅ CORRECT: Query per-symbol count for each user
      for (const userId of userIds) {
        // Get the signal count for THIS SPECIFIC SYMBOL in last 24 hours
        const signalCount = await this.signalRepository.getLast24HoursSignalCountBySymbol(
          userId,
          signalDto.symbol,
        );

        // Create signal entity with correct per-symbol number
        const signal = new Signal();
        signal.signalNumber = signalCount + 1;
        signal.symbol = signalDto.symbol;
        signal.priceChangePercent = signalDto.priceChangePercent;
        signal.oiGrowthPercent = signalDto.oiGrowthPercent;
        signal.deltaPercent = signalDto.deltaPercent;
        signal.currentPrice = signalDto.currentPrice;

        // Save to database
        await this.signalRepository.save(signal);

        // Send to Telegram with correct number
        await this.telegramBotService.sendSignal(
          userId, 
          {
            ...signalDto,
            signalNumber: signalCount + 1,
            timestamp: new Date(),
          },
          triggerIntervalMinutes  // ← ADD THIS LINE
        );
      }

      this.logger.info(`Signal sent for ${signalDto.symbol}`);
    } catch (error) {
      this.logger.error('Error handling signal:', error);
    }
  }
}
