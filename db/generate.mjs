#!/usr/bin/env node
/**
 * Pathshala schema generator.
 *   node db/generate.mjs
 * Reads db/schema/*.def.mjs (one compact definition per module group) and writes:
 *   db/mysql/schema.sql     MySQL 8 / MariaDB 10.6+  (cPanel shared hosting — primary)
 *   db/sqlite/schema.sql    SQLite 3                  (zero-config fallback used by the installer)
 *   db/postgres/schema.sql  PostgreSQL 14+            (VPS/Docker deployments)
 *   db/schema.json          machine-readable model    (schema explorer, docs, code generators)
 *   db/SCHEMA.md            human-readable reference
 *
 * Column DSL (one column per line inside `cols`):
 *   name  type  [flags…]  [# description]
 *   types : ulid str str(n) text long int big small bool money pct dec(p,s) float date dt time json enum(a|b|c)
 *   flags : !  required      u  unique      i  index      >table  foreign key (cascade)
 *           >table:null  FK set-null      >table:restrict  FK restrict      =value  default (now|true|false|number|'text')
 * Every table gets: id CHAR(26) ULID primary key, school_id (unless tenant:false), created_at/updated_at (unless ts:false),
 * deleted_at when soft:true.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defDir = path.join(here, 'schema');
const files = fs.readdirSync(defDir).filter(f => f.endsWith('.def.mjs')).sort();
const modules = [];
for (const f of files) { const m = await import(path.join(defDir, f).replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:')); modules.push(...m.default); }

/* ---------- parse ---------- */
function parseCols(src) {
  const out = [];
  for (let raw of src.split('\n')) {
    let desc = '';
    const hash = raw.indexOf('#'); if (hash >= 0) { desc = raw.slice(hash + 1).trim(); raw = raw.slice(0, hash); }
    const parts = raw.trim().split(/\s+/).filter(Boolean); if (!parts.length) continue;
    const [name, typeRaw, ...flags] = parts; if (!typeRaw) throw new Error(`column "${name}" has no type`);
    const tm = typeRaw.match(/^(\w+)(?:\((.*)\))?$/); if (!tm) throw new Error(`bad type ${typeRaw} for ${name}`);
    const col = { name, type: tm[1], args: tm[2] ?? null, req: false, unique: false, index: false, fk: null, def: undefined, desc };
    for (const f of flags) {
      if (f === '!') col.req = true; else if (f === 'u') col.unique = true; else if (f === 'i') col.index = true;
      else if (f.startsWith('>')) { const [t, act] = f.slice(1).split(':'); col.fk = { table: t, onDelete: act === 'null' ? 'SET NULL' : act === 'restrict' ? 'RESTRICT' : 'CASCADE' }; if (act === 'null') col.req = false; }
      else if (f.startsWith('=')) col.def = f.slice(1);
      else throw new Error(`unknown flag ${f} on ${name}`);
    }
    if (col.type === 'enum' && !col.args) throw new Error(`enum ${name} needs values`);
    out.push(col);
  }
  return out;
}
const tables = []; const byName = {};
for (const mod of modules) {
  for (const [tname, t] of Object.entries(mod.tables)) {
    const cols = [{ name: 'id', type: 'ulid', req: true, pk: true, desc: 'ULID primary key' }];
    if (t.tenant !== false) cols.push({ name: 'school_id', type: 'ulid', req: true, index: true, fk: { table: 'schools', onDelete: 'CASCADE' }, desc: 'Tenant' });
    cols.push(...parseCols(t.cols || ''));
    if (t.ts !== false) { cols.push({ name: 'created_at', type: 'dt', req: true, def: 'now', desc: '' }, { name: 'updated_at', type: 'dt', req: true, def: 'now', onUpdate: true, desc: '' }); }
    if (t.soft) cols.push({ name: 'deleted_at', type: 'dt', req: false, desc: 'Soft delete' });
    const tbl = { name: tname, module: mod.key, desc: t.desc || '', cols, unique: t.unique || [], index: t.index || [] };
    tables.push(tbl); if (byName[tname]) throw new Error(`duplicate table ${tname}`); byName[tname] = tbl;
  }
}
for (const t of tables) for (const c of t.cols) if (c.fk && !byName[c.fk.table]) throw new Error(`${t.name}.${c.name} → unknown table ${c.fk.table}`);

/* ---------- emit ---------- */
const q = s => `\`${s}\``;
const lit = v => v == null ? null : v === 'now' ? 'CURRENT_TIMESTAMP' : v === 'true' ? '1' : v === 'false' ? '0' : /^-?\d+(\.\d+)?$/.test(v) ? v : `'${String(v).replace(/^'|'$/g, '').replace(/'/g, "''")}'`;
const enumVals = c => c.args.split('|').map(s => `'${s.trim()}'`).join(', ');
function mysqlType(c) {
  switch (c.type) {
    case 'ulid': return 'CHAR(26)'; case 'str': return `VARCHAR(${c.args || 255})`; case 'text': return 'TEXT'; case 'long': return 'LONGTEXT';
    case 'int': return 'INT'; case 'big': return 'BIGINT'; case 'small': return 'SMALLINT'; case 'bool': return 'TINYINT(1)';
    case 'money': return 'DECIMAL(14,2)'; case 'pct': return 'DECIMAL(5,2)'; case 'dec': return `DECIMAL(${c.args})`; case 'float': return 'DOUBLE';
    case 'date': return 'DATE'; case 'dt': return 'DATETIME'; case 'time': return 'TIME'; case 'json': return 'JSON'; case 'enum': return 'VARCHAR(40)';
    default: throw new Error(`unknown type ${c.type}`);
  }
}
function sqliteType(c) {
  switch (c.type) {
    case 'int': case 'big': case 'small': case 'bool': return 'INTEGER'; case 'money': case 'pct': case 'dec': case 'float': return 'NUMERIC'; default: return 'TEXT';
  }
}
let my = `-- Pathshala · MySQL 8 / MariaDB 10.6+ schema · generated by db/generate.mjs · ${tables.length} tables\n-- Do not edit by hand: change db/schema/*.def.mjs and re-run the generator.\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\n`;
let lite = `-- Pathshala · SQLite fallback schema · generated by db/generate.mjs · ${tables.length} tables\nPRAGMA foreign_keys = ON;\nPRAGMA journal_mode = WAL;\n\n`;
const fkAlters = [];
let curMod = '';
for (const t of tables) {
  if (t.module !== curMod) { curMod = t.module; const m = modules.find(x => x.key === curMod); my += `\n-- ============ ${m.title} ============\n`; lite += `\n-- ============ ${m.title} ============\n`; }
  const myLines = [], liteLines = [], checks = [];
  for (const c of t.cols) {
    let d = `  ${q(c.name)} ${mysqlType(c)}`;
    d += c.req ? ' NOT NULL' : ' NULL';
    if (c.def !== undefined && c.type !== 'json') d += ` DEFAULT ${lit(c.def)}`;
    if (c.onUpdate) d += ' ON UPDATE CURRENT_TIMESTAMP';
    if (c.desc) d += ` COMMENT '${c.desc.replace(/'/g, "''").slice(0, 1000)}'`;
    myLines.push(d);
    let s = `  ${q(c.name)} ${sqliteType(c)}`; if (c.req) s += ' NOT NULL';
    if (c.def !== undefined) s += ` DEFAULT ${c.def === 'now' ? "(strftime('%Y-%m-%d %H:%M:%f','now'))" : lit(c.def)}`;
    if (c.fk) s += ` REFERENCES ${q(c.fk.table)}(${q('id')}) ON DELETE ${c.fk.onDelete}`;
    liteLines.push(s);
    if (c.type === 'enum') checks.push(`CHECK (${q(c.name)} IN (${enumVals(c)}))`);
    if (c.fk) fkAlters.push(`ALTER TABLE ${q(t.name)} ADD CONSTRAINT ${q(`fk_${t.name}_${c.name}`.slice(0, 64))} FOREIGN KEY (${q(c.name)}) REFERENCES ${q(c.fk.table)} (${q('id')}) ON DELETE ${c.fk.onDelete};`);
  }
  const keys = [`  PRIMARY KEY (${q('id')})`]; const seen = new Set();
  const ixName = cols => `ix_${t.name}_${cols.join('_')}`.slice(0, 64);
  for (const c of t.cols) { if (c.unique && !c.pk) keys.push(`  UNIQUE KEY ${q(`uq_${t.name}_${c.name}`.slice(0, 64))} (${q(c.name)})`); else if ((c.index || c.fk) && !c.pk) { seen.add(ixName([c.name])); keys.push(`  KEY ${q(ixName([c.name]))} (${q(c.name)})`); } }
  for (const u of t.unique) keys.push(`  UNIQUE KEY ${q(`uq_${t.name}_${u.join('_')}`.slice(0, 64))} (${u.map(q).join(', ')})`);
  t.index = t.index.filter(ix => !seen.has(ixName(ix)));
  for (const ix of t.index) keys.push(`  KEY ${q(ixName(ix))} (${ix.map(q).join(', ')})`);
  my += `CREATE TABLE ${q(t.name)} (\n${[...myLines, ...keys, ...checks.map(c => '  ' + c)].join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='${t.desc.replace(/'/g, "''").slice(0, 2000)}';\n\n`;
  const lkeys = [`  PRIMARY KEY (${q('id')})`, ...t.unique.map(u => `  UNIQUE (${u.map(q).join(', ')})`), ...t.cols.filter(c => c.unique && !c.pk).map(c => `  UNIQUE (${q(c.name)})`), ...checks.map(c => '  ' + c)];
  lite += `CREATE TABLE ${q(t.name)} (\n${[...liteLines, ...lkeys].join(',\n')}\n);\n`;
  for (const c of t.cols) if ((c.index || c.fk) && !c.pk && !c.unique) lite += `CREATE INDEX ${q(`ix_${t.name}_${c.name}`)} ON ${q(t.name)} (${q(c.name)});\n`;
  for (const ix of t.index) lite += `CREATE INDEX ${q(`ix_${t.name}_${ix.join('_')}`)} ON ${q(t.name)} (${ix.map(q).join(', ')});\n`;
  lite += '\n';
}
my += `\n-- ============ foreign keys ============\n${fkAlters.join('\n')}\nSET FOREIGN_KEY_CHECKS = 1;\n`;

fs.mkdirSync(path.join(here, 'mysql'), { recursive: true }); fs.mkdirSync(path.join(here, 'sqlite'), { recursive: true });
fs.writeFileSync(path.join(here, 'mysql', 'schema.sql'), my);
fs.writeFileSync(path.join(here, 'sqlite', 'schema.sql'), lite);

/* ---------- postgres (VPS/Docker) ---------- */
function pgType(c) {
  switch (c.type) {
    case 'ulid': return 'CHAR(26)'; case 'str': return `VARCHAR(${c.args || 255})`; case 'text': case 'long': return 'TEXT';
    case 'int': return 'INTEGER'; case 'big': return 'BIGINT'; case 'small': return 'SMALLINT'; case 'bool': return 'BOOLEAN';
    case 'money': return 'NUMERIC(14,2)'; case 'pct': return 'NUMERIC(5,2)'; case 'dec': return `NUMERIC(${c.args})`; case 'float': return 'DOUBLE PRECISION';
    case 'date': return 'DATE'; case 'dt': return 'TIMESTAMP(3)'; case 'time': return 'TIME'; case 'json': return 'JSONB'; case 'enum': return 'VARCHAR(40)';
    default: throw new Error(`unknown type ${c.type}`);
  }
}
const pgLit = (c, v) => v === 'now' ? 'CURRENT_TIMESTAMP' : c.type === 'bool' ? (v === 'true' || v === '1' ? 'TRUE' : 'FALSE') : lit(v);
const pq = s => '"' + s + '"';
let pg = `-- Pathshala · PostgreSQL 14+ schema (VPS/Docker) · generated by db/generate.mjs · ${tables.length} tables\n-- Do not edit by hand: change db/schema/*.def.mjs and re-run the generator.\n\n`;
const pgFks = [];
curMod = '';
for (const t of tables) {
  if (t.module !== curMod) { curMod = t.module; const m = modules.find(x => x.key === curMod); pg += `\n-- ============ ${m.title} ============\n`; }
  const lines = [], checks = [];
  for (const c of t.cols) {
    let d = `  ${pq(c.name)} ${pgType(c)}`; if (c.req) d += ' NOT NULL';
    if (c.def !== undefined && c.type !== 'json') d += ` DEFAULT ${pgLit(c, c.def)}`;
    lines.push(d);
    if (c.type === 'enum') checks.push(`CHECK (${pq(c.name)} IN (${enumVals(c)}))`);
    if (c.fk) pgFks.push(`ALTER TABLE ${pq(t.name)} ADD CONSTRAINT ${pq(`fk_${t.name}_${c.name}`.slice(0, 63))} FOREIGN KEY (${pq(c.name)}) REFERENCES ${pq(c.fk.table)} ("id") ON DELETE ${c.fk.onDelete}`);
  }
  const keys = ['  PRIMARY KEY ("id")', ...t.unique.map(u => `  UNIQUE (${u.map(pq).join(', ')})`), ...t.cols.filter(c => c.unique && !c.pk).map(c => `  UNIQUE (${pq(c.name)})`), ...checks.map(c => '  ' + c)];
  pg += `CREATE TABLE IF NOT EXISTS ${pq(t.name)} (\n${[...lines, ...keys].join(',\n')}\n);\n`;
  for (const c of t.cols) if ((c.index || c.fk) && !c.pk && !c.unique) pg += `CREATE INDEX IF NOT EXISTS ${pq(`ix_${t.name}_${c.name}`.slice(0, 63))} ON ${pq(t.name)} (${pq(c.name)});\n`;
  for (const ix of t.index) pg += `CREATE INDEX IF NOT EXISTS ${pq(`ix_${t.name}_${ix.join('_')}`.slice(0, 63))} ON ${pq(t.name)} (${ix.map(pq).join(', ')});\n`;
  pg += '\n';
}
pg += `\n-- ============ foreign keys (idempotent) ============\n${pgFks.map(f => `DO $$ BEGIN ${f}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`).join('\n')}\n`;
fs.mkdirSync(path.join(here, 'postgres'), { recursive: true });
fs.writeFileSync(path.join(here, 'postgres', 'schema.sql'), pg);


/* ---------- json + markdown ---------- */
const json = { generated: new Date().toISOString(), tables: tables.length, columns: tables.reduce((a, t) => a + t.cols.length, 0), modules: modules.map(m => ({ key: m.key, title: m.title, group: m.group, color: m.color, desc: m.desc, year: m.year || 1, tables: tables.filter(t => t.module === m.key).map(t => ({ name: t.name, desc: t.desc, cols: t.cols.map(c => ({ name: c.name, type: c.type + (c.args ? `(${c.args})` : ''), req: !!c.req, unique: !!c.unique, fk: c.fk ? c.fk.table : null, def: c.def ?? null, desc: c.desc || '' })), unique: t.unique, index: t.index })) })) };
fs.writeFileSync(path.join(here, 'schema.json'), JSON.stringify(json));
let md = `# Pathshala schema reference\n\nGenerated from \`db/schema/*.def.mjs\` · ${tables.length} tables · ${json.columns} columns · MySQL 8 / MariaDB 10.6+ (primary) and SQLite (fallback).\n\n`;
for (const m of json.modules) { md += `## ${m.title}\n\n${m.desc}\n\n`; for (const t of m.tables) { md += `### \`${t.name}\`\n${t.desc}\n\n| Column | Type | Notes |\n|---|---|---|\n`; for (const c of t.cols) md += `| ${c.name} | ${c.type} | ${[c.req ? 'required' : '', c.unique ? 'unique' : '', c.fk ? '→ ' + c.fk : '', c.def != null ? 'default ' + c.def : '', c.desc].filter(Boolean).join(' · ')} |\n`; md += '\n'; } }
fs.writeFileSync(path.join(here, 'SCHEMA.md'), md);
console.log(`ok · ${modules.length} modules · ${tables.length} tables · ${json.columns} columns → db/mysql/schema.sql, db/sqlite/schema.sql, db/postgres/schema.sql, db/schema.json, db/SCHEMA.md`);
