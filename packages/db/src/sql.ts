import type { Db, Engine, FindOptions, Row, Value } from './types.js';
import { isJsonColumn } from './schema/json-columns.js';

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
export function ident(name: string, engine: Engine): string {
  if (!IDENT.test(name)) throw new Error(`invalid identifier: ${name}`);
  return engine === 'postgres' ? `"${name}"` : `\`${name}\``;
}

/** UTC 'YYYY-MM-DD HH:MM:SS' — the one datetime format stored in every engine. */
export function nowSql(d = new Date()): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
export function toSql(d: Date | string | number): string {
  return typeof d === 'string' ? d : nowSql(new Date(d));
}
export function fromSql(v: unknown): Date | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v;
  const s = String(v).replace(' ', 'T');
  return new Date(s.endsWith('Z') || /[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z');
}

/** Parse a JSON column value (string in sqlite/mysql2 text mode, object in postgres). */
export function json<T = unknown>(v: unknown, fallback: T | null = null): T | null {
  if (v == null) return fallback;
  if (typeof v === 'object') return v as T;
  // MySQL and Postgres hand a JSON column back already parsed, so a stored `100` or `true` arrives as
  // a number or a boolean. SQLite stores the same column as text and it arrives as "100". Dropping the
  // parsed ones silently turned every numeric setting into its default on two engines out of three.
  if (typeof v === 'number' || typeof v === 'boolean') return v as unknown as T;
  if (typeof v !== 'string') return fallback;
  // mysql2 already parses JSON columns, so a scalar JSON value arrives as a bare string; keep it as-is
  try { return JSON.parse(v) as T; } catch { return v as unknown as T; }
}

/** Normalise a JS value into what the driver expects. Objects/arrays → JSON text, booleans → 0/1 (except postgres), Date → SQL string. */
export function bind(v: Value, engine: Engine): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return nowSql(v);
  if (typeof v === 'boolean') return engine === 'postgres' ? v : v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

/**
 * What a JSON column is given, as JSON.
 *
 * MySQL and Postgres parse a `json` column on the way in and refuse anything that is not a document:
 * a campus address typed as `Road 7` is a 500 on both and passes silently on SQLite, which stores the
 * column as text. So every value bound to a JSON column is encoded here — except a string that is
 * already JSON, because most writers stringify their own objects and settings values, and encoding
 * those twice would store `"\"bn\""` where `"bn"` belongs.
 */
export function jsonValue(v: Value): unknown {
  if (v == null) return null;
  if (v instanceof Date) return JSON.stringify(nowSql(v));
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string') { try { JSON.parse(v); return v; } catch { return JSON.stringify(v); } }
  return JSON.stringify(v);   // a bare number or boolean is valid JSON on its own
}

/** Rewrite `?` placeholders to `$1..$n` for postgres. Skips `?` inside quoted strings. */
export function toPgPlaceholders(sql: string): string {
  let n = 0; let out = ''; let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) { out += ch; if (ch === quote && sql[i + 1] !== quote) quote = null; else if (ch === quote) { out += sql[++i]; } continue; }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    if (ch === '?') { out += `$${++n}`; continue; }
    out += ch;
  }
  return out;
}

export function whereClause(where: Row | undefined, engine: Engine): { sql: string; params: unknown[] } {
  if (!where || !Object.keys(where).length) return { sql: '', params: [] };
  const parts: string[] = []; const params: unknown[] = [];
  for (const [k, v] of Object.entries(where)) {
    if (v === null) { parts.push(`${ident(k, engine)} IS NULL`); continue; }
    if (Array.isArray(v)) {
      if (!v.length) { parts.push('1=0'); continue; }
      parts.push(`${ident(k, engine)} IN (${v.map(() => '?').join(',')})`); params.push(...v.map(x => bind(x as Value, engine))); continue;
    }
    parts.push(`${ident(k, engine)} = ?`); params.push(bind(v, engine));
  }
  return { sql: ' WHERE ' + parts.join(' AND '), params };
}

function orderClause(orderBy: string | undefined, engine: Engine): string {
  if (!orderBy) return '';
  const parts = orderBy.split(',').map(p => {
    const [col, dir] = p.trim().split(/\s+/);
    return ident(col, engine) + (dir && /^desc$/i.test(dir) ? ' DESC' : ' ASC');
  });
  return ' ORDER BY ' + parts.join(', ');
}

/** Builds the generic CRUD helpers on top of query/execute so each engine only implements the primitives. */
export function crud(engine: Engine, query: Db['query'], execute: Db['execute']) {
  const q = (n: string) => ident(n, engine);
  // a column the schema calls `json` carries a document on every engine, whatever the caller passed
  const val = (table: string, column: string, v: Value) => (isJsonColumn(table, column) ? jsonValue(v) : bind(v, engine));
  return {
    async insert(table: string, row: Row) {
      const keys = Object.keys(row);
      await execute(`INSERT INTO ${q(table)} (${keys.map(q).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map(k => val(table, k, row[k])));
    },
    async insertMany(table: string, rows: Row[]) {
      if (!rows.length) return;
      const keys = Object.keys(rows[0]);
      const chunk = 200;
      for (let i = 0; i < rows.length; i += chunk) {
        const slice = rows.slice(i, i + chunk);
        const values = slice.map(() => `(${keys.map(() => '?').join(', ')})`).join(', ');
        await execute(`INSERT INTO ${q(table)} (${keys.map(q).join(', ')}) VALUES ${values}`, slice.flatMap(r => keys.map(k => val(table, k, r[k]))));
      }
    },
    async update(table: string, set: Row, where: Row) {
      const keys = Object.keys(set); if (!keys.length) return 0;
      const w = whereClause(where, engine);
      const r = await execute(`UPDATE ${q(table)} SET ${keys.map(k => `${q(k)} = ?`).join(', ')}${w.sql}`, [...keys.map(k => val(table, k, set[k])), ...w.params]);
      return r.affectedRows;
    },
    async delete(table: string, where: Row) {
      const w = whereClause(where, engine);
      if (!w.sql) throw new Error('refusing to delete without a where clause');
      return (await execute(`DELETE FROM ${q(table)}${w.sql}`, w.params)).affectedRows;
    },
    async findMany<T = Row>(table: string, where?: Row, opts: FindOptions = {}) {
      const w = whereClause(where, engine);
      const cols = opts.columns?.length ? opts.columns.map(q).join(', ') : '*';
      let sql = `SELECT ${cols} FROM ${q(table)}${w.sql}${orderClause(opts.orderBy, engine)}`;
      if (opts.limit != null) sql += ` LIMIT ${Math.max(0, Math.floor(opts.limit))}`;
      if (opts.offset) sql += ` OFFSET ${Math.max(0, Math.floor(opts.offset))}`;
      return query<T>(sql, w.params);
    },
    async findOne<T = Row>(table: string, where: Row, opts: FindOptions = {}) {
      const rows = await this.findMany<T>(table, where, { ...opts, limit: 1 });
      return rows[0] ?? null;
    },
    async count(table: string, where?: Row) {
      const w = whereClause(where, engine);
      const rows = await query<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${q(table)}${w.sql}`, w.params);
      return Number(rows[0]?.n ?? 0);
    },
  };
}

/** Split a SQL script into statements (';' at end of line), dropping comment-only lines. Handles $$ blocks for postgres. */
export function splitStatements(script: string): string[] {
  const out: string[] = [];
  let buf = ''; let inDollar = false;
  for (const line of script.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!buf && (trimmed === '' || trimmed.startsWith('--'))) continue;
    buf += line + '\n';
    const dollars = (line.match(/\$\$/g) || []).length;
    if (dollars % 2 === 1) inDollar = !inDollar;
    if (!inDollar && trimmed.endsWith(';')) { out.push(buf.trim()); buf = ''; }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
