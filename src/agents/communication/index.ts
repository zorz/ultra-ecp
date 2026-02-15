/**
 * Agent Communication System
 *
 * Primitives for inter-agent communication within workflows.
 * These can be used as workflow nodes or directly by agents.
 */

import type { AgentMessage } from '../roles/base.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Message Bus Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Message delivery status.
 */
export type DeliveryStatus = 'pending' | 'delivered' | 'read' | 'failed';

/**
 * Envelope wrapping a message with delivery metadata.
 */
export interface MessageEnvelope {
  /** Unique envelope ID */
  id: string;
  /** The message */
  message: AgentMessage;
  /** Delivery status */
  status: DeliveryStatus;
  /** When queued */
  queuedAt: Date;
  /** When delivered (if applicable) */
  deliveredAt?: Date;
  /** Retry count */
  retries: number;
  /** Priority (higher = more urgent) */
  priority: number;
}

/**
 * Handler for incoming messages.
 */
export type MessageHandler = (message: AgentMessage) => Promise<void>;

// ─────────────────────────────────────────────────────────────────────────────
// Message Bus Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Message bus for agent-to-agent communication.
 */
export interface MessageBus {
  /** Send a message to a specific agent */
  send(message: AgentMessage): Promise<string>;

  /** Broadcast a message to all agents in a workflow */
  broadcast(
    workflowId: string,
    message: Omit<AgentMessage, 'to'>
  ): Promise<string[]>;

  /** Subscribe to messages for an agent */
  subscribe(agentId: string, handler: MessageHandler): () => void;

  /** Get pending messages for an agent */
  getPending(agentId: string): Promise<AgentMessage[]>;

  /** Acknowledge message receipt */
  acknowledge(messageId: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared Memory Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entry in shared memory with metadata.
 */
export interface SharedMemoryEntry {
  /** Key */
  key: string;
  /** Value (JSON-serializable) */
  value: unknown;
  /** Who wrote it */
  writtenBy: string;
  /** When written */
  writtenAt: Date;
  /** Version for optimistic locking */
  version: number;
  /** TTL in ms (optional) */
  ttl?: number;
}

/**
 * Change event for shared memory.
 */
export interface MemoryChangeEvent {
  type: 'set' | 'delete' | 'expire';
  key: string;
  oldValue?: unknown;
  newValue?: unknown;
  changedBy: string;
}

/**
 * Handler for memory changes.
 */
export type MemoryChangeHandler = (event: MemoryChangeEvent) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Shared Memory Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shared memory for agents within a workflow.
 */
export interface SharedMemory {
  /** Get a value */
  get<T = unknown>(key: string): Promise<T | undefined>;

  /** Get a value with metadata */
  getEntry(key: string): Promise<SharedMemoryEntry | undefined>;

  /** Set a value */
  set(key: string, value: unknown, agentId: string, ttl?: number): Promise<void>;

  /** Delete a value */
  delete(key: string, agentId: string): Promise<boolean>;

  /** Check if key exists */
  has(key: string): Promise<boolean>;

  /** List all keys */
  keys(): Promise<string[]>;

  /** Get all entries */
  entries(): Promise<SharedMemoryEntry[]>;

  /** Subscribe to changes */
  onChange(handler: MemoryChangeHandler): () => void;

  /** Compare-and-swap for safe concurrent updates */
  compareAndSwap(
    key: string,
    expectedVersion: number,
    newValue: unknown,
    agentId: string
  ): Promise<boolean>;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-Memory Implementations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simple in-memory message bus implementation.
 */
export class InMemoryMessageBus implements MessageBus {
  private queues = new Map<string, MessageEnvelope[]>();
  private handlers = new Map<string, MessageHandler[]>();
  private messageCounter = 0;

  async send(message: AgentMessage): Promise<string> {
    const id = `msg_${++this.messageCounter}`;
    const envelope: MessageEnvelope = {
      id,
      message,
      status: 'pending',
      queuedAt: new Date(),
      retries: 0,
      priority: 0,
    };

    // Add to recipient queue
    const queue = this.queues.get(message.to) ?? [];
    queue.push(envelope);
    this.queues.set(message.to, queue);

    // Notify handlers
    const handlers = this.handlers.get(message.to) ?? [];
    for (const handler of handlers) {
      try {
        await handler(message);
        envelope.status = 'delivered';
        envelope.deliveredAt = new Date();
      } catch {
        envelope.status = 'failed';
        envelope.retries++;
      }
    }

    return id;
  }

  async broadcast(
    _workflowId: string,
    message: Omit<AgentMessage, 'to'>
  ): Promise<string[]> {
    const ids: string[] = [];
    // In a real implementation, we'd look up agents in the workflow by _workflowId
    // For now, broadcast to all subscribed agents
    for (const agentId of this.handlers.keys()) {
      const fullMessage: AgentMessage = {
        ...message,
        to: agentId,
      };
      const id = await this.send(fullMessage);
      ids.push(id);
    }
    return ids;
  }

  subscribe(agentId: string, handler: MessageHandler): () => void {
    const handlers = this.handlers.get(agentId) ?? [];
    handlers.push(handler);
    this.handlers.set(agentId, handlers);

    return () => {
      const current = this.handlers.get(agentId) ?? [];
      this.handlers.set(
        agentId,
        current.filter((h) => h !== handler)
      );
    };
  }

  async getPending(agentId: string): Promise<AgentMessage[]> {
    const queue = this.queues.get(agentId) ?? [];
    return queue
      .filter((e) => e.status === 'pending')
      .map((e) => e.message);
  }

  async acknowledge(messageId: string): Promise<void> {
    for (const queue of this.queues.values()) {
      const envelope = queue.find((e) => e.id === messageId);
      if (envelope) {
        envelope.status = 'read';
        break;
      }
    }
  }
}

/**
 * Simple in-memory shared memory implementation.
 */
export class InMemorySharedMemory implements SharedMemory {
  private storage = new Map<string, SharedMemoryEntry>();
  private changeHandlers: MemoryChangeHandler[] = [];

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const entry = this.storage.get(key);
    if (!entry) return undefined;

    // Check TTL
    if (entry.ttl) {
      const elapsed = Date.now() - entry.writtenAt.getTime();
      if (elapsed > entry.ttl) {
        await this.delete(key, 'system');
        return undefined;
      }
    }

    return entry.value as T;
  }

  async getEntry(key: string): Promise<SharedMemoryEntry | undefined> {
    return this.storage.get(key);
  }

  async set(
    key: string,
    value: unknown,
    agentId: string,
    ttl?: number
  ): Promise<void> {
    const existing = this.storage.get(key);
    const entry: SharedMemoryEntry = {
      key,
      value,
      writtenBy: agentId,
      writtenAt: new Date(),
      version: (existing?.version ?? 0) + 1,
      ttl,
    };

    this.storage.set(key, entry);
    this.notifyChange({
      type: 'set',
      key,
      oldValue: existing?.value,
      newValue: value,
      changedBy: agentId,
    });
  }

  async delete(key: string, agentId: string): Promise<boolean> {
    const existing = this.storage.get(key);
    if (!existing) return false;

    this.storage.delete(key);
    this.notifyChange({
      type: 'delete',
      key,
      oldValue: existing.value,
      changedBy: agentId,
    });

    return true;
  }

  async has(key: string): Promise<boolean> {
    return this.storage.has(key);
  }

  async keys(): Promise<string[]> {
    return Array.from(this.storage.keys());
  }

  async entries(): Promise<SharedMemoryEntry[]> {
    return Array.from(this.storage.values());
  }

  onChange(handler: MemoryChangeHandler): () => void {
    this.changeHandlers.push(handler);
    return () => {
      this.changeHandlers = this.changeHandlers.filter((h) => h !== handler);
    };
  }

  async compareAndSwap(
    key: string,
    expectedVersion: number,
    newValue: unknown,
    agentId: string
  ): Promise<boolean> {
    const existing = this.storage.get(key);
    const currentVersion = existing?.version ?? 0;

    if (currentVersion !== expectedVersion) {
      return false;
    }

    await this.set(key, newValue, agentId);
    return true;
  }

  private notifyChange(event: MemoryChangeEvent): void {
    for (const handler of this.changeHandlers) {
      try {
        handler(event);
      } catch {
        // Ignore handler errors
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Communication Context Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a communication context for a workflow execution.
 */
export interface CommunicationContext {
  messageBus: MessageBus;
  sharedMemory: SharedMemory;
}

/**
 * Create an in-memory communication context.
 */
export function createCommunicationContext(): CommunicationContext {
  return {
    messageBus: new InMemoryMessageBus(),
    sharedMemory: new InMemorySharedMemory(),
  };
}
