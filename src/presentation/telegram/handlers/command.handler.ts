import TelegramBot from 'node-telegram-bot-api';
import { Inject, Injectable } from '../../../shared/decorators';
import { TelegramBotService } from '../../../infrastructure/telegram/telegram.bot';
import { CreateTriggerUseCase } from '../../../application/use-cases/create-trigger.use-case';
import { GetTriggersUseCase } from '../../../application/use-cases/get-triggers.use-case';
import { RemoveTriggerUseCase } from '../../../application/use-cases/remove-trigger.use-case';
import { CreateTriggerDto } from '../../../application/dto/create-trigger.dto';
import { validate } from 'class-validator';
import { Logger } from '../../../shared/logger';
import { Direction } from '../../../domain/types/direction.type';
import { Trigger } from '../../../domain/entities/trigger.entity';

@Injectable()
export class CommandHandler {
  private readonly logger = new Logger(CommandHandler.name);
  private bot: TelegramBot;

  constructor(
    private readonly telegramBotService: TelegramBotService,
    private readonly createTriggerUseCase: CreateTriggerUseCase,
    private readonly getTriggersUseCase: GetTriggersUseCase,
    private readonly removeTriggerUseCase: RemoveTriggerUseCase,
  ) {
    this.bot = this.telegramBotService.getBot();
  }

  public initialize(): void {
    this.bot.onText(/\/start/, this.handleStart.bind(this));
    this.bot.onText(/\/add/, this.handleAddTrigger.bind(this));
    this.bot.onText(/\/my_triggers/, this.handleMyTriggers.bind(this));
    this.bot.on('callback_query', this.handleCallbackQuery.bind(this));
    this.logger.info('Telegram command handlers initialized.');
  }

  private async handleStart(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const welcomeMessage = `
👋 <b>Добро пожаловать в Pump Scout Bot!</b>

Я слежу за аномальными изменениями <b>Открытого Интереса (ОИ)</b> по всем USDT парам.

<b>Как создать триггер:</b>
Отправьте команду в формате:
<code>/add [up/down] [ОИ %] [интервал мин] [кулдаун сек]</code>

<b>Пример:</b>
<code>/add up 10 15 60</code>
(Уведомить, если <b>ОИ</b> вырастет на <b>10%</b> за <b>15 минут</b>. Кулдаун уведомлений <b>60 секунд</b>)

В уведомлении также будет указано изменение цены за этот же период.

<b>Доступные команды:</b>
/add - Создать новый триггер
/my_triggers - Ваши активные триггеры
    `.trim();
    await this.telegramBotService.sendMessage(chatId, welcomeMessage);
  }

  private async handleAddTrigger(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !msg.text) return;

    const parts = msg.text.trim().split(/\s+/);
    if (parts.length !== 5) {
      // <-- Теперь ожидаем 5 частей
      await this.telegramBotService.sendMessage(
        chatId,
        '❌ Неверный формат. Пример: <code>/add up 10 15 60</code>',
      );
      return;
    }

    const [, direction, oiPercent, interval, limit] = parts;
    const dto = new CreateTriggerDto();
    dto.userId = userId;
    dto.direction = direction as Direction;
    dto.oiChangePercent = parseFloat(oiPercent);
    dto.timeIntervalMinutes = parseInt(interval, 10);
    dto.notificationLimitSeconds = parseInt(limit, 10);

    const errors = await validate(dto);
    if (errors.length > 0) {
      const errorMessage = errors
        .map((e) => Object.values(e.constraints || {}).join(', '))
        .join('; ');
      await this.telegramBotService.sendMessage(chatId, `❌ Ошибка валидации: ${errorMessage}`);
      return;
    }

    try {
      await this.createTriggerUseCase.execute(dto);
      await this.telegramBotService.sendMessage(
        chatId,
        '✅ Триггер на изменение ОИ успешно создан!',
      );
    } catch (error) {
      this.logger.error('Failed to create trigger:', error);
      await this.telegramBotService.sendMessage(
        chatId,
        '❗️ Произошла ошибка при создании триггера.',
      );
    }
  }

  private async handleMyTriggers(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (!userId) return;

    const triggers = await this.getTriggersUseCase.execute(userId);

    if (triggers.length === 0) {
      await this.telegramBotService.sendMessage(chatId, 'У вас пока нет активных триггеров.');
      return;
    }

    const message =
      '<b>Ваши активные триггеры:</b>\n\n' + triggers.map(this.formatTrigger).join('\n');
    const options: TelegramBot.SendMessageOptions = {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: triggers.map((trigger) => [
          {
            text: `❌ Удалить триггер #${trigger.id}`,
            callback_data: `delete_trigger_${trigger.id}`,
          },
        ]),
      },
    };

    await this.bot.sendMessage(chatId, message, options);
  }

  private formatTrigger(trigger: Trigger): string {
    const directionEmoji = trigger.direction === 'up' ? '📈' : '📉';
    return `${directionEmoji} #${trigger.id}: ОИ на <b>${trigger.oiChangePercent}%</b> за <b>${trigger.timeIntervalMinutes} мин.</b> (кулдаун ${trigger.notificationLimitSeconds} сек)`;
  }

  private async handleCallbackQuery(query: TelegramBot.CallbackQuery): Promise<void> {
    if (!query.data || !query.message) return;

    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const [action, entity, id] = query.data.split('_');

    if (action === 'delete' && entity === 'trigger') {
      try {
        const triggerId = parseInt(id, 10);
        const success = await this.removeTriggerUseCase.execute(triggerId, userId);

        if (success) {
          await this.bot.answerCallbackQuery(query.id, { text: 'Триггер удален!' });
          // Редактируем сообщение, чтобы убрать кнопку
          await this.bot.editMessageText('Триггер был успешно удален.', {
            chat_id: chatId,
            message_id: query.message.message_id,
          });
        } else {
          await this.bot.answerCallbackQuery(query.id, { text: 'Не удалось найти триггер.' });
        }
      } catch (error) {
        this.logger.error('Failed to delete trigger:', error);
        await this.bot.answerCallbackQuery(query.id, { text: 'Ошибка при удалении.' });
      }
    }
  }
}
