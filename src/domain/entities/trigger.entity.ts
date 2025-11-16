import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { Direction } from '../types/direction.type';

@Entity('triggers')
export class Trigger {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column({ name: 'user_id', type: 'integer' })
  userId!: number;

  @Column({ type: 'text' })
  direction!: Direction;

  @Column({ name: 'oi_change_percent', type: 'real' })
  oiChangePercent!: number;

  @Column({ name: 'time_interval_minutes', type: 'integer' })
  timeIntervalMinutes!: number;

  @Column({ name: 'notification_limit_seconds', type: 'integer' })
  notificationLimitSeconds!: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;
}
