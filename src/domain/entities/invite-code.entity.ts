import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('invite_codes')
export class InviteCode {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'integer' })
  @Index()
  code!: number;

  @Column({ type: 'boolean' })
  @Index()
  activated!: number;

  @CreateDateColumn()
  @Index()
  createdAt!: Date;
}
