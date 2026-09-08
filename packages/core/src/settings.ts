import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { OutboxService } from './automation/outbox.js';
import { badRequest, currentContext, notFound } from './context.js';

export type SettingType = 'string' | 'number' | 'boolean' | 'time' | 'list' | 'object' | 'secret';

export interface SettingMeta {
  /** The console module the key belongs to. */
  module: string;
  type: SettingType;
  /** The job, service or method that actually reads this row — named so a school can check. */
  readBy: string | null;
  /** What the value does, in one line, for the Policies list. */
  note: string;
}

export interface SettingRow extends SettingMeta {
  key: string;
  /** The stored value, or `{ enc: true }` where it is an encrypted secret. */
  value: unknown;
  secret: boolean;
  seeded: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * What each key is for, and what reads it.
 *
 * This is written by hand and checked against the call sites rather than generated, because the
 * point of the Policies screen is to tell a head teacher which nightly job a number changes. A key
 * with `readBy: null` is seeded and nothing reads it yet — the screen says so instead of implying
 * the value matters.
 */
export const SETTING_CATALOGUE: Record<string, SettingMeta> = {
  'calendar.weekend': { module: 'academic', type: 'list', readBy: 'AcademicService.weeklyOffs', note: 'Which days of the week the school is closed. The calendar and the register expect nobody on these days.' },
  'attendance.cutoff_time': { module: 'attendance', type: 'time', readBy: 'AttendanceService.ensureDefaultPolicy', note: 'The time the first attendance policy is created with. Once a policy exists, the policy row is what the auto-absent job reads.' },
  'notifications.quiet_hours': { module: 'communication', type: 'object', readBy: 'NotificationService.notify', note: 'A message raised inside this window waits until it ends. OTP ignores it.' },
  'notifications.channels': { module: 'communication', type: 'object', readBy: 'NotificationService.notify', note: 'Which channels a notification may use at all. A channel switched off here is never tried.' },
  'admissions.required_documents': { module: 'admissions', type: 'list', readBy: 'AdmissionsService — application checklist', note: 'The documents an application is incomplete without.' },
  'commerce.default_daily_limit': { module: 'commerce', type: 'number', readBy: 'CommerceService — wallet spend', note: 'How much a child may spend from the wallet in one day when no per-child limit is set.' },
  'commerce.low_balance_at': { module: 'commerce', type: 'number', readBy: 'CommerceService — wallet top-up alert', note: 'The balance at which the guardian is told to top up.' },
  'compliance.census_months': { module: 'compliance', type: 'list', readBy: 'compliance.census scheduled job', note: 'The months the BANBEIS census return is prepared in.' },
  'compliance.response_days': { module: 'compliance', type: 'number', readBy: 'compliance.data_requests scheduled job', note: 'How many days a data request may stand before it is overdue.' },
  'hostel.meal_rates': { module: 'hostel', type: 'object', readBy: 'HostelService — mess billing', note: 'What each meal is charged at when the mess bill is raised.' },
  'hr.pay_day': { module: 'hr', type: 'number', readBy: 'hr.payroll scheduled job', note: 'The day of the month payroll is prepared on.' },
  'hr.gratuity': { module: 'hr', type: 'object', readBy: 'HrService.gratuity', note: 'The gratuity rule: whether it is on, the years of service it needs, the months paid per year, and what forfeits it.' },
  'ai.monthly_budget': { module: 'ai', type: 'number', readBy: 'AiService.budgetLeft', note: 'What the school will spend on the AI provider in a month. Drafting stops when it is used up.' },
  'ivr.webhook_secret': { module: 'ivr', type: 'secret', readBy: 'IvrService — inbound call gateway', note: 'The shared secret the voice gateway sends. Written encrypted and never read back out.' },
  'ivr.silence_alerted_on': { module: 'ivr', type: 'string', readBy: 'ivr.watch scheduled job', note: 'Housekeeping: the day the office was last told the line had gone quiet. Written by the job, not by a person.' },
  'backup.target': { module: 'platform', type: 'string', readBy: 'platform.backup scheduled job', note: 'Where the nightly backup is shipped: local, dropbox, gdrive or s3.' },
  'backup.keep_days': { module: 'platform', type: 'number', readBy: 'platform.backup scheduled job', note: 'How many days of backups are kept before the old ones are deleted.' },
  'backup.dropbox': { module: 'platform', type: 'secret', readBy: 'platform.backup scheduled job', note: 'The Dropbox token and folder the backup is uploaded with. Held for the whole installation, not for one school, and set by whoever runs the host.' },
  'backup.gdrive': { module: 'platform', type: 'secret', readBy: 'platform.backup scheduled job', note: 'The Google Drive credentials the backup is uploaded with. Held for the whole installation, not for one school, and set by whoever runs the host.' },
  'backup.s3': { module: 'platform', type: 'secret', readBy: 'platform.backup scheduled job', note: 'The S3 credentials the backup is uploaded with. Held for the whole installation, not for one school, and set by whoever runs the host.' },
  'platform.storage_warn_mb': { module: 'platform', type: 'number', readBy: 'platform.watchdog scheduled job', note: 'The uploads size at which the watchdog warns that the hosting plan is filling up.' },
  'fees.due_day': { module: 'fees', type: 'number', readBy: null, note: 'Seeded, but the due day actually used comes from each fee structure item. Changing this changes nothing yet.' },
  'fees.reminder_ladder_days': { module: 'fees', type: 'list', readBy: null, note: 'Seeded. The reminder ladder in use is the one on the automation rule, not this row.' },
  'locale.default': { module: 'core', type: 'string', readBy: null, note: 'Seeded. The language a person sees comes from their own user row, then the school row.' },
  'locale.numerals': { module: 'core', type: 'string', readBy: null, note: 'Seeded. Bangla numerals are chosen by locale in the UI, not by this row.' },
  'automation.preview_hours': { module: 'platform', type: 'number', readBy: null, note: 'Seeded. Preview is set per rule (`automation_rules.preview_until`), not from this row.' },
  'automation.alert_after_failures': { module: 'platform', type: 'number', readBy: null, note: 'Seeded. The relay alerts on its own failure count, not from this row.' },
  'hosting.mode': { module: 'platform', type: 'string', readBy: null, note: 'Seeded record of how this copy is hosted. The adapters are chosen by `.env`, not by this row.' },
};

/** Keys whose value is a secret whatever the catalogue says — a provider key added later, say. */
const SECRET_KEY = /(secret|password|token|api_?key|credential|private)/i;

/** True when this value must never leave the server: an `{ enc }` wrapper, or a key that names a secret. */
export function isSecretSetting(key: string, value: unknown): boolean {
  if (SETTING_CATALOGUE[key]?.type === 'secret') return true;
  if (SECRET_KEY.test(key)) return true;
  return !!value && typeof value === 'object' && typeof (value as { enc?: unknown }).enc === 'string';
}

const typeOf = (value: unknown): SettingType =>
  Array.isArray(value) ? 'list' : value === null ? 'string' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : typeof value === 'object' ? 'object' : /^\d{1,2}:\d{2}(:\d{2})?$/.test(String(value)) ? 'time' : 'string';

export interface SchoolProfilePatch {
  name?: string; nameBn?: string | null; eiin?: string | null; mpoCode?: string | null; board?: string | null; institutionType?: string;
  address?: string | null; phone?: string | null; email?: string | null; website?: string | null;
  timezone?: string; currency?: string; locale?: 'bn' | 'en'; theme?: unknown;
}

const PROFILE_COLUMNS: Record<keyof SchoolProfilePatch, string> = {
  name: 'name', nameBn: 'name_bn', eiin: 'eiin', mpoCode: 'mpo_code', board: 'board', institutionType: 'institution_type',
  address: 'address', phone: 'phone', email: 'email', website: 'website', timezone: 'timezone', currency: 'currency', locale: 'locale', theme: 'theme',
};

/** Per-school key/value settings (JSON values) with a small in-memory cache per process. */
export class SettingsService {
  private cache = new Map<string, { at: number; value: unknown }>();
  constructor(private db: Db, private outbox?: OutboxService, private ttlMs = 15_000) {}

  async get<T = unknown>(schoolId: string, key: string, fallback: T | null = null): Promise<T | null> {
    const ck = `${schoolId}:${key}`;
    const hit = this.cache.get(ck);
    if (hit && Date.now() - hit.at < this.ttlMs) return (hit.value ?? fallback) as T | null;
    const row = await this.db.findOne<{ value: unknown }>('settings', { school_id: schoolId, key_name: key });
    const value = row ? json<T>(row.value) : null;
    this.cache.set(ck, { at: Date.now(), value });
    return value ?? fallback;
  }

  async set(schoolId: string, key: string, value: unknown): Promise<void> {
    const before = await this.get(schoolId, key);
    const userId = currentContext()?.userId ?? null;
    await this.db.transaction(async tx => {
      const row = await tx.findOne<{ id: string }>('settings', { school_id: schoolId, key_name: key });
      // JSON columns need valid JSON even for scalars (MySQL rejects bare text), so always stringify here
      if (row) await tx.update('settings', { value: JSON.stringify(value ?? null), updated_by: userId, updated_at: nowSql() }, { id: row.id });
      else await tx.insert('settings', { id: ulid(), school_id: schoolId, key_name: key, value: JSON.stringify(value ?? null), updated_by: userId });
      if (this.outbox) await this.outbox.emit(tx, { type: 'settings.changed', schoolId, aggregateType: 'core.setting', aggregateId: row?.id ?? key, payload: { key, before, after: value } });
    });
    this.cache.delete(`${schoolId}:${key}`);
  }

  async all(schoolId: string): Promise<Record<string, unknown>> {
    const rows = await this.db.findMany<{ key_name: string; value: unknown }>('settings', { school_id: schoolId });
    return Object.fromEntries(rows.map(r => [r.key_name, json(r.value)]));
  }

  /**
   * Every key this school has, with what reads it and what the value means — keyed by the key itself
   * so a caller can address one row without scanning. A secret never leaves as its value: it comes
   * back as `{ enc: true }`, which says the thing is configured and nothing more.
   */
  async list(schoolId: string): Promise<Record<string, SettingRow>> {
    const rows = await this.db.findMany<Row>('settings', { school_id: schoolId }, { orderBy: 'key_name ASC' });
    const out: Record<string, SettingRow> = {};
    for (const r of rows) {
      const key = String(r.key_name);
      const raw = json(r.value);
      const meta = SETTING_CATALOGUE[key] ?? { module: key.split('.')[0], type: typeOf(raw), readBy: null, note: 'Not one of the keys Pathshala ships; something in this school wrote it.' };
      const secret = isSecretSetting(key, raw);
      out[key] = {
        key, module: meta.module, type: secret ? 'secret' : meta.type, readBy: meta.readBy, note: meta.note,
        value: secret ? { enc: true } : raw, secret, seeded: key in SETTING_CATALOGUE,
        updatedAt: r.updated_at ? String(r.updated_at) : null, updatedBy: r.updated_by ? String(r.updated_by) : null,
      };
    }
    return out;
  }

  /** A key Pathshala ships and this school has not written yet still belongs on the Policies list. */
  missing(have: Record<string, SettingRow>): SettingRow[] {
    return Object.entries(SETTING_CATALOGUE).filter(([k]) => !(k in have)).map(([key, meta]) => ({
      key, ...meta, value: null, secret: meta.type === 'secret', seeded: true, updatedAt: null, updatedBy: null,
    }));
  }

  // ---------- the school's own row ----------
  /** The school profile as the console edits it. `settings` (the JSON column) is not part of it. */
  async profile(schoolId: string) {
    const s = await this.db.findOne<Row>('schools', { id: schoolId });
    if (!s) throw notFound('school');
    return {
      id: String(s.id), code: String(s.code), name: String(s.name), nameBn: (s.name_bn as string) ?? null,
      institutionType: String(s.institution_type), board: (s.board as string) ?? null, eiin: (s.eiin as string) ?? null, mpoCode: (s.mpo_code as string) ?? null,
      address: (s.address as string) ?? null, phone: (s.phone as string) ?? null, email: (s.email as string) ?? null, website: (s.website as string) ?? null,
      timezone: String(s.timezone), currency: String(s.currency), locale: String(s.locale), theme: json(s.theme), status: String(s.status),
    };
  }

  async updateProfile(schoolId: string, patch: SchoolProfilePatch) {
    const before = await this.profile(schoolId);
    const set: Row = {};
    for (const [field, column] of Object.entries(PROFILE_COLUMNS)) {
      const k = field as keyof SchoolProfilePatch;
      if (!(k in patch)) continue;
      const v = patch[k];
      // the theme is a JSON column: MySQL and Postgres refuse a bare string in one
      set[column] = column === 'theme' ? (v == null ? null : JSON.stringify(v)) : (v as never);
    }
    if (!Object.keys(set).length) return { updated: 0, profile: before };
    set.updated_at = nowSql();
    const updated = await this.db.update('schools', set, { id: schoolId });
    return { updated, profile: await this.profile(schoolId), before };
  }

  invalidate(schoolId?: string) { for (const k of this.cache.keys()) if (!schoolId || k.startsWith(schoolId + ':')) this.cache.delete(k); }
}

/** Guard for the settings write endpoint: a value the browser sends is never allowed to be a secret. */
export function assertWritableSetting(key: string, value: unknown) {
  if (isSecretSetting(key, value) || SETTING_CATALOGUE[key]?.type === 'secret') {
    throw badRequest(`${key} holds a secret and is set by the module that owns it, not from this list`);
  }
}
