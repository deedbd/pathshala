import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './types.js';
import { nowSql } from './sql.js';

/**
 * Boot-time migrations.
 *  1. `schema_migrations` bookkeeping table.
 *  2. Baseline: db/<engine>/schema.sql (generated from db/schema/*.def.mjs) applied idempotently —
 *     every CREATE becomes IF NOT EXISTS and duplicate keys/constraints are skipped, so an
 *     interrupted install simply resumes on the next boot.
 *  3. Deltas: db/migrations/<engine>/NNNN_name.sql in order, each recorded once.
 */
export interface MigrateResult { baseline: boolean; applied: string[]; statements: number; }

export async function migrate(db: Db, dbDir: string, log: (msg: string) => void = () => {}): Promise<MigrateResult> {
  await db.script(`CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(160) NOT NULL, applied_at VARCHAR(30) NOT NULL, PRIMARY KEY (name));`);
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map(r => r.name));
  const result: MigrateResult = { baseline: false, applied: [], statements: 0 };

  if (!done.has('0000_baseline')) {
    const file = path.join(dbDir, db.engine, 'schema.sql');
    if (!fs.existsSync(file)) throw new Error(`schema file missing: ${file}`);
    log(`applying baseline schema from ${file}`);
    const sql = idempotent(fs.readFileSync(file, 'utf8'), db.engine);
    const r = await db.script(sql, { ignore: isAlreadyExists });
    result.statements += r.ran;
    await db.insert('schema_migrations', { name: '0000_baseline', applied_at: nowSql() });
    result.baseline = true;
    log(`baseline done: ${r.ran} statements, ${r.skipped} already present`);
  }

  const dir = path.join(dbDir, 'migrations', db.engine);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort() : [];
  for (const f of files) {
    const name = f.replace(/\.sql$/, '');
    if (done.has(name)) continue;
    log(`applying migration ${name}`);
    const r = await db.script(fs.readFileSync(path.join(dir, f), 'utf8'), { ignore: isAlreadyExists });
    result.statements += r.ran;
    await db.insert('schema_migrations', { name, applied_at: nowSql() });
    result.applied.push(name);
  }
  return result;
}

function idempotent(sql: string, engine: string): string {
  if (engine === 'postgres') return sql; // generator already emits IF NOT EXISTS + guarded FKs
  return sql
    .replace(/^CREATE TABLE `/gm, 'CREATE TABLE IF NOT EXISTS `')
    .replace(/^CREATE INDEX `/gm, 'CREATE INDEX IF NOT EXISTS `')
    .replace(/^CREATE UNIQUE INDEX `/gm, 'CREATE UNIQUE INDEX IF NOT EXISTS `');
}

function isAlreadyExists(err: Error & { code?: string; errno?: number }): boolean {
  const m = err.message || '';
  // MySQL/MariaDB: 1061 duplicate key name, 1826 duplicate FK, 1022/1050 exists, 1005/121 constraint exists; SQLite/Postgres: "already exists"
  return [1061, 1826, 1022, 1050, 1005, 121].includes(err.errno ?? -1)
    || ['ER_DUP_KEYNAME', 'ER_FK_DUP_NAME', 'ER_TABLE_EXISTS_ERROR', 'ER_DUP_KEY', 'ER_CANT_CREATE_TABLE'].includes(err.code ?? '')
    || /already exists|Duplicate (key|foreign key|constraint)|errno:? 121\b/i.test(m);
}
