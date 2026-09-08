import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './types.js';
import { nowSql } from './sql.js';
import { isAlreadyExists, reconcile, type ReconcileResult, type SchemaDrift } from './reconcile.js';

/**
 * Boot-time migrations.
 *  1. `schema_migrations` bookkeeping table.
 *  2. Baseline: db/<engine>/schema.sql (generated from db/schema/*.def.mjs) applied idempotently —
 *     every CREATE becomes IF NOT EXISTS and duplicate keys/constraints are skipped, so an
 *     interrupted install simply resumes on the next boot.
 *  3. Deltas: db/migrations/<engine>/NNNN_name.sql in order, each recorded once.
 *  4. Reconcile: the baseline is applied once and never again, so a column added to the schema
 *     definitions after a school was installed would never reach it. `reconcile()` compares the
 *     shipped shape against the live one on every boot and adds what is missing — see reconcile.ts
 *     for what it will and will not touch.
 */
export interface MigrateResult {
  baseline: boolean;
  applied: string[];
  statements: number;
  added: ReconcileResult['added'];
  mismatched: SchemaDrift[];
  failed: ReconcileResult['failed'];
}

export async function migrate(db: Db, dbDir: string, log: (msg: string) => void = () => {}): Promise<MigrateResult> {
  await db.script(`CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(160) NOT NULL, applied_at VARCHAR(30) NOT NULL, PRIMARY KEY (name));`);
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map(r => r.name));
  const result: MigrateResult = { baseline: false, applied: [], statements: 0, added: { tables: [], columns: [], indexes: [] }, mismatched: [], failed: [] };

  const file = path.join(dbDir, db.engine, 'schema.sql');
  if (!fs.existsSync(file)) throw new Error(`schema file missing: ${file}`);
  const schemaSql = fs.readFileSync(file, 'utf8');

  if (!done.has('0000_baseline')) {
    log(`applying baseline schema from ${file}`);
    const sql = idempotent(schemaSql, db.engine);
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

  const r = await reconcile(db, schemaSql, log);
  result.added = r.added; result.mismatched = r.mismatched; result.failed = r.failed; result.statements += r.statements;
  return result;
}

function idempotent(sql: string, engine: string): string {
  if (engine === 'postgres') return sql; // generator already emits IF NOT EXISTS + guarded FKs
  return sql
    .replace(/^CREATE TABLE `/gm, 'CREATE TABLE IF NOT EXISTS `')
    .replace(/^CREATE INDEX `/gm, 'CREATE INDEX IF NOT EXISTS `')
    .replace(/^CREATE UNIQUE INDEX `/gm, 'CREATE UNIQUE INDEX IF NOT EXISTS `');
}
