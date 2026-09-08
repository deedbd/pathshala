import type { Db, Row } from '@pathshala/db';
import { ulid } from '@pathshala/db';
import { badRequest, currentContext, forbidden, notFound } from './context.js';

export interface UserAccess { roles: string[]; permissions: Set<string>; level: number }

/** Role-based access from `roles` / `role_permissions` / `user_roles`, checked in one place. */
export class RbacService {
  private cache = new Map<string, { at: number; access: UserAccess }>();
  constructor(private db: Db, private ttlMs = 30_000) {}

  async accessFor(userId: string): Promise<UserAccess> {
    const hit = this.cache.get(userId);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.access;
    const rows = await this.db.query<{ slug: string; level: number; key_name: string | null }>(
      `SELECT r.slug, r.level, p.key_name FROM user_roles ur JOIN roles r ON r.id = ur.role_id LEFT JOIN role_permissions rp ON rp.role_id = r.id LEFT JOIN permissions p ON p.id = rp.permission_id WHERE ur.user_id = ?`, [userId]);
    const roles = [...new Set(rows.map(r => r.slug))];
    const permissions = new Set(rows.map(r => r.key_name).filter((k): k is string => !!k));
    const level = rows.reduce((m, r) => Math.max(m, Number(r.level) || 0), 0);
    const access = { roles, permissions, level };
    this.cache.set(userId, { at: Date.now(), access });
    return access;
  }

  can(perm: string, access?: UserAccess): boolean {
    const a = access ?? (currentContext()?.permissions ? { permissions: currentContext()!.permissions!, roles: currentContext()!.roles ?? [], level: 0 } : null);
    if (!a) return false;
    if (a.roles.includes('super_admin')) return true;
    if (a.permissions.has(perm)) return true;
    const [mod] = perm.split('.');
    return a.permissions.has(`${mod}.*`);
  }
  require(perm: string, access?: UserAccess) { if (!this.can(perm, access)) throw forbidden(`missing permission ${perm}`); }
  invalidate(userId?: string) { userId ? this.cache.delete(userId) : this.cache.clear(); }

  async assignRole(userId: string, roleSlug: string, schoolId: string, campusId: string | null = null) {
    const role = await this.db.findOne<{ id: string }>('roles', { school_id: schoolId, slug: roleSlug });
    if (!role) throw new Error(`role ${roleSlug} not seeded for school`);
    const exists = await this.db.findOne('user_roles', { user_id: userId, role_id: role.id });
    if (!exists) await this.db.insert('user_roles', { id: ulid(), user_id: userId, role_id: role.id, campus_id: campusId });
    this.invalidate(userId);
  }

  // ---------- the console's Users and Roles screens ----------
  /**
   * The operator logins: the people who sign in to the console, never the accounts that come with a
   * child or a guardian (those are made by People and are read through the portal). A password hash
   * and a TOTP secret are columns on the same row and neither leaves here.
   */
  async users(schoolId: string): Promise<RbacUser[]> {
    const rows = await this.db.query<Row>(
      `SELECT u.id, u.display_name, u.email, u.phone, u.username, u.user_type, u.is_active, u.two_factor_enabled, u.last_login_at, u.locked_until, u.created_at
       FROM users u WHERE u.school_id = ? AND u.user_type IN ('admin', 'staff') AND u.deleted_at IS NULL
       ORDER BY u.display_name ASC, u.id ASC`, [schoolId]);
    const ids = rows.map(r => String(r.id));
    const held = ids.length
      ? await this.db.query<{ user_id: string; slug: string; name: string }>(
        `SELECT ur.user_id, r.slug, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id IN (${ids.map(() => '?').join(', ')}) ORDER BY r.level DESC, r.slug ASC`, ids)
      : [];
    return rows.map(r => ({
      id: String(r.id), displayName: String(r.display_name), email: (r.email as string) ?? null, phone: (r.phone as string) ?? null,
      username: (r.username as string) ?? null, userType: String(r.user_type), isActive: !!Number(r.is_active),
      twoFactor: !!Number(r.two_factor_enabled), lastLoginAt: (r.last_login_at as string) ?? null, lockedUntil: (r.locked_until as string) ?? null,
      roles: held.filter(h => h.user_id === String(r.id)).map(h => ({ slug: String(h.slug), name: String(h.name) })),
    }));
  }

  /** The matrix, read across (a role) and down (a permission), plus who holds each role. */
  async roles(schoolId: string): Promise<RbacMatrix> {
    const [roles, perms, grants, counts] = await Promise.all([
      this.db.findMany<Row>('roles', { school_id: schoolId }, { orderBy: 'level DESC, name ASC' }),
      this.db.findMany<Row>('permissions', {}, { orderBy: 'module ASC, key_name ASC' }),
      this.db.query<{ role_id: string; key_name: string }>(
        `SELECT rp.role_id, p.key_name FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id WHERE r.school_id = ?`, [schoolId]),
      this.db.query<{ role_id: string; n: number }>(
        `SELECT ur.role_id, COUNT(*) AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.school_id = ? GROUP BY ur.role_id`, [schoolId]),
    ]);
    return {
      roles: roles.map(r => ({
        id: String(r.id), slug: String(r.slug), name: String(r.name), level: Number(r.level) || 0, isSystem: !!Number(r.is_system),
        holders: Number(counts.find(c => String(c.role_id) === String(r.id))?.n ?? 0),
        // super_admin is the school's way back in and `can()` grants it everything whatever the rows say
        locked: String(r.slug) === SUPER_ADMIN,
        permissions: String(r.slug) === SUPER_ADMIN ? perms.map(p => String(p.key_name)) : grants.filter(g => String(g.role_id) === String(r.id)).map(g => String(g.key_name)),
      })),
      permissions: perms.map(p => ({ key: String(p.key_name), module: String(p.module) })),
      modules: [...new Set(perms.map(p => String(p.module)))].sort(),
    };
  }

  /**
   * Replace one role's permissions.
   *
   * `super_admin` is refused outright: `can()` returns true for it whatever `role_permissions` says,
   * so editing its rows would show a school a matrix that is not what the door actually does — and a
   * school that emptied it would believe it had locked itself out when it had not.
   */
  async setRolePermissions(schoolId: string, roleId: string, keys: string[]) {
    const role = await this.db.findOne<Row>('roles', { id: roleId, school_id: schoolId });
    if (!role) throw notFound('role');
    if (String(role.slug) === SUPER_ADMIN) throw badRequest('super_admin always holds every permission — it is the way back in when a role is set wrong. Change one of the other roles instead');
    const wanted = [...new Set(keys)];
    const perms = wanted.length
      ? await this.db.query<{ id: string; key_name: string }>(`SELECT id, key_name FROM permissions WHERE key_name IN (${wanted.map(() => '?').join(', ')})`, wanted)
      : [];
    const unknown = wanted.filter(k => !perms.some(p => p.key_name === k));
    if (unknown.length) throw badRequest(`no such permission: ${unknown.slice(0, 5).join(', ')}`);
    const before = (await this.db.query<{ key_name: string }>(
      `SELECT p.key_name FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`, [roleId])).map(r => String(r.key_name));
    await this.db.transaction(async tx => {
      await tx.delete('role_permissions', { role_id: roleId });
      if (perms.length) await tx.insertMany('role_permissions', perms.map(p => ({ id: ulid(), role_id: roleId, permission_id: p.id })));
    });
    // every session's cached access is now stale, and the change has to bite on the next request
    this.invalidate();
    const after = perms.map(p => p.key_name);
    return { role: String(role.slug), before, after, added: after.filter(k => !before.includes(k)), removed: before.filter(k => !after.includes(k)) };
  }

  /**
   * Replace the roles one user holds.
   *
   * Refused when it would leave the school with nobody holding `super_admin`: that is the only role
   * that can hand the roles back out, so a school that removes the last one has locked itself out of
   * its own console with no way in short of the database.
   */
  async setUserRoles(schoolId: string, userId: string, slugs: string[]) {
    const user = await this.db.findOne<Row>('users', { id: userId, school_id: schoolId });
    if (!user) throw notFound('user');
    const wanted = [...new Set(slugs)];
    const roles = await this.db.findMany<Row>('roles', { school_id: schoolId });
    const unknown = wanted.filter(s => !roles.some(r => String(r.slug) === s));
    if (unknown.length) throw badRequest(`no such role here: ${unknown.slice(0, 5).join(', ')}`);
    const before = (await this.db.query<{ slug: string }>(
      `SELECT r.slug FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`, [userId])).map(r => String(r.slug));
    if (before.includes(SUPER_ADMIN) && !wanted.includes(SUPER_ADMIN) && (await this.superAdmins(schoolId)).length <= 1) {
      throw badRequest(`${String(user.display_name)} is the only super_admin left; give somebody else that role first or the school cannot change its own roles again`);
    }
    const chosen = roles.filter(r => wanted.includes(String(r.slug)));
    await this.db.transaction(async tx => {
      await tx.delete('user_roles', { user_id: userId });
      if (chosen.length) await tx.insertMany('user_roles', chosen.map(r => ({ id: ulid(), user_id: userId, role_id: r.id, campus_id: null })));
    });
    this.invalidate(userId);
    return { userId, before, after: wanted };
  }

  /** Who still holds `super_admin` here, and is not disabled — the answer the guards above ask. */
  async superAdmins(schoolId: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT u.id FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
       WHERE r.school_id = ? AND r.slug = ? AND u.school_id = ? AND u.is_active = ? AND u.deleted_at IS NULL`,
      [schoolId, SUPER_ADMIN, schoolId, true]);
    return [...new Set(rows.map(r => String(r.id)))];
  }
}

const SUPER_ADMIN = 'super_admin';

export interface RbacUser {
  id: string; displayName: string; email: string | null; phone: string | null; username: string | null; userType: string;
  isActive: boolean; twoFactor: boolean; lastLoginAt: string | null; lockedUntil: string | null;
  roles: { slug: string; name: string }[];
}
export interface RbacRole { id: string; slug: string; name: string; level: number; isSystem: boolean; holders: number; locked: boolean; permissions: string[] }
export interface RbacMatrix { roles: RbacRole[]; permissions: { key: string; module: string }[]; modules: string[] }
