import fs from 'node:fs';
import path from 'node:path';
import { createGzip, gunzipSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { Db, Row } from '@pathshala/db';
import { nowSql, ulid } from '@pathshala/db';
import type { Adapters, JobContext, Logger, ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { SettingsService } from '../settings.js';
import { HttpError, badRequest, notFound } from '../context.js';

export interface BackupTargetConfig { kind: 'local' | 'dropbox' | 'gdrive' | 's3'; token?: string; folder?: string }

/** Tables whose rows are noise in a backup: they rebuild themselves and would double the file size. */
const SKIP_TABLES = ['vehicle_gps_logs', 'device_punch_logs', 'event_consumptions', 'notifications_queue_stats', 'system_health', 'webhook_deliveries', 'automation_runs',
  'schema_migrations'];   // the target writes its own migration history when its schema is created

/**
 * The platform's own housekeeping: a backup anybody can restore, the SQLite → MySQL move a school
 * makes when it outgrows the free tier, an update that can be rolled back, and the first-run
 * checklist that tells a new school what is still missing. Everything here is written so that a
 * person with cPanel File Manager and nothing else can still get their data out.
 */
export class PlatformService {
  constructor(
    private db: Db, private outbox: OutboxService, private notifications: NotificationService, private settings: SettingsService,
    private adapters: Adapters, private rootDir: string, private log: Logger,
  ) {}

  // ---------- backup ----------
  /**
   * A backup is one gzipped JSON-lines file: a header, then `{table, row}` per line. It is portable
   * across SQLite, MySQL and Postgres because it carries data, never SQL. Written in chunks so a
   * 1,500-student school does not build the whole thing in memory.
   */
  async backup(schoolId: string | null, opts: { kind?: 'database' | 'files' | 'full'; target?: 'local' | 'dropbox' | 'gdrive' | 's3' } = {}) {
    const id = ulid();
    const kind = opts.kind ?? 'database';
    const target = opts.target ?? 'local';
    const dir = path.join(this.rootDir, 'storage', 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const name = `pathshala-${nowSql().slice(0, 10)}-${id.slice(-6).toLowerCase()}.jsonl.gz`;
    const file = path.join(dir, name);
    await this.db.insert('backups', { id, school_id: schoolId, kind, target, file_path: file, size_bytes: null, status: 'running', started_at: nowSql(), finished_at: null, error: null });
    try {
      const tables = await this.orderedTables();
      const self = this;
      async function* lines() {
        yield `${JSON.stringify({ pathshala: 1, engine: self.db.engine, schoolId, kind, at: nowSql() })}\n`;
        for (const table of tables) {
          let offset = 0;
          for (;;) {
            const rows = await self.db.query<Row>(`SELECT * FROM ${self.db.quote(table)}${schoolId && (await self.hasSchoolColumn(table)) ? ' WHERE school_id = ?' : ''} LIMIT 500 OFFSET ${offset}`, schoolId && (await self.hasSchoolColumn(table)) ? [schoolId] : []);
            if (!rows.length) break;
            for (const row of rows) yield `${JSON.stringify({ t: table, r: row })}\n`;
            offset += rows.length;
            if (rows.length < 500) break;
          }
        }
      }
      await pipeline(Readable.from(lines()), createGzip(), fs.createWriteStream(file));
      const size = fs.statSync(file).size;
      // A backup nobody has read is a rumour. Reading it back costs a second and catches the two
      // failures that otherwise surface only on the day the school actually needs it: a truncated
      // gzip stream, and a file that is technically valid but empty because the query found nothing.
      const check = this.verify(file);
      if (!check.ok) throw new Error(`the backup did not read back: ${check.error}`);
      let stored = file;
      if (target !== 'local') stored = await this.upload(target, file, name);
      await this.db.update('backups', { status: 'success', size_bytes: size, file_path: stored, finished_at: nowSql(), updated_at: nowSql() }, { id });
      await this.outbox.emitNow({ type: 'backup.finished', schoolId: schoolId ?? '', aggregateType: 'platform.backup', aggregateId: id, payload: { backupId: id, status: 'success', sizeBytes: size, kind, target, path: stored, tables: check.tables, rows: check.rows } as never });
      return { id, file: stored, sizeBytes: size, target, tables: check.tables, rows: check.rows };
    } catch (e) {
      await this.db.update('backups', { status: 'failed', error: (e as Error).message.slice(0, 2000), finished_at: nowSql(), updated_at: nowSql() }, { id });
      await this.outbox.emitNow({ type: 'backup.finished', schoolId: schoolId ?? '', aggregateType: 'platform.backup', aggregateId: id, payload: { backupId: id, status: 'failed', sizeBytes: null } as never });
      throw e;
    }
  }
  /**
   * Reads a backup file back the way `restore()` would, without writing anything: the same gunzip,
   * the same header check, the same line parsing. It is the restore rehearsal a school will never
   * think to run, and it is the difference between "the backup ran" and "the backup is a backup".
   */
  verify(file: string): { ok: boolean; tables: number; rows: number; error: string | null } {
    const full = path.isAbsolute(file) ? file : path.join(this.rootDir, 'storage', 'backups', file);
    try {
      if (!fs.existsSync(full)) return { ok: false, tables: 0, rows: 0, error: 'the file is not there' };
      const lines = gunzipSync(fs.readFileSync(full)).toString('utf8').split('\n').filter(Boolean);
      const header = JSON.parse(lines[0] ?? '{}') as { pathshala?: number };
      if (!header.pathshala) return { ok: false, tables: 0, rows: 0, error: 'no Pathshala header on the first line' };
      const tables = new Set<string>();
      for (const line of lines.slice(1)) {
        const { t } = JSON.parse(line) as { t: string; r: Row };
        tables.add(t);
      }
      if (!tables.size) return { ok: false, tables: 0, rows: 0, error: 'the file holds no rows at all' };
      return { ok: true, tables: tables.size, rows: lines.length - 1, error: null };
    } catch (e) { return { ok: false, tables: 0, rows: 0, error: (e as Error).message.slice(0, 200) }; }
  }
  /**
   * Tables in the order the schema creates them, which is also the order that satisfies the foreign
   * keys. It matters because engines list their tables differently: SQLite gives creation order,
   * MySQL and Postgres give alphabetical, and a child inserted before its parent is refused.
   */
  private order: string[] | null = null;
  private canonicalOrder(): string[] {
    if (this.order) return this.order;
    try {
      const schema = JSON.parse(fs.readFileSync(path.join(this.rootDir, 'db', 'schema.json'), 'utf8')) as { modules: { tables: { name: string }[] }[] };
      this.order = schema.modules.flatMap(m => m.tables.map(t => t.name));
    } catch { this.order = []; }
    return this.order;
  }
  private async orderedTables() {
    const present = new Set((await this.db.tables()).filter(t => !SKIP_TABLES.includes(t)));
    const order = this.canonicalOrder().filter(t => present.has(t));
    for (const t of present) if (!order.includes(t)) order.push(t);   // anything the schema does not know goes last
    return order;
  }
  private schoolColumns = new Map<string, boolean>();
  private async hasSchoolColumn(table: string) {
    if (!this.schoolColumns.has(table)) {
      try { await this.db.query(`SELECT school_id FROM ${this.db.quote(table)} LIMIT 1`); this.schoolColumns.set(table, true); }
      catch { this.schoolColumns.set(table, false); }
    }
    return this.schoolColumns.get(table)!;
  }
  /** Off-site copy. Dropbox needs only a token, which is what a school on shared hosting can manage. */
  private async upload(target: string, file: string, name: string) {
    const config = (await this.settings.get<BackupTargetConfig>('', `backup.${target}`)) ?? ({} as BackupTargetConfig);
    const token = config.token ?? process.env[`${target.toUpperCase()}_TOKEN`];
    if (!token) throw new HttpError(409, `no ${target} token configured — set backup.${target} in settings`, 'no_token');
    if (target !== 'dropbox') throw new HttpError(501, `${target} upload is not implemented yet; the file is on disk at ${file}`, 'not_implemented');
    const body = fs.readFileSync(file);
    const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ path: `${config.folder ?? '/pathshala'}/${name}`, mode: 'add', autorename: true }) },
      body: new Uint8Array(body),
    });
    if (!res.ok) throw new HttpError(502, `dropbox refused the upload: ${res.status} ${(await res.text()).slice(0, 200)}`, 'upload_failed');
    return `dropbox:${config.folder ?? '/pathshala'}/${name}`;
  }
  async backups(schoolId?: string | null) {
    const where = schoolId ? { school_id: schoolId } : undefined;
    return this.db.findMany<Row>('backups', where as never, { orderBy: 'started_at DESC', limit: 50 });
  }
  /**
   * Restores a backup file into the current database. Rows are inserted table by table in the order
   * they were written, which is the schema's own order, so parents land before their children.
   */
  async restore(file: string, opts: { truncate?: boolean } = {}) {
    const full = path.isAbsolute(file) ? file : path.join(this.rootDir, 'storage', 'backups', file);
    if (!fs.existsSync(full)) throw notFound('backup file');
    const text = gunzipSync(fs.readFileSync(full)).toString('utf8');
    const lines = text.split('\n').filter(Boolean);
    const header = JSON.parse(lines[0]!) as { pathshala?: number };
    if (!header.pathshala) throw badRequest('that file is not a Pathshala backup');
    const byTable = new Map<string, Row[]>();
    for (const line of lines.slice(1)) {
      const { t, r } = JSON.parse(line) as { t: string; r: Row };
      if (!byTable.has(t)) byTable.set(t, []);
      byTable.get(t)!.push(r);
    }
    let restored = 0;
    // parents before children, whatever order the file happens to be in
    const order = this.canonicalOrder();
    const tablesInOrder = [...byTable.keys()].sort((a, b) => (order.indexOf(a) + 1 || 9999) - (order.indexOf(b) + 1 || 9999));
    for (const table of tablesInOrder) {
      const rows = byTable.get(table)!;
      if (opts.truncate) await this.db.execute(`DELETE FROM ${this.db.quote(table)}`).catch(() => undefined);
      for (let i = 0; i < rows.length; i += 200) {
        const slice = rows.slice(i, i + 200);
        try { await this.db.insertMany(table, slice); restored += slice.length; }
        catch { for (const row of slice) { try { await this.db.insert(table, row); restored++; } catch { /* a row that is already there is not a failure */ } } }
      }
    }
    return { tables: byTable.size, rows: restored };
  }

  // ---------- moving engine ----------
  /**
   * SQLite → MySQL (or Postgres) without the school losing a day: the target schema is created by
   * the installer's own migrations, then every row is copied in chunks. Returns what it moved so the
   * operator can compare counts before switching `.env` over.
   */
  async migrateTo(target: Db, opts: { schoolId?: string | null; chunk?: number } = {}) {
    const chunk = opts.chunk ?? 500;
    const tables = await this.orderedTables();
    const moved: Record<string, number> = {};
    const failures: { table: string; error: string }[] = [];
    for (const table of tables) {
      let offset = 0;
      for (;;) {
        const raw = await this.db.query<Row>(`SELECT * FROM ${this.db.quote(table)} LIMIT ${chunk} OFFSET ${offset}`);
        if (!raw.length) break;
        const rows = raw.map(portable);
        try { await target.insertMany(table, rows); moved[table] = (moved[table] ?? 0) + rows.length; }
        catch {
          // one bad row must not lose the other 499, but a row that will not go is reported, never hidden
          for (const row of rows) {
            try { await target.insert(table, row); moved[table] = (moved[table] ?? 0) + 1; }
            catch (e) { if (failures.length < 50) failures.push({ table, error: (e as Error).message.slice(0, 200) }); }
          }
        }
        offset += raw.length;
        if (raw.length < chunk) break;
      }
    }
    const totals = { tables: Object.keys(moved).length, rows: Object.values(moved).reduce((a, b) => a + b, 0) };
    return { ...totals, moved, failures };
  }
  /** Row counts per table on both sides, so a move can be checked rather than trusted. */
  async compareWith(other: Db) {
    const tables = await this.orderedTables();
    const diff: { table: string; here: number; there: number }[] = [];
    for (const table of tables) {
      const here = Number((await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${this.db.quote(table)}`))[0]?.n ?? 0);
      const there = Number((await other.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${other.quote(table)}`).catch(() => [{ n: -1 }]))[0]?.n ?? -1);
      if (here !== there) diff.push({ table, here, there });
    }
    return { matched: diff.length === 0, differences: diff };
  }

  // ---------- onboarding ----------
  /**
   * What a new school still has to do before it can run a day. Each step reports whether it is done
   * and where to go, so the console can show a checklist instead of an empty dashboard.
   */
  async onboarding(schoolId: string) {
    const count = async (table: string, where: Row = {}) => this.db.count(table, { school_id: schoolId, ...where } as never);
    const [students, staff, classes, timetable, feeStructure, exams, invoices, notifications] = await Promise.all([
      count('students'), count('staff'), count('classes'), count('timetable_slots'), count('fee_structures'), count('exams'), count('invoices'),
      this.db.count('messaging_providers', { school_id: schoolId, is_active: true } as never).catch(() => 0),
    ]);
    const steps = [
      { key: 'classes', label: 'Set up classes and sections', done: classes > 0, href: '/academic', count: classes },
      { key: 'staff', label: 'Add the teachers', done: staff > 0, href: '/staff', count: staff },
      { key: 'students', label: 'Import the students', done: students > 0, href: '/import', count: students },
      { key: 'timetable', label: 'Build the timetable', done: timetable > 0, href: '/timetable', count: timetable },
      { key: 'fees', label: 'Set the fee structure', done: feeStructure > 0, href: '/fees', count: feeStructure },
      { key: 'invoices', label: 'Generate the first month of invoices', done: invoices > 0, href: '/fees', count: invoices },
      { key: 'exams', label: 'Create the first exam', done: exams > 0, href: '/exams', count: exams },
      { key: 'sms', label: 'Connect an SMS provider so guardians hear from you', done: notifications > 0, href: '/settings', count: notifications },
    ];
    const done = steps.filter(s => s.done).length;
    return { steps, done, total: steps.length, complete: done === steps.length };
  }

  // ---------- health ----------
  /** What the platform itself is doing: queue depth, failures, storage, and the last backup. */
  async health(schoolId?: string | null) {
    const [queued, failedJobs, unpublished, failedNotifications, lastBackup] = await Promise.all([
      this.db.count('background_jobs', { status: 'queued' } as never),
      this.db.count('background_jobs', { status: 'failed' } as never),
      Number((await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox_events WHERE published_at IS NULL`))[0]?.n ?? 0),
      this.db.count('notifications', { status: 'failed' } as never),
      this.db.findMany<Row>('backups', undefined as never, { orderBy: 'started_at DESC', limit: 1 }),
    ]);
    const uploads = path.join(this.rootDir, 'uploads');
    const storageBytes = fs.existsSync(uploads) ? dirSize(uploads) : 0;
    const memory = process.memoryUsage();
    return {
      queue: { queued, failed: failedJobs }, outbox: { unpublished }, notifications: { failed: failedNotifications },
      storage: { uploadsBytes: storageBytes, uploadsMb: Math.round(storageBytes / 104_857.6) / 10 },
      memory: { rssMb: Math.round(memory.rss / 104_857.6) / 10, heapMb: Math.round(memory.heapUsed / 104_857.6) / 10 },
      lastBackup: lastBackup[0] ? { at: String(lastBackup[0].started_at), status: String(lastBackup[0].status), sizeBytes: Number(lastBackup[0].size_bytes ?? 0) } : null,
      engine: this.db.engine, adapters: { queue: this.adapters.queue.kind, scheduler: this.adapters.scheduler.kind, storage: this.adapters.storage.kind },
      schoolId: schoolId ?? null,
    };
  }

  // ---------- watchdog ----------
  /**
   * Records one health check. `system_health.check_key` is unique, so a check that inserted a new
   * row every night would fail on the second night — quietly, since a scheduled job that throws is
   * only written to its own `last_status`. The state of a check is one row that gets overwritten.
   */
  async recordHealth(checkKey: string, status: 'ok' | 'warn' | 'fail', detail: Record<string, unknown>) {
    const row = { status, detail: detail as never, checked_at: nowSql() };
    const ex = await this.db.findOne<{ id: string }>('system_health', { check_key: checkKey });
    if (ex) await this.db.update('system_health', row, { id: ex.id });
    else await this.db.insert('system_health', { id: ulid(), check_key: checkKey, ...row });
  }
  /**
   * Every job in the seeded catalogue has a row for this school. It matters after an update: the
   * seeds only run when a school is provisioned, so a school installed last year would never gain
   * the automations shipped this year — they would sit in the code with nothing to call them.
   */
  private catalogue: { job_key: string; cron_expr: string; rows: string }[] | null = null;
  async syncScheduledJobs(schoolId: string) {
    if (!this.catalogue) {
      try { this.catalogue = JSON.parse(fs.readFileSync(path.join(this.rootDir, 'db', 'seeds', 'scheduled_jobs.json'), 'utf8')) as { job_key: string; cron_expr: string; rows: string }[]; }
      catch { this.catalogue = []; }
    }
    const added: string[] = [];
    for (const j of this.catalogue) {
      if (await this.db.findOne('scheduled_jobs', { school_id: schoolId, job_key: j.job_key })) continue;
      await this.db.insert('scheduled_jobs', { id: ulid(), school_id: schoolId, job_key: j.job_key, cron_expr: j.cron_expr, timezone: 'Asia/Dhaka', payload: { rows: j.rows } as never, is_active: true });
      added.push(j.job_key);
    }
    return added;
  }
  /**
   * What the machinery itself is doing, checked by the machinery itself.
   *
   * Everything else in this system watches the school. Nothing watched the watcher: a scheduled job
   * that threw wrote `failed` into its own row and told nobody, a backup that could not be written
   * did the same, and an event whose consumer gave up after five attempts was marked consumed so the
   * queue would not stall — correctly, but silently. On a shared host with no monitoring, silence is
   * indistinguishable from working, and the first sign of a fortnight of missed invoices is a parent
   * asking why nobody sent a bill.
   *
   * Each finding is one message per kind, at most one in three days, so a fault that takes a week to
   * fix does not train the office to ignore the messages about it.
   */
  async watchdog(schoolId: string) {
    const now = Date.now();
    const findings: { kind: 'scheduled_job' | 'outbox' | 'backup' | 'storage' | 'notifications'; detail: string; count: number }[] = [];
    const tell = async (kind: typeof findings[number]['kind'], title: string, body: string, count: number) => {
      findings.push({ kind, detail: body, count });
      const sent = await this.notifications.notifyRoleOnce(schoolId, 'admin', 72, { channels: ['in_app', 'email'], eventKey: 'platform.stalled', title, body, entityType: 'platform.watchdog', entityId: kind });
      // the event follows the message, not the check: a fault that lasts a week would otherwise put
      // an event on the bus every hour, and every webhook and rule listening would hear all of them
      if (sent.length) await this.outbox.emitNow({ type: 'automation.stalled', schoolId, aggregateType: 'platform.watchdog', aggregateId: kind, payload: { kind, detail: body.slice(0, 400), count } });
    };

    const added = await this.syncScheduledJobs(schoolId);

    // 1. a job that failed, or one whose turn came and went. The watchdog never reports itself.
    // "Overdue" also has to mean "and has not run since": on a shared host the scheduler is a
    // heartbeat, so after a quiet weekend every job is overdue for the few seconds it takes the
    // tick to work through them — and this pass is one of the jobs in that same tick. Only a job
    // that has not run for a day at all is actually stopped.
    const overdue = nowSql(new Date(now - 6 * 3600_000));
    const silentFor = nowSql(new Date(now - 24 * 3600_000));
    const stalled = await this.db.query<Row>(
      `SELECT job_key, last_status, last_run_at, next_run_at FROM scheduled_jobs
       WHERE school_id = ? AND is_active = TRUE AND job_key <> 'platform.watchdog'
         AND (last_status = 'failed'
              OR (next_run_at IS NOT NULL AND next_run_at < ? AND (last_run_at IS NULL OR last_run_at < ?)))
       ORDER BY job_key LIMIT 20`, [schoolId, overdue, silentFor]);
    if (stalled.length) {
      const names = stalled.map(r => `${String(r.job_key)}${String(r.last_status) === 'failed' ? ' (failed)' : ' (overdue)'}`).join(', ');
      await tell('scheduled_job', `${stalled.length} automation${stalled.length === 1 ? ' has' : 's have'} stopped running`, `${names}. Nothing they do is happening: the Automation page shows the error against each one.`, stalled.length);
    }

    // 2. events written but never published, and consumers that gave up on one
    const [pending] = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox_events WHERE school_id = ? AND published_at IS NULL AND occurred_at < ?`, [schoolId, nowSql(new Date(now - 30 * 60_000))]);
    if (Number(pending?.n ?? 0) > 0) await tell('outbox', 'Automation events are not being delivered', `${Number(pending!.n)} events have been waiting more than half an hour. The relay is not running, or one of them keeps failing.`, Number(pending!.n));
    const [givenUp] = await this.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM event_consumptions c JOIN outbox_events e ON e.event_uid = c.event_uid
       WHERE e.school_id = ? AND c.consumer LIKE '%:failed' AND c.attempts >= 5 AND c.processed_at >= ?`, [schoolId, nowSql(new Date(now - 86_400_000))]);
    if (Number(givenUp?.n ?? 0) > 0) await tell('outbox', 'Some automations gave up on an event', `${Number(givenUp!.n)} events were abandoned after five attempts in the last day. Whatever they were meant to do did not happen.`, Number(givenUp!.n));

    // 3. the backup. A school that has never taken one is not warned; one that stopped taking them is.
    const last = await this.db.findOne<Row>('backups', { school_id: schoolId, status: 'success' }, { orderBy: 'started_at DESC' });
    const anyBackup = await this.db.findOne<Row>('backups', { school_id: schoolId }, { orderBy: 'started_at DESC' });
    if (anyBackup && (!last || String(last.started_at) < nowSql(new Date(now - 48 * 3600_000)))) {
      await tell('backup', 'The nightly backup has not worked', last ? `The last good backup was ${String(last.started_at).slice(0, 16)}. Everything since then is only in the database.` : 'No backup has ever finished successfully. Everything is only in the database.', 1);
    }
    await this.recordHealth(`backup:${schoolId}`, last && String(last.started_at) >= nowSql(new Date(now - 48 * 3600_000)) ? 'ok' : anyBackup ? 'fail' : 'warn', { lastAt: last ? String(last.started_at) : null });

    // 4. messages queued and never sent — the delivery job was lost, or the process died holding it.
    // This one is repaired rather than reported: re-queueing is exactly what a person would do.
    const stuck = await this.db.query<{ id: string }>(
      `SELECT id FROM notifications WHERE school_id = ? AND status = 'queued' AND scheduled_for < ? ORDER BY scheduled_for LIMIT 200`, [schoolId, nowSql(new Date(now - 30 * 60_000))]);
    if (stuck.length) {
      await this.adapters.queue.push({ name: 'notifications.deliver', queue: 'notifications', schoolId, payload: { ids: stuck.map(r => r.id) }, triggeredBy: 'platform.watchdog' });
      // told only when it keeps happening: one lost tick is noise, a hundred stuck messages is not
      if (stuck.length >= 100) await tell('notifications', 'Messages are queued and not going out', `${stuck.length} messages have been waiting more than half an hour. They have been queued again; if this repeats, the SMS or email provider is refusing them.`, stuck.length);
    }

    // 5. the disk. On shared hosting this is the failure that takes the whole site down at 2 a.m.
    // Walking every uploaded file is the one expensive thing in this pass, and a disk does not fill
    // up in an hour, so it is measured four times a day rather than twenty-four.
    const lastCheck = await this.db.findOne<Row>('system_health', { check_key: `storage:${schoolId}` });
    if (lastCheck && String(lastCheck.checked_at) > nowSql(new Date(now - 6 * 3600_000))) return { catalogueAdded: added, findings };
    const uploads = path.join(this.rootDir, 'uploads');
    const usedMb = Math.round((fs.existsSync(uploads) ? dirSize(uploads) : 0) / 1_048_576);
    const warnMb = Number((await this.settings.get<number>(schoolId, 'platform.storage_warn_mb')) ?? 2048);
    const free = await this.adapters.storage.freeBytes().catch(() => null);
    const freeMb = free == null ? null : Math.round(free / 1_048_576);
    if (usedMb >= warnMb || (freeMb != null && freeMb < 200)) {
      await tell('storage', 'Storage is filling up', `Uploads are ${usedMb} MB${freeMb == null ? '' : ` and ${freeMb} MB is free on the host`}. Old files and backups are worth clearing before the disk is full.`, usedMb);
    }
    await this.recordHealth(`storage:${schoolId}`, usedMb >= warnMb ? 'warn' : 'ok', { usedMb, warnMb, freeMb });
    return { catalogueAdded: added, findings };
  }

  // ---------- scheduled ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      /**
       * Hourly: is the machinery itself alive? Repairs what it can (missing job rows, messages stuck
       * in the queue) and reports — once every three days per kind — what only a person can fix.
       */
      'platform.watchdog': async ({ schoolId }) => this.watchdog(schoolId),
      // N10's other half: a nightly backup, read back before it is trusted, kept for as long as the
      // school asked. A backup that cannot be written is told to the office rather than left in a
      // job row nobody opens — it is the one failure that is only discovered when it is too late.
      'platform.backup': async ({ schoolId }) => {
        const target = (await this.settings.get<string>(schoolId, 'backup.target')) ?? 'local';
        let r: Awaited<ReturnType<PlatformService['backup']>>;
        try {
          r = await this.backup(schoolId, { kind: 'database', target: target as 'local' });
        } catch (e) {
          await this.recordHealth(`backup:${schoolId}`, 'fail', { error: (e as Error).message.slice(0, 300), at: nowSql() });
          await this.notifications.notifyRoleOnce(schoolId, 'admin', 20, {
            channels: ['in_app', 'email'], eventKey: 'platform.backup_failed', title: 'Tonight\'s backup did not work',
            body: `${(e as Error).message.slice(0, 200)}. Until this is fixed the school's records exist in one place only.`,
            entityType: 'platform.backup', entityId: schoolId,
          });
          throw e;
        }
        const keep = Number((await this.settings.get<number>(schoolId, 'backup.keep_days')) ?? 14);
        const cutoff = new Date(Date.now() - keep * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
        const old = await this.db.query<Row>(`SELECT * FROM backups WHERE school_id = ? AND started_at < ? AND status = 'success'`, [schoolId, cutoff]);
        for (const b of old) {
          const p = String(b.file_path ?? '');
          if (p && !p.startsWith('dropbox:') && fs.existsSync(p)) fs.rmSync(p, { force: true });
          await this.db.delete('backups', { id: String(b.id) });
        }
        await this.recordHealth(`backup:${schoolId}`, 'ok', { at: nowSql(), sizeBytes: r.sizeBytes, tables: r.tables, rows: r.rows, target });
        return { backupId: r.id, sizeBytes: r.sizeBytes, tables: r.tables, rows: r.rows, pruned: old.length };
      },
    };
  }
}

/**
 * One engine's row as the next engine will accept it: MySQL hands back Date objects and Buffers,
 * Postgres hands back booleans, and SQLite takes neither. Dates become the UTC string every engine
 * stores, buffers become text, booleans become 0/1 and objects go back to JSON.
 */
function portable(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) out[k] = nowSql(v);
    else if (Buffer.isBuffer(v)) out[k] = v.toString('utf8');
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0;
    else if (v !== null && typeof v === 'object') out[k] = JSON.stringify(v);
    else out[k] = v as never;
  }
  return out;
}

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else { try { total += fs.statSync(p).size; } catch { /* a file that vanished mid-walk is not a failure */ } }
  }
  return total;
}
