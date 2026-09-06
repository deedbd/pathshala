/**
 * Small 5-field cron matcher (minute hour day-of-month month day-of-week) with IANA time-zone support.
 * Supports: * , - / and names (jan-dec, sun-sat). No dependency, no native code.
 */
export interface CronSpec { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean }

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseField(field: string, min: number, max: number, names: string[] = []): Set<number> {
  const out = new Set<number>();
  const norm = (tok: string) => { const i = names.indexOf(tok.toLowerCase()); return i >= 0 ? i + min : Number(tok); };
  for (const part of field.split(',')) {
    const [rangeRaw, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    let lo = min, hi = max;
    if (rangeRaw !== '*' && rangeRaw !== '?') {
      const [a, b] = rangeRaw.split('-');
      lo = norm(a); hi = b !== undefined ? norm(b) : stepRaw ? max : lo;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(step) || step < 1) throw new Error(`bad cron field "${field}"`);
    for (let v = lo; v <= hi; v += step) out.add(v === 7 && max === 6 ? 0 : v); // 7 = sunday
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron needs 5 fields: "${expr}"`);
  return {
    minute: parseField(f[0], 0, 59), hour: parseField(f[1], 0, 23), dom: parseField(f[2], 1, 31),
    month: parseField(f[3], 1, 12, MONTHS), dow: parseField(f[4], 0, 6, DAYS),
    domStar: f[2] === '*', dowStar: f[4] === '*',
  };
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' }); fmtCache.set(tz, f); }
  return f;
}
/** Wall-clock fields of `d` in `tz`. */
export function zonedParts(d: Date, tz: string) {
  const p: Record<string, string> = {};
  for (const x of fmt(tz).formatToParts(d)) p[x.type] = x.value;
  return { minute: Number(p.minute), hour: Number(p.hour), dom: Number(p.day), month: Number(p.month), year: Number(p.year), dow: DAYS.indexOf(p.weekday.toLowerCase()) };
}

export function cronMatches(spec: CronSpec, d: Date, tz: string): boolean {
  const z = zonedParts(d, tz);
  if (!spec.minute.has(z.minute) || !spec.hour.has(z.hour) || !spec.month.has(z.month)) return false;
  const domOk = spec.dom.has(z.dom), dowOk = spec.dow.has(z.dow);
  if (spec.domStar && spec.dowStar) return true;
  if (spec.domStar) return dowOk;
  if (spec.dowStar) return domOk;
  return domOk || dowOk; // vixie cron semantics when both are restricted
}

/** Next matching minute strictly after `from` (default now), within 366 days. */
export function nextRun(expr: string | CronSpec, tz = 'Asia/Dhaka', from = new Date()): Date | null {
  const spec = typeof expr === 'string' ? parseCron(expr) : expr;
  const t = new Date(from); t.setUTCSeconds(0, 0); t.setUTCMinutes(t.getUTCMinutes() + 1);
  const limit = t.getTime() + 366 * 86400_000;
  while (t.getTime() <= limit) {
    const z = zonedParts(t, tz);
    if (!spec.month.has(z.month)) { t.setUTCDate(t.getUTCDate() + 1); t.setUTCHours(0, 0, 0, 0); continue; }
    if (!spec.hour.has(z.hour)) { t.setUTCMinutes(t.getUTCMinutes() + (60 - z.minute)); continue; }
    if (cronMatches(spec, t, tz)) return t;
    t.setUTCMinutes(t.getUTCMinutes() + 1);
  }
  return null;
}

export function isValidCron(expr: string): boolean { try { parseCron(expr); return true; } catch { return false; } }
