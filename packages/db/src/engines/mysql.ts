import mysql from 'mysql2/promise';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { Db, DbConfig, Row } from '../types.js';
import { bind, crud, ident, splitStatements } from '../sql.js';

/** cPanel's MySQL/MariaDB through mysql2 (pure JS). Datetimes are read as strings, decimals as numbers. */
export function openMysql(cfg: DbConfig): Db {
  const common = { dateStrings: true as const, decimalNumbers: true, supportBigNumbers: true, bigNumberStrings: false, charset: 'utf8mb4', timezone: 'Z', connectionLimit: cfg.poolSize ?? 4, waitForConnections: true, multipleStatements: false };
  const pool: Pool = cfg.url ? mysql.createPool({ uri: cfg.url, ...common }) : mysql.createPool({ host: cfg.host ?? '127.0.0.1', port: cfg.port ?? 3306, database: cfg.database, user: cfg.user, password: cfg.password, ...common });
  return makeDb(pool, null);
}

type Exec = Pool | PoolConnection;

function makeDb(pool: Pool, conn: PoolConnection | null): Db {
  const ex: Exec = conn ?? pool;
  const query = async <T = Row>(sql: string, params: unknown[] = []) => {
    const [rows] = await ex.query(sql, params.map(p => bind(p as never, 'mysql')));
    return rows as T[];
  };
  const execute = async (sql: string, params: unknown[] = []) => {
    const [r] = await ex.query(sql, params.map(p => bind(p as never, 'mysql')));
    return { affectedRows: Number((r as { affectedRows?: number }).affectedRows ?? 0) };
  };
  const base = crud('mysql', query, execute);
  const db: Db = {
    engine: 'mysql',
    raw: pool,
    query, execute, ...base,
    quote: (n: string) => ident(n, 'mysql'),
    async tables() { const rows = await query<Record<string, string>>(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name`); return rows.map(r => String(r.name ?? r.NAME ?? Object.values(r)[0])); },
    async script(sql, opts) {
      let ran = 0, skipped = 0;
      for (const st of splitStatements(sql)) {
        try { await ex.query(st); ran++; }
        catch (e) { if (opts?.ignore?.(e as Error, st)) { skipped++; continue; } throw new Error(`${(e as Error).message}\n  in: ${st.slice(0, 200)}`); }
      }
      return { ran, skipped };
    },
    async transaction(fn) {
      if (conn) return fn(db);
      const c = await pool.getConnection();
      try {
        await c.beginTransaction();
        const r = await fn(makeDb(pool, c));
        await c.commit();
        return r;
      } catch (e) { try { await c.rollback(); } catch { /* ignore */ } throw e; }
      finally { c.release(); }
    },
    async close() { if (!conn) await pool.end(); },
  };
  return db;
}
