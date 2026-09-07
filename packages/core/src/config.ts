import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface AppConfig {
  env: NodeJS.ProcessEnv;
  rootDir: string;        // where .env, uploads/, db/ live (public_html on cPanel, repo root in dev)
  dbDir: string;
  uploadsDir: string;
  appUrl: string;
  appKey: string;
  cronKey: string;
  isProduction: boolean;
  port: number;
  sessionDays: number;
  /**
   * The path the Pathshala team's own sign-in lives behind, without a slash — say `k7f2p9m4qz`.
   *
   * It is written into `.env` at install time and printed once. An unguessable path is not the
   * security boundary and is not treated as one: the gate is still the role, the founder school, the
   * password and the second factor. What the door buys is that the vendor's console does not appear
   * on a school's site at all — `/owner` and `/api/owner` answer 404 to everybody who has not come
   * through it, so there is nothing to find and nothing to attack. With no door configured the whole
   * thing is closed rather than open.
   */
  ownerDoor: string | null;
  /** Optional comma-separated list of addresses that may reach the door at all. */
  ownerIps: string[];
  /**
   * Optional MAC addresses that may reach it. Only ever answers for a machine on the server's own
   * network segment — a MAC does not travel over the internet, so on shared hosting this list is
   * inert and the address list and the trusted devices decide.
   */
  ownerMacs: string[];
}

/** Minimal .env parser (no dependency): KEY=value, quotes optional, # comments. Does not override existing process env. */
export function loadDotenv(file: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('='); if (eq < 0) continue;
    const key = line.slice(0, eq).trim(); let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
    if (env[key] === undefined) env[key] = val;
  }
  return out;
}

export function writeDotenv(file: string, values: Record<string, string>) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = existing ? existing.split(/\r?\n/) : [];
  const seen = new Set<string>();
  const fmt = (k: string, v: string) => `${k}=${/[\s#"']/.test(v) ? JSON.stringify(v) : v}`;
  const next = lines.map(l => {
    const m = l.match(/^([A-Z0-9_]+)=/);
    if (m && values[m[1]] !== undefined) { seen.add(m[1]); return fmt(m[1], values[m[1]]); }
    return l;
  });
  for (const [k, v] of Object.entries(values)) if (!seen.has(k)) next.push(fmt(k, v));
  fs.writeFileSync(file, next.join('\n').replace(/\n+$/, '') + '\n');
}

/** Resolves rootDir: explicit APP_ROOT, else the directory that holds `.env`/`db/` walking up from cwd. */
export function resolveRootDir(start = process.cwd()): string {
  if (process.env.APP_ROOT) return path.resolve(process.env.APP_ROOT);
  let dir = path.resolve(start);
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'db', 'schema.json')) || fs.existsSync(path.join(dir, '.env'))) return dir;
    const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
  }
  return path.resolve(start);
}

export function loadConfig(rootDir = resolveRootDir()): AppConfig {
  loadDotenv(path.join(rootDir, '.env'));
  const env = process.env;
  const appKey = env.APP_KEY && env.APP_KEY !== 'change-me-64-hex-chars' ? env.APP_KEY : randomBytes(32).toString('hex');
  if (!env.APP_KEY || env.APP_KEY === 'change-me-64-hex-chars') env.APP_KEY = appKey;
  return {
    env, rootDir,
    dbDir: path.resolve(rootDir, env.DB_DIR || 'db'),
    uploadsDir: path.resolve(rootDir, env.UPLOADS_DIR || 'uploads'),
    appUrl: (env.APP_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
    appKey,
    cronKey: env.CRON_KEY || appKey.slice(0, 24),
    isProduction: (env.APP_ENV || env.NODE_ENV) === 'production',
    port: Number(env.PORT) || 3000,
    sessionDays: Number(env.SESSION_DAYS) || 30,
    ownerDoor: (env.OWNER_DOOR || '').trim().replace(/^\/+|\/+$/g, '').toLowerCase() || null,
    ownerIps: (env.OWNER_IPS || '').split(',').map(x => x.trim()).filter(Boolean),
    ownerMacs: (env.OWNER_MACS || '').split(',').map(x => x.trim()).filter(Boolean),
  };
}
