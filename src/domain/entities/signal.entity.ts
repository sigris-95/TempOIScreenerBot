import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('signals')
export class Signal {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'integer' })
  @Index()
  signalNumber!: number;

  @Column({ type: 'varchar' })
  symbol!: string;

  @Column({ name: 'price_change_percent', type: 'decimal', precision: 10, scale: 4 })
  priceChangePercent!: number;

  @Column({ type: 'decimal', precision: 10, scale: 4 })
  oiGrowthPercent!: number;

  @Column({ type: 'decimal', precision: 10, scale: 4 })
  deltaPercent!: number;

  @Column({ type: 'decimal', precision: 15, scale: 8 })
  currentPrice!: number;

  @CreateDateColumn()
  @Index()
  createdAt!: Date;
}
