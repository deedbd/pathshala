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
      let stored = file;
      if (target !== 'local') stored = await this.upload(target, file, name);
      await this.db.update('backups', { status: 'success', size_bytes: size, file_path: stored, finished_at: nowSql(), updated_at: nowSql() }, { id });
      await this.outbox.emitNow({ type: 'backup.finished', schoolId: schoolId ?? '', aggregateType: 'platform.backup', aggregateId: id, payload: { backupId: id, kind, target, sizeBytes: size, path: stored } as never });
      return { id, file: stored, sizeBytes: size, target };
    } catch (e) {
      await this.db.update('backups', { status: 'failed', error: (e as Error).message.slice(0, 2000), finished_at: nowSql(), updated_at: nowSql() }, { id });
      throw e;
    }
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

  // ---------- scheduled ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      // N10's other half: a nightly backup, kept for as long as the school asked
      'platform.backup': async ({ schoolId }) => {
        const target = (await this.settings.get<string>(schoolId, 'backup.target')) ?? 'local';
        const r = await this.backup(schoolId, { kind: 'database', target: target as 'local' });
        const keep = Number((await this.settings.get<number>(schoolId, 'backup.keep_days')) ?? 14);
        const cutoff = new Date(Date.now() - keep * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
        const old = await this.db.query<Row>(`SELECT * FROM backups WHERE school_id = ? AND started_at < ? AND status = 'success'`, [schoolId, cutoff]);
        for (const b of old) {
          const p = String(b.file_path ?? '');
          if (p && !p.startsWith('dropbox:') && fs.existsSync(p)) fs.rmSync(p, { force: true });
          await this.db.delete('backups', { id: String(b.id) });
        }
        return { backupId: r.id, sizeBytes: r.sizeBytes, pruned: old.length };
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
