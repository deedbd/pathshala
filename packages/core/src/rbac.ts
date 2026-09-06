import type { Db } from '@pathshala/db';
import { ulid } from '@pathshala/db';
import { currentContext, forbidden } from './context.js';

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
}
