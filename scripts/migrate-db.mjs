#!/usr/bin/env node
// Move a school off SQLite and onto MySQL (or Postgres) without losing a row.
//
//   node scripts/migrate-db.mjs --from sqlite:storage/pathshala.db --to mysql://user:pass@localhost/school
//   node scripts/migrate-db.mjs --from sqlite:storage/pathshala.db --to "$DB_URL" --check
//
// The target schema is created by the same migrations the installer runs, then every row is copied in
// chunks and the row counts are compared on both sides. Nothing is deleted from the source: switch
// DB_URL in .env only once the counts match, and keep the SQLite file until the school is happy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, all) => (a.startsWith('--') ? [[a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]]] : [])));
if (!args.from || !args.to) {
  console.error('usage: node scripts/migrate-db.mjs --from sqlite:<path> --to <url> [--check] [--chunk 500]');
  process.exit(2);
}

const { connect, dbConfigFromEnv } = await import(`file://${path.join(root, 'packages/db/dist/index.js').replace(/\\/g, '/')}`);
const { migrate } = await import(`file://${path.join(root, 'packages/db/dist/index.js').replace(/\\/g, '/')}`).then(m => ({ migrate: m.migrate ?? null }));

const parse = spec => {
  if (String(spec).startsWith('sqlite:')) return { engine: 'sqlite', sqlitePath: path.resolve(root, String(spec).slice(7)) };
  return dbConfigFromEnv({ DB_URL: String(spec) }, root);
};

const from = connect(parse(args.from));
const to = connect(parse(args.to));
console.log(`from ${from.engine} → to ${to.engine}`);

// the target gets the schema the same way a fresh install does
const schemaFile = path.join(root, 'db', to.engine, 'schema.sql');
if (!fs.existsSync(schemaFile)) { console.error(`no schema for ${to.engine} at ${schemaFile}`); process.exit(2); }
const existing = await to.tables();
if (!existing.length) {
  const r = await to.script(fs.readFileSync(schemaFile, 'utf8'), { ignore: err => /already exists/i.test(err.message) });
  console.log(`created the schema on the target: ${r.ran} statements`);
} else {
  console.log(`the target already has ${existing.length} tables; rows will be added to them`);
}

const core = await import(`file://${path.join(root, 'packages/core/dist/index.js').replace(/\\/g, '/')}`);
const platform = new core.PlatformService(from, { emitNow: async () => undefined }, { notifyRole: async () => [] }, { get: async () => null }, { queue: { kind: 'db' }, scheduler: { kind: 'db' }, storage: { kind: 'local' } }, root, console);

if (!args.check) {
  const started = Date.now();
  const moved = await platform.migrateTo(to, { chunk: Number(args.chunk ?? 500) });
  console.log(`moved ${moved.rows} rows across ${moved.tables} tables in ${Math.round((Date.now() - started) / 1000)}s`);
}

const compare = await platform.compareWith(to);
if (compare.matched) {
  console.log('every table has the same number of rows on both sides.');
  console.log('now point DB_URL in .env at the new database and restart. Keep the old file until you are sure.');
} else {
  console.error('these tables do not match:');
  for (const d of compare.differences) console.error(`  ${d.table}: ${d.here} here, ${d.there} there`);
}
await from.close(); await to.close();
process.exit(compare.matched ? 0 : 1);
