import fs from 'node:fs';
import path from 'node:path';
import type { Db, Row } from './types.js';
import { ulid } from './ulid.js';

/**
 * Idempotent seeds. Global rows (permissions, feature flags) are seeded once; tenant rows
 * (roles, settings, leave types, grading scale, fee heads, chart of accounts, scheduled jobs,
 * automation rules, notification templates) are seeded per school. Safe to re-run at any time.
 */
export interface SeedOptions { schoolId?: string; dbDir: string; log?: (m: string) => void }
export interface SeedResult { inserted: Record<string, number> }

export const MODULES = ['core', 'platform', 'saas', 'cms', 'academic', 'people', 'curriculum', 'admissions', 'attendance', 'assessment', 'lms', 'diary', 'cocurricular', 'library', 'fees', 'accounting', 'wallet', 'hr', 'scholarships', 'transport', 'hostel', 'inventory', 'facilities', 'frontoffice', 'communication', 'welfare', 'documents', 'alumni', 'events', 'governance', 'compliance', 'analytics', 'ai', 'marketplace'] as const;
const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export'] as const;

export const SYSTEM_ROLES: Record<string, { name: string; level: number; perms: (p: string) => boolean }> = {
  super_admin: { name: 'Super Admin', level: 100, perms: () => true },
  admin: { name: 'Administrator', level: 90, perms: p => !p.startsWith('saas.') },
  principal: { name: 'Principal', level: 80, perms: p => !/^(saas|marketplace|platform\.hosting)/.test(p) && !p.endsWith('.delete') },
  accountant: { name: 'Accountant', level: 60, perms: p => /^(fees|accounting|wallet|scholarships|hr\.view|people\.view|academic\.view)/.test(p) },
  teacher: { name: 'Teacher', level: 40, perms: p => /^(academic\.view|people\.view|curriculum|attendance|assessment|lms|diary|library\.view|communication|welfare\.view|documents\.view)/.test(p) && !p.endsWith('.delete') },
  staff: { name: 'Staff', level: 30, perms: p => /\.view$/.test(p) && !/^(saas|accounting|hr|fees)/.test(p) },
  librarian: { name: 'Librarian', level: 40, perms: p => /^(library|people\.view|academic\.view)/.test(p) },
  driver: { name: 'Driver', level: 20, perms: p => /^(transport\.(view|edit))$/.test(p) },
  guardian: { name: 'Guardian', level: 10, perms: p => /^(fees\.view|attendance\.view|assessment\.view|communication\.view|diary\.view|academic\.view|documents\.view|transport\.view)$/.test(p) },
  student: { name: 'Student', level: 10, perms: p => /^(attendance\.view|assessment\.view|lms\.view|library\.view|communication\.view|diary\.view|academic\.view)$/.test(p) },
};

export async function seed(db: Db, opts: SeedOptions): Promise<SeedResult> {
  const log = opts.log ?? (() => {});
  const inserted: Record<string, number> = {};
  const bump = (t: string, n = 1) => { inserted[t] = (inserted[t] ?? 0) + n; };

  // ---- global: permissions ----
  const existingPerms = new Map((await db.findMany<{ id: string; key_name: string }>('permissions')).map(p => [p.key_name, p.id]));
  const permRows: Row[] = [];
  const allPermKeys: string[] = [];
  for (const m of MODULES) for (const a of ACTIONS) allPermKeys.push(`${m}.${a}`);
  allPermKeys.push('platform.automation', 'platform.hosting', 'platform.settings', 'core.users', 'core.roles', 'core.audit');
  for (const key of allPermKeys) {
    if (existingPerms.has(key)) continue;
    const id = ulid(); existingPerms.set(key, id);
    permRows.push({ id, key_name: key, module: key.split('.')[0], description: null });
  }
  if (permRows.length) { await db.insertMany('permissions', permRows); bump('permissions', permRows.length); }

  // ---- global: feature flags ----
  const flags = [['saas', 'Multi-tenant SaaS mode', false], ['cms', 'School website (CMS)', true], ['wallet', 'Wallet / POS', false], ['ai', 'AI assistant', false], ['marketplace', 'Plugin marketplace', false], ['sms', 'SMS channel', false], ['whatsapp', 'WhatsApp channel', false]] as const;
  for (const [key, desc, on] of flags) {
    if (await db.findOne('feature_flags', { key_name: key })) continue;
    await db.insert('feature_flags', { id: ulid(), key_name: key, description: desc, default_on: on }); bump('feature_flags');
  }

  if (!opts.schoolId) return { inserted };
  const sid = opts.schoolId;
  log(`seeding tenant ${sid}`);

  // ---- roles + role_permissions ----
  const roleIds: Record<string, string> = {};
  for (const [slug, def] of Object.entries(SYSTEM_ROLES)) {
    let role = await db.findOne<{ id: string }>('roles', { school_id: sid, slug });
    if (!role) { role = { id: ulid() }; await db.insert('roles', { id: role.id, school_id: sid, name: def.name, slug, is_system: true, level: def.level }); bump('roles'); }
    roleIds[slug] = role.id;
    const have = new Set((await db.findMany<{ permission_id: string }>('role_permissions', { role_id: role.id })).map(r => r.permission_id));
    const rows: Row[] = [];
    for (const [key, pid] of existingPerms) if (def.perms(key) && !have.has(pid)) rows.push({ id: ulid(), role_id: role.id, permission_id: pid });
    if (rows.length) { await db.insertMany('role_permissions', rows); bump('role_permissions', rows.length); }
  }

  // ---- settings ----
  const settings: Record<string, unknown> = {
    'calendar.weekend': ['fri', 'sat'],
    'notifications.quiet_hours': { from: '21:00', to: '07:00' },
    'notifications.channels': { push: true, sms: false, email: true, in_app: true },
    'attendance.cutoff_time': '10:30',
    'fees.due_day': 10,
    'fees.reminder_ladder_days': [-3, 0, 3, 7, 15],
    'locale.default': 'bn',
    'locale.numerals': 'bn',
    'automation.preview_hours': 24,
    'automation.alert_after_failures': 3,
    'hosting.mode': 'cpanel',
  };
  for (const [key, value] of Object.entries(settings)) {
    if (await db.findOne('settings', { school_id: sid, key_name: key })) continue;
    await db.insert('settings', { id: ulid(), school_id: sid, key_name: key, value: JSON.stringify(value) }); bump('settings');
  }

  // ---- shifts ----
  for (const [name, s, e] of [['Morning', '08:00:00', '13:00:00'], ['Day', '10:00:00', '16:00:00']]) {
    if (await db.findOne('shifts', { school_id: sid, name })) continue;
    await db.insert('shifts', { id: ulid(), school_id: sid, name, start_time: s, end_time: e }); bump('shifts');
  }

  // ---- leave types (BD conventions) ----
  const leaveTypes = [
    ['Casual Leave', 'CL', 'staff', 20, 'yearly', true, 0, false, 1],
    ['Sick Leave', 'SL', 'staff', 14, 'yearly', true, 0, true, 0],
    ['Earned Leave', 'EL', 'staff', 20, 'yearly', true, 60, false, 7],
    ['Maternity Leave', 'ML', 'staff', 182, 'none', true, 0, true, 30],
    ['Leave Without Pay', 'LWP', 'staff', 0, 'none', false, 0, false, 3],
    ['Sick', 'STU-SICK', 'student', 0, 'none', true, 0, true, 0],
    ['Family', 'STU-FAM', 'student', 0, 'none', true, 0, false, 1],
  ] as const;
  for (const [name, code, audience, days, accrual, paid, carry, doc, notice] of leaveTypes) {
    if (await db.findOne('leave_types', { school_id: sid, code })) continue;
    await db.insert('leave_types', { id: ulid(), school_id: sid, name, code, audience, days_per_year: days, accrual, is_paid: paid, carry_forward_max: carry, requires_document: doc, min_notice_days: notice }); bump('leave_types');
  }

  // ---- grading scale: Bangladesh GPA 5.0 ----
  if (!(await db.findOne('grading_scales', { school_id: sid, name: 'GPA 5.0 (Bangladesh)' }))) {
    const scaleId = ulid();
    await db.insert('grading_scales', { id: scaleId, school_id: sid, name: 'GPA 5.0 (Bangladesh)', is_default: true, gpa_max: 5, fail_gpa_zero: true }); bump('grading_scales');
    const bands = [['A+', 80, 100, 5, false], ['A', 70, 79.99, 4, false], ['A-', 60, 69.99, 3.5, false], ['B', 50, 59.99, 3, false], ['C', 40, 49.99, 2, false], ['D', 33, 39.99, 1, false], ['F', 0, 32.99, 0, true]] as const;
    await db.insertMany('grading_bands', bands.map(([grade, min, max, gp, fail]) => ({ id: ulid(), school_id: sid, scale_id: scaleId, grade, min_percent: min, max_percent: max, grade_point: gp, is_fail: fail })));
    bump('grading_bands', bands.length);
  }

  // ---- chart of accounts (BD school) ----
  const coa: [string, string, string, boolean, string | null][] = [
    ['1000', 'Assets', 'asset', true, null], ['1100', 'Cash in Hand', 'asset', false, '1000'], ['1200', 'Bank Accounts', 'asset', true, '1000'], ['1210', 'Bank — Collection', 'asset', false, '1200'], ['1220', 'bKash / Nagad Wallet', 'asset', false, '1200'], ['1300', 'Fees Receivable', 'asset', false, '1000'], ['1400', 'Advances & Deposits', 'asset', false, '1000'], ['1500', 'Fixed Assets', 'asset', true, '1000'], ['1510', 'Furniture & Fixtures', 'asset', false, '1500'], ['1520', 'Computers & Equipment', 'asset', false, '1500'], ['1530', 'Vehicles', 'asset', false, '1500'], ['1540', 'Buildings', 'asset', false, '1500'],
    ['2000', 'Liabilities', 'liability', true, null], ['2100', 'Fees Received in Advance', 'liability', false, '2000'], ['2200', 'Salary Payable', 'liability', false, '2000'], ['2300', 'Provident Fund Payable', 'liability', false, '2000'], ['2400', 'Tax Deducted at Source', 'liability', false, '2000'], ['2500', 'Student Wallet Liability', 'liability', false, '2000'], ['2600', 'Security Deposits', 'liability', false, '2000'], ['2700', 'Accounts Payable', 'liability', false, '2000'],
    ['3000', 'Equity', 'equity', true, null], ['3100', 'General Fund', 'equity', false, '3000'], ['3200', 'Retained Surplus', 'equity', false, '3000'],
    ['4000', 'Income', 'income', true, null], ['4100', 'Tuition Fees', 'income', false, '4000'], ['4110', 'Admission Fees', 'income', false, '4000'], ['4120', 'Session Fees', 'income', false, '4000'], ['4130', 'Exam Fees', 'income', false, '4000'], ['4140', 'Transport Fees', 'income', false, '4000'], ['4150', 'Hostel Fees', 'income', false, '4000'], ['4160', 'Library Fines', 'income', false, '4000'], ['4170', 'Late Fees & Fines', 'income', false, '4000'], ['4180', 'Canteen & Shop Sales', 'income', false, '4000'], ['4200', 'MPO Government Grant', 'income', false, '4000'], ['4300', 'Donations', 'income', false, '4000'], ['4900', 'Other Income', 'income', false, '4000'],
    ['5000', 'Expenses', 'expense', true, null], ['5100', 'Salaries & Allowances', 'expense', false, '5000'], ['5110', 'Employer PF Contribution', 'expense', false, '5000'], ['5200', 'Utilities', 'expense', false, '5000'], ['5300', 'Rent', 'expense', false, '5000'], ['5400', 'Repairs & Maintenance', 'expense', false, '5000'], ['5500', 'Stationery & Printing', 'expense', false, '5000'], ['5600', 'Transport Running Cost', 'expense', false, '5000'], ['5700', 'Hostel & Mess', 'expense', false, '5000'], ['5800', 'SMS & Communication', 'expense', false, '5000'], ['5850', 'Scholarships & Waivers', 'expense', false, '5000'], ['5900', 'Depreciation', 'expense', false, '5000'], ['5950', 'Bank & Gateway Charges', 'expense', false, '5000'], ['5990', 'Miscellaneous Expense', 'expense', false, '5000'],
  ];
  const glIds: Record<string, string> = {};
  for (const [code, name, type, group, parent] of coa) {
    const ex = await db.findOne<{ id: string }>('gl_accounts', { school_id: sid, code });
    if (ex) { glIds[code] = ex.id; continue; }
    const id = ulid(); glIds[code] = id;
    await db.insert('gl_accounts', { id, school_id: sid, code, name, account_type: type, parent_id: parent ? glIds[parent] ?? null : null, is_group: group, is_system: true }); bump('gl_accounts');
  }

  // ---- fee heads ----
  const feeHeads = [['Tuition Fee', 'TUITION', 'academic', '4100'], ['Admission Fee', 'ADMISSION', 'academic', '4110'], ['Session Fee', 'SESSION', 'academic', '4120'], ['Exam Fee', 'EXAM', 'academic', '4130'], ['Transport Fee', 'TRANSPORT', 'transport', '4140'], ['Hostel Fee', 'HOSTEL', 'hostel', '4150'], ['Late Fine', 'LATE_FINE', 'fine', '4170'], ['Library Fine', 'LIB_FINE', 'fine', '4160'], ['Form Fee', 'FORM', 'misc', '4110']] as const;
  for (const [name, code, kind, gl] of feeHeads) {
    if (await db.findOne('fee_heads', { school_id: sid, code })) continue;
    await db.insert('fee_heads', { id: ulid(), school_id: sid, name, code, head_kind: kind, gl_account_id: glIds[gl] ?? null, is_refundable: code === 'ADMISSION' }); bump('fee_heads');
  }

  // ---- scheduled jobs (docs/AUTOMATION.md) ----
  const jobs = readJson<{ job_key: string; cron_expr: string; rows: string }[]>(opts.dbDir, 'scheduled_jobs.json');
  for (const j of jobs) {
    if (await insertIfAbsent(db, 'scheduled_jobs', { id: ulid(), school_id: sid, job_key: j.job_key, cron_expr: j.cron_expr, timezone: 'Asia/Dhaka', payload: { rows: j.rows }, is_active: true }, { school_id: sid, job_key: j.job_key })) bump('scheduled_jobs');
  }

  // ---- automation rules (docs/AUTOMATION.md, editable per school) ----
  const rules = readJson<{ code: string; module: string; name: string; description: string; trigger_kind: string; event_type: string | null; condition_text: string; actions: unknown[] }[]>(opts.dbDir, 'automation_rules.json');
  for (const r of rules) {
    if (await insertIfAbsent(db, 'automation_rules', { id: ulid(), school_id: sid, code: r.code, name: r.name, module: r.module, description: r.description, trigger_kind: r.trigger_kind, event_type: r.event_type, cron_expr: null, conditions: r.condition_text ? { note: r.condition_text } : null, actions: r.actions as Row[], is_system: true, is_active: true, priority: 100, cooldown_minutes: 5, run_count: 0 }, { school_id: sid, code: r.code })) bump('automation_rules');
  }

  // ---- notification templates bn/en ----
  bump('notification_templates', await seedNotificationTemplates(db, sid));

  return { inserted };
}


/**
 * The messages the platform itself sends, in both languages.
 *
 * Kept out of `seed()` and exported because seeds run exactly once — when a school is created — so a
 * template added by a later release would otherwise reach nobody who is already installed. The boot
 * reconcile (`InstallerService.ensureAutomationCatalogue`) calls this for every school, and it only
 * ever adds what is missing: a template a school has edited is left exactly as the school wrote it.
 */
export const NOTIFICATION_TEMPLATES: [string, string, string, string | null, string][] = [
  ['auth.otp', 'sms', 'bn', null, '{{school}}: আপনার কোড {{code}}। {{minutes}} মিনিটের মধ্যে ব্যবহার করুন। কাউকে শেয়ার করবেন না।'],
  ['auth.otp', 'sms', 'en', null, '{{school}}: your code is {{code}}. Valid for {{minutes}} minutes. Do not share it.'],
  ['auth.otp', 'email', 'bn', '{{school}} — লগইন কোড', 'আপনার লগইন কোড: {{code}} ({{minutes}} মিনিট)।'],
  ['auth.otp', 'email', 'en', '{{school}} — your login code', 'Your login code is {{code}} (valid {{minutes}} minutes).'],
  ['auth.welcome', 'sms', 'bn', null, '{{school}} এ স্বাগতম, {{name}}! লগইন: {{url}}'],
  ['auth.welcome', 'sms', 'en', null, 'Welcome to {{school}}, {{name}}! Sign in: {{url}}'],
  ['installer.selftest', 'email', 'en', '{{school}} — Pathshala self-test', 'Mail is working. Installed at {{url}} on {{engine}}.'],
  ['installer.selftest', 'push', 'en', 'Pathshala is ready', 'Automation, queue and PDF rendering all passed the self-test.'],
  ['automation.rule_failed', 'push', 'bn', 'অটোমেশন ব্যর্থ', 'রুল {{rule}} {{attempts}} বার ব্যর্থ হয়েছে: {{error}}'],
  ['automation.rule_failed', 'push', 'en', 'Automation failed', 'Rule {{rule}} failed {{attempts}} times: {{error}}'],
  ['task.assigned', 'push', 'bn', 'নতুন কাজ', '{{title}} — শেষ সময় {{due}}'],
  ['task.assigned', 'push', 'en', 'New task', '{{title}} — due {{due}}'],
  ['approval.requested', 'push', 'bn', 'অনুমোদন প্রয়োজন', '{{summary}}'],
  ['approval.requested', 'push', 'en', 'Approval needed', '{{summary}}'],
  ['fees.invoice_created', 'sms', 'bn', null, '{{school}}: {{student}} এর {{month}} মাসের বেতন ৳{{amount}}, শেষ তারিখ {{due}}। পরিশোধ: {{url}}'],
  ['fees.invoice_created', 'sms', 'en', null, '{{school}}: fee for {{student}} ({{month}}) is Tk {{amount}}, due {{due}}. Pay: {{url}}'],
  ['attendance.absent', 'sms', 'bn', null, '{{school}}: {{student}} আজ ({{date}}) অনুপস্থিত। কারণ জানাতে রিপ্লাই করুন।'],
  ['attendance.absent', 'sms', 'en', null, '{{school}}: {{student}} is absent today ({{date}}). Reply with the reason.'],
  // The school's own sign-in address, sent to the school and to nobody else. It never carries the
  // password: the address and the password travel apart, so one intercepted message opens nothing.
  ['owner.school_ready', 'email', 'bn', '{{school}} — আপনার সাইন-ইন ঠিকানা',
    '{{school}} এর জন্য Pathshala প্রস্তুত।\n\nসাইন ইন করুন: {{url}}\nআপনার আইডি: {{identifier}}\n\nপাসওয়ার্ড আলাদাভাবে দেওয়া হয়েছে — এই বার্তায় নেই।\n\nএই ঠিকানাটি শুধু আপনার স্কুলের কর্মীদের মধ্যেই রাখুন; এটি কোথাও লিঙ্ক করা নেই এবং কেউ অনুমান করে খুঁজে পাবে না। অভিভাবক ও শিক্ষার্থীরা {{portalUrl}} ঠিকানায় যাবেন।'],
  ['owner.school_ready', 'email', 'en', '{{school}} — your sign-in address',
    'Pathshala is ready for {{school}}.\n\nSign in here: {{url}}\nYour sign-in ID: {{identifier}}\n\nThe password is given to you separately — it is not in this message.\n\nPlease keep this address to your own staff. It is linked from nowhere and cannot be guessed, which is what keeps your console off the open internet. Guardians and students use {{portalUrl}} instead.'],
];

/**
 * Adds any of the templates above that this school does not already have. Returns how many were
 * written, so a caller can report an update that actually changed something.
 */
export async function seedNotificationTemplates(db: Db, schoolId: string): Promise<number> {
  let n = 0;
  for (const [event_key, channel, locale, subject, body] of NOTIFICATION_TEMPLATES) {
    if (await db.findOne('notification_templates', { school_id: schoolId, event_key, channel, locale })) continue;
    const vars = [...body.matchAll(/{{(\w+)}}/g)].map(m => m[1]);
    await db.insert('notification_templates', { id: ulid(), school_id: schoolId, event_key, channel, locale, subject, body, variables: vars, is_active: true });
    n++;
  }
  return n;
}

/**
 * Inserts a row unless the same one arrives from somewhere else first.
 *
 * Seeding a school is no longer the only thing that writes these rows: the automation catalogue is
 * reconciled at boot and again on every watchdog tick, so a school being provisioned at that moment
 * can lose a race against a unique key it shares. Losing it means the row is there, which is what the
 * seed was asking for — the failure worth avoiding is a school left half-seeded because two passes
 * agreed with each other.
 */
async function insertIfAbsent(db: Db, table: string, row: Row, key: Row): Promise<boolean> {
  if (await db.findOne(table, key as never)) return false;
  try {
    await db.attempt(() => db.insert(table, row));
    return true;
  } catch (e) {
    if (await db.findOne(table, key as never)) return false;
    throw e;
  }
}

export interface SeededJob { job_key: string; cron_expr: string; rows: string }
export interface SeededRule { code: string; module: string; name: string; description: string; trigger_kind: string; event_type: string | null; condition_text: string; actions: unknown[] }
/** The automation catalogue the build shipped, so a running install can reconcile itself against it. */
export function catalogue(dbDir: string) {
  return {
    jobs: readJson<SeededJob[]>(dbDir, 'scheduled_jobs.json'),
    rules: readJson<SeededRule[]>(dbDir, 'automation_rules.json'),
  };
}

function readJson<T>(dbDir: string, file: string): T {
  const p = path.join(dbDir, 'seeds', file);
  if (!fs.existsSync(p)) return [] as unknown as T;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}
