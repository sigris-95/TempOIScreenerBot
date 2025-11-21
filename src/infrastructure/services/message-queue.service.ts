import { Injectable } from '../../shared/decorators';
import { Logger } from '../../shared/logger';
import { SignalDto } from '../../application/dto/signal.dto';

export enum MessagePriority {
  HIGH = 0,    // Сильные сигналы (>10% OI)
  NORMAL = 1,  // Обычные сигналы (5-10% OI)
  LOW = 2,     // Слабые сигналы (<5% OI)
}

export interface QueuedMessage {
  chatId: number;
  message: string;
  priority: MessagePriority;
  signal?: SignalDto;
  triggerIntervalMinutes?: number;
  timestamp: number;
  retryCount: number;
  id: string;
}

@Injectable()
export class MessageQueueService {
  private readonly logger = new Logger(MessageQueueService.name);
  
  // Priority queues (High, Normal, Low)
  private readonly queues: Map<MessagePriority, QueuedMessage[]> = new Map([
    [MessagePriority.HIGH, []],
    [MessagePriority.NORMAL, []],
    [MessagePriority.LOW, []],
  ]);

  // Rate limiting: per-chat tracking
  private readonly sentMessages = new Map<number, number[]>(); // chatId -> timestamps
  
  // Deduplication: prevent sending identical signals
  private readonly recentSignals = new Map<string, number>(); // key -> timestamp
  
  // Configuration
  private readonly MAX_MESSAGES_PER_SECOND = 28; // Telegram limit is 30, keep safe margin
  private readonly GLOBAL_MAX_PER_SECOND = 28;
  private readonly RATE_LIMIT_WINDOW_MS = 1000;
  private readonly DEDUP_WINDOW_MS = 5000; // 5 seconds dedup window
  private readonly MAX_QUEUE_SIZE = 1000;
  private readonly MAX_RETRY_COUNT = 3;
  private readonly PROCESSING_INTERVAL_MS = 50; // Process queue every 50ms
  
  // State
  private isRunning = false;
  private processingTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  
  // Stats
  private stats = {
    sent: 0,
    dropped: 0,
    deduplicated: 0,
    retried: 0,
  };

  constructor() {
    // Cleanup old tracking data every minute
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.processingTimer = setInterval(() => this.processQueue(), this.PROCESSING_INTERVAL_MS);
    this.logger.info('MessageQueueService started');
  }

  public stop(): void {
    this.isRunning = false;
    if (this.processingTimer) {
      clearInterval(this.processingTimer);
      this.processingTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.logger.info('MessageQueueService stopped');
  }

  /**
   * Enqueue a message with automatic priority calculation
   */
  public enqueue(
    chatId: number,
    message: string,
    signal?: SignalDto,
    triggerIntervalMinutes?: number,
  ): boolean {
    // Calculate priority based on signal strength
    const priority = this.calculatePriority(signal);
    
    // Deduplication check
    if (signal && this.isDuplicate(chatId, signal)) {
      this.stats.deduplicated++;
      this.logger.debug(`Deduplicated signal for ${signal.symbol} (${signal.oiChangePercent.toFixed(2)}%)`);
      return false;
    }

    const queuedMessage: QueuedMessage = {
      chatId,
      message,
      priority,
      signal,
      triggerIntervalMinutes,
      timestamp: Date.now(),
      retryCount: 0,
      id: this.generateMessageId(chatId, signal),
    };

    const queue = this.queues.get(priority)!;
    
    // Check queue size limit
    const totalQueueSize = this.getTotalQueueSize();
    if (totalQueueSize >= this.MAX_QUEUE_SIZE) {
      // Drop lowest priority messages to make space
      this.dropLowPriorityMessages();
    }

    queue.push(queuedMessage);
    
    // Track for deduplication
    if (signal) {
      const dedupKey = this.getDedupKey(chatId, signal);
      this.recentSignals.set(dedupKey, Date.now());
    }

    return true;
  }

  /**
   * Process queue: send messages respecting rate limits
   */
  private async processQueue(): Promise<void> {
    if (!this.isRunning) return;

    const now = Date.now();

    // Check global rate limit
    const globalSentCount = this.getGlobalSentCount(now);
    if (globalSentCount >= this.GLOBAL_MAX_PER_SECOND) {
      return; // Wait for next tick
    }

    // Process messages by priority (HIGH -> NORMAL -> LOW)
    for (const priority of [MessagePriority.HIGH, MessagePriority.NORMAL, MessagePriority.LOW]) {
      const queue = this.queues.get(priority)!;
      
      while (queue.length > 0 && this.canSendMessage(now)) {
        const msg = queue.shift()!;
        
        // Check per-chat rate limit
        if (!this.canSendToChat(msg.chatId, now)) {
          // Re-queue at the end if per-chat limit exceeded
          queue.push(msg);
          break;
        }

        // Try to send
        const success = await this.sendMessage(msg);
        
        if (success) {
          this.trackSentMessage(msg.chatId, now);
          this.stats.sent++;
        } else {
          // Retry logic
          if (msg.retryCount < this.MAX_RETRY_COUNT) {
            msg.retryCount++;
            queue.push(msg);
            this.stats.retried++;
          } else {
            this.stats.dropped++;
            this.logger.warn(`Dropped message after ${this.MAX_RETRY_COUNT} retries: ${msg.id}`);
          }
        }

        // Check global limit again
        const currentGlobalCount = this.getGlobalSentCount(now);
        if (currentGlobalCount >= this.GLOBAL_MAX_PER_SECOND) {
          return; // Stop processing this tick
        }
      }
    }
  }

  /**
   * Send message callback (to be set by TelegramBotService)
   */
  private sendMessageCallback: ((chatId: number, message: string) => Promise<boolean>) | null = null;

  public setSendCallback(callback: (chatId: number, message: string) => Promise<boolean>): void {
    this.sendMessageCallback = callback;
  }

  private async sendMessage(msg: QueuedMessage): Promise<boolean> {
    if (!this.sendMessageCallback) {
      this.logger.error('Send callback not set!');
      return false;
    }

    try {
      return await this.sendMessageCallback(msg.chatId, msg.message);
    } catch (error) {
      this.logger.error(`Failed to send message ${msg.id}:`, error);
      return false;
    }
  }

  /**
   * Calculate message priority based on signal strength
   */
  private calculatePriority(signal?: SignalDto): MessagePriority {
    if (!signal) return MessagePriority.NORMAL;

    const oiChange = Math.abs(signal.oiChangePercent || 0);
    
    if (oiChange >= 10) return MessagePriority.HIGH;
    if (oiChange >= 5) return MessagePriority.NORMAL;
    return MessagePriority.LOW;
  }

  /**
   * Check if signal is duplicate
   */
  private isDuplicate(chatId: number, signal: SignalDto): boolean {
    const key = this.getDedupKey(chatId, signal);
    const lastSent = this.recentSignals.get(key);
    
    if (!lastSent) return false;
    
    const now = Date.now();
    return (now - lastSent) < this.DEDUP_WINDOW_MS;
  }

  private getDedupKey(chatId: number, signal: SignalDto): string {
    // Key includes chatId, symbol, and rounded OI change
    const roundedOI = Math.round(signal.oiChangePercent * 10) / 10; // Round to 0.1%
    return `${chatId}:${signal.symbol}:${roundedOI}`;
  }

  private generateMessageId(chatId: number, signal?: SignalDto): string {
    const timestamp = Date.now();
    const symbol = signal?.symbol || 'msg';
    return `${chatId}:${symbol}:${timestamp}`;
  }

  /**
   * Rate limiting checks
   */
  private canSendMessage(now: number): boolean {
    const globalCount = this.getGlobalSentCount(now);
    return globalCount < this.GLOBAL_MAX_PER_SECOND;
  }

  private canSendToChat(chatId: number, now: number): boolean {
    const timestamps = this.sentMessages.get(chatId) || [];
    const recentCount = timestamps.filter(ts => (now - ts) < this.RATE_LIMIT_WINDOW_MS).length;
    return recentCount < this.MAX_MESSAGES_PER_SECOND;
  }

  private getGlobalSentCount(now: number): number {
    let count = 0;
    for (const timestamps of this.sentMessages.values()) {
      count += timestamps.filter(ts => (now - ts) < this.RATE_LIMIT_WINDOW_MS).length;
    }
    return count;
  }

  private trackSentMessage(chatId: number, timestamp: number): void {
    const timestamps = this.sentMessages.get(chatId) || [];
    timestamps.push(timestamp);
    this.sentMessages.set(chatId, timestamps);
  }

  /**
   * Queue management
   */
  private getTotalQueueSize(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }

  private dropLowPriorityMessages(): void {
    // Drop from LOW priority first, then NORMAL
    const lowQueue = this.queues.get(MessagePriority.LOW)!;
    if (lowQueue.length > 0) {
      lowQueue.shift();
      this.stats.dropped++;
      return;
    }

    const normalQueue = this.queues.get(MessagePriority.NORMAL)!;
    if (normalQueue.length > 0) {
      normalQueue.shift();
      this.stats.dropped++;
    }
  }

  /**
   * Cleanup old tracking data
   */
  private cleanup(): void {
    const now = Date.now();
    
    // Cleanup sent message tracking
    for (const [chatId, timestamps] of this.sentMessages.entries()) {
      const recent = timestamps.filter(ts => (now - ts) < this.RATE_LIMIT_WINDOW_MS * 2);
      if (recent.length === 0) {
        this.sentMessages.delete(chatId);
      } else {
        this.sentMessages.set(chatId, recent);
      }
    }

    // Cleanup deduplication tracking
    for (const [key, timestamp] of this.recentSignals.entries()) {
      if (now - timestamp > this.DEDUP_WINDOW_MS * 2) {
        this.recentSignals.delete(key);
      }
    }

    this.logger.debug(
      `🧹 Cleanup: ${this.sentMessages.size} chats tracked, ${this.recentSignals.size} recent signals`,
    );
  }

  /**
   * Get queue statistics
   */
  public getStats(): {
    queueSizes: Record<string, number>;
    sent: number;
    dropped: number;
    deduplicated: number;
    retried: number;
    trackedChats: number;
  } {
    return {
      queueSizes: {
        high: this.queues.get(MessagePriority.HIGH)!.length,
        normal: this.queues.get(MessagePriority.NORMAL)!.length,
        low: this.queues.get(MessagePriority.LOW)!.length,
      },
      sent: this.stats.sent,
      dropped: this.stats.dropped,
      deduplicated: this.stats.deduplicated,
      retried: this.stats.retried,
      trackedChats: this.sentMessages.size,
    };
  }

  public getQueueSize(): number {
    return this.getTotalQueueSize();
  }
}

