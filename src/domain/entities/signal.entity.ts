import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('signals')
export class Signal {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'integer' })
  @Index()
  signalNumber!: number;

  @Column({ name: 'trigger_id', type: 'integer' })
  @Index()
  triggerId!: number;

  @Column({ type: 'varchar' })
  symbol!: string;

  // Primary metric: OI
  @Column({ name: 'oi_change_percent', type: 'decimal', precision: 10, scale: 6, default: 0 })
  oiChangePercent!: number;

  // Secondary: Price change kept for context
  @Column({ name: 'price_change_percent', type: 'decimal', precision: 10, scale: 6, nullable: true })
  priceChangePercent!: number | null;

  @Column({ type: 'decimal', precision: 15, scale: 8, nullable: true })
  currentPrice!: number | null;

  @CreateDateColumn()
  @Index()
  createdAt!: Date;
}
