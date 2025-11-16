import { IsInt, IsNumber, IsPositive, Min, Max, IsIn } from 'class-validator';
import { Direction } from '../../domain/types/direction.type';

export class CreateTriggerDto {
  userId!: number;

  @IsIn(['up', 'down'])
  direction!: Direction;

  @IsNumber({}, { message: 'Процент изменения ОИ должен быть числом' })
  @IsPositive({ message: 'Процент изменения ОИ должен быть положительным' })
  @Min(0.1)
  @Max(100)
  oiChangePercent!: number;

  @IsInt({ message: 'Интервал должен быть целым числом' })
  @IsPositive({ message: 'Интервал должен быть положительным' })
  @Min(1)
  @Max(30)
  timeIntervalMinutes!: number;

  @IsInt({ message: 'Лимит уведомлений должен быть целым числом' })
  @IsPositive({ message: 'Лимит уведомлений должен быть положительным' })
  @Min(10)
  notificationLimitSeconds!: number;
}
