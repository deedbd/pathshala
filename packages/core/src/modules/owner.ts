import { randomInt } from 'node:crypto';
import type { Db, Row } from '@pathshala/db';
import { json, nowSql } from '@pathshala/db';
import type { AppConfig } from '../config.js';
import type { AuditService } from '../audit.js';
import type { RbacService } from '../rbac.js';
import type { AuthService } from '../auth/service.js';
import type { InstallerService } from '../installer.js';
import type { NotificationService } from '../notifications.js';
import type { SaasService } from './saas.js';
import type { PlatformService } from './platform.js';
import type { TenantService, WebAddress } from '../tenant.js';
import { HttpError, badRequest, forbidden, notFound } from '../context.js';
import { round } from './accounting.js';

/** The caller, as the server resolved them from the session. */
export interface OwnerUser { id: string; school_id: string; user_type?: string }

export interface ProvisionInput {
  schoolName: string;
  schoolNameBn?: string | null;
  schoolCode?: string | null;
  institutionType?: 'school' | 'college' | 'school_college' | 'madrasa' | 'kindergarten' | 'coaching' | 'university';
  locale?: 'bn' | 'en';
  adminName: string;
  adminPhone: string;
  adminEmail?: string | null;
  /** Optional: when the owner does not choose one, a strong password is generated and returned once. */
  adminPassword?: string | null;
  planId?: string | null;
  billingCycle?: 'monthly' | 'yearly';
  trialDays?: number;
  discountPct?: number;
  referralCode?: string | null;
}

export interface SchoolFilter { q?: string; status?: string; planId?: string; limit?: number; offset?: number }
export type OwnerSchoolStatus = 'active' | 'trial' | 'past_due' | 'suspended' | 'closed';

/** Password made of characters nobody misreads down a phone line: no O/0, no I/l/1. */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export function generatePassword(length = 14) {
  let out = '';
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[randomInt(0, PASSWORD_ALPHABET.length)];
  return out;
}

/**
 * The vendor's half of the platform: the console the owner of Pathshala uses to sell it.
 *
 * Everything else in this codebase belongs to a school. `SaasService` already knows what a school
 * pays and what an unpaid bill costs them, but it is reached with a `saas.*` permission that any
 * school's own super admin carries — inside their own tenant, quite legitimately. That is enough for
 * one school's billing page and nowhere near enough for a list of every client on the installation.
 *
 * So this is the second service that crosses the tenant boundary (after `GroupsService`), and it is
 * gated the same way: the gate is a private method of the service, every public method goes through
 * it first, and the route layer adds nothing the service does not already enforce.
 *
 *  - **Who is the vendor?** The super admin of the founder school — the installation's oldest school,
 *    decided exactly as `GroupsService.requireFounder` decides it, because that is the school whose
 *    form the owner filled in when they installed the software. Every other tenant in the database
 *    was created *by* that person, through `provision` below. A school's own admin is refused, and so
 *    is another school's super admin: being a super admin is a statement about one tenant.
 *  - **Fail closed.** No caller, no founder school, no super_admin role, or a portal account: 403.
 *
 * Two things this deliberately does not do. There is no "sign in as this school": support gets what
 * it actually needs — a new or reset administrator login, which leaves a row in the school's own
 * audit trail that a person can point at. And nothing here writes another module's tables: schools
 * are created through `InstallerService`, subscriptions and invoices through `SaasService`, logins
 * through `AuthService`. The only table this service writes is `schools.status`, which no module owns
 * and which is the vendor's own switch.
 */
/** The role that says "this account belongs to the company that sells the software". */
export const OWNER_ROLE = 'platform_owner';

export class OwnerService {
  constructor(
    private db: Db,
    private config: AppConfig,
    private audit: AuditService,
    private rbac: RbacService,
    private auth: AuthService,
    private installer: InstallerService,
    private notifications: NotificationService,
    private saas: SaasService,
    private platform: PlatformService,
    private tenant: TenantService,
  ) {}

  // ---------------------------------------------------------------- the gate
  /** The installation's oldest school. ULIDs sort by time, so `id` breaks a same-second tie. */
  private async founderSchool() {
    const first = await this.db.findOne<Row>('schools', {}, { orderBy: 'created_at ASC, id ASC' });
    if (!first) throw forbidden('this installation has no school yet');
    return first;
  }

  /**
   * The only door into this service. The caller must be a super admin *of the founder school*: the
   * role alone is not enough, because every school has one, and the school alone is not enough,
   * because a clerk of the vendor's own school is not the vendor.
   */
  async requireOwner(user: OwnerUser | null | undefined) {
    if (!user?.id || !user.school_id) throw forbidden('the owner console needs a signed-in account');
    if (user.user_type && ['guardian', 'student', 'alumni'].includes(user.user_type)) throw forbidden('the owner console is not a portal endpoint');
    const founder = await this.founderSchool();
    if (String(founder.id) !== String(user.school_id)) throw forbidden('the owner console belongs to the school this installation was created with');
    const access = await this.rbac.accessFor(user.id);
    if (!access.roles.includes(OWNER_ROLE)) throw forbidden('the owner console belongs to the Pathshala team');
    return { founder, founderId: String(founder.id), access };
  }

  /** Whether anybody on this installation is the vendor yet. A school-only install: nobody, for ever. */
  async hasOwner(): Promise<boolean> {
    const founder = await this.founderSchool().catch(() => null);
    if (!founder) return false;
    // `user_roles` carries no school of its own — the role row does, and the user belongs to a school
    const rows = await this.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
       WHERE u.school_id = ? AND r.slug = ?`,
      [String(founder.id), OWNER_ROLE]);
    return Number(rows[0]?.n ?? 0) > 0;
  }

  /**
   * The first person through the owner door becomes the vendor, and only the first.
   *
   * There is no earlier moment to do this in: the console cannot be opened to grant the role, and a
   * role granted to everybody who happens to be a super admin would lock every single-school customer
   * out of their own sign-in page. So the door is the ceremony — it is behind a path written into
   * `.env` at install, a machine the owner has trusted, a password and a second factor — and it
   * happens once. Afterwards `requireOwner` asks only for the role.
   */
  async claimOwnership(user: OwnerUser | null | undefined) {
    if (!user?.id || !user.school_id) throw forbidden('the owner console needs a signed-in account');
    const founder = await this.founderSchool();
    if (String(founder.id) !== String(user.school_id)) throw forbidden('the owner console belongs to the school this installation was created with');
    if (await this.hasOwner()) return this.requireOwner(user);
    const access = await this.rbac.accessFor(user.id);
    if (!access.roles.includes('super_admin')) throw forbidden('the first owner must already be a super admin of this school');
    await this.rbac.assignRole(user.id, OWNER_ROLE, String(founder.id));
    await this.audit.log({ action: 'create', entityType: 'owner.claim', entityId: user.id, after: { role: OWNER_ROLE, school: String(founder.id) } });
    this.rbac.invalidate?.(user.id);
    return this.requireOwner(user);
  }

  // ---------------------------------------------------------------- shared SQL
  /**
   * The school's live subscription, if it has one: the newest row that is still running. Written as a
   * scalar subquery rather than a window function so the same statement runs on SQLite, MySQL and
   * Postgres, and tie-broken on id because two rows can share a second.
   */
  private static readonly LIVE_SUB = `LEFT JOIN saas_subscriptions sub ON sub.id = (
      SELECT x.id FROM saas_subscriptions x WHERE x.school_id = s.id AND x.status IN ('trial','active','past_due')
      ORDER BY x.created_at DESC, x.id DESC LIMIT 1)
    LEFT JOIN saas_plans p ON p.id = sub.plan_id`;

  /**
   * What the owner means by "how is this client doing": the school's own status wins (the vendor
   * suspended it, or it closed), then what it owes, then whether it is still on trial.
   */
  private static readonly STATUS = `CASE
      WHEN s.status = 'closed' THEN 'closed'
      WHEN s.status = 'suspended' THEN 'suspended'
      WHEN sub.status = 'past_due' THEN 'past_due'
      WHEN sub.status = 'trial' THEN 'trial'
      WHEN sub.id IS NULL AND s.status = 'trial' THEN 'trial'
      ELSE 'active' END`;

  private since(ms: number) { return nowSql(new Date(Date.now() - ms)); }

  // ---------------------------------------------------------------- overview
  /** The one screen: how many clients, of what kind, worth how much, and what is broken. */
  async overview(user: OwnerUser) {
    await this.requireOwner(user);
    const stuckSince = this.since(30 * 60_000);
    const staleSince = this.since(48 * 3600_000);
    const [statuses, people, subs, invoices, tickets, jobs, events, backups] = await Promise.all([
      // grouped over a derived table, not over the CASE itself: MySQL's ONLY_FULL_GROUP_BY refuses to
      // match a repeated expression in GROUP BY, however identical the two copies are
      this.db.query<{ effective_status: string; n: number }>(
        `SELECT t.effective_status, COUNT(*) AS n FROM (
           SELECT ${OwnerService.STATUS} AS effective_status FROM schools s ${OwnerService.LIVE_SUB} WHERE s.deleted_at IS NULL
         ) t GROUP BY t.effective_status`),
      this.db.query<{ students: number; staff: number }>(
        `SELECT (SELECT COUNT(*) FROM students st JOIN schools sc ON sc.id = st.school_id WHERE st.status = 'active' AND st.deleted_at IS NULL AND sc.deleted_at IS NULL) AS students,
                (SELECT COUNT(*) FROM staff sf JOIN schools sc ON sc.id = sf.school_id WHERE sf.status IN ('active','probation','on_leave') AND sf.deleted_at IS NULL AND sc.deleted_at IS NULL) AS staff`),
      this.db.query<Row>(
        `SELECT sub.billing_cycle, sub.price, sub.status, pl.currency FROM saas_subscriptions sub
         JOIN saas_plans pl ON pl.id = sub.plan_id JOIN schools s ON s.id = sub.school_id
         WHERE s.deleted_at IS NULL AND sub.status IN ('trial','active','past_due')`),
      this.db.query<{ status: string; n: number; amount: number }>(
        `SELECT i.status, COUNT(*) AS n, COALESCE(SUM(i.total), 0) AS amount FROM saas_invoices i GROUP BY i.status`),
      this.db.query<{ status: string; n: number }>(`SELECT t.status, COUNT(*) AS n FROM saas_support_tickets t GROUP BY t.status`),
      this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM background_jobs WHERE status = 'failed'`),
      this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox_events WHERE published_at IS NULL AND occurred_at < ?`, [stuckSince]),
      this.db.query<{ school_id: string; last_ok: string | null; n: number }>(
        `SELECT b.school_id, MAX(CASE WHEN b.status = 'success' THEN b.started_at END) AS last_ok, COUNT(*) AS n FROM backups b GROUP BY b.school_id`),
    ]);

    const byStatus = (s: OwnerSchoolStatus) => Number(statuses.find(r => String(r.effective_status) === s)?.n ?? 0);
    const schools = { total: statuses.reduce((t, r) => t + Number(r.n), 0), active: byStatus('active'), trial: byStatus('trial'), pastDue: byStatus('past_due'), suspended: byStatus('suspended'), closed: byStatus('closed') };

    // Monthly recurring revenue, per currency. Two schools billed in different currencies are not
    // added together — GroupsService refuses that for a trust's figures and the vendor's own total
    // deserves the same honesty — so `amount` is null and `byCurrency` carries the parts.
    const monthly = new Map<string, { active: number; atRisk: number }>();
    let trials = 0;
    for (const r of subs) {
      const ccy = String(r.currency ?? 'BDT');
      const per = String(r.billing_cycle) === 'monthly' ? Number(r.price) : Number(r.price) / 12;
      const bucket = monthly.get(ccy) ?? { active: 0, atRisk: 0 };
      if (String(r.status) === 'active') bucket.active += per;
      else if (String(r.status) === 'past_due') bucket.atRisk += per;
      else trials++;
      monthly.set(ccy, bucket);
    }
    const byCurrency = [...monthly].map(([currency, v]) => ({ currency, mrr: round(v.active), atRisk: round(v.atRisk) })).sort((a, b) => a.currency.localeCompare(b.currency));
    const paying = byCurrency.filter(c => c.mrr > 0 || c.atRisk > 0);
    const mrr = {
      amount: paying.length <= 1 ? round(paying[0]?.mrr ?? 0) : null,
      currency: paying.length <= 1 ? (paying[0]?.currency ?? String(this.config.env.CURRENCY ?? 'BDT')) : null,
      atRisk: paying.length <= 1 ? round(paying[0]?.atRisk ?? 0) : null,
      mixedCurrency: paying.length > 1,
      byCurrency,
      trials,
    };

    const inv = (s: string) => invoices.find(r => String(r.status) === s);
    const outstanding = ['issued', 'overdue'].reduce((t, s) => ({ count: t.count + Number(inv(s)?.n ?? 0), amount: round(t.amount + Number(inv(s)?.amount ?? 0)) }), { count: 0, amount: 0 });

    const staleBackups = backups.filter(b => Number(b.n) > 0 && (!b.last_ok || String(b.last_ok) < staleSince)).length;
    return {
      generatedAt: nowSql(),
      schools,
      people: { students: Number(people[0]?.students ?? 0), staff: Number(people[0]?.staff ?? 0) },
      mrr,
      invoices: {
        outstanding,
        overdue: { count: Number(inv('overdue')?.n ?? 0), amount: round(Number(inv('overdue')?.amount ?? 0)) },
        paid: { count: Number(inv('paid')?.n ?? 0), amount: round(Number(inv('paid')?.amount ?? 0)) },
      },
      tickets: { open: Number(tickets.find(t => String(t.status) === 'open')?.n ?? 0), answered: Number(tickets.find(t => String(t.status) === 'answered')?.n ?? 0) },
      health: { failedJobs: Number(jobs[0]?.n ?? 0), staleBackups, stuckEvents: Number(events[0]?.n ?? 0) },
    };
  }

  // ---------------------------------------------------------------- the client list
  /**
   * One row per client. `lastActivity` is the later of the last successful sign-in by anybody in that
   * school and the last audited change — the two rows that only exist because a person did something.
   * The `lastActivitySource` field says which of the two it was, because "active 3 months ago" is a
   * sales decision and a number whose meaning is guessed is worse than no number.
   */
  async schools(user: OwnerUser, f: SchoolFilter = {}) {
    await this.requireOwner(user);
    const where = ['s.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (f.q) { where.push('(LOWER(s.name) LIKE ? OR LOWER(s.code) LIKE ?)'); const like = `%${f.q.trim().toLowerCase()}%`; params.push(like, like); }
    if (f.status) { where.push(`${OwnerService.STATUS} = ?`); params.push(f.status); }
    if (f.planId) { where.push('sub.plan_id = ?'); params.push(f.planId); }
    const limit = Math.min(200, Math.max(1, Math.round(Number(f.limit) || 50)));
    const offset = Math.max(0, Math.round(Number(f.offset) || 0));
    const clause = where.join(' AND ');

    const counted = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM schools s ${OwnerService.LIVE_SUB} WHERE ${clause}`, params);
    const rows = await this.db.query<Row>(
      `SELECT s.id, s.name, s.name_bn, s.code, s.slug, s.custom_domain, s.institution_type, s.locale, s.currency, s.status AS school_status, s.created_at, s.onboarded_at,
        ${OwnerService.STATUS} AS effective_status,
        sub.id AS subscription_id, sub.status AS subscription_status, sub.billing_cycle, sub.price, sub.starts_at, sub.ends_at,
        p.id AS plan_id, p.name AS plan_name, p.currency AS plan_currency, p.student_limit,
        (SELECT COUNT(*) FROM students st WHERE st.school_id = s.id AND st.status = 'active' AND st.deleted_at IS NULL) AS students,
        (SELECT COUNT(*) FROM staff sf WHERE sf.school_id = s.id AND sf.status IN ('active','probation','on_leave') AND sf.deleted_at IS NULL) AS staff,
        (SELECT MAX(u.last_login_at) FROM users u WHERE u.school_id = s.id) AS last_login_at,
        (SELECT MAX(a.created_at) FROM audit_logs a WHERE a.school_id = s.id) AS last_audit_at,
        (SELECT MAX(b.started_at) FROM backups b WHERE b.school_id = s.id AND b.status = 'success') AS last_backup_at,
        (SELECT COALESCE(SUM(i.balance), 0) FROM invoices i WHERE i.school_id = s.id AND i.status IN ('issued','partially_paid','overdue')) AS fees_outstanding
       FROM schools s ${OwnerService.LIVE_SUB}
       WHERE ${clause} ORDER BY s.created_at ASC, s.id ASC LIMIT ${limit} OFFSET ${offset}`, params);

    return {
      total: Number(counted[0]?.n ?? 0), limit, offset,
      schools: rows.map(r => this.clientRow(r)),
    };
  }

  private clientRow(r: Row) {
    const login = r.last_login_at ? String(r.last_login_at) : null;
    const audited = r.last_audit_at ? String(r.last_audit_at) : null;
    const at = login && audited ? (login > audited ? login : audited) : (login ?? audited);
    return {
      id: String(r.id), name: String(r.name), nameBn: r.name_bn ? String(r.name_bn) : null, code: String(r.code),
      // the address a person types to reach this school, so the console can show and link it
      slug: r.slug ? String(r.slug) : null,
      customDomain: r.custom_domain ? String(r.custom_domain) : null,
      url: r.custom_domain ? `https://${String(r.custom_domain)}` : `${this.config.appUrl.replace(/\/$/, '')}${r.slug ? `/${String(r.slug)}` : ''}`,
      institutionType: String(r.institution_type), locale: String(r.locale), currency: String(r.currency),
      status: String(r.effective_status) as OwnerSchoolStatus, schoolStatus: String(r.school_status),
      createdAt: String(r.created_at), onboardedAt: r.onboarded_at ? String(r.onboarded_at) : null,
      students: Number(r.students ?? 0), staff: Number(r.staff ?? 0),
      plan: r.plan_name ? { id: String(r.plan_id), name: String(r.plan_name), currency: String(r.plan_currency), studentLimit: r.student_limit == null ? null : Number(r.student_limit) } : null,
      subscription: r.subscription_id ? {
        id: String(r.subscription_id), status: String(r.subscription_status), billingCycle: String(r.billing_cycle),
        price: round(Number(r.price ?? 0)), startsAt: r.starts_at ? String(r.starts_at) : null, endsAt: r.ends_at ? String(r.ends_at) : null,
      } : null,
      trialEndsAt: String(r.subscription_status ?? '') === 'trial' && r.ends_at ? String(r.ends_at) : null,
      lastActivity: at,
      lastActivitySource: at == null ? null : at === login ? 'last sign-in' : 'last audited change',
      lastBackupAt: r.last_backup_at ? String(r.last_backup_at) : null,
      feesOutstanding: round(Number(r.fees_outstanding ?? 0)),
    };
  }

  // ---------------------------------------------------------------- one client
  /** Everything the owner needs before picking up the phone to this school. */
  async school(user: OwnerUser, id: string) {
    await this.requireOwner(user);
    const rows = await this.db.query<Row>(
      `SELECT s.id, s.name, s.name_bn, s.code, s.slug, s.custom_domain, s.institution_type, s.locale, s.currency, s.timezone, s.board, s.eiin,
        s.phone, s.email, s.website, s.status AS school_status, s.created_at, s.onboarded_at, s.trial_ends_at,
        ${OwnerService.STATUS} AS effective_status,
        sub.id AS subscription_id, sub.status AS subscription_status, sub.billing_cycle, sub.price, sub.discount_pct, sub.starts_at, sub.ends_at, sub.auto_renew,
        p.id AS plan_id, p.name AS plan_name, p.currency AS plan_currency, p.student_limit, p.sms_included, p.storage_gb, p.modules,
        (SELECT COUNT(*) FROM students st WHERE st.school_id = s.id AND st.status = 'active' AND st.deleted_at IS NULL) AS students,
        (SELECT COUNT(*) FROM staff sf WHERE sf.school_id = s.id AND sf.status IN ('active','probation','on_leave') AND sf.deleted_at IS NULL) AS staff,
        (SELECT MAX(u.last_login_at) FROM users u WHERE u.school_id = s.id) AS last_login_at,
        (SELECT MAX(a.created_at) FROM audit_logs a WHERE a.school_id = s.id) AS last_audit_at,
        (SELECT MAX(b.started_at) FROM backups b WHERE b.school_id = s.id AND b.status = 'success') AS last_backup_at,
        (SELECT COALESCE(SUM(i.balance), 0) FROM invoices i WHERE i.school_id = s.id AND i.status IN ('issued','partially_paid','overdue')) AS fees_outstanding
       FROM schools s ${OwnerService.LIVE_SUB} WHERE s.id = ? AND s.deleted_at IS NULL`, [id]);
    const r = rows[0];
    if (!r) throw notFound('school');

    const month = `${nowSql().slice(0, 7)}-01`;
    const monthEnd = new Date(`${month}T00:00:00Z`);
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
    const [counts, usage, invoices, admins, health] = await Promise.all([
      this.db.query<Row>(
        `SELECT (SELECT COUNT(*) FROM students st WHERE st.school_id = ? AND st.deleted_at IS NULL) AS students_all,
                (SELECT COUNT(*) FROM guardians g WHERE g.school_id = ?) AS guardians,
                (SELECT COUNT(*) FROM classes c WHERE c.school_id = ?) AS classes,
                (SELECT COUNT(*) FROM users u WHERE u.school_id = ? AND u.deleted_at IS NULL) AS users,
                (SELECT COUNT(*) FROM invoices i WHERE i.school_id = ?) AS fee_invoices,
                (SELECT COUNT(*) FROM files f WHERE f.school_id = ?) AS files`, [id, id, id, id, id, id]),
      // read-only: the same three measures `SaasService.meter` stores, counted live so opening a
      // client's page never writes a usage row
      this.db.query<Row>(
        `SELECT (SELECT COUNT(*) FROM students st WHERE st.school_id = ? AND st.status = 'active' AND st.deleted_at IS NULL) AS students,
                (SELECT COUNT(*) FROM notifications n WHERE n.school_id = ? AND n.channel IN ('sms','voice','whatsapp') AND n.status IN ('sent','delivered') AND n.created_at >= ? AND n.created_at < ?) AS sms,
                (SELECT COALESCE(SUM(f.size_bytes), 0) FROM files f WHERE f.school_id = ?) AS storage_bytes`,
        [id, id, `${month} 00:00:00`, `${monthEnd.toISOString().slice(0, 10)} 00:00:00`, id]),
      this.saas.invoices({ schoolId: id }),
      this.db.query<Row>(
        `SELECT u.id, u.display_name, u.email, u.phone, u.last_login_at, u.is_active, r.slug AS role
         FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
         WHERE u.school_id = ? AND u.deleted_at IS NULL AND r.slug IN ('super_admin','admin')
         ORDER BY r.level DESC, u.display_name, u.id`, [id]),
      this.schoolHealth(id),
    ]);

    const limits = {
      students: { used: Number(usage[0]?.students ?? 0), limit: r.student_limit == null ? null : Number(r.student_limit) },
      sms: { used: Number(usage[0]?.sms ?? 0), limit: r.sms_included == null ? null : Number(r.sms_included), month },
      storageMb: { used: Math.round(Number(usage[0]?.storage_bytes ?? 0) / 1_048_576), limit: r.storage_gb == null ? null : Number(r.storage_gb) * 1024 },
    };
    return {
      school: {
        ...this.clientRow(r),
        timezone: String(r.timezone), board: r.board ? String(r.board) : null, eiin: r.eiin ? String(r.eiin) : null,
        phone: r.phone ? String(r.phone) : null, email: r.email ? String(r.email) : null, website: r.website ? String(r.website) : null,
      },
      subscription: r.subscription_id ? {
        id: String(r.subscription_id), status: String(r.subscription_status), billingCycle: String(r.billing_cycle),
        price: round(Number(r.price ?? 0)), discountPct: Number(r.discount_pct ?? 0), autoRenew: !!Number(r.auto_renew),
        startsAt: r.starts_at ? String(r.starts_at) : null, endsAt: r.ends_at ? String(r.ends_at) : null,
        plan: { id: String(r.plan_id), name: String(r.plan_name), currency: String(r.plan_currency), modules: json<string[]>(r.modules) ?? null },
      } : null,
      usage: limits,
      invoices: invoices.slice(0, 10).map(i => this.invoiceRow(i)),
      admins: admins.map(a => ({ id: String(a.id), name: String(a.display_name), email: a.email ? String(a.email) : null, phone: a.phone ? String(a.phone) : null, lastLoginAt: a.last_login_at ? String(a.last_login_at) : null, isActive: !!Number(a.is_active), role: String(a.role) })),
      health,
      counts: {
        studentsAll: Number(counts[0]?.students_all ?? 0), guardians: Number(counts[0]?.guardians ?? 0), classes: Number(counts[0]?.classes ?? 0),
        users: Number(counts[0]?.users ?? 0), feeInvoices: Number(counts[0]?.fee_invoices ?? 0), files: Number(counts[0]?.files ?? 0),
      },
    };
  }

  // ---------------------------------------------------------------- provisioning
  /**
   * A new client, under their own name. This is what the owner console is for: the school gets its
   * own tenant, its own code (which every document number then carries), its own seeded academic
   * year and website, and one administrator who can sign in this afternoon.
   *
   * The password is shown exactly once. If the owner did not choose one it is generated here, handed
   * back in this reply and then only ever exists as a bcrypt hash — it is not in the audit row, not
   * in the school record, and not recoverable. Losing it costs a reset (`addAdmin`), which is cheap;
   * storing it in the clear costs every client on the installation, which is not.
   */
  async provision(user: OwnerUser, input: ProvisionInput) {
    const { founderId } = await this.requireOwner(user);
    const name = String(input.schoolName ?? '').trim();
    if (name.length < 2) throw badRequest('the school needs a name');
    const password = (input.adminPassword ?? '').trim() || generatePassword();
    if (password.length < 8) throw badRequest('a password of at least 8 characters');
    const generated = !(input.adminPassword ?? '').trim();

    await this.saas.ensurePlans();
    // the plan is chosen before the tenant exists, so a mistyped id does not leave a school behind
    const plan = input.planId
      ? await this.db.findOne<Row>('saas_plans', { id: input.planId })
      : await this.db.findOne<Row>('saas_plans', { is_public: true }, { orderBy: 'sort_order ASC, id ASC' });
    if (input.planId && !plan) throw notFound('plan');

    const created = await this.installer.addTenant({
      schoolName: name,
      schoolNameBn: input.schoolNameBn || '',
      schoolCode: (input.schoolCode || '').toUpperCase(),
      institutionType: input.institutionType ?? 'school',
      locale: input.locale ?? 'bn',
      adminName: String(input.adminName ?? '').trim(),
      adminPhone: String(input.adminPhone ?? '').trim(),
      adminEmail: input.adminEmail || '',
      adminPassword: password,
    });
    const school = await this.db.findOne<Row>('schools', { id: created.schoolId });
    const code = String(school?.code ?? '');

    let subscription: Awaited<ReturnType<SaasService['subscribe']>> | null = null;
    if (plan) {
      subscription = await this.saas.subscribe(created.schoolId, {
        planId: String(plan.id), billingCycle: input.billingCycle ?? 'yearly',
        trialDays: input.trialDays ?? 14, discountPct: input.discountPct ?? 0, referralCode: input.referralCode ?? null,
      });
    }

    // the trail: what was created, for whom, on what plan — and never the password
    await this.audit.log({
      schoolId: founderId, actorUserId: user.id, action: 'provision', entityType: 'owner.school', entityId: created.schoolId,
      after: { schoolId: created.schoolId, name, code, institutionType: input.institutionType ?? 'school', locale: input.locale ?? 'bn', adminUserId: created.userId, adminEmail: input.adminEmail || null, adminPhone: input.adminPhone, plan: plan ? String(plan.name) : null, trialDays: input.trialDays ?? 14, passwordGenerated: generated },
    });
    await this.audit.log({
      schoolId: created.schoolId, actorUserId: user.id, action: 'create', entityType: 'owner.school', entityId: created.schoolId,
      after: { name, code, provisionedBy: 'owner console' },
    });

    // the school is told where its own sign-in lives, in writing, the moment it exists. The address
    // is the only thing it cannot work out for itself — and the password is deliberately not in it.
    const invitation = await this.sendSignInLink(user, created.schoolId, { reason: 'provisioned' })
      .catch(e => ({ sent: false, to: null as string | null, reason: (e as Error).message.slice(0, 200) }));

    return {
      schoolId: created.schoolId, code, name,
      adminUserId: created.userId, adminName: String(input.adminName ?? '').trim(),
      adminEmail: (input.adminEmail || null) as string | null, adminPhone: String(input.adminPhone ?? '').trim(),
      /** Shown once. Nothing stores it in the clear, so it cannot be read back from anywhere. */
      password, passwordGenerated: generated,
      /** The school's own sign-in door: /<slug>/x/<door>, which is the only way into its console. */
      url: await this.loginUrl(created.schoolId),
      slug: (await this.tenant.school(created.schoolId).catch(() => null))?.slug ?? null,
      /** Whether the address actually went out by email, and to whom. */
      invitation,
      subscription,
    };
  }

  // ---------------------------------------------------------------- status
  /**
   * Turning a client off, and on again.
   *
   * A suspended school loses new work and keeps every record it has already entered — the same rule
   * `SaasService` applies to an unpaid bill, for the same reason: whatever an adult has failed to do,
   * a register, a result and a receipt belong to the children in it. `newWorkAllowed` below is the
   * single place that answers "may this school do new work?", and the API guard is the only caller.
   *
   * The founder school cannot be suspended: that is the owner's own console, and locking it would
   * leave nobody able to unlock anything.
   */
  async setStatus(user: OwnerUser, id: string, status: 'active' | 'suspended', reason?: string | null) {
    const { founderId } = await this.requireOwner(user);
    if (id === founderId) throw new HttpError(409, 'the school this installation was created with cannot be suspended', 'conflict');
    const school = await this.db.findOne<Row>('schools', { id });
    if (!school) throw notFound('school');
    const before = String(school.status);
    if (before === status) return { id, status, changed: false, reason: reason ?? null };
    await this.db.update('schools', { status, updated_at: nowSql() }, { id });
    await this.audit.log({ schoolId: founderId, actorUserId: user.id, action: 'status', entityType: 'owner.school', entityId: id, before: { status: before }, after: { status, reason: reason ?? null } });
    await this.audit.log({ schoolId: id, actorUserId: user.id, action: 'status', entityType: 'owner.school', entityId: id, before: { status: before }, after: { status, reason: reason ?? null } });
    await this.notifications.notifyRole(id, 'admin', {
      channels: ['in_app', 'email'], eventKey: 'owner.status', entityType: 'owner.school', entityId: id,
      title: status === 'suspended' ? 'This school has been suspended' : 'This school is active again',
      body: status === 'suspended'
        ? `New entries are paused${reason ? `: ${reason}` : '.'} Everything already recorded stays readable — registers, results and receipts are untouched. Contact the office that supplied Pathshala.`
        : 'Everything works normally again.',
    });
    return { id, status, changed: true, reason: reason ?? null };
  }

  /**
   * May this school do new work right now? Suspension is the vendor's switch and is answered here;
   * an unpaid bill is `SaasService.allows`, which owns that question and is asked for its own limits.
   * Reads are never refused by either, which is the whole point of both rules.
   */
  async newWorkAllowed(schoolId: string) {
    const school = await this.db.findOne<{ status: string }>('schools', { id: schoolId }, { columns: ['status'] });
    if (!school) return { allowed: true, status: null as string | null, reason: 'no such school on this installation' };
    const status = String(school.status);
    if (status === 'suspended') return { allowed: false, status, reason: 'this school is suspended; its records stay readable' };
    if (status === 'closed') return { allowed: false, status, reason: 'this school is closed; its records stay readable' };
    return { allowed: true, status, reason: 'active' };
  }

  // ---------------------------------------------------------------- the school's own web address
  /**
   * Where a school opens, and what to do about it.
   *
   * Until a school has an address of its own, which school a visitor belongs to is decided by who is
   * already signed in — which is no answer at all for somebody arriving at a login page. Two forms,
   * and the vendor sets both from here: a slug on the installation's own host, which works the
   * moment it is saved, and the school's own domain, which needs DNS the vendor reads down a
   * telephone. The instructions carry this server's actual address rather than a placeholder, and
   * say plainly that `www.` is covered by the second record.
   */
  async webAddress(user: OwnerUser, id: string): Promise<WebAddress> {
    await this.requireOwner(user);
    return this.tenant.webAddress(id);
  }

  /**
   * Names a school. `customDomain: null` removes it. Both keys are unique across the installation
   * and a collision is refused rather than resolved — routing one school's guardians at another
   * school's console is the failure this whole feature exists to prevent.
   *
   * Where a cPanel token is configured the alias is made here too, because DNS alone does not make a
   * hostname reach our folder on shared hosting. Where it is not, `alias.manual` is the sentence the
   * vendor follows in the panel by hand, and it is present either way.
   */
  async setWebAddress(user: OwnerUser, id: string, input: { slug?: string | null; customDomain?: string | null }) {
    const { founderId } = await this.requireOwner(user);
    const before = await this.tenant.school(id);
    const after = await this.tenant.setWebAddress(id, input);

    // the alias is attempted only for a domain that is actually new: re-saving the same one must not
    // ask the panel again, and removing one never touches the account
    const alias = after.customDomain && after.customDomain !== before.customDomain
      ? await this.tenant.ensureAlias(after.customDomain).catch(e => ({ configured: false, created: false, alreadyThere: false, error: (e as Error).message.slice(0, 200), manual: `Add ${after.customDomain} as a domain in cPanel, pointed at the folder Pathshala is installed in.` }))
      : null;

    await this.audit.log({
      schoolId: founderId, actorUserId: user.id, action: 'web_address', entityType: 'owner.school', entityId: id,
      before: { slug: before.slug, customDomain: before.customDomain },
      after: { slug: after.slug, customDomain: after.customDomain, aliasCreated: alias?.created ?? false },
    });
    // the school's own trail: the address people type to reach it changed, which is its business
    await this.audit.log({
      schoolId: id, actorUserId: user.id, action: 'web_address', entityType: 'owner.school', entityId: id,
      before: { slug: before.slug, customDomain: before.customDomain },
      after: { slug: after.slug, customDomain: after.customDomain, by: 'owner console' },
    });
    return { ...(await this.tenant.webAddress(id)), alias };
  }

  /**
   * The address to read out to a school's administrator: its own door and nothing else.
   *
   * There is no `/login` on this installation any more — a school's console sign-in is served only
   * at `<the school's address>/x/<door>`, and every other spelling is a 404. A school with no door
   * yet (a row written before the column existed and not yet repaired at boot) gets its plain
   * address back rather than a link that would not work.
   */
  private async loginUrl(schoolId: string) {
    const school = await this.tenant.school(schoolId).catch(() => null);
    if (school) return this.tenant.doorUrlFor(school) ?? this.tenant.urlFor(school);
    return this.config.appUrl.replace(/\/$/, '');
  }

  // ---------------------------------------------------------------- the school's own door
  /**
   * Emails a school the address of its own sign-in page.
   *
   * The address goes to the school's registered address (`schools.email`), and to the administrator
   * who was created with it where the school has none — that is the one address on record that is
   * certain to belong to somebody who is allowed in. It is a template, in the school's own language,
   * because everything this platform says to a person is; and it never carries the password, which
   * travels by another route entirely so that one intercepted mailbox opens nothing.
   */
  async sendSignInLink(user: OwnerUser, id: string, opts: { reason?: string } = {}) {
    const { founderId } = await this.requireOwner(user);
    const school = await this.db.findOne<Row>('schools', { id });
    if (!school) throw notFound('school');
    const url = await this.loginUrl(id);
    const tenant = await this.tenant.school(id);

    // the school's registered address first, then the administrator's: whoever is on record
    const admin = await this.db.query<Row>(
      `SELECT u.email, u.phone, u.username, u.display_name FROM users u
         JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
        WHERE u.school_id = ? AND r.slug IN ('super_admin','admin') AND u.is_active = TRUE AND u.deleted_at IS NULL
        ORDER BY u.created_at ASC, u.id ASC LIMIT 1`, [id]);
    const to = String(school.email ?? '').trim() || String(admin[0]?.email ?? '').trim();
    // the identifier is what the person actually types into the form, which is their email or phone
    const identifier = String(admin[0]?.email ?? '').trim() || String(admin[0]?.phone ?? '').trim() || String(admin[0]?.username ?? '').trim();
    if (!to) return { sent: false, to: null as string | null, url, reason: 'this school has no email address on record, and neither has its administrator' };

    const ids = await this.notifications.notify({
      schoolId: id, address: to, channels: ['email'], eventKey: 'owner.school_ready',
      entityType: 'owner.school', entityId: id,
      // an address somebody is waiting for is not held back until seven in the morning
      respectQuietHours: false,
      locale: (String(school.locale ?? 'bn') === 'en' ? 'en' : 'bn'),
      data: { url, identifier, portalUrl: `${this.tenant.urlFor(tenant)}/portal`, school: String(school.name ?? '') },
    });

    // the trail says the address was sent and to whom; the door itself is never written into a log
    await this.audit.log({ schoolId: founderId, actorUserId: user.id, action: 'send_sign_in_link', entityType: 'owner.school', entityId: id, after: { to, reason: opts.reason ?? 'resent', sent: ids.length > 0 } });
    await this.audit.log({ schoolId: id, actorUserId: user.id, action: 'send_sign_in_link', entityType: 'owner.school', entityId: id, after: { to, by: 'owner console' } });
    return { sent: ids.length > 0, to, url, notificationIds: ids };
  }

  /**
   * A new door, and the old address dead from the next request.
   *
   * This is what an address that has leaked costs: one click, and the school is emailed the new one
   * in the same breath — a rotation nobody is told about is a school locked out of its own console.
   * Nobody is signed out: the door was never the session.
   */
  async rotateDoor(user: OwnerUser, id: string) {
    const { founderId } = await this.requireOwner(user);
    const before = await this.tenant.school(id);
    await this.tenant.rotateDoor(id);
    await this.audit.log({
      schoolId: founderId, actorUserId: user.id, action: 'rotate_door', entityType: 'owner.school', entityId: id,
      before: { hadDoor: !!before.loginDoor }, after: { rotated: true },
    });
    await this.audit.log({
      schoolId: id, actorUserId: user.id, action: 'rotate_door', entityType: 'owner.school', entityId: id,
      after: { rotated: true, by: 'owner console' },
    });
    const email = await this.sendSignInLink(user, id, { reason: 'rotated' }).catch(e => ({ sent: false, to: null as string | null, reason: (e as Error).message.slice(0, 200) }));
    // the same shape the console already renders, so the section repaints with the new address
    return { ...(await this.tenant.webAddress(id)), email };
  }

  // ---------------------------------------------------------------- plan
  /** Moves a client onto a plan (or a new price): SaasService writes it, this only decides who may. */
  async setPlan(user: OwnerUser, id: string, p: { planId: string; billingCycle?: 'monthly' | 'yearly'; trialDays?: number; discountPct?: number; referralCode?: string | null }) {
    const { founderId } = await this.requireOwner(user);
    if (!(await this.db.findOne('schools', { id }))) throw notFound('school');
    const before = await this.saas.subscription(id);
    const r = await this.saas.subscribe(id, { planId: p.planId, billingCycle: p.billingCycle, trialDays: p.trialDays, discountPct: p.discountPct, referralCode: p.referralCode ?? null });
    await this.audit.log({
      schoolId: founderId, actorUserId: user.id, action: 'plan', entityType: 'owner.subscription', entityId: r.id,
      before: before ? { plan: String(before.plan_name), status: String(before.status), price: Number(before.price) } : null,
      after: { schoolId: id, plan: r.plan, status: r.status, price: r.price, endsAt: r.endsAt, discountPct: p.discountPct ?? 0 },
    });
    return r;
  }

  // ---------------------------------------------------------------- admin logins
  /**
   * A login for the school's administrator — the support call this replaces is "nobody here can get
   * in". An account with that phone or email already in this school is reset rather than duplicated,
   * which also logs every session of theirs out; a new one is created with the same rights the
   * installer gives the first administrator. The password is returned once and stored only as a hash.
   */
  async addAdmin(user: OwnerUser, id: string, a: { name: string; phone: string; email?: string | null; password?: string | null }) {
    const { founderId } = await this.requireOwner(user);
    if (!(await this.db.findOne('schools', { id }))) throw notFound('school');
    const password = (a.password ?? '').trim() || generatePassword();
    if (password.length < 8) throw badRequest('a password of at least 8 characters');
    const generated = !(a.password ?? '').trim();

    const existing = (await this.auth.findByIdentifier(a.phone, id)) ?? (a.email ? await this.auth.findByIdentifier(a.email, id) : null);
    if (existing) {
      await this.auth.setPassword(existing.id, password);
      await this.rbac.assignRole(existing.id, 'super_admin', id);
      await this.audit.log({ schoolId: founderId, actorUserId: user.id, action: 'reset_password', entityType: 'owner.admin', entityId: existing.id, after: { schoolId: id, userId: existing.id, reset: true, passwordGenerated: generated } });
      await this.audit.log({ schoolId: id, actorUserId: user.id, action: 'reset_password', entityType: 'owner.admin', entityId: existing.id, after: { by: 'owner console', reset: true } });
      return { userId: existing.id, schoolId: id, name: String(existing.display_name), email: existing.email ?? null, phone: existing.phone ?? null, password, passwordGenerated: generated, created: false, reset: true, url: await this.loginUrl(id) };
    }
    const userId = await this.auth.createUser({ schoolId: id, userType: 'admin', displayName: a.name, phone: a.phone, email: a.email || null, password, roles: ['super_admin'] });
    await this.audit.log({ schoolId: founderId, actorUserId: user.id, action: 'create', entityType: 'owner.admin', entityId: userId, after: { schoolId: id, userId, name: a.name, phone: a.phone, email: a.email ?? null, passwordGenerated: generated } });
    await this.audit.log({ schoolId: id, actorUserId: user.id, action: 'create', entityType: 'owner.admin', entityId: userId, after: { by: 'owner console', name: a.name } });
    return { userId, schoolId: id, name: a.name, email: a.email ?? null, phone: a.phone, password, passwordGenerated: generated, created: true, reset: false, url: await this.loginUrl(id) };
  }

  // ---------------------------------------------------------------- billing
  /**
   * Every subscription invoice on the installation with the dunning rung it has reached, plus the
   * resellers and what they are owed. The bucket is worked out from the due date and today, not
   * stored, so it cannot drift away from the invoice it describes.
   */
  async billing(user: OwnerUser, f: { status?: string; schoolId?: string } = {}) {
    await this.requireOwner(user);
    const [rows, partners, payouts] = await Promise.all([
      this.saas.invoices({ status: f.status, schoolId: f.schoolId }),
      this.saas.partners(),
      this.saas.payouts(),
    ]);
    const invoices = rows.map(i => this.invoiceRow(i));
    const buckets: Record<string, { count: number; amount: number }> = {};
    let outstanding = 0;
    for (const i of invoices) {
      const b = buckets[i.bucket] ?? (buckets[i.bucket] = { count: 0, amount: 0 });
      b.count++; b.amount = round(b.amount + i.total);
      if (i.status === 'issued' || i.status === 'overdue') outstanding = round(outstanding + i.total);
    }
    return {
      invoices, buckets, totals: { invoices: invoices.length, outstanding },
      partners: partners.map(p => ({ id: String(p.id), name: String(p.name), referralCode: String(p.referral_code), commissionPct: Number(p.commission_pct), status: String(p.status), schools: Number(p.schools ?? 0) })),
      payouts: payouts.map(p => ({ id: String(p.id), partnerId: String(p.partner_id), partner: String(p.partner_name), period: String(p.period).slice(0, 10), amount: round(Number(p.amount)), status: String(p.status), paidAt: p.paid_at ? String(p.paid_at) : null })),
    };
  }

  /** Marks a subscription invoice paid — the money arrived in the vendor's own bank, elsewhere. */
  async markInvoicePaid(user: OwnerUser, invoiceId: string, p: { paidAt?: string; reference?: string | null } = {}) {
    const { founderId } = await this.requireOwner(user);
    const before = await this.db.findOne<Row>('saas_invoices', { id: invoiceId });
    if (!before) throw notFound('invoice');
    const r = await this.saas.markPaid(invoiceId, p);
    await this.audit.log({ schoolId: founderId, actorUserId: user.id, action: 'paid', entityType: 'owner.invoice', entityId: invoiceId, before: { status: String(before.status) }, after: { status: 'paid', schoolId: String(before.school_id), total: Number(before.total), reference: p.reference ?? null } });
    return r;
  }

  private invoiceRow(i: Row) {
    const due = String(i.due_date ?? '').slice(0, 10);
    const status = String(i.status);
    const days = due ? Math.round((Date.parse(`${nowSql().slice(0, 10)}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000) : 0;
    const bucket = status === 'paid' ? 'paid' : status === 'void' || status === 'draft' ? status
      : days <= 0 ? 'current' : days <= 7 ? '1-7 days' : days <= 14 ? '8-14 days' : days <= 30 ? '15-30 days' : 'over 30 days';
    return {
      id: String(i.id), schoolId: String(i.school_id), school: i.school_name ? String(i.school_name) : null,
      invoiceNo: String(i.invoice_no), periodStart: String(i.period_start), periodEnd: String(i.period_end),
      total: round(Number(i.total)), status, dueDate: due, paidAt: i.paid_at ? String(i.paid_at) : null,
      daysOverdue: status === 'paid' ? 0 : Math.max(0, days), bucket,
    };
  }

  // ---------------------------------------------------------------- support
  async tickets(user: OwnerUser, f: { status?: string; schoolId?: string } = {}) {
    await this.requireOwner(user);
    const rows = await this.saas.tickets(f);
    return {
      tickets: rows.map(t => ({
        id: String(t.id), schoolId: String(t.school_id), school: t.school_name ? String(t.school_name) : null,
        subject: String(t.subject), body: t.body ? String(t.body) : null, priority: String(t.priority), status: String(t.status),
        openedBy: t.opened_by ? String(t.opened_by) : null, createdAt: String(t.created_at), closedAt: t.closed_at ? String(t.closed_at) : null,
      })),
      counts: {
        open: rows.filter(t => String(t.status) === 'open').length,
        answered: rows.filter(t => String(t.status) === 'answered').length,
        urgent: rows.filter(t => String(t.priority) === 'urgent' && String(t.status) !== 'closed').length,
      },
    };
  }

  async closeTicket(user: OwnerUser, ticketId: string, resolution?: string | null) {
    const { founderId } = await this.requireOwner(user);
    const before = await this.db.findOne<Row>('saas_support_tickets', { id: ticketId });
    if (!before) throw notFound('ticket');
    const r = await this.saas.closeTicket(ticketId, resolution ?? undefined);
    await this.audit.log({ schoolId: founderId, actorUserId: user.id, action: 'close', entityType: 'owner.ticket', entityId: ticketId, before: { status: String(before.status) }, after: { status: 'closed', schoolId: String(before.school_id), resolution: resolution ?? null } });
    return r;
  }

  // ---------------------------------------------------------------- health
  /**
   * The watchdog's findings for every client at once. `PlatformService.watchdog` tells each school's
   * own office what has stopped working in that school; this is the same evidence read across the
   * installation, because the person who can actually fix a stalled relay is the vendor.
   */
  async health(user: OwnerUser) {
    await this.requireOwner(user);
    const rows = await this.db.query<Row>(
      `SELECT s.id, s.name, s.code, s.status,
        (SELECT COUNT(*) FROM background_jobs j WHERE j.school_id = s.id AND j.status = 'failed') AS failed_jobs,
        (SELECT COUNT(*) FROM outbox_events e WHERE e.school_id = s.id AND e.published_at IS NULL AND e.occurred_at < ?) AS stuck_events,
        (SELECT COUNT(*) FROM notifications n WHERE n.school_id = s.id AND n.status = 'failed') AS failed_notifications,
        (SELECT COUNT(*) FROM scheduled_jobs sj WHERE sj.school_id = s.id AND sj.is_active = TRUE AND sj.last_status = 'failed') AS failed_schedules,
        (SELECT COUNT(*) FROM backups b WHERE b.school_id = s.id) AS backups,
        (SELECT MAX(b.started_at) FROM backups b WHERE b.school_id = s.id AND b.status = 'success') AS last_backup_at
       FROM schools s WHERE s.deleted_at IS NULL ORDER BY s.created_at ASC, s.id ASC LIMIT 500`, [this.since(30 * 60_000)]);
    const schools = rows.map(r => this.healthRow(r));
    return {
      generatedAt: nowSql(),
      installation: await this.platform.health(null),
      schools,
      totals: {
        schools: schools.length,
        unhealthy: schools.filter(s => !s.ok).length,
        failedJobs: schools.reduce((t, s) => t + s.failedJobs, 0),
        stuckEvents: schools.reduce((t, s) => t + s.stuckEvents, 0),
        staleBackups: schools.filter(s => s.backupStale).length,
      },
    };
  }

  private async schoolHealth(schoolId: string) {
    const rows = await this.db.query<Row>(
      `SELECT s.id, s.name, s.code, s.status,
        (SELECT COUNT(*) FROM background_jobs j WHERE j.school_id = s.id AND j.status = 'failed') AS failed_jobs,
        (SELECT COUNT(*) FROM outbox_events e WHERE e.school_id = s.id AND e.published_at IS NULL AND e.occurred_at < ?) AS stuck_events,
        (SELECT COUNT(*) FROM notifications n WHERE n.school_id = s.id AND n.status = 'failed') AS failed_notifications,
        (SELECT COUNT(*) FROM scheduled_jobs sj WHERE sj.school_id = s.id AND sj.is_active = TRUE AND sj.last_status = 'failed') AS failed_schedules,
        (SELECT COUNT(*) FROM backups b WHERE b.school_id = s.id) AS backups,
        (SELECT MAX(b.started_at) FROM backups b WHERE b.school_id = s.id AND b.status = 'success') AS last_backup_at
       FROM schools s WHERE s.id = ?`, [this.since(30 * 60_000), schoolId]);
    return rows[0] ? this.healthRow(rows[0]) : null;
  }

  private healthRow(r: Row) {
    const staleSince = this.since(48 * 3600_000);
    const lastBackupAt = r.last_backup_at ? String(r.last_backup_at) : null;
    // a school that has never taken a backup is not warned about one; one that stopped is
    const backupStale = Number(r.backups ?? 0) > 0 && (!lastBackupAt || lastBackupAt < staleSince);
    const failedJobs = Number(r.failed_jobs ?? 0), stuckEvents = Number(r.stuck_events ?? 0);
    const failedSchedules = Number(r.failed_schedules ?? 0), failedNotifications = Number(r.failed_notifications ?? 0);
    const findings: string[] = [];
    if (failedJobs) findings.push(`${failedJobs} background job${failedJobs === 1 ? '' : 's'} failed`);
    if (failedSchedules) findings.push(`${failedSchedules} scheduled job${failedSchedules === 1 ? '' : 's'} last ran with an error`);
    if (stuckEvents) findings.push(`${stuckEvents} event${stuckEvents === 1 ? '' : 's'} waiting more than half an hour`);
    if (backupStale) findings.push(lastBackupAt ? `no good backup since ${lastBackupAt.slice(0, 16)}` : 'no backup has ever succeeded');
    if (failedNotifications) findings.push(`${failedNotifications} message${failedNotifications === 1 ? '' : 's'} could not be sent`);
    return {
      schoolId: String(r.id), name: String(r.name), code: String(r.code), status: String(r.status),
      failedJobs, failedSchedules, stuckEvents, failedNotifications,
      backups: Number(r.backups ?? 0), lastBackupAt, backupStale,
      ok: findings.length === 0, findings,
    };
  }
}
