import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt } from 'node:crypto';

/** `{{name}}` interpolation for notification templates; missing keys render empty. */
export function renderTemplate(tpl: string, data: Record<string, unknown>): string {
  return tpl.replace(/{{\s*([\w.]+)\s*}}/g, (_, key: string) => {
    const v = key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), data);
    return v == null ? '' : String(v);
  });
}

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const hmac = (key: string, s: string) => createHmac('sha256', key).update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const otpCode = (digits = 6) => String(randomInt(0, 10 ** digits)).padStart(digits, '0');
export const slugify = (s: string) => s.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').toLowerCase().slice(0, 60) || 'x';

/** Envelope encryption for secrets at rest (gateway keys, SMS credentials): AES-256-GCM under APP_KEY. */
export function encryptSecret(plain: string, appKey: string): string {
  const key = createHash('sha256').update(appKey).digest();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${enc.toString('base64url')}.${c.getAuthTag().toString('base64url')}`;
}
export function decryptSecret(blob: string, appKey: string): string {
  const [v, iv, data, tag] = blob.split('.');
  if (v !== 'v1') throw new Error('unknown secret format');
  const key = createHash('sha256').update(appKey).digest();
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

/** Normalises a Bangladesh phone to +8801XXXXXXXXX; returns null when it is not a BD mobile. */
export function normalizeBdPhone(raw: string): string | null {
  const v = raw.replace(/[\s-]/g, '');
  const m = v.match(/^(?:\+?88)?(01[3-9]\d{8})$/);
  return m ? '+88' + m[1] : null;
}
export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

export function addMinutes(d: Date, m: number) { return new Date(d.getTime() + m * 60_000); }
export function addHours(d: Date, h: number) { return addMinutes(d, h * 60); }
export function addDays(d: Date, n: number) { return addHours(d, n * 24); }

/** Local time HH:MM in a zone (quiet hours, cut-offs). */
export function localHHMM(d: Date, tz = 'Asia/Dhaka'): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}
/** Returns the next Date at local `hhmm` in `tz` at or after `from`. */
export function nextLocalTime(hhmm: string, tz: string, from = new Date()): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(from);
  const p: Record<string, number> = {}; for (const x of parts) if (x.type !== 'literal') p[x.type] = Number(x.value);
  // offset between wall clock and UTC for this instant
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const offsetMs = wall - Math.floor(from.getTime() / 60_000) * 60_000;
  let target = Date.UTC(p.year, p.month - 1, p.day, h, m) - offsetMs;
  if (target < from.getTime()) target += 86_400_000;
  return new Date(target);
}
export function inQuietHours(now: Date, quiet: { from: string; to: string } | null | undefined, tz = 'Asia/Dhaka'): boolean {
  if (!quiet?.from || !quiet?.to) return false;
  const cur = localHHMM(now, tz);
  return quiet.from <= quiet.to ? cur >= quiet.from && cur < quiet.to : cur >= quiet.from || cur < quiet.to;
}
