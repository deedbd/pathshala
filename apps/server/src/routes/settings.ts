import type { Request, Response, Router } from 'express';
import { HttpError, assertWritableSetting, generatePassword, type App } from '@pathshala/core';
import { bdPhoneSchema, settingWriteSchema, z } from '@pathshala/schemas';

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (e?: unknown) => void) => void;
type User = { id: string; school_id: string; user_type: string };

/**
 * Settings: the half of the console every other half depends on.
 *
 * Every scheduled job reads the `settings` table, `audit_logs` is written on every change,
 * `number_sequences` decides what a receipt is called, and `roles`/`permissions` decide who may do
 * any of it — and until this file existed a school could see none of it and change none of it.
 *
 * Three rules run through the whole file:
 *
 * 1. A secret never comes back. A key holding an encrypted value is listed as `{ enc: true }` — the
 *    school learns that the thing is configured and nothing else — and a write to such a key is
 *    refused here rather than quietly storing a plaintext where ciphertext is expected. The module
 *    that owns a secret (IVR, a payment gateway) is the only thing that sets it.
 * 2. Every write is audited, and the audit row names the actor from the request context.
 * 3. A change to `settings` takes effect on the **next** run of the job that reads it, not
 *    retroactively — the reply says so, because a head teacher who changes the auto-absent time at
 *    11:00 needs to know today's register is already written.
 */
export function mountSettings(api: Router, app: App, wrap: Wrap, requirePerm: (req: Request, perm: string) => User) {
  /** Reads take `platform.view`; the three that have a dedicated permission of their own use it. */
  const read = (req: Request, perm = 'platform.view') => requirePerm(req, perm);
  const write = (req: Request) => requirePerm(req, 'platform.settings');

  // ---------------------------------------------------------------- policies
  /**
   * Every key this school has, plus the ones Pathshala ships that it has not written yet — keyed by
   * the key itself, so a caller can ask about one row without walking a list.
   */
  api.get('/settings', wrap(async req => {
    const u = read(req);
    const have = await app.settings.list(u.school_id);
    for (const row of app.settings.missing(have)) have[row.key] = row;
    return have;
  }));

  api.put('/settings', wrap(async req => {
    const u = write(req);
    const { key, value } = settingWriteSchema.parse(req.body);
    assertWritableSetting(key, value);
    const before = await app.settings.get(u.school_id, key);
    await app.settings.set(u.school_id, key, value);
    await app.audit.log({ action: 'update', entityType: 'settings', entityId: key, before: { value: before }, after: { value } });
    const meta = (await app.settings.list(u.school_id))[key];
    return {
      key, value, saved: true,
      // the jobs read this table live; nothing that already ran is rewritten
      effect: meta?.readBy ? `${meta.readBy} uses this from its next run — anything it has already done stands.` : 'Saved. Nothing reads this key yet, so nothing changes until something does.',
      readBy: meta?.readBy ?? null,
    };
  }));

  // ---------------------------------------------------------------- audit
  api.get('/audit', wrap(async req => {
    const u = read(req, 'core.audit');
    const q = z.object({
      entityType: z.string().max(60).optional(), entityId: z.string().max(64).optional(), action: z.string().max(40).optional(),
      actorUserId: z.string().max(64).optional(), actorType: z.enum(['user', 'system', 'automation', 'api']).optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      page: z.coerce.number().int().min(0).max(10_000).optional(), pageSize: z.coerce.number().int().min(1).max(200).optional(),
    }).parse(req.query);
    return app.audit.search(u.school_id, q);
  }));

  // ---------------------------------------------------------------- numbering
  api.get('/sequences', wrap(async req => {
    const u = read(req);
    return app.numbering.sequences(u.school_id);
  }));

  api.patch('/sequences/:id', wrap(async req => {
    const u = write(req);
    const b = z.object({
      prefix: z.string().max(20).optional(), padding: z.coerce.number().int().min(0).max(12).optional(),
      nextValue: z.coerce.number().int().min(1).optional(), resetYearly: z.coerce.boolean().optional(),
    }).parse(req.body);
    const r = await app.numbering.updateSequence(u.school_id, String(req.params.id), b);
    await app.audit.log({ action: 'update', entityType: 'number_sequence', entityId: String(req.params.id), before: 'before' in r ? r.before : null, after: b });
    return r;
  }));

  // ---------------------------------------------------------------- users
  api.get('/users', wrap(async req => {
    const u = read(req, 'core.users');
    return app.rbac.users(u.school_id);
  }));

  /**
   * Invite an operator: the account is created and the sign-in details are sent to them.
   *
   * The password is generated unless one is given, is returned exactly once (the office may have to
   * read it out where there is no email), and is stored only as a bcrypt hash. It is deliberately
   * absent from the audit row.
   */
  api.post('/users', wrap(async req => {
    const u = write(req);
    const b = z.object({
      displayName: z.string().trim().min(2).max(160),
      phone: bdPhoneSchema.optional(), email: z.string().trim().toLowerCase().email().optional(),
      roles: z.array(z.string().max(60)).min(1).max(6),
      locale: z.enum(['bn', 'en']).optional(),
      password: z.string().min(8).max(128).optional(),
    }).refine(v => v.phone || v.email, { message: 'a mobile number or an email — the invitation has to reach them somewhere' }).parse(req.body);

    const known = await app.rbac.roles(u.school_id);
    const unknown = b.roles.filter(s => !known.roles.some(r => r.slug === s));
    if (unknown.length) throw new HttpError(400, `no such role here: ${unknown.join(', ')}`, 'bad_request');

    const password = b.password ?? generatePassword();
    const userId = await app.auth.createUser({ schoolId: u.school_id, userType: 'staff', displayName: b.displayName, phone: b.phone ?? null, email: b.email ?? null, password, locale: b.locale, roles: b.roles });
    app.rbac.invalidate(userId);

    const url = `${app.config.appUrl.replace(/\/$/, '')}/login`;
    const sent = await app.notifications.notify({
      schoolId: u.school_id, userId, channels: b.email ? ['email', 'in_app'] : ['sms', 'in_app'], eventKey: 'core.user_invited',
      title: 'Your Pathshala sign-in', body: `${b.displayName}, an account has been made for you. Sign in at ${url} with ${b.phone ?? b.email} and the password ${password}. Change it once you are in.`,
      data: { name: b.displayName, url, identifier: b.phone ?? b.email ?? '', password },
      entityType: 'user', entityId: userId, respectQuietHours: false, immediate: true,
    });
    await app.audit.log({ action: 'invite', entityType: 'user', entityId: userId, after: { displayName: b.displayName, phone: b.phone ?? null, email: b.email ?? null, roles: b.roles, passwordGenerated: !b.password } });
    return { userId, password, passwordGenerated: !b.password, url, invitationsSent: sent.length };
  }));

  api.post('/users/:id/roles', wrap(async req => {
    const u = write(req);
    const b = z.object({ roles: z.array(z.string().max(60)).max(10) }).parse(req.body);
    const r = await app.rbac.setUserRoles(u.school_id, String(req.params.id), b.roles);
    await app.audit.log({ action: 'update', entityType: 'user_roles', entityId: String(req.params.id), before: { roles: r.before }, after: { roles: r.after } });
    return { ...r, effect: 'That person’s next request is checked against the new roles; anything they already did stands.' };
  }));

  api.post('/users/:id/reset', wrap(async req => {
    const u = write(req);
    const id = String(req.params.id);
    const target = await app.db.findOne<{ id: string; display_name: string; phone: string | null; email: string | null }>('users', { id, school_id: u.school_id });
    if (!target) throw new HttpError(404, 'user not found', 'not_found');
    const password = generatePassword();
    await app.auth.setPassword(id, password);          // ends every session they were holding
    const url = `${app.config.appUrl.replace(/\/$/, '')}/login`;
    const sent = await app.notifications.notify({
      schoolId: u.school_id, userId: id, channels: target.email ? ['email', 'in_app'] : ['sms', 'in_app'], eventKey: 'core.password_reset',
      title: 'Your Pathshala password was reset', body: `${target.display_name}, your password has been reset. Sign in at ${url} with ${target.phone ?? target.email} and the password ${password}, then change it.`,
      data: { name: target.display_name, url, password }, entityType: 'user', entityId: id, respectQuietHours: false, immediate: true,
    });
    await app.audit.log({ action: 'reset_password', entityType: 'user', entityId: id, after: { reset: true, sessionsEnded: true } });
    return { userId: id, password, url, sent: sent.length };
  }));

  api.post('/users/:id/disable', wrap(async req => {
    const u = write(req);
    const id = String(req.params.id);
    const b = z.object({ active: z.coerce.boolean().optional() }).parse(req.body ?? {});
    const active = b.active ?? false;
    const target = await app.db.findOne<{ id: string }>('users', { id, school_id: u.school_id });
    if (!target) throw new HttpError(404, 'user not found', 'not_found');
    if (id === u.id && !active) throw new HttpError(400, 'you would be signing yourself out for good — ask another administrator', 'bad_request');
    // the same refusal as taking the role away: the last super_admin is the school's way back in
    if (!active) {
      const holders = await app.rbac.superAdmins(u.school_id);
      if (holders.length <= 1 && holders.includes(id)) throw new HttpError(400, 'that is the only super_admin left; give somebody else that role first', 'bad_request');
    }
    const r = await app.auth.setActive(id, active);    // writes its own audit row
    app.rbac.invalidate(id);
    return r;
  }));

  // ---------------------------------------------------------------- roles
  api.get('/roles', wrap(async req => {
    const u = read(req, 'core.roles');
    return app.rbac.roles(u.school_id);
  }));

  api.put('/roles/:id/permissions', wrap(async req => {
    const u = write(req);
    const b = z.object({ permissions: z.array(z.string().max(120)).max(1000) }).parse(req.body);
    const r = await app.rbac.setRolePermissions(u.school_id, String(req.params.id), b.permissions);
    await app.audit.log({ action: 'update', entityType: 'role_permissions', entityId: String(req.params.id), before: { permissions: r.before }, after: { permissions: r.after } });
    // setRolePermissions clears the whole access cache; every session is re-read on its next request
    return { ...r, effect: 'Live now: the next request anybody holding this role makes is checked against the new list.' };
  }));

  // ---------------------------------------------------------------- the school itself
  api.get('/school', wrap(async req => {
    const u = read(req);
    const [profile, campuses, shifts] = await Promise.all([
      app.settings.profile(u.school_id), app.academic.campuses(u.school_id), app.academic.shifts(u.school_id),
    ]);
    return { profile, campuses, shifts };
  }));

  api.patch('/school', wrap(async req => {
    const u = write(req);
    const b = z.object({
      name: z.string().trim().min(2).max(160).optional(),
      nameBn: z.string().trim().max(160).nullable().optional(),
      institutionType: z.enum(['school', 'college', 'school_college', 'madrasa', 'kindergarten', 'coaching', 'university']).optional(),
      eiin: z.string().trim().max(20).nullable().optional(),
      mpoCode: z.string().trim().max(30).nullable().optional(),
      board: z.string().trim().max(60).nullable().optional(),
      address: z.string().trim().max(400).nullable().optional(),
      phone: z.string().trim().max(30).nullable().optional(),
      email: z.string().trim().max(160).nullable().optional(),
      website: z.string().trim().max(200).nullable().optional(),
      timezone: z.string().trim().max(60).optional(),
      currency: z.string().trim().length(3).toUpperCase().optional(),
      locale: z.enum(['bn', 'en']).optional(),
      theme: z.record(z.string(), z.unknown()).nullable().optional(),
    }).parse(req.body);
    const r = await app.settings.updateProfile(u.school_id, b);
    await app.audit.log({ action: 'update', entityType: 'school', entityId: u.school_id, before: 'before' in r ? r.before : null, after: b });
    return { updated: r.updated, profile: r.profile };
  }));

  api.post('/school/campuses', wrap(async req => {
    const u = write(req);
    const b = z.object({ name: z.string().trim().min(2).max(120), code: z.string().trim().min(2).max(12), address: z.string().trim().max(400).nullable().optional(), phone: z.string().trim().max(30).nullable().optional(), isMain: z.coerce.boolean().optional() }).parse(req.body);
    const id = await app.academic.createCampus(u.school_id, b);
    await app.audit.log({ action: 'create', entityType: 'campus', entityId: id, after: b });
    return { id };
  }));

  api.patch('/school/campuses/:id', wrap(async req => {
    const u = write(req);
    const b = z.object({ name: z.string().trim().min(2).max(120).optional(), address: z.string().trim().max(400).nullable().optional(), phone: z.string().trim().max(30).nullable().optional(), isMain: z.coerce.boolean().optional(), status: z.enum(['active', 'inactive']).optional() }).parse(req.body);
    const updated = await app.academic.updateCampus(u.school_id, String(req.params.id), b);
    await app.audit.log({ action: 'update', entityType: 'campus', entityId: String(req.params.id), after: b });
    return { updated };
  }));

  api.post('/school/shifts', wrap(async req => {
    const u = write(req);
    const b = z.object({ name: z.string().trim().min(2).max(60), startTime: timeString, endTime: timeString }).parse(req.body);
    const id = await app.academic.createShift(u.school_id, b);
    await app.audit.log({ action: 'create', entityType: 'shift', entityId: id, after: b });
    return { id };
  }));

  api.patch('/school/shifts/:id', wrap(async req => {
    const u = write(req);
    const b = z.object({ name: z.string().trim().min(2).max(60).optional(), startTime: timeString.optional(), endTime: timeString.optional() }).parse(req.body);
    const updated = await app.academic.updateShift(u.school_id, String(req.params.id), b);
    await app.audit.log({ action: 'update', entityType: 'shift', entityId: String(req.params.id), after: b });
    return { updated };
  }));
}

/** 'HH:MM' or 'HH:MM:SS' from a form, stored as the seconds-bearing form every engine compares. */
const timeString = z.string().trim().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'a time like 08:00').transform(v => (v.length === 5 ? `${v}:00` : v));
