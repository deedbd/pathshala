import type { Db, Row } from '@pathshala/db';
import { nowSql, ulid } from '@pathshala/db';
import type { Logger } from '@pathshala/adapters';
import type { AuditService } from '../audit.js';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { RbacService } from '../rbac.js';
import { HttpError, badRequest, unauthorized } from '../context.js';
import { isEmail, normalizeBdPhone, otpCode, randomToken, sha256 } from '../util.js';
import { hashPassword, needsRehash, verifyPassword } from './password.js';
import { signJwt, verifyJwt, type JwtClaims } from './jwt.js';
import { generateTotpSecret, totpUri, verifyTotp } from './totp.js';

export interface UserRow {
  id: string; school_id: string; user_type: string; username: string | null; email: string | null; phone: string | null; password_hash: string | null;
  display_name: string; locale: string | null; is_active: unknown; two_factor_secret: string | null; two_factor_enabled: unknown; session_epoch: number;
  failed_logins: number; locked_until: string | null; last_login_at: string | null; preferences: unknown;
}
export interface SessionRow { id: string; user_id: string; token_hash: string; epoch: number; expires_at: string; revoked_at: string | null; last_seen_at: string | null }
export interface CreateUserInput { schoolId: string; userType: 'admin' | 'staff' | 'student' | 'guardian' | 'alumni' | 'vendor' | 'api'; displayName: string; phone?: string | null; email?: string | null; username?: string | null; password?: string | null; locale?: 'bn' | 'en'; roles?: string[] }
export interface LoginInput { schoolId?: string; identifier: string; password: string; totp?: string; platform?: 'web' | 'android' | 'ios' | 'pwa' | 'api'; deviceName?: string; ip?: string | null; userAgent?: string | null; remember?: boolean }

const MAX_FAILED = 5; const LOCK_MINUTES = 15;
const OTP_MINUTES = 5; const OTP_PER_10MIN = 3; const OTP_MAX_ATTEMPTS = 5;

/** Passwords (bcryptjs), OTP by SMS/email, TOTP 2FA, sessions with epoch (logout everywhere), JWT for the API. */
export class AuthService {
  constructor(private db: Db, private deps: { audit: AuditService; outbox: OutboxService; notifications: NotificationService; rbac: RbacService; log: Logger; appKey: string; sessionDays: number }) {}

  async createUser(input: CreateUserInput, tx?: Db): Promise<string> {
    const run = async (t: Db) => {
      const phone = input.phone ? normalizeBdPhone(input.phone) ?? input.phone.trim() : null;
      const email = input.email ? input.email.trim().toLowerCase() : null;
      if (email && !isEmail(email)) throw badRequest('invalid email');
      if (phone && await t.findOne('users', { school_id: input.schoolId, phone })) throw new HttpError(409, 'phone already registered', 'conflict');
      if (email && await t.findOne('users', { school_id: input.schoolId, email })) throw new HttpError(409, 'email already registered', 'conflict');
      const id = ulid();
      await t.insert('users', { id, school_id: input.schoolId, user_type: input.userType, username: input.username ?? null, email, phone, password_hash: input.password ? await hashPassword(input.password) : null, display_name: input.displayName.trim().slice(0, 160), locale: input.locale ?? null, is_active: true, session_epoch: 1, failed_logins: 0, two_factor_enabled: false, preferences: null });
      for (const r of input.roles ?? []) {
        const role = await t.findOne<{ id: string }>('roles', { school_id: input.schoolId, slug: r });
        if (role) await t.insert('user_roles', { id: ulid(), user_id: id, role_id: role.id, campus_id: null });
      }
      await this.deps.outbox.emit(t, { type: 'user.created', schoolId: input.schoolId, aggregateType: 'core.user', aggregateId: id, payload: { userId: id, userType: input.userType, phone, email, displayName: input.displayName } });
      await this.deps.audit.log({ action: 'create', entityType: 'user', entityId: id, after: { userType: input.userType, phone, email }, schoolId: input.schoolId }, t);
      return id;
    };
    return tx ? run(tx) : this.db.transaction(run);
  }

  async findByIdentifier(identifier: string, schoolId?: string): Promise<UserRow | null> {
    const id = identifier.trim();
    const phone = normalizeBdPhone(id);
    const where = (extra: Row): Row => (schoolId ? { school_id: schoolId, ...extra } : extra);
    if (phone) return this.db.findOne<UserRow>('users', where({ phone }));
    if (isEmail(id)) return this.db.findOne<UserRow>('users', where({ email: id.toLowerCase() }));
    return this.db.findOne<UserRow>('users', where({ username: id }));
  }

  async login(input: LoginInput): Promise<{ user: UserRow; token: string; sessionId: string; expiresAt: string } | { totpRequired: true; userId: string }> {
    const user = await this.findByIdentifier(input.identifier, input.schoolId);
    if (!user || !Number(user.is_active)) throw unauthorized('wrong phone/email or password');
    if (user.locked_until && user.locked_until > nowSql()) throw new HttpError(423, `account locked until ${user.locked_until} UTC`, 'locked');
    const ok = await verifyPassword(input.password, user.password_hash);
    if (!ok) {
      const failed = Number(user.failed_logins) + 1;
      const lock = failed >= MAX_FAILED ? nowSql(new Date(Date.now() + LOCK_MINUTES * 60_000)) : null;
      await this.db.update('users', { failed_logins: lock ? 0 : failed, locked_until: lock, updated_at: nowSql() }, { id: user.id });
      await this.deps.audit.log({ action: 'login_failed', entityType: 'user', entityId: user.id, schoolId: user.school_id, actorUserId: user.id });
      if (lock) await this.deps.outbox.emitNow({ type: 'user.locked', schoolId: user.school_id, aggregateType: 'core.user', aggregateId: user.id, payload: { userId: user.id, until: lock } });
      throw unauthorized('wrong phone/email or password');
    }
    if (Number(user.two_factor_enabled)) {
      if (!input.totp) return { totpRequired: true, userId: user.id };
      if (!verifyTotp(user.two_factor_secret ?? '', input.totp)) throw unauthorized('wrong authenticator code');
    }
    if (user.password_hash && needsRehash(user.password_hash)) await this.db.update('users', { password_hash: await hashPassword(input.password) }, { id: user.id });
    await this.db.update('users', { failed_logins: 0, locked_until: null, last_login_at: nowSql(), updated_at: nowSql() }, { id: user.id });
    const session = await this.createSession(user, input);
    await this.deps.audit.log({ action: 'login', entityType: 'user', entityId: user.id, schoolId: user.school_id, actorUserId: user.id });
    await this.deps.outbox.emitNow({ type: 'user.logged_in', schoolId: user.school_id, aggregateType: 'core.user', aggregateId: user.id, payload: { userId: user.id, platform: input.platform ?? 'web', ip: input.ip ?? null } });
    return { user, ...session };
  }

  async createSession(user: UserRow, meta: Partial<LoginInput> = {}) {
    const token = randomToken(32);
    const id = ulid();
    const days = meta.remember === false ? 1 : this.deps.sessionDays;
    const expiresAt = nowSql(new Date(Date.now() + days * 86_400_000));
    await this.db.insert('auth_sessions', { id, user_id: user.id, token_hash: sha256(token), epoch: Number(user.session_epoch), device_name: meta.deviceName ?? null, device_id: null, platform: meta.platform ?? 'web', ip: meta.ip ?? null, user_agent: meta.userAgent?.slice(0, 255) ?? null, expires_at: expiresAt, last_seen_at: nowSql() });
    return { token, sessionId: id, expiresAt };
  }

  /** Cookie/bearer session token → user (null when expired, revoked, or the user's epoch moved on). */
  async resolveSession(token: string | null | undefined): Promise<{ user: UserRow; session: SessionRow } | null> {
    if (!token) return null;
    const session = await this.db.findOne<SessionRow>('auth_sessions', { token_hash: sha256(token) });
    if (!session || session.revoked_at || session.expires_at <= nowSql()) return null;
    const user = await this.db.findOne<UserRow>('users', { id: session.user_id });
    if (!user || !Number(user.is_active) || Number(user.session_epoch) !== Number(session.epoch)) return null;
    if (!session.last_seen_at || session.last_seen_at < nowSql(new Date(Date.now() - 5 * 60_000))) await this.db.update('auth_sessions', { last_seen_at: nowSql() }, { id: session.id });
    return { user, session };
  }

  async logout(token: string) { await this.db.update('auth_sessions', { revoked_at: nowSql() }, { token_hash: sha256(token) }); }
  async logoutEverywhere(userId: string) {
    await this.db.execute(`UPDATE users SET session_epoch = session_epoch + 1, updated_at = ? WHERE id = ?`, [nowSql(), userId]);
    await this.deps.audit.log({ action: 'logout_all', entityType: 'user', entityId: userId, actorUserId: userId });
  }

  accessToken(user: UserRow, sessionId: string) { return signJwt({ sub: user.id, sid: sessionId, sch: user.school_id, epoch: Number(user.session_epoch), typ: user.user_type }, this.deps.appKey, 900); }
  verifyAccessToken(token: string): JwtClaims | null { return verifyJwt(token, this.deps.appKey); }

  // ---------- OTP ----------
  async issueOtp(input: { schoolId: string; target: string; channel: 'sms' | 'email'; purpose: 'login' | 'verify' | 'reset' | 'invite' | 'consent'; userId?: string | null }) {
    const target = input.channel === 'sms' ? normalizeBdPhone(input.target) : input.target.trim().toLowerCase();
    if (!target || (input.channel === 'email' && !isEmail(target))) throw badRequest(`invalid ${input.channel === 'sms' ? 'phone number' : 'email'}`);
    const recent = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM otp_codes WHERE school_id = ? AND target = ? AND created_at >= ?`, [input.schoolId, target, nowSql(new Date(Date.now() - 600_000))]);
    if (Number(recent[0]?.n) >= OTP_PER_10MIN) throw new HttpError(429, 'too many codes requested; wait 10 minutes', 'rate_limited');
    const code = otpCode(6);
    const id = ulid();
    await this.db.insert('otp_codes', { id, school_id: input.schoolId, user_id: input.userId ?? null, target, channel: input.channel, purpose: input.purpose, code_hash: sha256(`${target}:${code}`), attempts: 0, expires_at: nowSql(new Date(Date.now() + OTP_MINUTES * 60_000)) });
    await this.deps.notifications.notify({ schoolId: input.schoolId, userId: input.userId ?? null, address: target, channels: [input.channel], eventKey: 'auth.otp', data: { code, minutes: OTP_MINUTES }, respectQuietHours: false, immediate: true, entityType: 'core.otp', entityId: id });
    return { id, target, expiresInMinutes: OTP_MINUTES, ...(process.env.APP_ENV === 'test' ? { code } : {}) };
  }

  async verifyOtp(input: { schoolId: string; target: string; code: string; purpose: string }): Promise<{ ok: true; userId: string | null; otpId: string }> {
    const target = normalizeBdPhone(input.target) ?? input.target.trim().toLowerCase();
    const rows = await this.db.findMany<Record<string, unknown>>('otp_codes', { school_id: input.schoolId, target, purpose: input.purpose, consumed_at: null }, { orderBy: 'created_at DESC', limit: 1 });
    const otp = rows[0];
    if (!otp || String(otp.expires_at) <= nowSql()) throw unauthorized('code expired; request a new one');
    if (Number(otp.attempts) >= OTP_MAX_ATTEMPTS) throw new HttpError(429, 'too many attempts; request a new code', 'rate_limited');
    if (otp.code_hash !== sha256(`${target}:${input.code.trim()}`)) { await this.db.execute(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, [otp.id]); throw unauthorized('wrong code'); }
    await this.db.update('otp_codes', { consumed_at: nowSql() }, { id: otp.id as string });
    const userId = (otp.user_id as string | null) ?? (await this.findByIdentifier(target, input.schoolId))?.id ?? null;
    if (userId && input.purpose === 'verify') await this.db.update('users', normalizeBdPhone(target) ? { phone_verified_at: nowSql() } : { email_verified_at: nowSql() }, { id: userId });
    return { ok: true, userId, otpId: String(otp.id) };
  }

  /** OTP login: verify code → session. Creates no users; the school invites people first. */
  async loginWithOtp(input: { schoolId: string; target: string; code: string; platform?: LoginInput['platform']; ip?: string | null; userAgent?: string | null }) {
    const v = await this.verifyOtp({ schoolId: input.schoolId, target: input.target, code: input.code, purpose: 'login' });
    if (!v.userId) throw unauthorized('no account for this number');
    const user = await this.db.findOne<UserRow>('users', { id: v.userId });
    if (!user || !Number(user.is_active)) throw unauthorized('account inactive');
    await this.db.update('users', { failed_logins: 0, locked_until: null, last_login_at: nowSql(), phone_verified_at: normalizeBdPhone(input.target) ? nowSql() : undefined as never, updated_at: nowSql() }, { id: user.id });
    const session = await this.createSession(user, input);
    await this.deps.audit.log({ action: 'login_otp', entityType: 'user', entityId: user.id, schoolId: user.school_id, actorUserId: user.id });
    return { user, ...session };
  }

  // ---------- TOTP 2FA ----------
  async beginTotp(userId: string, account: string) {
    const secret = generateTotpSecret();
    await this.db.update('users', { two_factor_secret: secret, two_factor_enabled: false, updated_at: nowSql() }, { id: userId });
    return { secret, uri: totpUri(secret, account) };
  }
  async confirmTotp(userId: string, code: string) {
    const user = await this.db.findOne<UserRow>('users', { id: userId });
    if (!user?.two_factor_secret || !verifyTotp(user.two_factor_secret, code)) throw badRequest('wrong authenticator code');
    await this.db.update('users', { two_factor_enabled: true, updated_at: nowSql() }, { id: userId });
    await this.deps.audit.log({ action: 'totp_enabled', entityType: 'user', entityId: userId, schoolId: user.school_id, actorUserId: userId });
  }
  async disableTotp(userId: string) { await this.db.update('users', { two_factor_enabled: false, two_factor_secret: null, updated_at: nowSql() }, { id: userId }); }

  async setPassword(userId: string, password: string) {
    await this.db.update('users', { password_hash: await hashPassword(password), updated_at: nowSql() }, { id: userId });
    await this.logoutEverywhere(userId);
  }

  /**
   * Turn a login on or off. Disabling ends every session the person is holding as well — leaving one
   * open would let somebody who was just removed carry on working until their cookie expired.
   */
  async setActive(userId: string, active: boolean) {
    const user = await this.db.findOne<UserRow>('users', { id: userId });
    if (!user) throw new HttpError(404, 'user not found', 'not_found');
    await this.db.update('users', { is_active: active, updated_at: nowSql() }, { id: userId });
    if (!active) await this.logoutEverywhere(userId);
    await this.deps.audit.log({ action: active ? 'enable' : 'disable', entityType: 'user', entityId: userId, schoolId: user.school_id, before: { isActive: !!Number(user.is_active) }, after: { isActive: active } });
    return { userId, isActive: active };
  }
}
