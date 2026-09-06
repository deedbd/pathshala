import type { Db, DbConfig, Engine } from './types.js';
import { openSqlite } from './engines/sqlite.js';
import { openMysql } from './engines/mysql.js';
import { openPostgres } from './engines/postgres.js';

export function connect(cfg: DbConfig): Db {
  switch (cfg.engine) {
    case 'sqlite': return openSqlite(cfg.sqlitePath || ':memory:');
    case 'mysql': return openMysql(cfg);
    case 'postgres': return openPostgres(cfg);
    default: throw new Error(`unknown DB_ENGINE ${(cfg as DbConfig).engine}`);
  }
}

/** Reads DB_* / DB_URL / SQLITE_PATH. DB_URL's scheme wins over DB_ENGINE. */
export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env, rootDir = process.cwd()): DbConfig {
  const url = env.DB_URL?.trim();
  let engine = (env.DB_ENGINE?.trim().toLowerCase() || '') as Engine | '';
  if (url) {
    if (/^postgres(ql)?:/.test(url)) engine = 'postgres';
    else if (/^mysql:/.test(url)) engine = 'mysql';
    else if (/^(sqlite|file):/.test(url)) engine = 'sqlite';
  }
  if (!engine) engine = env.DB_HOST || env.DB_NAME ? 'mysql' : 'sqlite';
  if (engine === 'sqlite') {
    let file = env.SQLITE_PATH || (url ? url.replace(/^(sqlite|file):\/*/, '') : '') || 'storage/sqlite/pathshala.db';
    if (file !== ':memory:' && !/^([a-zA-Z]:)?[\\/]/.test(file)) file = `${rootDir}/${file}`;
    return { engine, sqlitePath: file };
  }
  return {
    engine,
    url: url || undefined,
    host: env.DB_HOST || '127.0.0.1',
    port: env.DB_PORT ? Number(env.DB_PORT) : undefined,
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    poolSize: env.DB_POOL ? Number(env.DB_POOL) : undefined,
  };
}
