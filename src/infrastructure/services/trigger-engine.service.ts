// src/infrastructure/services/trigger-engine.service.ts

import { Inject, Injectable } from '../../shared/decorators';
import {
  IDataAggregatorService,
  ITriggerEngineService,
  INotificationService,
} from '../../domain/interfaces/services.interface';
import { ITriggerRepository } from '../../domain/interfaces/repositories.interface';
import { Trigger } from '../../domain/entities/trigger.entity';
import { Logger } from '../../shared/logger';

const TICK_INTERVAL_MS = 15 * 1000;
const BATCH_PROCESSING_SIZE = 10;

@Injectable()
export class TriggerEngineService implements ITriggerEngineService {
  private readonly logger = new Logger(TriggerEngineService.name);
  private interval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private processedSymbols = new Set<string>();
  private symbolRotationIndex = 0;

  constructor(
    @Inject('ITriggerRepository') private readonly triggerRepository: ITriggerRepository,
    @Inject('IDataAggregatorService') private readonly dataAggregator: IDataAggregatorService,
    @Inject('INotificationService') private readonly notificationService: INotificationService,
  ) {}

  public start(): void {
    if (this.isRunning) {
      this.logger.warn('Trigger engine is already running');
      return;
    }

    this.isRunning = true;
    this.interval = setInterval(() => {
      this.processTick().catch(error => {
        this.logger.error('Error in trigger engine tick:', error);
      });
    }, TICK_INTERVAL_MS);

    this.logger.info('Trigger engine started');
  }

  public stop(): void {
    this.isRunning = false;
    
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    this.processedSymbols.clear();
    this.symbolRotationIndex = 0;
    
    this.logger.info('Trigger engine stopped');
  }

  private async processTick(): Promise<void> {
    try {
      const activeTriggers = this.triggerRepository.getAllActive();
      if (activeTriggers.length === 0) {
        return;
      }

      const allSymbols = this.dataAggregator.getAllKnownSymbols();
      if (allSymbols.length === 0) {
        return;
      }

      const symbolsToProcess = this.getSymbolsBatch(allSymbols);
      
      this.logger.debug(`Processing ${symbolsToProcess.length} symbols, ${activeTriggers.length} active triggers`);

      for (const symbol of symbolsToProcess) {
        await this.processSymbol(symbol, activeTriggers);
      }

    } catch (error) {
      this.logger.error('Error processing trigger engine tick:', error);
    }
  }

  private getSymbolsBatch(allSymbols: string[]): string[] {
    const startIndex = this.symbolRotationIndex;
    const endIndex = Math.min(startIndex + BATCH_PROCESSING_SIZE, allSymbols.length);
    
    const batch = allSymbols.slice(startIndex, endIndex);
    
    this.symbolRotationIndex = endIndex >= allSymbols.length ? 0 : endIndex;
    
    return batch;
  }

  private async processSymbol(symbol: string, activeTriggers: Trigger[]): Promise<void> {
    try {
      const historyLength = this.dataAggregator.getHistoryLength(symbol);
      if (historyLength < 2) {
        return;
      }

      const relevantTriggers = this.getRelevantTriggersForSymbol(symbol, activeTriggers);
      
      if (relevantTriggers.length === 0) {
        return;
      }

      for (const trigger of relevantTriggers) {
        await this.processTriggerForSymbol(trigger, symbol);
      }

    } catch (error) {
      this.logger.error(`Error processing symbol ${symbol}:`, error);
    }
  }

  private getRelevantTriggersForSymbol(symbol: string, triggers: Trigger[]): Trigger[] {
    return triggers;
  }

  private async processTriggerForSymbol(trigger: Trigger, symbol: string): Promise<void> {
    try {
      const metrics = this.dataAggregator.getMetricChanges(symbol, trigger.timeIntervalMinutes);
      
      if (!metrics) {
        return;
      }

      if (this.shouldTriggerFire(trigger, metrics)) {
        await this.notificationService.processTrigger(trigger, symbol, metrics);
      }

    } catch (error) {
      this.logger.error(`Error processing trigger ${trigger.id} for ${symbol}:`, error);
    }
  }

  private shouldTriggerFire(trigger: Trigger, metrics: { priceChangePercent: number; oiChangePercent: number }): boolean {
    const { direction, oiChangePercent: triggerThreshold } = trigger;
    const { oiChangePercent: actualOIChange } = metrics;

    if (direction === 'up') {
      return actualOIChange >= triggerThreshold;
    } else if (direction === 'down') {
      return actualOIChange <= -triggerThreshold;
    }

    return false;
  }

  public async forceCheckSymbol(symbol: string): Promise<void> {
    const activeTriggers = this.triggerRepository.getAllActive();
    await this.processSymbol(symbol, activeTriggers);
  }

  public getEngineStats(): { isRunning: boolean; processedSymbolsCount: number } {
    return {
      isRunning: this.isRunning,
      processedSymbolsCount: this.processedSymbols.size
    };
  }
}