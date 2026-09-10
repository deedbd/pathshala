// A column added to db/schema/*.def.mjs must reach a school that is already installed.
// The baseline is applied once and never again, so this is the only thing standing between an
// update and a live database that is missing the column the new code selects.
//   node --test tests/migrate.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-mig');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'mig-key-'.padEnd(64, 'x'), CRON_KEY: 'cron-mig', UPLOADS_DIR: 'tests/.tmp-mig/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'error', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-mig/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');

let app, schoolId, engine;
const opened = [];
const t0 = Date.now();

/** A boot: the app starts, the schema pass runs in the background, and this waits for its report. */
async function boot() {
  const a = core.createApp({ rootDir: root });
  opened.push(a);
  await a.start();
  for (let i = 0; i < 200 && !a.installer.lastMigrate; i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(a.installer.lastMigrate, 'the boot reported what it did to the schema');
  return a;
}
const counted = r => r.added.tables.length + r.added.columns.length + r.added.indexes.length;
const drift = (r, table, column) => r.mismatched.find(m => m.table === table && m.column === column);

describe('schema reconcile', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    opened.push(app);
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    engine = app.db.engine;
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Migration School', schoolCode: 'MIG', institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: '01799999999', adminEmail: 'admin@mig.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
  });
  after(async () => { for (const a of opened) await a.stop().catch(() => {}); console.log(`migrate finished in ${Date.now() - t0} ms on ${engine}`); });

  test('a fresh install has nothing to bring forward', () => {
    const r = app.installer.lastMigrate;
    assert.ok(r.baseline, 'the baseline was applied');
    assert.deepEqual(r.failed, [], 'nothing was refused');
    assert.equal(counted(r), 0, `the baseline already has it all, but the reconcile added ${JSON.stringify(r.added)}`);
    assert.deepEqual(r.mismatched, [], `a fresh install must match itself: ${JSON.stringify(r.mismatched)}`);
  });

  test('an older database — missing columns, a table and an index — is brought forward at boot', async () => {
    const db = app.db;
    const q = n => db.quote(n);
    // 1. two columns of `schools` that a later release added (this is the schools.slug shape)
    await db.execute(`ALTER TABLE ${q('schools')} DROP COLUMN ${q('board')}`);
    await db.execute(`ALTER TABLE ${q('schools')} DROP COLUMN ${q('website')}`);
    // 2. a NOT NULL column with a default, on a table an automation back-fill writes to
    await db.execute(`ALTER TABLE ${q('scheduled_jobs')} DROP COLUMN ${q('timezone')}`);
    await db.execute(`DELETE FROM scheduled_jobs WHERE school_id = ?`, [schoolId]);
    // 3. a whole table nothing points at, and a group of three that point at each other (children first)
    await db.execute(`DROP TABLE ${q('currency_rates')}`);
    for (const t of ['student_transfers', 'school_group_members', 'school_groups']) await db.execute(`DROP TABLE ${q(t)}`);
    // 4. one index (not the one behind a foreign key — MySQL will not let that one go)
    await db.script(engine === 'mysql' ? `ALTER TABLE ${q('audit_logs')} DROP INDEX ${q('ix_audit_logs_school_id_created_at')}` : `DROP INDEX ${q('ix_audit_logs_school_id_created_at')}`);
    // 5. a table whose column type has moved: everything else about it is missing too
    const idType = engine === 'sqlite' ? 'TEXT' : 'CHAR(26)';
    // an older release built this table with the same generated SQL, so it carries the same charset:
    // MySQL refuses a foreign key between two CHAR columns that collate differently, and a stub left
    // on the server's own default would be testing that refusal rather than the reconciler
    const opts = engine === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' : '';
    await db.execute(`DROP TABLE ${q('kpi_daily')}`);
    await db.script(`CREATE TABLE ${q('kpi_daily')} (${q('id')} ${idType} NOT NULL, ${q('students_active')} VARCHAR(20), PRIMARY KEY (${q('id')}))${opts}`);
    await app.stop();

    const next = await boot();
    const r = next.installer.lastMigrate;
    assert.deepEqual(r.failed, [], `the database refused something: ${JSON.stringify(r.failed)}`);
    assert.ok(r.added.columns.includes('schools.board') && r.added.columns.includes('schools.website'), JSON.stringify(r.added.columns));
    assert.ok(r.added.columns.includes('scheduled_jobs.timezone'), JSON.stringify(r.added.columns));
    for (const t of ['currency_rates', 'student_transfers', 'school_group_members', 'school_groups']) assert.ok(r.added.tables.includes(t), `${t} was not rebuilt: ${JSON.stringify(r.added.tables)}`);
    assert.ok(r.added.indexes.includes('audit_logs(school_id, created_at)'), JSON.stringify(r.added.indexes));
    assert.ok(r.added.columns.includes('kpi_daily.day'), 'the missing columns of a half-built table are added too');

    // the columns are real: a select that names them works
    await next.db.query(`SELECT board, website FROM schools WHERE id = ?`, [schoolId]);
    // the default and the NOT NULL came back with the column
    await next.db.insert('scheduled_jobs', { id: 'MIGTESTJOB0000000000000001', school_id: schoolId, job_key: 'test.default', cron_expr: '0 0 * * *', is_active: true });
    const job = await next.db.findOne('scheduled_jobs', { id: 'MIGTESTJOB0000000000000001' });
    assert.equal(job.timezone, 'Asia/Dhaka', 'the column came back with its default');
    await next.db.delete('scheduled_jobs', { id: 'MIGTESTJOB0000000000000001' });
    // the table came back with its unique key, not just its columns
    const row = { id: 'MIGTESTRATE000000000000001', base_ccy: 'BDT', quote_ccy: 'USD', rate: 0.0091, as_of: '2026-01-01', source: 'test' };
    await next.db.insert('currency_rates', row);
    await assert.rejects(() => next.db.insert('currency_rates', { ...row, id: 'MIGTESTRATE000000000000002' }), 'the unique key on (base, quote, as_of) is back');
    await next.db.delete('currency_rates', { id: 'MIGTESTRATE000000000000001' });

    // a column whose type has moved is reported and left exactly as it was
    const moved = drift(r, 'kpi_daily', 'students_active');
    assert.ok(moved && /type differs/.test(moved.note), `expected a type mismatch, got ${JSON.stringify(r.mismatched)}`);
    await next.db.insert('kpi_daily', { id: 'MIGTESTKPI0000000000000001', school_id: schoolId, day: '2026-01-01', students_active: 'still text' });
    assert.equal((await next.db.findOne('kpi_daily', { id: 'MIGTESTKPI0000000000000001' })).students_active, 'still text', 'the live column was not retyped');
    await next.db.delete('kpi_daily', { id: 'MIGTESTKPI0000000000000001' });

    // the back-fills follow the columns: the automation catalogue is re-seeded in the same boot,
    // which it could not be while `scheduled_jobs.timezone` was missing (syncCatalogue writes it).
    assert.ok(await next.db.count('scheduled_jobs', { school_id: schoolId }) > 0, 'the school got its scheduled jobs back in the same pass');
  });

  test('a second boot adds nothing, and still reports what it will not touch', async () => {
    const again = await boot();
    const r = again.installer.lastMigrate;
    assert.equal(counted(r), 0, `a second run must be a no-op, but it added ${JSON.stringify(r.added)}`);
    assert.deepEqual(r.failed, []);
    assert.ok(drift(r, 'kpi_daily', 'students_active'), 'the difference it will not guess at is still reported');
  });
});
