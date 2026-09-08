import type { Db } from './types.js';
import { splitStatements } from './sql.js';

/**
 * Bring an already-installed database up to the shape this build ships.
 *
 * `migrate()` applies the baseline once and then looks for hand-written deltas. A column added to
 * `db/schema/*.def.mjs` therefore exists on a fresh install and is missing on every school already
 * running — and the first query that names it throws. This closes that gap at boot: it reads the
 * shipped shape, reads the live shape, and **adds what is missing and nothing else**.
 *
 * What it will do: create a table that does not exist, add a column that does not exist (with its
 * default and nullability), create an index or unique key that does not exist.
 * What it will never do: drop, rename, retype, or widen anything. A column whose type or nullability
 * has moved is *reported* and left exactly as it is — a school's data is not a place to guess.
 *
 * The shipped shape is read from the generated `db/<engine>/schema.sql`, not `db/schema.json`:
 * schema.json drops the per-column index flag and carries the DSL type rather than the engine's, so
 * it can say neither which index is missing nor what DDL would add a column. Both files come from
 * the same generator run.
 */
export interface SchemaDrift { table: string; column?: string; expected: string; actual: string; note: string }
export interface ReconcileResult {
  added: { tables: string[]; columns: string[]; indexes: string[] };
  /** Differences that exist but cannot be changed safely. Reported, never applied. */
  mismatched: SchemaDrift[];
  /** Statements the database refused. A build that needs one of these is not safely installed. */
  failed: { statement: string; error: string }[];
  statements: number;
}

interface ShippedColumn { name: string; ddl: string; type: string; notNull: boolean; def: string | null }
interface ShippedIndex { name: string; unique: boolean; cols: string[] }
interface ShippedTable { name: string; create: string; cols: ShippedColumn[]; indexes: ShippedIndex[]; after: string[] }

export async function reconcile(db: Db, schemaSql: string, log: (msg: string) => void = () => {}): Promise<ReconcileResult> {
  const result: ReconcileResult = { added: { tables: [], columns: [], indexes: [] }, mismatched: [], failed: [], statements: 0 };
  const shipped = readShipped(schemaSql);
  const live = await readLive(db);

  const run = async (sql: string, done: () => void) => {
    try { await db.attempt(() => db.script(sql)); result.statements++; done(); }
    // Postgres aborts a whole transaction on a failed statement; `attempt` fences each one so a
    // refusal here does not take the rest of the pass with it. Passenger can start two processes at
    // once and both will reconcile: losing that race means the column is there, which is the answer.
    catch (e) { if (!isAlreadyExists(e as Error)) result.failed.push({ statement: sql.replace(/\s+/g, ' ').slice(0, 200), error: (e as Error).message }); }
  };

  const pending: string[] = [];                               // indexes and foreign keys of new tables
  for (const table of shipped.values()) {
    const have = live.get(table.name);
    if (!have) {                                              // whole table missing
      await run(table.create, () => result.added.tables.push(table.name));
      pending.push(...table.after);
      continue;
    }
    for (const col of table.cols) {
      const actual = have.cols.get(col.name);
      if (!actual) {
        const { sql, note } = addColumn(db, table.name, col);
        let added = false;
        await run(sql, () => {
          added = true;
          result.added.columns.push(`${table.name}.${col.name}`);
          if (note) result.mismatched.push({ table: table.name, column: col.name, expected: col.ddl, actual: 'added, weakened', note });
        });
        // MySQL and Postgres carry each foreign key as its own statement, so a column that has one
        // gets it here. Every row's value is null or the default, which no foreign key objects to.
        const fk = table.after.find(s => new RegExp(`FOREIGN KEY \\([\`"]${col.name}[\`"]\\)`, 'i').test(s));
        if (added && fk) await run(fk, () => {});
        continue;
      }
      const want = normType(col.type), got = normType(actual.type);
      if (want && got && want !== got) result.mismatched.push({ table: table.name, column: col.name, expected: col.type, actual: actual.type, note: 'column type differs; retyping a live column is not safe to guess, so it was left alone' });
      else if (col.notNull && actual.nullable) result.mismatched.push({ table: table.name, column: col.name, expected: 'NOT NULL', actual: 'NULL', note: 'existing rows may have no value; NOT NULL was not applied' });
    }
    for (const ix of table.indexes) {
      // Matched by column list, not by name: the generator names an index only on MySQL, so the same
      // unique constraint is `uq_schools_code`, `sqlite_autoindex_schools_1` or `schools_code_key`.
      if (have.indexes.has(key(ix.unique, ix.cols))) continue;
      if (!ix.unique && have.indexes.has(key(true, ix.cols))) continue;   // a unique index already covers it
      const sql = `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${db.quote(ix.name)} ON ${db.quote(table.name)} (${ix.cols.map(c => db.quote(c)).join(', ')})`;
      await run(sql, () => result.added.indexes.push(`${table.name}(${ix.cols.join(', ')})`));
    }
  }
  // Last, once every table exists: a new table's foreign key can point at another new table that the
  // file defines after it, and on MySQL the constraint is a separate statement that would fail.
  for (const stmt of pending) await run(stmt, () => {});

  const n = result.added.tables.length + result.added.columns.length + result.added.indexes.length;
  if (n) log(`schema brought forward: ${describe(result)}`);
  return result;
}

export function describe(r: ReconcileResult): string {
  const bits: string[] = [];
  if (r.added.tables.length) bits.push(`${r.added.tables.length} table(s) [${r.added.tables.join(', ')}]`);
  if (r.added.columns.length) bits.push(`${r.added.columns.length} column(s) [${r.added.columns.join(', ')}]`);
  if (r.added.indexes.length) bits.push(`${r.added.indexes.length} index(es) [${r.added.indexes.join(', ')}]`);
  return bits.length ? `added ${bits.join(', ')}` : 'nothing to add';
}

/**
 * A statement that failed because somebody else already did it. Two Passenger processes booting at
 * the same moment both run this pass, and the loser must not report the winner's work as a failure.
 */
export function isAlreadyExists(err: Error & { code?: string; errno?: number }): boolean {
  const m = err.message || '';
  // MySQL/MariaDB: 1060 duplicate column, 1061 duplicate key name, 1826 duplicate FK, 1022/1050 exists, 1005/121 constraint exists
  return [1060, 1061, 1826, 1022, 1050, 1005, 121].includes(err.errno ?? -1)
    || ['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME', 'ER_FK_DUP_NAME', 'ER_TABLE_EXISTS_ERROR', 'ER_DUP_KEY', 'ER_CANT_CREATE_TABLE'].includes(err.code ?? '')
    || /already exists|duplicate column|Duplicate column|Duplicate (key|foreign key|constraint)|errno:? 121\b/i.test(m);
}

/* ---------- the shape this build ships (generated db/<engine>/schema.sql) ---------- */

function readShipped(sql: string): Map<string, ShippedTable> {
  const tables = new Map<string, ShippedTable>();
  for (const stmt of splitStatements(sql)) {
    const create = stmt.match(/^CREATE TABLE (?:IF NOT EXISTS )?[`"]([^`"]+)[`"]\s*\(/i);
    if (create) { tables.set(create[1], parseCreate(create[1], stmt)); continue; }
    const index = stmt.match(/^CREATE (UNIQUE )?INDEX (?:IF NOT EXISTS )?[`"]([^`"]+)[`"] ON [`"]([^`"]+)[`"]\s*\(([^)]*)\)/i);
    if (index) {
      const t = tables.get(index[3]);
      if (t) { t.indexes.push({ name: index[2], unique: !!index[1], cols: cols(index[4]) }); t.after.push(stmt); }
      continue;
    }
    const fk = stmt.match(/ALTER TABLE [`"]([^`"]+)[`"] ADD CONSTRAINT/i);   // MySQL tail, and Postgres inside DO $$
    if (fk) tables.get(fk[1])?.after.push(stmt);
  }
  return tables;
}

function parseCreate(name: string, stmt: string): ShippedTable {
  const t: ShippedTable = { name, create: stmt, cols: [], indexes: [], after: [] };
  for (const raw of stmt.slice(stmt.indexOf('(') + 1).split('\n')) {
    const line = raw.trim().replace(/,$/, '');
    if (!line || line.startsWith(')')) continue;
    const col = line.match(/^[`"]([^`"]+)[`"]\s+(.+)$/);
    if (col) {
      const rest = col[2];
      const def = rest.match(/\bDEFAULT\s+(.+?)(?=\s+(?:ON UPDATE|COMMENT|REFERENCES)\b|$)/i);
      t.cols.push({
        // the type is the first word, plus the second half of DOUBLE PRECISION / CHARACTER VARYING,
        // plus its arguments — everything after it is nullability, default, comment, references
        name: col[1], ddl: line, type: (rest.match(/^([A-Za-z]+(?:\s+(?:PRECISION|VARYING))?(?:\s*\([^)]*\))?)/i) ?? ['', ''])[1].trim(),
        notNull: /\bNOT NULL\b/i.test(rest), def: def ? def[1].trim() : null,
      });
      continue;
    }
    if (/^(PRIMARY KEY|CHECK|CONSTRAINT|FOREIGN KEY)/i.test(line)) continue;
    const key = line.match(/^(UNIQUE\s+)?(?:KEY|INDEX)?\s*(?:[`"]([^`"]+)[`"]\s*)?\(([^)]*)\)$/i);
    if (key) {
      const unique = !!key[1], list = cols(key[3]);
      t.indexes.push({ name: key[2] ?? `${unique ? 'uq' : 'ix'}_${name}_${list.join('_')}`.slice(0, 63), unique, cols: list });
    }
  }
  return t;
}

const cols = (s: string) => s.split(',').map(c => c.trim().replace(/^[`"]|[`"]$/g, '')).filter(Boolean);
const key = (unique: boolean, list: string[]) => `${unique ? 'u' : 'i'}:${list.join(',')}`;

/* ---------- the shape the database actually has ---------- */

interface LiveTable { cols: Map<string, { type: string; nullable: boolean }>; indexes: Set<string> }

async function readLive(db: Db): Promise<Map<string, LiveTable>> {
  const out = new Map<string, LiveTable>();
  const table = (name: string) => { let t = out.get(name); if (!t) out.set(name, t = { cols: new Map(), indexes: new Set() }); return t; };

  if (db.engine === 'sqlite') {
    for (const name of await db.tables()) {
      const t = table(name);
      for (const c of await db.query<{ name: string; type: string; notnull: number }>(`PRAGMA table_info(${db.quote(name)})`)) t.cols.set(c.name, { type: c.type, nullable: !Number(c.notnull) });
      for (const ix of await db.query<{ name: string; unique: number; origin: string }>(`PRAGMA index_list(${db.quote(name)})`)) {
        if (ix.origin === 'pk') continue;
        const parts = await db.query<{ name: string; seqno: number }>(`PRAGMA index_info(${db.quote(ix.name)})`);
        t.indexes.add(key(!!Number(ix.unique), parts.sort((a, b) => a.seqno - b.seqno).map(p => p.name)));
      }
    }
    return out;
  }

  if (db.engine === 'mysql') {
    // information_schema hands its column names back in whichever case the server feels like, so the
    // aliases are lowercased before they are read (db.tables() defends the same way).
    const rows = async <T>(sql: string) => (await db.query<Record<string, unknown>>(sql)).map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v])) as T);
    for (const r of await rows<{ tbl: string; col: string; typ: string; nullable: string }>(`SELECT table_name AS tbl, column_name AS col, column_type AS typ, is_nullable AS nullable FROM information_schema.columns WHERE table_schema = DATABASE()`)) table(r.tbl).cols.set(r.col, { type: r.typ, nullable: String(r.nullable).toUpperCase() === 'YES' });
    const seen = new Map<string, { tbl: string; unique: boolean; cols: string[] }>();
    for (const r of await rows<{ tbl: string; idx: string; nonuniq: number; seq: number; col: string }>(`SELECT table_name AS tbl, index_name AS idx, non_unique AS nonuniq, seq_in_index AS seq, column_name AS col FROM information_schema.statistics WHERE table_schema = DATABASE() ORDER BY table_name, index_name, seq_in_index`)) {
      const e = seen.get(`${r.tbl}.${r.idx}`) ?? { tbl: r.tbl, unique: !Number(r.nonuniq), cols: [] };
      e.cols.push(r.col); seen.set(`${r.tbl}.${r.idx}`, e);
    }
    for (const e of seen.values()) table(e.tbl).indexes.add(key(e.unique, e.cols));
    return out;
  }

  for (const r of await db.query<{ tbl: string; col: string; typ: string; notnull: boolean }>(`SELECT c.relname AS tbl, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS typ, a.attnotnull AS notnull FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped`)) table(r.tbl).cols.set(r.col, { type: r.typ, nullable: !r.notnull });
  for (const r of await db.query<{ tbl: string; def: string }>(`SELECT tablename AS tbl, indexdef AS def FROM pg_indexes WHERE schemaname = current_schema()`)) {
    const list = r.def.match(/\(([^()]*)\)\s*$/);
    if (list) table(r.tbl).indexes.add(key(/^CREATE UNIQUE/i.test(r.def), cols(list[1])));
  }
  return out;
}

/* ---------- adding a column to a table that already has rows ---------- */

/**
 * The shipped DDL describes a column on an empty table. On a table with rows, NOT NULL without a
 * default is impossible on every engine, and SQLite additionally refuses a non-constant default and
 * a REFERENCES clause in ALTER TABLE ADD COLUMN. Each of those is weakened here, once, and named in
 * `mismatched` so nobody has to discover it later.
 */
function addColumn(db: Db, table: string, col: ShippedColumn): { sql: string; note?: string } {
  let ddl = col.ddl, def = col.def;
  const notes: string[] = [];
  if (db.engine === 'sqlite') {
    // SQLite writes its foreign keys inline and refuses one in ADD COLUMN; MySQL and Postgres get
    // theirs from a separate ALTER, which the caller runs straight after this.
    if (/\bREFERENCES\b/i.test(ddl)) { ddl = ddl.replace(/\s*REFERENCES\s+.*$/i, ''); notes.push('added without its foreign key: SQLite cannot add one to an existing table'); }
    if (def?.startsWith('(')) { ddl = ddl.replace(/\s*DEFAULT\s+\([^)]*\)/i, ''); def = null; notes.push('added without its default: SQLite refuses a computed default in ADD COLUMN'); }
  }
  if (col.notNull && !def) { ddl = ddl.replace(/\s+NOT NULL\b/i, ''); notes.push('added nullable: a NOT NULL column with no default cannot be added to a table that already has rows'); }
  return { sql: `ALTER TABLE ${db.quote(table)} ADD COLUMN ${ddl}`, note: notes.join('; ') || undefined };
}

/* ---------- type comparison ---------- */

/**
 * Both sides come from the same engine's vocabulary, so this only has to bridge the spellings
 * Postgres reports back (`character varying`, `timestamp(3) without time zone`) and MySQL's display
 * widths. Anything it cannot parse returns '' and is never reported as a mismatch — a false alarm
 * every boot would be worse than a missed one.
 */
function normType(t: string): string {
  const s = String(t ?? '').toLowerCase().trim().replace(/\s+without time zone$/, '');
  const m = s.match(/^([a-z][a-z ]*?)\s*(?:\(([^)]*)\))?$/);
  if (!m) return '';
  // MariaDB has no JSON type of its own: it reports every JSON column as longtext, so the two are
  // one type here rather than a warning against a few hundred columns at every boot.
  const base = ({ 'character varying': 'varchar', character: 'char', 'double precision': 'double', int: 'integer', jsonb: 'json', longtext: 'json', timestamp: 'datetime', bool: 'boolean' } as Record<string, string>)[m[1].trim()] ?? m[1].trim();
  const args = ['integer', 'bigint', 'smallint'].includes(base) ? '' : (m[2] ?? '').replace(/\s+/g, '');
  return args ? `${base}(${args})` : base;
}
