import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '@pathshala/adapters';

/** Console + rotating-ish file logger (uploads/logs/app-YYYY-MM-DD.log). No dependency; pino can replace it on a VPS. */
export function createLogger(logDir?: string, level: 'debug' | 'info' | 'warn' | 'error' = 'info'): Logger {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  const min = order[level];
  let stream: fs.WriteStream | null = null; let streamDay = '';
  const file = () => {
    if (!logDir) return null;
    const day = new Date().toISOString().slice(0, 10);
    if (stream && streamDay === day) return stream;
    stream?.end(); fs.mkdirSync(logDir, { recursive: true });
    stream = fs.createWriteStream(path.join(logDir, `app-${day}.log`), { flags: 'a' }); streamDay = day;
    return stream;
  };
  const write = (lvl: keyof typeof order, msg: string, meta?: unknown) => {
    if (order[lvl] < min) return;
    const extra = meta === undefined || meta === '' ? '' : ' ' + (meta instanceof Error ? (meta.stack || meta.message) : typeof meta === 'string' ? meta : safeJson(meta));
    const line = `${new Date().toISOString()} [${lvl}] ${msg}${extra}`;
    (lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log)(line);
    try { file()?.write(line + '\n'); } catch { /* disk full: keep serving */ }
  };
  return { debug: (m, x) => write('debug', m, x), info: (m, x) => write('info', m, x), warn: (m, x) => write('warn', m, x), error: (m, x) => write('error', m, x) };
}
function safeJson(v: unknown) { try { return JSON.stringify(v); } catch { return String(v); } }
