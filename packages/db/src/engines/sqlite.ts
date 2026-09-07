import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db, Row } from '../types.js';
import { ident, bind, crud, splitStatements } from '../sql.js';

/**
 * Zero-config fallback engine using Node's built-in SQLite (no native npm package).
 * One connection, WAL mode, foreign keys on. Fine up to a few thousand students; the
 * "Migrate to MySQL" tool copies data out later.
 */
export function openSqlite(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  return makeDb(conn, false);
}

let spCounter = 0;

function makeDb(conn: DatabaseSync, inTx: boolean): Db {
  const query = async <T = Row>(sql: string, params: unknown[] = []) => {
    const stmt = conn.prepare(sql);
    return stmt.all(...(params.map(p => bind(p as never, 'sqlite')) as never[])) as T[];
  };
  const execute = async (sql: string, params: unknown[] = []) => {
    const stmt = conn.prepare(sql);
    const r = stmt.run(...(params.map(p => bind(p as never, 'sqlite')) as never[]));
    return { affectedRows: Number(r.changes) };
  };
  const base = crud('sqlite', query, execute);
  const db: Db = {
    engine: 'sqlite',
    raw: conn,
    query, execute, ...base,
    quote: (n: string) => ident(n, 'sqlite'),
    async tables() { return (await query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid`)).map(r => r.name); },
    async script(sql, opts) {
      let ran = 0, skipped = 0;
      for (const st of splitStatements(sql)) {
        try { conn.exec(st); ran++; }
        catch (e) { if (opts?.ignore?.(e as Error, st)) { skipped++; continue; } throw new Error(`${(e as Error).message}\n  in: ${st.slice(0, 200)}`); }
      }
      return { ran, skipped };
    },
    async attempt(fn) {
      if (!inTx) return fn();
      const name = `sp_${(spCounter = (spCounter + 1) % 1_000_000)}`;
      conn.exec(`SAVEPOINT ${name}`);
      try { const r = await fn(); conn.exec(`RELEASE ${name}`); return r; }
      catch (e) { conn.exec(`ROLLBACK TO ${name}`); conn.exec(`RELEASE ${name}`); throw e; }
    },
    async transaction(fn) {
      if (inTx) return fn(db); // SQLite has one connection; nested transactions join the outer one
      conn.exec('BEGIN IMMEDIATE');
      try { const r = await fn(makeDb(conn, true)); conn.exec('COMMIT'); return r; }
      catch (e) { try { conn.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
    },
    async close() { if (!inTx) conn.close(); },
  };
  return db;
}
