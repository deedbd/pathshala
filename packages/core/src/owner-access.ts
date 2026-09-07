import { execFile } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db, Row } from '@pathshala/db';
import { nowSql, ulid } from '@pathshala/db';
import type { AppConfig } from './config.js';

export type OwnerMatch = 'device' | 'ip' | 'mac' | 'open';
export interface OwnerDevice { id: string; label: string; addedAt: string; lastSeenAt: string | null; lastIp: string | null; mac: string | null }
export interface OwnerAccessResult { allowed: boolean; matched: OwnerMatch | null; deviceId: string | null; reason: string | null }

/** Where the trusted devices are kept: one settings row on the founder school, so no new table. */
const DEVICES_KEY = 'owner.devices';
/** The cookie the browser carries. Signed, so a stolen id alone is no use without the key. */
export const OWNER_DEVICE_COOKIE = 'ps_owner_device';
/** ARP is a link-layer question; asking it costs a process, so the answer is kept for a minute. */
const MAC_CACHE_MS = 60_000;

/**
 * Who may reach the Pathshala team's own door at all — before any password is typed.
 *
 * Three things can vouch for a machine and **any one of them is enough**: a device this owner has
 * already trusted (a signed cookie), an address on the allowlist, or — only where the server and the
 * machine share a LAN — the machine's MAC. A laptop that travels keeps working on its device key
 * while its address changes; a fresh browser at the office is let through by the address; a machine
 * on the same network is recognised by its card. None of the three configured means none of them is
 * asked for, because an owner locked out of their own console by a network rule is a worse failure
 * than the one this prevents.
 *
 * This is a filter in front of the door, not the lock. The lock is the `super_admin` role on the
 * founder school, the password and the second factor — all of which still apply afterwards. And a
 * MAC address cannot travel over the internet at all: it exists on one network segment, so on shared
 * hosting it will simply never match and the other two decide. Anything sold as "MAC locking" over
 * the internet is a device token wearing a hat, which is exactly what the device key is.
 */
export class OwnerAccessService {
  constructor(private db: Db, private config: AppConfig) {}

  private macCache = new Map<string, { at: number; mac: string | null }>();

  /** The founder school owns the device list, as it owns everything else about the installation. */
  async founderSchoolId(): Promise<string | null> {
    const rows = await this.db.query<{ id: string }>(`SELECT id FROM schools WHERE status <> 'closed' ORDER BY created_at ASC, id ASC LIMIT 1`);
    return rows[0] ? String(rows[0].id) : null;
  }

  async devices(): Promise<OwnerDevice[]> {
    const sid = await this.founderSchoolId();
    if (!sid) return [];
    const row = await this.db.findOne<Row>('settings', { school_id: sid, key_name: DEVICES_KEY });
    const value = row?.value;
    const list = typeof value === 'string' ? safeParse(value) : Array.isArray(value) ? value : [];
    return (list as OwnerDevice[]).filter(d => d && typeof d.id === 'string');
  }

  private async saveDevices(list: OwnerDevice[]): Promise<void> {
    const sid = await this.founderSchoolId();
    if (!sid) return;
    const row = await this.db.findOne<{ id: string }>('settings', { school_id: sid, key_name: DEVICES_KEY });
    const value = JSON.stringify(list.slice(0, 50));                    // fifty machines is already generous
    if (row) await this.db.update('settings', { value, updated_at: nowSql() }, { id: row.id });
    else await this.db.insert('settings', { id: ulid(), school_id: sid, key_name: DEVICES_KEY, value });
  }

  /**
   * Trusts this machine and hands back the cookie value for it. The first device is trusted when the
   * owner first signs in — there is nobody else to approve it and the alternative is an owner who
   * cannot reach their own console. Every device after that has to be approved from one already
   * trusted, which is the only moment the list can be added to.
   */
  async trustDevice(input: { label: string; ip?: string | null; mac?: string | null }): Promise<{ id: string; token: string; first: boolean }> {
    const list = await this.devices();
    const id = ulid();
    const device: OwnerDevice = { id, label: input.label.slice(0, 60) || 'a machine', addedAt: nowSql(), lastSeenAt: nowSql(), lastIp: input.ip ?? null, mac: input.mac ?? null };
    await this.saveDevices([device, ...list]);
    return { id, token: this.tokenFor(id), first: list.length === 0 };
  }

  async forgetDevice(id: string): Promise<boolean> {
    const list = await this.devices();
    const left = list.filter(d => d.id !== id);
    if (left.length === list.length) return false;
    await this.saveDevices(left);
    return true;
  }

  /** `<id>.<hmac>` — the id alone proves nothing without the installation's key. */
  tokenFor(deviceId: string): string {
    return `${deviceId}.${createHmac('sha256', this.config.appKey).update(deviceId).digest('base64url')}`;
  }

  private deviceIdFrom(token: string | null | undefined): string | null {
    if (!token || !token.includes('.')) return null;
    const [id, mac] = token.split('.', 2);
    if (!id || !mac) return null;
    const expected = Buffer.from(createHmac('sha256', this.config.appKey).update(id).digest('base64url'));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return id;
  }

  /**
   * The gate in front of the door. Any one of the three vouches for the machine; with none of them
   * configured and no device yet trusted, the door is open to the password alone — which is the case
   * on the day the software is installed and nobody has signed in yet.
   */
  async check(input: { ip?: string | null; deviceToken?: string | null }): Promise<OwnerAccessResult> {
    const devices = await this.devices();
    const ips = this.config.ownerIps;
    const macs = this.config.ownerMacs.map(m => normalizeMac(m)).filter(Boolean) as string[];
    const configured = devices.length > 0 || ips.length > 0 || macs.length > 0;
    if (!configured) return { allowed: true, matched: 'open', deviceId: null, reason: 'no machine has been trusted yet' };

    const deviceId = this.deviceIdFrom(input.deviceToken);
    if (deviceId && devices.some(d => d.id === deviceId)) {
      await this.touch(deviceId, input.ip ?? null);
      return { allowed: true, matched: 'device', deviceId, reason: null };
    }
    const ip = normalizeIp(input.ip);
    if (ip && ips.some(rule => ipMatches(ip, rule))) return { allowed: true, matched: 'ip', deviceId: null, reason: null };
    if (macs.length && ip) {
      const mac = await this.macFor(ip);
      if (mac && macs.includes(mac)) return { allowed: true, matched: 'mac', deviceId: null, reason: null };
    }
    return { allowed: false, matched: null, deviceId: null, reason: 'this machine is not one the owner has trusted' };
  }

  private async touch(deviceId: string, ip: string | null) {
    const list = await this.devices();
    const i = list.findIndex(d => d.id === deviceId);
    if (i < 0) return;
    list[i] = { ...list[i]!, lastSeenAt: nowSql(), lastIp: ip ?? list[i]!.lastIp };
    await this.saveDevices(list);
  }

  /**
   * The MAC behind an address, asked of this machine's own ARP table.
   *
   * It can only ever answer for a machine on the same network segment — over the internet the reply
   * is nothing, every time, and the other two rules decide. That is a property of how Ethernet works,
   * not a limitation here, so the failure is silent rather than an error.
   */
  async macFor(ip: string): Promise<string | null> {
    if (!isLanIp(ip)) return null;
    const hit = this.macCache.get(ip);
    if (hit && Date.now() - hit.at < MAC_CACHE_MS) return hit.mac;
    const mac = await arpLookup(ip).catch(() => null);
    this.macCache.set(ip, { at: Date.now(), mac });
    return mac;
  }
}

function safeParse(v: string): unknown[] {
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
}

/** `::ffff:203.0.113.9` and `[::1]` are the same addresses as the ones people write down. */
export function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  let out = String(ip).trim().replace(/^\[|\]$/g, '');
  if (out.startsWith('::ffff:')) out = out.slice(7);
  return out || null;
}

export function normalizeMac(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const hex = String(mac).toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g)!.join(':');
}

/** An exact address, or a v4 CIDR such as `203.0.113.0/24`. */
export function ipMatches(ip: string, rule: string): boolean {
  const r = rule.trim();
  if (!r) return false;
  if (!r.includes('/')) return r === ip;
  const [base, bitsRaw] = r.split('/', 2);
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const a = ipv4ToInt(ip), b = ipv4ToInt(base!);
  if (a == null || b == null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

export function isLanIp(ip: string): boolean {
  if (ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  const n = ipv4ToInt(ip);
  if (n == null) return false;
  return (n >>> 24) === 10 || (n >>> 24) === 127 || (n >>> 20) === 0xac1 || (n >>> 16) === 0xc0a8;
}

/** Reads the platform's own ARP table. Never throws outward; a machine that is not on our segment simply has no row. */
async function arpLookup(ip: string): Promise<string | null> {
  const args = process.platform === 'win32' ? ['-a', ip] : ['-n', ip];
  const text = await new Promise<string>((resolve, reject) => {
    const child = execFile('arp', args, { timeout: 800, windowsHide: true }, (err, stdout) => (err && !stdout ? reject(err) : resolve(String(stdout))));
    child.on('error', reject);
  });
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes(ip)) continue;
    const m = line.match(/([0-9a-f]{2}[-:]){5}[0-9a-f]{2}/i);
    if (m) return normalizeMac(m[0]);
  }
  return null;
}

/** A cookie a browser will keep for two years and never hand to script. */
export function ownerDeviceCookie(token: string, secure: boolean): string {
  return `${OWNER_DEVICE_COOKIE}=${token}; Path=/; Max-Age=${2 * 365 * 24 * 3600}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
export function readOwnerDeviceCookie(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === OWNER_DEVICE_COOKIE) return rest.join('=') || null;
  }
  return null;
}

export function randomDeviceLabel(userAgent: string | null | undefined): string {
  const ua = String(userAgent ?? '');
  const os = /Windows/i.test(ua) ? 'Windows' : /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Mac OS/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'a machine';
  const browser = /Edg\//i.test(ua) ? 'Edge' : /Chrome\//i.test(ua) ? 'Chrome' : /Firefox\//i.test(ua) ? 'Firefox' : /Safari\//i.test(ua) ? 'Safari' : 'a browser';
  return `${browser} on ${os} · ${randomBytes(2).toString('hex')}`;
}
