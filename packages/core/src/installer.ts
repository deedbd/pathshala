import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Db, MigrateResult, Row } from '@pathshala/db';
import { describeReconcile, json, migrate, nowSql, seed, ulid } from '@pathshala/db';
import type { Adapters, Logger } from '@pathshala/adapters';
import { WebPush } from '@pathshala/adapters';
import type { InstallSchoolInput } from '@pathshala/schemas';
import type { AppConfig } from './config.js';
import { syncCatalogue } from './automation/catalogue.js';
import { writeDotenv } from './config.js';
import type { AuthService } from './auth/service.js';
import type { OutboxService } from './automation/outbox.js';
import type { NotificationService } from './notifications.js';
import type { Relay } from './automation/relay.js';
import { runWithContext, systemContext } from './context.js';
import { slugify } from './util.js';

export const INSTALL_STEPS = ['schema', 'seeds', 'school', 'selftest', 'done'] as const;
export type InstallStep = typeof INSTALL_STEPS[number];
export interface StepState { step: InstallStep; status: 'pending' | 'done' | 'failed' | 'skipped' | 'running'; detail: unknown; finished_at: string | null }

/**
 * Node side of the zero-touch installer (docs/HOSTING-CPANEL.md §2 steps 7–10). Every step writes
 * `installer_state`; re-opening /install resumes at the first step that is not done. Long steps run in
 * the background so no HTTP request waits more than a few seconds on shared hosting.
 */
export class InstallerService {
  private running: Promise<void> | null = null;
  private memory = new Map<InstallStep, StepState>();  // before the schema exists there is no table to write to
  private installedFlag: boolean | null = null;

  constructor(private db: Db, private config: AppConfig, private adapters: Adapters, private deps: { auth: AuthService; outbox: OutboxService; notifications: NotificationService; relay: Relay; log: Logger; afterSchool?: (schoolId: string, input: InstallSchoolInput) => Promise<void> }) {}

  private schemaFlag = false;
  /** True once the baseline schema has been applied (cheap, cached after the first positive answer). */
  async hasSchema(): Promise<boolean> {
    if (this.schemaFlag) return true;
    try { const r = await this.db.query<{ name: string }>(`SELECT name FROM schema_migrations WHERE name = '0000_baseline'`); this.schemaFlag = r.length > 0; } catch { this.schemaFlag = false; }
    return this.schemaFlag;
  }

  private schemaPass: Promise<MigrateResult> | null = null;
  /** What the last schema pass did. Read by /_health so an update can check it before declaring success. */
  lastMigrate: MigrateResult | null = null;

  /**
   * Brings an already-installed database up to the shape this build ships, at every boot.
   *
   * The baseline is applied once and never again, so a column added to `db/schema/*.def.mjs` after a
   * school was installed reaches a fresh install and nobody else — and the first query naming it
   * throws. `migrate()` ends in a reconcile that adds the missing tables, columns and indexes; this
   * is the pass that calls it outside the installer, and it runs *before* the back-fills
   * (`ensureAutomationCatalogue`, and anything else that fills a value in), so a school that has just
   * gained a column gets its value in the same boot.
   */
  async ensureSchema(): Promise<MigrateResult> {
    if (this.schemaPass) return this.schemaPass;
    this.schemaPass = (async () => {
      const r = await migrate(this.db, this.config.dbDir, m => this.deps.log.info(`migrate: ${m}`));
      this.lastMigrate = r;
      this.reportSchema(r);
      return r;
    })();
    try { return await this.schemaPass; } finally { this.schemaPass = null; }
  }

  /**
   * One line when an old database was actually brought forward, and one per thing left alone.
   * A database somebody has edited by hand can differ in hundreds of places; the log says how many
   * and shows the first twenty, because a boot that prints a thousand warnings is read by nobody.
   */
  private reportSchema(r: MigrateResult) {
    if (r.added.tables.length || r.added.columns.length || r.added.indexes.length) this.deps.log.info(`schema: ${describeReconcile(r)}`);
    if (r.mismatched.length) this.deps.log.warn(`schema: ${r.mismatched.length} difference(s) this build will not change by itself:`);
    for (const m of r.mismatched.slice(0, 20)) this.deps.log.warn(`schema:   ${m.table}${m.column ? '.' + m.column : ''} is ${m.actual}, this build expects ${m.expected} — ${m.note}`);
    for (const f of r.failed) this.deps.log.error(`schema: the database refused "${f.statement}" — ${f.error}`);
  }

  /**
   * Reconciles every school on this installation against the automation catalogue the build ships.
   * `syncCatalogue` is the rule; this is the pass over the schools, run once at boot.
   */
  async ensureAutomationCatalogue(): Promise<{ schools: number; jobs: number; rules: number }> {
    const added = { schools: 0, jobs: 0, rules: 0 };
    if (!(await this.hasSchema())) return added;
    const schools = await this.db.query<{ id: string }>(`SELECT id FROM schools WHERE status <> 'closed' ORDER BY created_at, id`);
    for (const school of schools) {
      const r = await syncCatalogue(this.db, this.config.dbDir, String(school.id));
      added.jobs += r.jobs.length; added.rules += r.rules.length;
      if (r.jobs.length || r.rules.length) added.schools++;
    }
    if (added.jobs || added.rules) {
      this.deps.log.info(`automation catalogue: added ${added.jobs} job(s) and ${added.rules} rule(s) across ${added.schools} school(s)`);
    }
    return added;
  }

  async isInstalled(): Promise<boolean> {
    if (this.installedFlag) return true;
    try { const row = await this.db.findOne<StepState>('installer_state', { step: 'done', status: 'done' }); this.installedFlag = !!row; return this.installedFlag; }
    catch { return false; }
  }

  async status(): Promise<{ installed: boolean; engine: string; steps: StepState[]; busy: boolean; school?: { id: string; name: string } | null }> {
    let rows: StepState[] = [];
    try { rows = await this.db.findMany<StepState>('installer_state'); } catch { rows = []; }
    const byStep = new Map(rows.map(r => [r.step, { ...r, detail: json(r.detail) }]));
    const steps = INSTALL_STEPS.map(s => byStep.get(s) ?? this.memory.get(s) ?? { step: s, status: 'pending' as const, detail: null, finished_at: null });
    const installed = steps.find(s => s.step === 'done')?.status === 'done';
    let school: { id: string; name: string } | null = null;
    if (steps.find(s => s.step === 'school')?.status === 'done') { try { school = await this.db.findOne<{ id: string; name: string }>('schools', {}, { orderBy: 'created_at ASC' }); } catch { /* not yet */ } }
    return { installed, engine: this.db.engine, steps, busy: !!this.running, school };
  }

  private async mark(step: InstallStep, status: StepState['status'], detail: unknown = null) {
    const state: StepState = { step, status, detail, finished_at: status === 'done' || status === 'failed' ? nowSql() : null };
    this.memory.set(step, state);
    try {
      const ex = await this.db.findOne<{ id: string }>('installer_state', { step });
      if (ex) await this.db.update('installer_state', { status, detail: detail as never, finished_at: state.finished_at }, { id: ex.id });
      else await this.db.insert('installer_state', { id: ulid(), step, status, detail: detail as never, finished_at: state.finished_at });
    } catch { /* table not there yet (schema step) */ }
    this.deps.log.info(`installer: ${step} → ${status}`);
  }

  /** Runs schema + seeds in the background; the wizard polls status(). */
  runPrepare(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        await this.mark('schema', 'running');
        const r = await migrate(this.db, this.config.dbDir, m => this.deps.log.info(`migrate: ${m}`));
        this.lastMigrate = r;
        this.reportSchema(r);
        await this.mark('schema', 'done', { baseline: r.baseline, statements: r.statements, applied: r.applied, added: r.added, mismatched: r.mismatched.slice(0, 50), mismatchedCount: r.mismatched.length, failed: r.failed, engine: this.db.engine });
        await this.mark('seeds', 'running');
        const s = await seed(this.db, { dbDir: this.config.dbDir, log: m => this.deps.log.info(`seed: ${m}`) });
        await this.mark('seeds', 'done', s.inserted);
      } catch (e) {
        const step = this.memory.get('schema')?.status === 'done' ? 'seeds' : 'schema';
        await this.mark(step, 'failed', { error: (e as Error).message });
        this.deps.log.error('installer prepare failed', e);
      } finally { this.running = null; }
    })();
    return this.running;
  }

  /**
   * A second (or fifth) school in the same database. The installer's own step 8 is one call to this;
   * a SaaS host or a group of schools sharing one cPanel account uses it directly. Every tenant gets
   * its own seeds, campus, admin and defaults — nothing is shared but the tables.
   */
  async addTenant(input: InstallSchoolInput): Promise<{ schoolId: string; userId: string }> {
    return this.provisionSchool(input, null, false);
  }
  /** Step 8: the one form the owner fills. Creates the school, seeds tenant rows, creates the admin, signs them in. */
  async createSchool(input: InstallSchoolInput): Promise<{ schoolId: string; userId: string }> {
    const existing = await this.db.findOne<{ id: string }>('schools', {}, { orderBy: 'created_at ASC' });
    if (existing && (await this.status()).steps.find(s => s.step === 'school')?.status === 'done') throw new Error('school already created; continue at the next step');
    await this.mark('school', 'running');
    try {
      return await this.provisionSchool(input, existing, true);
    } catch (e) { await this.mark('school', 'failed', { error: (e as Error).message }); throw e; }
  }
  private async provisionSchool(input: InstallSchoolInput, existing: { id: string } | null, markInstaller: boolean): Promise<{ schoolId: string; userId: string }> {
    {
      const schoolId = existing?.id ?? ulid();
      // the code prefixes every document number, so it has to be unique across the tenants sharing
      // this database — two schools whose names truncate to the same eight letters get a suffix
      let code = input.schoolCode || slugify(input.schoolName).replace(/-/g, '').toUpperCase().slice(0, 8) || 'SCHOOL';
      if (!existing) {
        const base = code.slice(0, 6);
        for (let n = 2; await this.db.findOne('schools', { code }); n++) code = `${base}${n}`.slice(0, 8);
      }
      const result = await this.db.transaction(async tx => {
        if (!existing) await tx.insert('schools', { id: schoolId, code, name: input.schoolName, name_bn: input.schoolNameBn || null, institution_type: input.institutionType, timezone: 'Asia/Dhaka', currency: 'BDT', locale: input.locale, status: 'active', onboarded_at: nowSql() });
        await tx.insert('campuses', { id: ulid(), school_id: schoolId, name: 'Main Campus', code: 'MAIN', is_main: true, status: 'active' }).catch(() => undefined);
        await this.deps.outbox.emit(tx, { type: 'school.created', schoolId, aggregateType: 'core.school', aggregateId: schoolId, payload: { schoolId, name: input.schoolName, code } });
        return { schoolId };
      });
      await seed(this.db, { dbDir: this.config.dbDir, schoolId, log: m => this.deps.log.info(`seed: ${m}`) });
      const userId = await runWithContext(systemContext(schoolId), () => this.deps.auth.createUser({ schoolId, userType: 'admin', displayName: input.adminName, phone: input.adminPhone, email: input.adminEmail || null, password: input.adminPassword, locale: input.locale, roles: ['super_admin'] }));
      if (this.deps.afterSchool) await runWithContext(systemContext(schoolId, { userId }), () => this.deps.afterSchool!(schoolId, input));
      if (markInstaller) await this.mark('school', 'done', { schoolId, userId, code });
      return { ...result, userId };
    }
  }

  /** Step 9: write a file, tick the scheduler, relay an event through a rule, queue + render a PDF, try mail. */
  async runSelfTest(schoolId: string): Promise<Record<string, unknown>> {
    await this.mark('selftest', 'running');
    const checks: Record<string, unknown> = {};
    try {
      const stored = await this.adapters.storage.put(`${schoolId}/selftest/${Date.now()}.txt`, Buffer.from('Pathshala self-test'));
      checks.storage = { ok: true, path: stored.path, freeBytes: await this.adapters.storage.freeBytes() };
    } catch (e) { checks.storage = { ok: false, error: (e as Error).message }; }
    try {
      const tick = await this.adapters.scheduler.tick();
      checks.scheduler = { ok: tick.errors.length === 0, mode: this.adapters.scheduler.kind, ran: tick.ran, errors: tick.errors };
    } catch (e) { checks.scheduler = { ok: false, error: (e as Error).message }; }
    try {
      const ev = await this.deps.outbox.emitNow({ type: 'test.ping', schoolId, aggregateType: 'platform.selftest', aggregateId: schoolId, payload: { at: nowSql(), note: 'installer self-test' } });
      await this.deps.relay.run();
      const consumed = await this.db.count('event_consumptions', { event_uid: ev.uid, consumer: 'rules' });
      checks.automation = { ok: consumed > 0, eventUid: ev.uid };
    } catch (e) { checks.automation = { ok: false, error: (e as Error).message }; }
    try {
      const jobId = await this.adapters.queue.push({ name: 'pdf.render', queue: 'pdf', schoolId, payload: { text: `Self-test PDF · ${nowSql()} · বাংলা ঠিক আছে` }, triggeredBy: 'installer' });
      await this.adapters.queue.drain(3);
      const job = await this.db.findOne<Record<string, unknown>>('background_jobs', { id: jobId });
      checks.pdf = { ok: job?.status === 'success', status: job?.status, result: json(job?.result), error: job?.error ?? null };
    } catch (e) { checks.pdf = { ok: false, error: (e as Error).message }; }
    try {
      checks.mail = { kind: this.adapters.mail.kind, ok: await this.adapters.mail.verify() };
      if (this.adapters.mail.kind === 'smtp') await this.deps.notifications.notifyRole(schoolId, 'super_admin', { channels: ['email'], eventKey: 'installer.selftest', data: { url: this.config.appUrl, engine: this.db.engine }, respectQuietHours: false, immediate: true });
    } catch (e) { checks.mail = { ok: false, error: (e as Error).message }; }
    checks.push = { kind: this.adapters.push.kind, configured: !!this.adapters.push.publicKey() };
    checks.sms = { kind: this.adapters.sms.kind };
    await this.deps.notifications.notifyRole(schoolId, 'super_admin', { channels: ['in_app'], eventKey: 'installer.selftest', title: 'Pathshala is ready', body: 'Automation, queue and PDF rendering passed the self-test.', respectQuietHours: false });
    const ok = ['storage', 'scheduler', 'automation', 'pdf'].every(k => (checks[k] as { ok?: boolean })?.ok);
    await this.mark('selftest', ok ? 'done' : 'failed', checks);
    return { ok, checks };
  }

  /** Step 10: mark done, delete install.php / index.php, emit installer.completed. */
  async finish(schoolId: string) {
    const removed: string[] = [];
    for (const f of ['install.php', 'index.php']) {
      const p = path.join(this.config.rootDir, f);
      try { if (fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('Pathshala installer')) { fs.unlinkSync(p); removed.push(f); } } catch (e) { this.deps.log.warn(`could not remove ${f}`, e); }
    }
    // The Pathshala team's own console needs a door before it can be opened at all, and the install
    // is the only moment we can write one nobody has ever seen. It goes into .env and is returned
    // here — the installer shows it once, and after that it is only in the file on the server.
    if (!this.config.ownerDoor) {
      try {
        const door = randomDoor();
        writeDotenv(path.join(this.config.rootDir, '.env'), { OWNER_DOOR: door });
        this.config.env.OWNER_DOOR = door;
        (this.config as { ownerDoor: string | null }).ownerDoor = door;
        this.ownerDoorJustWritten = door;
      } catch (e) { this.deps.log.warn('could not write the owner door', e); }
    }
    if (!this.adapters.push.publicKey() && !this.config.env.VAPID_PUBLIC_KEY) {
      try { const k = WebPush.generateKeys(); writeDotenv(path.join(this.config.rootDir, '.env'), { VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: `mailto:admin@${new URL(this.config.appUrl).hostname}` }); } catch (e) { this.deps.log.warn('could not write VAPID keys', e); }
    }
    await this.mark('done', 'done', { removed, at: nowSql(), url: this.config.appUrl });
    const ownerDoorUrl = this.ownerDoorJustWritten ? `${this.config.appUrl}/${this.ownerDoorJustWritten}` : null;
    this.installedFlag = true;
    await this.deps.outbox.emitNow({ type: 'installer.completed', schoolId, aggregateType: 'core.school', aggregateId: schoolId, payload: { schoolId, engine: this.db.engine, url: this.config.appUrl } });
    // Under Passenger (release layout: <root>/app/server.js) touch tmp/restart.txt so the process restarts with the final .env
    const appDir = path.join(this.config.rootDir, 'app');
    if (fs.existsSync(path.join(appDir, 'server.js'))) { try { fs.mkdirSync(path.join(appDir, 'tmp'), { recursive: true }); fs.writeFileSync(path.join(appDir, 'tmp', 'restart.txt'), String(Date.now())); } catch { /* read-only app dir */ } }
    return { removed, ownerDoorUrl };
  }

  /** Written once, shown once: the path the vendor's own sign-in lives behind. */
  private ownerDoorJustWritten: string | null = null;
}

/** A door nobody can guess and a person can still read down a telephone. */
function randomDoor(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';               // no l/1, no o/0
  const bytes = randomBytes(16);
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}
