import type { Db } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { JobHandler, JobRecord, JobSpec, Logger, QueueAdapter } from '../interfaces.js';

export interface DbQueueOptions {
  db: Db;
  log?: Logger;
  concurrency?: number;      // shared hosting: 2
  pollMs?: number;           // in-process loop interval
  lockSeconds?: number;      // how long a running job stays locked before another worker may retry it
  jobBudgetMs?: number;      // soft deadline handed to handlers (~25 s on shared hosting)
  onFailed?: (job: JobRecord, error: Error) => Promise<void>;
}

/**
 * Database-backed queue on `background_jobs`. Works on cPanel (no Redis): the in-process loop
 * polls while Passenger keeps the process alive, and the request heartbeat calls `drain()` when it
 * does not. Jobs are chunked/resumable via `cursor` and `progress_pct`; failures retry with backoff.
 */
export class DbQueue implements QueueAdapter {
  readonly kind = 'db';
  private handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private running = 0;
  private draining = false;
  private opts: Required<Omit<DbQueueOptions, 'onFailed' | 'log'>> & Pick<DbQueueOptions, 'onFailed' | 'log'>;

  constructor(o: DbQueueOptions) {
    this.opts = { concurrency: 2, pollMs: 1500, lockSeconds: 90, jobBudgetMs: 25_000, ...o };
  }

  register(name: string, handler: JobHandler) { this.handlers.set(name, handler); }

  async push(job: JobSpec): Promise<string> {
    const id = ulid();
    await this.opts.db.insert('background_jobs', {
      id, school_id: job.schoolId, queue: job.queue ?? 'default', job_name: job.name, payload: job.payload ?? {},
      status: 'pending', attempts: 0, max_attempts: job.maxAttempts ?? 5,
      scheduled_for: job.scheduledFor ? (typeof job.scheduledFor === 'string' ? job.scheduledFor : nowSql(job.scheduledFor)) : nowSql(),
      progress_pct: 0, total_items: job.totalItems ?? null, done_items: 0, triggered_by: job.triggeredBy ?? null,
    });
    return id;
  }

  start() {
    if (this.timer) return;
    const loop = async () => { try { await this.drain(this.opts.concurrency); } catch (e) { this.opts.log?.error('queue loop', e); } };
    this.timer = setInterval(loop, this.opts.pollMs);
    this.timer.unref?.();
    void loop();
  }

  async stop() { if (this.timer) clearInterval(this.timer); this.timer = null; while (this.running > 0) await new Promise(r => setTimeout(r, 50)); }

  async drain(max = this.opts.concurrency): Promise<{ ran: number; failed: number }> {
    if (this.draining) return { ran: 0, failed: 0 };
    this.draining = true;
    let ran = 0, failed = 0;
    try {
      while (ran + failed < max) {
        const job = await this.claim();
        if (!job) break;
        this.running++;
        try { const ok = await this.run(job); ok ? ran++ : failed++; }
        finally { this.running--; }
      }
    } finally { this.draining = false; }
    return { ran, failed };
  }

  /** Atomically claims one due job using an optimistic UPDATE (works on every engine without SELECT … FOR UPDATE). */
  private async claim(): Promise<JobRecord | null> {
    const { db } = this.opts;
    const now = nowSql();
    const candidates = await db.query<Record<string, unknown>>(
      `SELECT id FROM background_jobs WHERE status IN ('pending','running') AND scheduled_for <= ? AND (locked_until IS NULL OR locked_until < ?) AND attempts < max_attempts ORDER BY scheduled_for ASC LIMIT 5`, [now, now]);
    for (const c of candidates) {
      const lock = nowSql(new Date(Date.now() + this.opts.lockSeconds * 1000));
      const n = await db.execute(
        `UPDATE background_jobs SET status = 'running', locked_until = ?, started_at = COALESCE(started_at, ?), attempts = attempts + 1, updated_at = ? WHERE id = ? AND (locked_until IS NULL OR locked_until < ?)`,
        [lock, now, now, c.id, now]);
      if (n.affectedRows !== 1) continue;
      const row = await db.findOne<Record<string, unknown>>('background_jobs', { id: String(c.id) });
      if (!row) continue;
      return {
        id: String(row.id), schoolId: String(row.school_id), queue: String(row.queue), name: String(row.job_name),
        payload: json<Record<string, unknown>>(row.payload) ?? {}, attempts: Number(row.attempts), maxAttempts: Number(row.max_attempts),
        cursor: json(row.cursor), doneItems: Number(row.done_items ?? 0), totalItems: row.total_items == null ? null : Number(row.total_items),
      };
    }
    return null;
  }

  private async run(job: JobRecord): Promise<boolean> {
    const { db, log } = this.opts;
    const handler = this.handlers.get(job.name);
    const finish = (set: Record<string, unknown>) => db.update('background_jobs', { ...set, updated_at: nowSql() }, { id: job.id });
    if (!handler) {
      await finish({ status: 'failed', error: `no handler registered for ${job.name}`, finished_at: nowSql(), locked_until: null });
      log?.warn(`job ${job.name} has no handler`);
      return false;
    }
    const ctx = {
      job,
      deadline: Date.now() + this.opts.jobBudgetMs,
      log: (m: string) => log?.debug(`[job ${job.name}#${job.id}] ${m}`),
      progress: async (done: number, total?: number | null, cursor?: unknown) => {
        const t = total ?? job.totalItems;
        await finish({ done_items: done, total_items: t ?? null, progress_pct: t ? Math.min(100, Math.round((done / t) * 10000) / 100) : 0, cursor: (cursor === undefined ? job.cursor : cursor) as never });
      },
    };
    try {
      const r = await handler(job.payload, ctx);
      if (r && 'continue' in r && r.continue) {
        // chunked job: release the lock and let the next drain pick it up (attempts reset so chunks are not counted as retries)
        await finish({ status: 'pending', locked_until: null, attempts: job.attempts - 1, cursor: (r.cursor ?? job.cursor) as never, scheduled_for: nowSql(new Date(Date.now() + (r.delayMs ?? 0))) });
        return true;
      }
      await finish({ status: 'success', finished_at: nowSql(), locked_until: null, progress_pct: 100, result: (r && 'result' in r ? r.result : null) as never, error: null });
      return true;
    } catch (e) {
      const err = e as Error;
      const exhausted = job.attempts >= job.maxAttempts;
      const backoff = Math.min(3600, 30 * 2 ** (job.attempts - 1));
      const retry: Record<string, unknown> = exhausted ? { finished_at: nowSql() } : { scheduled_for: nowSql(new Date(Date.now() + backoff * 1000)) };
      await finish({ status: exhausted ? 'failed' : 'pending', error: (err.stack || err.message || String(e)).slice(0, 4000), locked_until: null, ...retry });
      log?.error(`job ${job.name}#${job.id} attempt ${job.attempts} failed: ${err.message}`);
      if (exhausted && this.opts.onFailed) { try { await this.opts.onFailed(job, err); } catch (e2) { log?.error('onFailed hook', e2); } }
      return false;
    }
  }
}
