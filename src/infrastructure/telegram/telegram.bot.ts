import TelegramBot from 'node-telegram-bot-api';
import { Injectable } from '../../shared/decorators';
import { Logger } from '../../shared/logger';
import { SignalDto, SignalQuality } from '../../application/dto/signal.dto';

@Injectable()
export class TelegramBotService {
  private bot: TelegramBot;
  private readonly logger = new Logger(TelegramBotService.name);

  constructor(token: string) {
    if (!token) {
      throw new Error('Telegram Bot Token is not provided!');
    }
    this.bot = new TelegramBot(token, { polling: true });
    this.setupErrorHandling();
  }

  public getBot(): TelegramBot {
    return this.bot;
  }

  public async sendMessage(chatId: number, message: string): Promise<void> {
    try {
      await this.bot.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true, // ← ДОБАВЛЯЕМ ЭТУ СТРОКУ
      });
    } catch (error) {
      this.logger.error(`Failed to send Telegram message to chat ${chatId}:`, error);
    }
  }

  /**
   * Принимает на вход полный SignalDto и отправляет отформатированное сообщение.
   */
  public async sendSignal(
    chatId: number,
    signal: SignalDto,
    triggerIntervalMinutes?: number,
  ): Promise<void> {
    const message = this.formatSignalMessage(signal, triggerIntervalMinutes);
    await this.sendMessage(chatId, message);
  }

  private formatSignalMessage(signal: SignalDto, triggerIntervalMinutes?: number): string {
    // Quality emoji mapping
    const qualityEmoji = {
      strong: '🟢',
      medium: '🟡',
      weak: '🔴',
    };

    // Format percentage with sign
    const formatPercent = (value: number): string => {
      const sign = value >= 0 ? '↗️' : '↘️';
      const absValue = Math.abs(value).toFixed(2);
      return `${sign} ${absValue}%`;
    };

    // Format delta
    const formatDelta = (value: number): string => {
      const absValue = Math.abs(value);
      if (absValue < 0.01) {
        return '0.00%';
      }
      return `${absValue.toFixed(2)}%`;
    };

    // Short time format (HH:MM)
    const timeStr = signal.timestamp.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    });

    // Format price with appropriate decimal places
    const priceStr = this.formatPrice(signal.currentPrice);

    // Format time interval display
    const intervalDisplay = triggerIntervalMinutes ? `${triggerIntervalMinutes}m` : '';

    // Build Binance futures link
    const binanceLink = `https://www.binance.com/ru/futures/${signal.symbol}`;

    // Build TradingView chart link
    const tradingViewLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${signal.symbol}`;

    // Build the message with clickable links
    return `
🔴 №${signal.signalNumber} - <a href="${binanceLink}">${signal.symbol}</a> - ${intervalDisplay}
<a href="${tradingViewLink}">OI: ${formatPercent(signal.oiGrowthPercent)}</a> | Price: ${formatPercent(signal.priceChangePercent)} | Δ: ${formatDelta(signal.deltaPercent)}
💵 $${priceStr} • ⏰ ${timeStr}
  `.trim();
  }

  /**
   * Smart price formatting based on value magnitude
   */
  private formatPrice(price: number): string {
    if (price >= 1000) {
      return price.toFixed(2); // $1,234.56
    } else if (price >= 1) {
      return price.toFixed(4); // $12.3456
    } else if (price >= 0.01) {
      return price.toFixed(4); // $0.1234
    } else {
      return price.toFixed(6); // $0.000123
    }
  }

  private setupErrorHandling(): void {
    this.bot.on('error', (error) => {
      this.logger.error('Telegram Bot error:', error);
    });

    this.bot.on('polling_error', (error) => {
      this.logger.error('Telegram Bot polling error:', error);
    });
  }

  public async stop(): Promise<void> {
    if (this.bot.isPolling()) {
      await this.bot.stopPolling();
    }
  }
}
