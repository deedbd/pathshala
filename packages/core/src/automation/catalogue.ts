import type { Db, Row } from '@pathshala/db';
import { catalogue, ulid } from '@pathshala/db';

/**
 * Brings a school's automation rows up to the catalogue this build ships.
 *
 * Seeds run when a school is created, so a school installed last year has no `scheduled_jobs` row
 * for a job added this year: the handler is registered, the scheduler never calls it, and the work
 * silently does not happen. Once a product is in the field that is every school that matters, so the
 * reconcile runs at boot for every school and again from the platform watchdog for its own school —
 * the second one matters because the first cannot run on a host where the process never restarts.
 *
 * It only ever adds what is missing. A job a school switched off keeps `is_active = false`, a cron
 * expression somebody changed is left alone, and a rule whose actions were edited is not restored to
 * the shipped version: the row exists, so it is not touched.
 */
export async function syncCatalogue(db: Db, dbDir: string, schoolId: string): Promise<{ jobs: string[]; rules: string[] }> {
  const { jobs, rules } = catalogue(dbDir);
  const added = { jobs: [] as string[], rules: [] as string[] };
  if (!jobs.length && !rules.length) return added;

  const haveJobs = new Set((await db.query<{ job_key: string }>(`SELECT job_key FROM scheduled_jobs WHERE school_id = ?`, [schoolId])).map(r => String(r.job_key)));
  for (const j of jobs) {
    if (haveJobs.has(j.job_key)) continue;
    await db.insert('scheduled_jobs', { id: ulid(), school_id: schoolId, job_key: j.job_key, cron_expr: j.cron_expr, timezone: 'Asia/Dhaka', payload: { rows: j.rows }, is_active: true });
    added.jobs.push(j.job_key);
  }

  const haveRules = new Set((await db.query<{ code: string }>(`SELECT code FROM automation_rules WHERE school_id = ?`, [schoolId])).map(r => String(r.code)));
  for (const r of rules) {
    if (haveRules.has(r.code)) continue;
    await db.insert('automation_rules', {
      id: ulid(), school_id: schoolId, code: r.code, name: r.name, module: r.module, description: r.description,
      trigger_kind: r.trigger_kind, event_type: r.event_type, cron_expr: null,
      conditions: r.condition_text ? { note: r.condition_text } : null, actions: r.actions as Row[],
      is_system: true, is_active: true, priority: 100, cooldown_minutes: 5, run_count: 0,
    });
    added.rules.push(r.code);
  }
  return added;
}
