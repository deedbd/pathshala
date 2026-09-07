import type { Db } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { Logger } from '@pathshala/adapters';
import type { EventEnvelope } from '@pathshala/events';
import type { HandlerRegistry } from './handlers.js';
import type { RuleEngine } from './rules.js';
import { hmac } from '../util.js';

/**
 * Outbox relay: publishes unpublished `outbox_events` to consumers — system handlers, the rule engine,
 * webhooks. At-least-once delivery + `event_consumptions` (consumer, event_uid) = effectively once.
 * Runs every 500 ms in-process, and on every scheduler tick / request heartbeat as a fallback.
 */
export class Relay {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private wanted = false;
  constructor(private db: Db, private handlers: HandlerRegistry, private rules: RuleEngine, private log: Logger, private appKey: string) {}

  private stopped = false;
  /** The background loop works in slices: a long backlog must not starve the requests being served. */
  start(intervalMs = 500) { this.stopped = false; if (this.timer) return; this.timer = setInterval(() => void this.run(100, Math.max(100, intervalMs - 100)).catch(e => this.log.error('relay', e)), intervalMs); this.timer.unref?.(); }
  async stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; while (this.busy) await new Promise(r => setTimeout(r, 20)); }
  /** Called by the outbox after an emit so events publish without waiting for the next interval. */
  nudge() { this.wanted = true; setImmediate(() => { if (this.wanted && !this.busy && !this.stopped) void this.run().catch(e => this.log.error('relay', e)); }); }

  private inflight: Promise<{ published: number; failed: number }> | null = null;
  /**
   * Publishes pending events. A caller that arrives while a pass is running waits for it, then runs
   * its own pass. `budgetMs` bounds how long one call may spend: a request heartbeat must never pay
   * for a backlog somebody else created — on SQLite every query is synchronous, so a long relay pass
   * blocks every other request in the process. What is left over waits for the next tick.
   */
  async run(max = 100, budgetMs = 0): Promise<{ published: number; failed: number }> {
    if (this.stopped) return { published: 0, failed: 0 };
    while (this.inflight) { try { await this.inflight; } catch { /* logged by the pass itself */ } }
    const deadline = budgetMs > 0 ? Date.now() + budgetMs : 0;
    // consumers emit follow-up events (task.created, approval.requested…); keep passing until nothing new is pending
    this.inflight = (async () => {
      const total = { published: 0, failed: 0 };
      // A budgeted call (a request heartbeat, the background loop) stops when its slice is up. An
      // unbudgeted one — /cron/tick, a test — keeps passing until nothing is pending, because
      // stopping early leaves an event unconsumed and whoever was waiting for its rule sees nothing.
      const maxPasses = deadline ? 8 : 200;
      for (let i = 0; i < maxPasses; i++) {
        const r = await this.pass(max, deadline);
        total.published += r.published; total.failed += r.failed;
        if (r.published === 0 || (deadline && Date.now() > deadline)) break;
      }
      return total;
    })();
    try { return await this.inflight; } finally { this.inflight = null; }
  }

  private async pass(max: number, deadline = 0): Promise<{ published: number; failed: number }> {
    this.busy = true; this.wanted = false;
    let published = 0, failed = 0, lastYield = Date.now();
    try {
      const rows = await this.db.query<Record<string, unknown>>(`SELECT * FROM outbox_events WHERE published_at IS NULL ORDER BY occurred_at ASC, id ASC LIMIT ${max}`);
      for (const row of rows) {
        const event: EventEnvelope = { uid: String(row.event_uid), type: row.event_type as EventEnvelope['type'], schoolId: String(row.school_id), aggregateType: String(row.aggregate_type), aggregateId: String(row.aggregate_id), payload: (json(row.payload) ?? {}) as never, actorUserId: row.actor_user_id as string | null, occurredAt: String(row.occurred_at), version: Number(row.version) };
        let ok = true;
        for (const h of this.handlers.for(event.type)) ok = (await this.once(`system:${h.name}`, event, () => h.fn(event))) && ok;
        ok = (await this.once('rules', event, () => this.rules.handle(event))) && ok;
        ok = (await this.once('webhooks', event, () => this.webhooks(event))) && ok;
        if (ok) { await this.db.update('outbox_events', { published_at: nowSql() }, { id: row.id as string }); published++; }
        else failed++;
        // SQLite queries are synchronous, so without a yield a backlog would hold the event loop and
        // every HTTP request behind it. Yielding on a time slice rather than per event keeps the app
        // answering without paying a turn of the loop for each of thousands of rows.
        if (Date.now() - lastYield > 15) { await new Promise(r => setImmediate(r)); lastYield = Date.now(); }
        if (deadline && Date.now() > deadline) break;   // the rest waits for the next tick
      }
    } finally { this.busy = false; }
    return { published, failed };
  }

  /** Runs `fn` once per (consumer, event); a thrown error leaves the event unpublished for a retry on the next pass. */
  private async once(consumer: string, event: EventEnvelope, fn: () => Promise<unknown>): Promise<boolean> {
    const done = await this.db.findOne('event_consumptions', { consumer, event_uid: event.uid });
    if (done) return true;
    try {
      await fn();
      await this.db.insert('event_consumptions', { id: ulid(), consumer, event_uid: event.uid, attempts: 1, processed_at: nowSql() });
      return true;
    } catch (e) {
      // attempts live on one row per (consumer, event): a second failure must not collide on the unique key
      const failed = `${consumer}:failed`;
      const prior = await this.db.findOne<{ id: string; attempts: number }>('event_consumptions', { consumer: failed, event_uid: event.uid });
      const attempts = prior ? Number(prior.attempts) + 1 : 1;
      this.log.error(`consumer ${consumer} failed on ${event.type} ${event.uid} (attempt ${attempts})`, e);
      if (prior) await this.db.update('event_consumptions', { attempts, processed_at: nowSql() }, { id: prior.id });
      else await this.db.insert('event_consumptions', { id: ulid(), consumer: failed, event_uid: event.uid, attempts, processed_at: nowSql() });
      if (attempts >= 5) { // give up: record and let the event publish so the queue does not stall
        await this.db.insert('event_consumptions', { id: ulid(), consumer, event_uid: event.uid, attempts, processed_at: nowSql() });
        return true;
      }
      return false;
    }
  }

  private async webhooks(event: EventEnvelope) {
    const hooks = await this.db.findMany<Record<string, unknown>>('webhooks', { school_id: event.schoolId, is_active: true });
    for (const h of hooks) {
      const types = json<string[]>(h.event_types) ?? [];
      if (types.length && !types.includes(event.type) && !types.includes('*')) continue;
      const body = JSON.stringify(event);
      const id = ulid();
      try {
        const res = await fetch(String(h.url), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pathshala-Signature': hmac(String(h.secret || this.appKey), body) }, body, signal: AbortSignal.timeout(8000) });
        await this.db.insert('webhook_deliveries', { id, school_id: event.schoolId, webhook_id: h.id as string, event_uid: event.uid, attempt: 1, response_code: res.status, response_body: (await res.text()).slice(0, 2000), delivered_at: res.ok ? nowSql() : null, next_retry_at: res.ok ? null : nowSql(new Date(Date.now() + 600_000)) });
        // the count is consecutive failures, not failures ever: a webhook that answers again has
        // recovered, and a year of occasional 502s must not add up to a switched-off integration
        if (!res.ok) await this.db.execute(`UPDATE webhooks SET failure_count = failure_count + 1 WHERE id = ?`, [h.id]);
        else await this.db.execute(`UPDATE webhooks SET failure_count = 0 WHERE id = ? AND failure_count > 0`, [h.id]);
      } catch (e) {
        await this.db.insert('webhook_deliveries', { id, school_id: event.schoolId, webhook_id: h.id as string, event_uid: event.uid, attempt: 1, response_code: null, response_body: (e as Error).message.slice(0, 2000), delivered_at: null, next_retry_at: nowSql(new Date(Date.now() + 600_000)) });
        await this.db.execute(`UPDATE webhooks SET failure_count = failure_count + 1 WHERE id = ?`, [h.id]);
      }
    }
  }
}
