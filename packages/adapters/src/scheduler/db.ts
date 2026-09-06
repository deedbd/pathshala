import type { Db } from '@pathshala/db';
import { json, nowSql } from '@pathshala/db';
import type { Logger, ScheduledFn, SchedulerAdapter } from '../interfaces.js';
import { nextRun, parseCron } from '../cron.js';

export type SchedulerMode = 'inprocess' | 'heartbeat' | 'cron';

export interface DbSchedulerOptions {
  db: Db;
  log?: Logger;
  /** inprocess: internal timer (Passenger keeps the process alive) · heartbeat: only tick() from requests · cron: external `curl /cron/tick` */
  mode?: SchedulerMode;
  intervalMs?: number;
  lockSeconds?: number;
  jobBudgetMs?: number;
  /** Runs after the scheduled jobs on every tick (relay + queue drain hook). */
  afterTick?: () => Promise<void>;
}

/**
 * Scheduler over `scheduled_jobs` (one row per school per job_key, cron in Asia/Dhaka by default).
 * `tick()` claims each overdue row with `locked_until` (DB lock → only one process runs a job even if
 * Passenger spawned two), runs the registered function, computes `next_run_at`. The same code serves
 * the in-process timer, the request heartbeat and an external cron line — WordPress-cron pattern.
 */
export class DbScheduler implements SchedulerAdapter {
  readonly kind: string;
  private fns = new Map<string, ScheduledFn>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private opts: Required<Omit<DbSchedulerOptions, 'log' | 'afterTick'>> & Pick<DbSchedulerOptions, 'log' | 'afterTick'>;

  constructor(o: DbSchedulerOptions) {
    this.opts = { mode: 'inprocess', intervalMs: 30_000, lockSeconds: 120, jobBudgetMs: 25_000, ...o };
    this.kind = this.opts.mode;
  }

  register(jobKey: string, fn: ScheduledFn) { this.fns.set(jobKey, fn); }

  start() {
    if (this.opts.mode !== 'inprocess' || this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(e => this.opts.log?.error('scheduler tick', e)); }, this.opts.intervalMs);
    this.timer.unref?.();
  }

  async stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private inflight: Promise<{ ran: string[]; skipped: number; errors: string[] }> | null = null;
  /** Runs overdue jobs. A caller arriving mid-tick waits for that tick and then runs its own. */
  async tick() {
    while (this.inflight) { try { await this.inflight; } catch { /* logged */ } }
    this.inflight = this.tickOnce();
    try { return await this.inflight; } finally { this.inflight = null; }
  }

  private async tickOnce() {
    const ran: string[] = []; const errors: string[] = []; let skipped = 0;
    this.ticking = true;
    const { db, log } = this.opts;
    try {
      const now = nowSql();
      // rows never scheduled get a next_run_at first (idempotent, cheap)
      const fresh = await db.query<Record<string, unknown>>(`SELECT id, cron_expr, timezone FROM scheduled_jobs WHERE is_active = TRUE AND next_run_at IS NULL LIMIT 200`);
      for (const r of fresh) {
        const n = safeNext(String(r.cron_expr), String(r.timezone || 'Asia/Dhaka'));
        await db.update('scheduled_jobs', { next_run_at: n ? nowSql(n) : null, updated_at: now }, { id: r.id as string });
      }
      const due = await db.query<Record<string, unknown>>(
        `SELECT * FROM scheduled_jobs WHERE is_active = TRUE AND next_run_at <= ? AND (locked_until IS NULL OR locked_until < ?) ORDER BY next_run_at ASC LIMIT 50`, [now, now]);
      for (const row of due) {
        const id = String(row.id), key = String(row.job_key), tz = String(row.timezone || 'Asia/Dhaka');
        const lock = nowSql(new Date(Date.now() + this.opts.lockSeconds * 1000));
        const claimed = await db.execute(`UPDATE scheduled_jobs SET locked_until = ?, last_status = 'running' WHERE id = ? AND (locked_until IS NULL OR locked_until < ?)`, [lock, id, nowSql()]);
        if (claimed.affectedRows !== 1) { skipped++; continue; }
        const fn = this.fns.get(key);
        const started = Date.now();
        const next = safeNext(String(row.cron_expr), tz);
        try {
          if (!fn) { log?.debug(`scheduled job ${key} has no handler yet (phase not shipped) — skipping`); }
          else await fn({ schoolId: String(row.school_id), jobKey: key, payload: json<Record<string, unknown>>(row.payload) ?? {}, deadline: started + this.opts.jobBudgetMs });
          await db.update('scheduled_jobs', { last_run_at: nowSql(), last_status: 'success', last_duration_ms: Date.now() - started, next_run_at: next ? nowSql(next) : null, locked_until: null, updated_at: nowSql() }, { id });
          if (fn) ran.push(key);
        } catch (e) {
          const err = e as Error;
          errors.push(`${key}: ${err.message}`);
          log?.error(`scheduled job ${key} failed`, err);
          await db.update('scheduled_jobs', { last_run_at: nowSql(), last_status: 'failed', last_duration_ms: Date.now() - started, next_run_at: next ? nowSql(next) : null, locked_until: null, updated_at: nowSql() }, { id });
        }
      }
      if (this.opts.afterTick) await this.opts.afterTick();
    } finally { this.ticking = false; }
    return { ran, skipped, errors };
  }
}

function safeNext(expr: string, tz: string): Date | null {
  try { return nextRun(parseCron(expr), tz); } catch { return null; }
}
