import dns from 'node:dns/promises';
import net from 'node:net';
import type { Db, Row } from '@pathshala/db';
import { nowSql } from '@pathshala/db';
import type { Adapters, ScheduledFn } from '@pathshala/adapters';
import type { AppConfig } from './config.js';
import type { SettingsService } from './settings.js';
import type { NotificationService } from './notifications.js';
import { HttpError, badRequest, notFound } from './context.js';
import { hmac } from './util.js';

/**
 * Which school a request belongs to.
 *
 * Until this existed the answer was "whoever is signed in", and the sign-in page itself showed
 * whichever school happened to be created first. That is fine for one school on one host and wrong
 * the moment the owner sells to a second one: a school has to be reachable at an address of its own,
 * before anybody has signed in, so the login page it opens is its own.
 *
 * Two forms, in that order of precedence:
 *
 *  - **a custom domain** — `saranjai.edu.bd` — the school gets the whole host and its console lives at
 *    the root of it. `prefix` is `''`, so nothing in the app has to know the address is special.
 *  - **a slug path** — `/saranjai/...` on the installation's own host, which works on day one with no
 *    DNS at all. `prefix` is `/saranjai`, and every link the web layer builds carries it.
 *
 * Neither → `source: 'none'`, which is the vendor's own space: the owner console, the installer and
 * the door live there and nowhere else.
 *
 * `schools.code` is untouched by any of this. It prefixes every document number a school has ever
 * issued — receipts, admission numbers, payslips — so it can never move. `slug` is a second, purely
 * cosmetic name that may be changed at will.
 */
export type TenantSource = 'domain' | 'slug' | 'none';

export interface TenantSchool {
  id: string;
  name: string;
  code: string;
  slug: string | null;
  customDomain: string | null;
  status: string;
}

export interface ResolvedTenant {
  school: TenantSchool | null;
  /** `''` for a custom domain, `/<slug>` for the path form, `''` when no tenant was resolved. */
  prefix: string;
  source: TenantSource;
}

/**
 * The tenant as a request carries it: what the server puts on `req.ps.tenant` and hands to the web
 * layer as `context.tenant`. `null` there means the vendor's own space (`source: 'none'`), so this
 * shape only ever describes a request a school actually owns.
 */
export interface RequestTenant {
  schoolId: string;
  slug: string | null;
  /** `''` on the school's own domain, `/<slug>` under the installation's host. Links carry it. */
  prefix: string;
  source: Exclude<TenantSource, 'none'>;
  name: string;
}

export interface DomainCheck {
  hostname: string;
  /** The name answers in DNS at all. */
  resolves: boolean;
  /** …and what answers is this installation, proven by its own `/_health`. */
  pointsHere: boolean;
  /** `null` when the question could not be reached — an unresolved name has no certificate to judge. */
  certificate: boolean | null;
  checkedAt: string;
  note: string;
}

export interface DnsInstruction { type: 'A' | 'CNAME'; name: string; value: string; note: string }

export interface WebAddress {
  slug: string | null;
  /** Where this school actually opens: its own domain, or the installation's host plus the slug. */
  url: string;
  customDomain: string | null;
  domain: DomainCheck | null;
  instructions: DnsInstruction[];
}

/**
 * Paths the app itself answers on, which therefore can never be a school's slug. A school called
 * "Portal High" gets `portal-high`; one that somehow reduces to `portal` gets `portal-2`.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'api', 'assets', 'cron', 'install', 'login', 'logout', 'owner', 'dashboard', 'site', 'portal',
  'x', 'public', '_health', 'favicon.ico', 'robots.txt',
]);

/** 2–40 characters, starting and ending with a letter or a digit. One character is not a name. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
/** Where the last domain check for a school is kept, so the daily job can see what changed. */
export const DOMAIN_WATCH_KEY = 'tenant.domain_watch';

// ---------------------------------------------------------------- Bangla → a URL
/**
 * Words that turn up in nearly every Bangladeshi school's name. The letter rules below get most of
 * them right on their own; these are the ones where the conventional romanisation is what people
 * expect to see in a web address, and a rule would produce something nobody recognises.
 */
const BN_WORDS: Record<string, string> = {
  'বিদ্যালয়': 'bidyalaya', 'মহাবিদ্যালয়': 'mahabidyalaya', 'বালিকা': 'balika', 'বালক': 'balak',
  'উচ্চ': 'uchcha', 'মাধ্যমিক': 'madhyamik', 'প্রাথমিক': 'prathamik', 'নিম্ন': 'nimna',
  'সরকারি': 'sarkari', 'বেসরকারি': 'besarkari', 'আদর্শ': 'adarsha', 'পাঠশালা': 'pathshala',
  'স্কুল': 'skul', 'কলেজ': 'college', 'মাদ্রাসা': 'madrasa', 'দাখিল': 'dakhil', 'আলিম': 'alim',
  'একাডেমি': 'academy', 'অ্যাকাডেমি': 'academy', 'ক্যাডেট': 'cadet', 'শিক্ষা': 'shikkha',
  'প্রতিষ্ঠান': 'protishthan', 'ইনস্টিটিউট': 'institute', 'কিন্ডারগার্টেন': 'kindergarten',
  'জুনিয়র': 'junior', 'সিনিয়র': 'senior', 'হাই': 'high', 'গার্লস': 'girls', 'বয়েজ': 'boys',
};
const BN_INDEPENDENT_VOWELS: Record<string, string> = { 'অ': 'a', 'আ': 'a', 'ই': 'i', 'ঈ': 'i', 'উ': 'u', 'ঊ': 'u', 'ঋ': 'ri', 'এ': 'e', 'ঐ': 'oi', 'ও': 'o', 'ঔ': 'ou' };
const BN_VOWEL_SIGNS: Record<string, string> = { 'া': 'a', 'ি': 'i', 'ী': 'i', 'ু': 'u', 'ূ': 'u', 'ৃ': 'ri', 'ে': 'e', 'ৈ': 'oi', 'ো': 'o', 'ৌ': 'ou' };
const BN_CONSONANTS: Record<string, string> = {
  'ক': 'k', 'খ': 'kh', 'গ': 'g', 'ঘ': 'gh', 'ঙ': 'ng', 'চ': 'ch', 'ছ': 'chh', 'জ': 'j', 'ঝ': 'jh', 'ঞ': 'n',
  'ট': 't', 'ঠ': 'th', 'ড': 'd', 'ঢ': 'dh', 'ণ': 'n', 'ত': 't', 'থ': 'th', 'দ': 'd', 'ধ': 'dh', 'ন': 'n',
  'প': 'p', 'ফ': 'ph', 'ব': 'b', 'ভ': 'bh', 'ম': 'm', 'য': 'y', 'র': 'r', 'ল': 'l',
  'শ': 'sh', 'ষ': 'sh', 'স': 's', 'হ': 'h', 'ড়': 'r', 'ঢ়': 'rh', 'য়': 'y', 'ৎ': 't',
};
const BN_MARKS: Record<string, string> = { 'ং': 'ng', 'ঃ': 'h', 'ঁ': '' };
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const HASANTA = '্';
const IS_BENGALI = /[\u0980-\u09FF]/;

/**
 * A Bangla word written the way somebody would type it into a browser.
 *
 * The one rule that carries the whole thing: a Bengali consonant carries an inherent "a" unless a
 * vowel sign or a hasanta says otherwise — so `উচ্চ` is `uchcha`, not `uchch`. That alone turns
 * `সরনজাই` into `saranajai`, one syllable longer than anybody writes it, because Bengali drops the
 * inherent vowel in the middle of a run. Dropping it on the third consecutive inherent syllable
 * gives `saranjai`, `balika` and `bidyalaya` — which is as close as a table of letters gets. It is
 * an approximation and it only ever produces a web address, never a name shown to a person.
 */
export function transliterateBangla(input: string): string {
  let out = '';
  for (const word of input.split(/(\s+)/)) {
    if (!IS_BENGALI.test(word)) { out += word; continue; }
    const known = BN_WORDS[word];
    if (known) { out += known; continue; }
    let run = 0;                        // consecutive syllables carrying only the inherent vowel
    for (let i = 0; i < word.length; i++) {
      const ch = word[i];
      const cons = BN_CONSONANTS[ch];
      if (cons) {
        out += cons;
        const next = word[i + 1];
        if (next === HASANTA) { i++; run = 0; continue; }             // joined to the next consonant
        const sign = next ? BN_VOWEL_SIGNS[next] : undefined;
        if (sign !== undefined) { out += sign; i++; run = 0; continue; }
        const atEnd = i + 1 >= word.length;
        const nextIsConsonant = !!(next && BN_CONSONANTS[next]);
        if (!atEnd && nextIsConsonant && run >= 2) { run = 0; continue; }  // the inherent vowel is dropped
        out += 'a'; run++;
        continue;
      }
      const vowel = BN_INDEPENDENT_VOWELS[ch];
      if (vowel) { out += vowel; run = 0; continue; }
      const mark = BN_MARKS[ch];
      if (mark !== undefined) { out += mark; continue; }
      const digit = BN_DIGITS.indexOf(ch);
      if (digit >= 0) { out += String(digit); run = 0; continue; }
      if (BN_VOWEL_SIGNS[ch] !== undefined) { out += BN_VOWEL_SIGNS[ch]; run = 0; continue; }
      if (ch !== HASANTA) { out += ch; run = 0; }
    }
  }
  return out;
}

/**
 * A school's name as a web address: lowercase ASCII, `[a-z0-9-]`, 2–40 characters, cut at a word
 * boundary rather than mid-syllable. `fallback` (the school's code) stands in when a name has
 * nothing usable left in it — a name written entirely in a script we cannot transliterate, say.
 */
export function slugifySchoolName(name: string, fallback = ''): string {
  const ascii = transliterateBangla(String(name ?? ''))
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  let slug = ascii.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > 40) {
    const cut = slug.slice(0, 41);
    const boundary = cut.lastIndexOf('-');
    slug = (boundary >= 2 ? cut.slice(0, boundary) : slug.slice(0, 40)).replace(/-+$/, '');
  }
  if (slug.length >= 2) return slug;
  const fromCode = String(fallback ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return fromCode.length >= 2 ? fromCode : 'school';
}

/** Refuses anything that is not already a legal slug; the caller decides what to do about it. */
export function normalizeSlug(raw: string): string {
  const slug = String(raw ?? '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw badRequest('a web address is 2–40 characters of lowercase letters, digits and hyphens, starting and ending with a letter or a digit');
  }
  return slug;
}

/** `WWW.Saranjai.Edu.BD:443` → `saranjai.edu.bd`. Returns null for anything that is not a hostname. */
export function normalizeHost(raw: string | null | undefined): string | null {
  let host = String(raw ?? '').trim().toLowerCase();
  if (!host) return null;
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']') > 0 ? host.indexOf(']') : undefined);
  else if (host.includes(':')) host = host.slice(0, host.indexOf(':'));
  host = host.replace(/\.$/, '').replace(/^www\./, '');
  return host || null;
}

export function normalizeDomain(raw: string): string {
  const host = normalizeHost(String(raw ?? '').replace(/^https?:\/\//, '').split('/')[0]);
  if (!host || host.length > 160 || !DOMAIN_RE.test(host)) {
    throw badRequest('a domain looks like school.edu.bd — no protocol, no path, and at least one dot');
  }
  return host;
}

/** The first path segment, lowercased: `/saranjai/fees` → `saranjai`. */
export function firstSegment(path: string | null | undefined): string | null {
  const seg = String(path ?? '').split('?')[0].split('/').filter(Boolean)[0];
  return seg ? decodeURIComponent(seg).toLowerCase() : null;
}

/**
 * Gives a slug to every school that has none, at boot, without anybody typing one.
 *
 * A school installed before this column existed must come up reachable, so this runs beside the
 * automation catalogue reconcile — the same reason and the same place: an update reaches schools
 * that are already in the field only if boot repairs them. It only ever fills a blank; a slug
 * somebody chose is never rewritten.
 */
export async function ensureSchoolSlugs(db: Db, schoolId?: string): Promise<{ schools: number; slugs: Array<{ schoolId: string; slug: string }> }> {
  const rows = await db.query<Row>(
    `SELECT id, name, name_bn, code FROM schools WHERE (slug IS NULL OR slug = '') AND deleted_at IS NULL${schoolId ? ' AND id = ?' : ''} ORDER BY created_at ASC, id ASC`,
    schoolId ? [schoolId] : []);
  const slugs: Array<{ schoolId: string; slug: string }> = [];
  for (const r of rows) {
    const base = slugifySchoolName(String(r.name ?? '') || String(r.name_bn ?? ''), String(r.code ?? ''));
    const slug = await claimSlug(db, base, String(r.id));
    if (slug) slugs.push({ schoolId: String(r.id), slug });
  }
  return { schools: slugs.length, slugs };
}

/**
 * Writes the first free slug of the `base`, `base-2`, `base-3`… series onto a school.
 *
 * The unique key on `schools.slug` is what actually decides: two boots racing each other, or two
 * schools whose names reduce to the same word, collide on the write and the loser takes the next
 * number. Reserved words are treated as already taken, so a school called "Portal" gets `portal-2`
 * rather than a slug that would shadow the guardian app.
 */
export async function claimSlug(db: Db, base: string, schoolId: string): Promise<string | null> {
  for (let n = 1; n <= 50; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const candidate = `${base.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (RESERVED_SLUGS.has(candidate)) continue;
    if (await db.findOne('schools', { slug: candidate })) continue;
    try {
      // fenced: Postgres would abort the surrounding transaction on a unique violation, and losing
      // this race means somebody else took the name, not that anything is broken
      await db.attempt(() => db.update('schools', { slug: candidate, updated_at: nowSql() }, { id: schoolId }));
      return candidate;
    } catch { /* taken between the read and the write; try the next number */ }
  }
  return null;
}

// ---------------------------------------------------------------- the service
export class TenantService {
  /** host/slug → the school it belongs to. A hit lives 60 s; a miss lives one, so a domain added a
   *  moment ago starts working without a restart and a mistyped one costs one query a second. */
  private cache = new Map<string, { at: number; school: TenantSchool | null }>();
  private static readonly HIT_MS = 60_000;
  private static readonly MISS_MS = 1_000;
  private serverAddr: { at: number; hostname: string; ip: string | null } | null = null;

  constructor(
    private db: Db,
    private config: AppConfig,
    private settings: SettingsService,
    private notifications: NotificationService,
    private adapters: Adapters,
  ) {}

  /** Drops both caches. Called by every write here; the API calls it after a cPanel alias too. */
  forget() { this.cache.clear(); }

  // ---------------------------------------------------------------- resolve
  async resolve(req: { host?: string | null; path?: string | null }): Promise<ResolvedTenant> {
    const host = normalizeHost(req.host);
    if (host) {
      const byDomain = await this.cached(`d:${host}`, () => this.lookupDomain(host));
      if (byDomain) return { school: byDomain, prefix: '', source: 'domain' };
    }
    const seg = firstSegment(req.path);
    if (seg && !RESERVED_SLUGS.has(seg) && SLUG_RE.test(seg)) {
      const bySlug = await this.cached(`s:${seg}`, () => this.lookupSlug(seg));
      if (bySlug) return { school: bySlug, prefix: `/${bySlug.slug}`, source: 'slug' };
    }
    return { school: null, prefix: '', source: 'none' };
  }

  private async cached(key: string, load: () => Promise<TenantSchool | null>): Promise<TenantSchool | null> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < (hit.school ? TenantService.HIT_MS : TenantService.MISS_MS)) return hit.school;
    const school = await load();
    this.cache.set(key, { at: Date.now(), school });
    if (this.cache.size > 2000) for (const [k, v] of this.cache) if (Date.now() - v.at > TenantService.HIT_MS) this.cache.delete(k);
    return school;
  }

  private static readonly COLUMNS = 'id, name, code, slug, custom_domain, status';
  private row(r: Row | undefined): TenantSchool | null {
    if (!r) return null;
    return {
      id: String(r.id), name: String(r.name), code: String(r.code),
      slug: r.slug ? String(r.slug) : null,
      customDomain: r.custom_domain ? String(r.custom_domain) : null,
      status: String(r.status),
    };
  }
  /** `www.` is stripped on the way in and on the way out, so either spelling finds the school. */
  private async lookupDomain(host: string) {
    const rows = await this.db.query<Row>(
      `SELECT ${TenantService.COLUMNS} FROM schools WHERE deleted_at IS NULL AND LOWER(custom_domain) IN (?, ?) ORDER BY created_at ASC, id ASC LIMIT 1`,
      [host, `www.${host}`]);
    return this.row(rows[0]);
  }
  private async lookupSlug(slug: string) {
    const rows = await this.db.query<Row>(
      `SELECT ${TenantService.COLUMNS} FROM schools WHERE deleted_at IS NULL AND LOWER(slug) = ? ORDER BY created_at ASC, id ASC LIMIT 1`, [slug]);
    return this.row(rows[0]);
  }

  async school(schoolId: string): Promise<TenantSchool> {
    const rows = await this.db.query<Row>(`SELECT ${TenantService.COLUMNS} FROM schools WHERE id = ? AND deleted_at IS NULL`, [schoolId]);
    const school = this.row(rows[0]);
    if (!school) throw notFound('school');
    return school;
  }

  // ---------------------------------------------------------------- write
  /**
   * Gives a school its web address. Validates the shape, refuses a reserved word and refuses a name
   * another school already holds — a slug and a domain are both keys that route strangers' children
   * to a console, so a collision is a 409 and never a silent overwrite.
   */
  async setWebAddress(schoolId: string, input: { slug?: string | null; customDomain?: string | null }): Promise<TenantSchool> {
    const before = await this.school(schoolId);
    const set: Row = {};

    if (input.slug !== undefined && input.slug !== null && String(input.slug).trim() !== '') {
      const slug = normalizeSlug(String(input.slug));
      if (RESERVED_SLUGS.has(slug)) throw badRequest(`"${slug}" is one of the words this installation answers on itself — pick another`);
      const clash = await this.db.query<{ id: string }>(
        `SELECT id FROM schools WHERE LOWER(slug) = ? AND id <> ? AND deleted_at IS NULL LIMIT 1`, [slug, schoolId]);
      if (clash.length) throw new HttpError(409, `another school on this installation already opens at /${slug}`, 'conflict');
      set.slug = slug;
    }

    if (input.customDomain !== undefined) {
      if (input.customDomain === null || String(input.customDomain).trim() === '') set.custom_domain = null;
      else {
        const domain = normalizeDomain(String(input.customDomain));
        const clash = await this.db.query<{ id: string }>(
          `SELECT id FROM schools WHERE LOWER(custom_domain) IN (?, ?) AND id <> ? AND deleted_at IS NULL LIMIT 1`,
          [domain, `www.${domain}`, schoolId]);
        if (clash.length) throw new HttpError(409, `${domain} is already the address of another school on this installation`, 'conflict');
        set.custom_domain = domain;
      }
    }

    if (!Object.keys(set).length) return before;
    set.updated_at = nowSql();
    try {
      await this.db.attempt(() => this.db.update('schools', set, { id: schoolId }));
    } catch (e) {
      // the unique keys are the real arbiter; a race between two vendors' tabs lands here
      throw new HttpError(409, 'that web address was taken a moment ago; try another', 'conflict', { cause: (e as Error).message.slice(0, 120) });
    }
    // a slug or a domain change has to take effect at once, not in a minute
    this.forget();
    // a domain that changed makes the previous check meaningless
    if (set.custom_domain !== undefined && set.custom_domain !== before.customDomain) await this.settings.set(schoolId, DOMAIN_WATCH_KEY, null);
    return this.school(schoolId);
  }

  // ---------------------------------------------------------------- the address, as the vendor reads it out
  /** Where a school opens today, what its domain is doing, and the DNS to dictate down a telephone. */
  async webAddress(schoolId: string): Promise<WebAddress> {
    const school = await this.school(schoolId);
    const stored = await this.settings.get<DomainCheck>(schoolId, DOMAIN_WATCH_KEY);
    const domain = school.customDomain
      ? (stored && stored.hostname === school.customDomain ? stored : this.neverChecked(school.customDomain))
      : null;
    return {
      slug: school.slug,
      url: this.urlFor(school),
      customDomain: school.customDomain,
      domain,
      instructions: await this.dnsInstructions(school.customDomain),
    };
  }

  urlFor(school: TenantSchool): string {
    if (school.customDomain) return `https://${school.customDomain}`;
    const base = this.config.appUrl.replace(/\/$/, '');
    return school.slug ? `${base}/${school.slug}` : base;
  }

  private neverChecked(hostname: string): DomainCheck {
    return { hostname, resolves: false, pointsHere: false, certificate: null, checkedAt: '', note: 'Not looked up yet. The nightly check will report it, or open this page again after the DNS records below have been added.' };
  }

  /**
   * This installation's own public address, resolved once and kept for an hour.
   *
   * It is the number the vendor reads down a telephone to a school's IT person, so it is the real
   * A record of the host we are actually running on, not a placeholder. If the host will not
   * resolve to an IPv4 address — behind a proxy, or an IPv6-only box — the instruction becomes a
   * CNAME to the hostname itself, which is correct in that case and wrong as a guess otherwise.
   */
  async serverAddress(): Promise<{ hostname: string; ip: string | null }> {
    if (this.serverAddr && Date.now() - this.serverAddr.at < 3600_000) return { hostname: this.serverAddr.hostname, ip: this.serverAddr.ip };
    let hostname = 'localhost';
    try { hostname = new URL(this.config.appUrl).hostname; } catch { /* keep the default */ }
    let ip: string | null = net.isIPv4(hostname) ? hostname : null;
    if (!ip) {
      try { ip = (await dns.resolve4(hostname))[0] ?? null; }
      catch { try { ip = (await dns.lookup(hostname, { family: 4 })).address; } catch { ip = null; } }
    }
    this.serverAddr = { at: Date.now(), hostname, ip };
    return { hostname, ip };
  }

  async dnsInstructions(domain: string | null): Promise<DnsInstruction[]> {
    const { hostname, ip } = await this.serverAddress();
    const named = domain ?? 'the school\'s domain';
    if (ip) return [
      { type: 'A', name: '@', value: ip, note: `The domain itself. "@" is how most panels write the bare name; if yours will not take "@", type ${named} in full instead.` },
      { type: 'A', name: 'www', value: ip, note: `The same address again, so www.${domain ?? 'the-domain'} works too. Both spellings then reach the school and the site answers on either — nobody has to remember which one to type.` },
    ];
    return [
      { type: 'CNAME', name: '@', value: hostname, note: `The domain itself, pointed at this server by name. Some registrars refuse a CNAME on the bare domain and offer "ALIAS" or "ANAME" instead — either is the same thing.` },
      { type: 'CNAME', name: 'www', value: hostname, note: `The same record again for www, so www.${domain ?? 'the-domain'} is covered as well and either spelling reaches the school.` },
    ];
  }

  // ---------------------------------------------------------------- the domain check
  /**
   * Three questions, in the order they can fail: does the name answer in DNS, does what answers turn
   * out to be *this* installation, and is the certificate good. The middle one is the one that
   * matters and it is proved rather than guessed — `/_health` carries this installation's own id, so
   * a domain parked on somebody else's server is not mistaken for one that is working.
   */
  async checkDomain(hostname: string, timeoutMs = 5_000): Promise<DomainCheck> {
    const checkedAt = nowSql();
    let addresses: string[] = [];
    try { addresses = await dns.resolve4(hostname); }
    catch { try { addresses = [(await dns.lookup(hostname, { family: 4 })).address]; } catch { addresses = []; } }
    if (!addresses.length) {
      return { hostname, resolves: false, pointsHere: false, certificate: null, checkedAt, note: `${hostname} does not answer in DNS yet. Until the records below are added, nothing at that address reaches the school.` };
    }

    const me = this.installationId();
    let pointsHere = false, httpsAnswered = false, reached = '';
    for (const scheme of ['https', 'http'] as const) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${scheme}://${hostname}/_health`, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'pathshala-domain-watch' } });
        const body = await res.json().catch(() => null) as { installation?: string; url?: string } | null;
        if (scheme === 'https') httpsAnswered = true;
        reached = scheme;
        if (body && (body.installation === me || (body.url ?? '').replace(/\/$/, '') === this.config.appUrl.replace(/\/$/, ''))) { pointsHere = true; break; }
      } catch { /* try the next scheme; why it failed is answered below by what did work */ }
      finally { clearTimeout(timer); }
    }
    // `false` is only claimed where the host is demonstrably up on http and https is not: a name that
    // answers nowhere has no certificate to judge, and saying it is bad would send somebody to the
    // wrong problem
    const certificate: boolean | null = httpsAnswered ? true : reached === 'http' ? false : null;

    const note = pointsHere
      ? certificate === false
        ? `${hostname} reaches this installation, but over http only — the certificate is not valid yet. On cPanel, AutoSSL issues one within a few hours of the domain being added.`
        : `${hostname} reaches this installation${reached === 'https' ? ' over https' : ''}. Nothing further to do.`
      : `${hostname} answers at ${addresses[0]}, but that is not this server. The DNS records below have not taken effect, or the name points somewhere else.`;
    return { hostname, resolves: true, pointsHere, certificate, checkedAt, note };
  }

  /**
   * A stable name for this installation that gives nothing away. Derived from the app key rather
   * than stored, so it survives a restore and is the same on every process of the same install.
   */
  installationId(): string {
    return createInstallationId(this.config.appKey);
  }

  // ---------------------------------------------------------------- the alias on a shared host
  /**
   * On cPanel, Apache will not route an unknown hostname to our folder at all until the domain
   * exists as an alias in the account — the DNS can be perfect and the request still lands on the
   * server's default page. With an API token configured we add the alias ourselves; without one the
   * caller is told exactly what to add by hand, which is the same sentence either way.
   */
  async ensureAlias(domain: string) {
    const manual = `In cPanel → Domains → Create A New Domain, add ${domain} and point its document root at the folder Pathshala is installed in (public_html). Tick "Share document root" so www.${domain} is covered by the same entry.`;
    const cpanel = this.adapters.cpanel;
    if (!cpanel?.configured) return { configured: false, created: false, alreadyThere: false, error: null as string | null, manual };
    const r = await cpanel.addAlias(domain);
    return { ...r, manual };
  }

  // ---------------------------------------------------------------- the nightly watch
  jobs(): Record<string, ScheduledFn> {
    return {
      /**
       * Daily, per school: what is that school's own domain doing today? Only a *change* is worth a
       * message — a domain that has never been pointed at us is not news, and the same broken domain
       * every night trains the vendor to ignore the messages about it.
       */
      'platform.domain_watch': async ({ schoolId }) => this.watchDomain(schoolId),
    };
  }

  async watchDomain(schoolId: string) {
    const school = await this.school(schoolId).catch(() => null);
    if (!school?.customDomain) return { checked: false, reason: 'this school has no domain of its own' };
    const before = await this.settings.get<DomainCheck>(schoolId, DOMAIN_WATCH_KEY);
    const now = await this.checkDomain(school.customDomain);
    await this.settings.set(schoolId, DOMAIN_WATCH_KEY, now);

    // the previous state only counts if it was about the same hostname
    const prev = before && before.hostname === now.hostname ? before : null;
    const wasOk = !!prev?.pointsHere;
    const founderId = await this.founderSchoolId();
    const told: string[] = [];
    const tell = async (kind: string, title: string, body: string) => {
      if (!founderId) return;
      // notifyRoleOnce is the second belt: the state comparison above is what stops a nightly repeat,
      // and this stops two ticks in the same hour saying it twice
      const sent = await this.notifications.notifyRoleOnce(founderId, 'admin', 24, {
        channels: ['in_app', 'email'], eventKey: `tenant.${kind}`, entityType: 'core.school', entityId: schoolId, title, body,
      });
      if (sent.length) told.push(kind);
    };

    if (wasOk && !now.pointsHere) {
      await tell('domain_lost', `${school.name} is no longer reachable at ${now.hostname}`,
        `${now.note} Until this is fixed, anybody typing that address does not reach the school — its console still opens at ${this.config.appUrl.replace(/\/$/, '')}/${school.slug ?? ''}.`);
    } else if (prev && !wasOk && now.pointsHere) {
      await tell('domain_live', `${school.name} is live at ${now.hostname}`, now.note);
    } else if (now.pointsHere && now.certificate === false && prev?.certificate !== false) {
      await tell('domain_certificate', `${now.hostname} has no valid certificate`, now.note);
    }
    return { checked: true, hostname: now.hostname, resolves: now.resolves, pointsHere: now.pointsHere, certificate: now.certificate, changed: told.length > 0, told };
  }

  /**
   * The installation's oldest school — the vendor's own tenant, decided exactly as `OwnerService`
   * decides it (ULIDs sort by time, so `id` breaks a same-second tie). This service only ever reads
   * it, to know whom to tell about a domain that stopped working.
   */
  private async founderSchoolId(): Promise<string | null> {
    const rows = await this.db.query<{ id: string }>(`SELECT id FROM schools WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1`);
    return rows[0] ? String(rows[0].id) : null;
  }
}

/** Kept out of the class so `/_health` can answer with it before any service exists. */
export function createInstallationId(appKey: string): string {
  // a one-way digest of the app key: stable across restarts and restores, and it tells a stranger
  // nothing except whether two addresses are the same installation
  return hmac(appKey, 'pathshala.installation').slice(0, 16);
}
