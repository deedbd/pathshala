import { randomUUID } from 'node:crypto';
import type { Db } from '@pathshala/db';
import { nowSql, ulid } from '@pathshala/db';
import type { EventEnvelope, EventPayloads, EventType } from '@pathshala/events';
import { currentContext } from '../context.js';

export interface EmitInput<T extends EventType = EventType> {
  type: T;
  schoolId: string;
  aggregateType: string;
  aggregateId: string;
  payload: EventPayloads[T];
  actorUserId?: string | null;
  version?: number;
}

/**
 * Transactional outbox: `emit()` writes the event in the caller's transaction so a domain change and
 * its event are committed (or rolled back) together. The relay publishes rows with published_at IS NULL.
 */
export class OutboxService {
  constructor(private db: Db, private onEmitted?: () => void) {}

  async emit<T extends EventType>(tx: Db, e: EmitInput<T>): Promise<EventEnvelope<T>> {
    const uid = randomUUID();
    const occurredAt = nowSql();
    await tx.insert('outbox_events', {
      id: ulid(), school_id: e.schoolId, event_uid: uid, event_type: e.type, aggregate_type: e.aggregateType, aggregate_id: e.aggregateId,
      payload: e.payload as never, actor_user_id: e.actorUserId ?? currentContext()?.userId ?? null, occurred_at: occurredAt, published_at: null, version: e.version ?? 1,
    });
    this.onEmitted?.();
    return { uid, type: e.type, schoolId: e.schoolId, aggregateType: e.aggregateType, aggregateId: e.aggregateId, payload: e.payload, actorUserId: e.actorUserId ?? null, occurredAt, version: e.version ?? 1 };
  }

  /** Convenience: emit outside of an existing transaction. */
  emitNow<T extends EventType>(e: EmitInput<T>) { return this.db.transaction(tx => this.emit(tx, e)); }
}
