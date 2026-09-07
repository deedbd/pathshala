export type Engine = 'mysql' | 'sqlite' | 'postgres';

export type Scalar = string | number | boolean | null | undefined | Date;
export type Value = Scalar | Record<string, unknown> | unknown[];
export type Row = Record<string, Value>;

export interface FindOptions {
  orderBy?: string;            // e.g. "created_at DESC"
  limit?: number;
  offset?: number;
  columns?: string[];
}

/**
 * Dialect-agnostic database handle. Domain code writes SQL with `?` placeholders and
 * ISO-like UTC datetime strings ('YYYY-MM-DD HH:MM:SS'); the engine adapter translates.
 * JSON values are serialised on insert/update; use `json()` to read them back.
 */
export interface Db {
  readonly engine: Engine;
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ affectedRows: number }>;
  /** Runs multiple statements in one script (migrations/seeds). Errors are per-statement. */
  script(sql: string, opts?: { ignore?: (err: Error, statement: string) => boolean }): Promise<{ ran: number; skipped: number }>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  insert(table: string, row: Row): Promise<void>;
  insertMany(table: string, rows: Row[]): Promise<void>;
  update(table: string, set: Row, where: Row): Promise<number>;
  delete(table: string, where: Row): Promise<number>;
  findOne<T = Row>(table: string, where: Row, opts?: FindOptions): Promise<T | null>;
  findMany<T = Row>(table: string, where?: Row, opts?: FindOptions): Promise<T[]>;
  count(table: string, where?: Row): Promise<number>;
  /** Every table this database actually has, in creation order. Used by backup and migration. */
  tables(): Promise<string[]>;
  /** Quotes an identifier for this engine; refuses anything that is not a plain name. */
  quote(name: string): string;
  close(): Promise<void>;
  /** Engine-native handle (mysql2 pool, node:sqlite DatabaseSync, pg Pool). Avoid in domain code. */
  readonly raw: unknown;
}

export interface DbConfig {
  engine: Engine;
  url?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  sqlitePath?: string;
  poolSize?: number;
}
