import type { Db } from '@pathshala/db';
import { nowSql, ulid } from '@pathshala/db';
import type { Adapters, JobHandler, Logger, ScheduledFn } from '@pathshala/adapters';
import type { NotificationService } from '../notifications.js';
import type { OutboxService } from './outbox.js';

/**
 * Platform job handlers for Phase 0. Queue jobs (`background_jobs.job_name`) and scheduled jobs
 * (`scheduled_jobs.job_key`, seeded from docs/AUTOMATION.md) are registered here; module phases add theirs.
 */
export function registerPlatformJobs(deps: { db: Db; adapters: Adapters; notifications: NotificationService; outbox: OutboxService; log: Logger }) {
  const { db, adapters, notifications, log } = deps;

  // ---------- queue jobs ----------
  const queueJobs: Record<string, JobHandler> = {
    'notifications.deliver': async payload => { const ids = (payload.ids as string[]) ?? []; return { result: await notifications.deliver(ids) }; },

    /** Chunked demo/self-test job: renders a PDF through the pdf adapter and stores it under uploads/. */
    'pdf.render': async (payload, ctx) => {
      const doc = (payload.doc as Record<string, unknown>) ?? { content: [{ text: 'Pathshala', style: 'h' }, { text: String(payload.text ?? '') }], styles: { h: { fontSize: 18, bold: true } } };
      const buf = await adapters.pdf.render(doc);
      const rel = `${ctx.job.schoolId}/generated/${ctx.job.id}.pdf`;
      await adapters.storage.put(rel, buf);
      await ctx.progress(1, 1);
      return { result: { path: rel, bytes: buf.length } };
    },

    /** Example of a resumable batch: processes `items` in chunks of `chunk`, yielding before the request budget ends. */
    'batch.noop': async (payload, ctx) => {
      const items = Number(payload.items ?? 0); const chunk = Number(payload.chunk ?? 100);
      let done = Number((ctx.job.cursor as { done?: number } | null)?.done ?? 0);
      while (done < items) { done = Math.min(items, done + chunk); await ctx.progress(done, items, { done }); if (Date.now() > ctx.deadline) return { continue: true, cursor: { done } }; }
      return { result: { done } };
    },
  };
  for (const [name, fn] of Object.entries(queueJobs)) adapters.queue.register(name, fn);

  // ---------- scheduled jobs ----------
  const scheduled: Record<string, ScheduledFn> = {
    'platform.housekeeping': async ({ schoolId }) => {
      const now = nowSql();
      const d = (days: number) => nowSql(new Date(Date.now() - days * 86_400_000));
      const r1 = await db.execute(`DELETE FROM otp_codes WHERE school_id = ? AND expires_at < ?`, [schoolId, now]);
      const r2 = await db.execute(`DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE school_id = ?) AND (expires_at < ? OR revoked_at < ?)`, [schoolId, now, d(7)]);
      const r3 = await db.execute(`DELETE FROM outbox_events WHERE school_id = ? AND published_at IS NOT NULL AND published_at < ?`, [schoolId, d(30)]);
      const r4 = await db.execute(`DELETE FROM event_consumptions WHERE processed_at < ?`, [d(30)]);
      const r5 = await db.execute(`DELETE FROM notifications WHERE school_id = ? AND status IN ('sent','delivered','read','failed') AND created_at < ?`, [schoolId, d(90)]);
      const r6 = await db.execute(`DELETE FROM background_jobs WHERE school_id = ? AND status IN ('success','cancelled') AND finished_at < ?`, [schoolId, d(14)]);
      const r7 = await db.execute(`DELETE FROM automation_runs WHERE school_id = ? AND started_at < ?`, [schoolId, d(180)]);
      log.info(`housekeeping ${schoolId}: otp ${r1.affectedRows}, sessions ${r2.affectedRows}, outbox ${r3.affectedRows}, consumptions ${r4.affectedRows}, notifications ${r5.affectedRows}, jobs ${r6.affectedRows}, runs ${r7.affectedRows}`);
      await db.insert('system_health', { id: ulid(), check_key: 'housekeeping', status: 'ok', detail: { schoolId, at: now }, checked_at: now });
    },
    'platform.kpi_snapshot': async ({ schoolId }) => {
      const day = new Date().toISOString().slice(0, 10);
      if (await db.findOne('kpi_daily', { school_id: schoolId, day })) return;
      const since = `${day} 00:00:00`;
      const students = await db.count('students', { school_id: schoolId, status: 'active' }).catch(() => 0);
      const sms = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE school_id = ? AND channel = 'sms' AND status IN ('sent','delivered') AND sent_at >= ?`, [schoolId, since]);
      await db.insert('kpi_daily', { id: ulid(), school_id: schoolId, day, students_active: students, sms_sent: Number(sms[0]?.n ?? 0), extra: null });
    },
    'comms.publish_scheduled_notices': async ({ schoolId }) => {
      const due = await db.query<Record<string, unknown>>(`SELECT id, title, audience FROM notices WHERE school_id = ? AND status = 'scheduled' AND publish_at <= ?`, [schoolId, nowSql()]);
      for (const n of due) {
        await db.transaction(async tx => {
          await tx.update('notices', { status: 'published', updated_at: nowSql() }, { id: n.id as string });
          await deps.outbox.emit(tx, { type: 'notice.published', schoolId, aggregateType: 'communication.notice', aggregateId: String(n.id), payload: { noticeId: String(n.id), title: String(n.title), audience: n.audience } });
        });
      }
    },
    'comms.provider_balance': async ({ schoolId }) => {
      const providers = await db.findMany<Record<string, unknown>>('messaging_providers', { school_id: schoolId, is_active: true });
      for (const p of providers) {
        const bal = p.channel === 'sms' && adapters.sms.balance ? await adapters.sms.balance() : null;
        if (bal != null) await db.update('messaging_providers', { balance: bal, updated_at: nowSql() }, { id: p.id as string });
        const threshold = Number(p.low_balance_threshold ?? 0);
        const current = bal ?? Number(p.balance ?? NaN);
        if (threshold && Number.isFinite(current) && current < threshold) await notifications.notifyRole(schoolId, 'admin', { channels: ['push', 'in_app', 'email'], eventKey: 'comms.provider_low_balance', title: `${p.provider} balance low`, body: `${p.channel} provider ${p.provider} has ৳${current} left (threshold ৳${threshold}).`, data: { provider: p.provider, balance: current } });
      }
    },
  };
  for (const [key, fn] of Object.entries(scheduled)) adapters.scheduler.register(key, fn);
  return { queueJobs: Object.keys(queueJobs), scheduledJobs: Object.keys(scheduled) };
}
