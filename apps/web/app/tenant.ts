import { useCallback } from 'react';
import { useRouteLoaderData } from 'react-router';

/**
 * Which school this request belongs to, as the server worked it out from the host and the path.
 *
 * `prefix` is what every in-app link has to carry: `''` when a custom domain resolved the school
 * (the app sits at that host's root) and `/<slug>` when the first path segment did. It is also `''`
 * on the vendor's own host-and-root, where `tenant` is null altogether and no school page is served.
 */
// the same shape the server publishes (`RequestTenant` in @pathshala/core), declared structurally so
// this module stays free of a runtime import into core — the web build must not pull core in
export type Tenant = { schoolId: string; slug: string | null; prefix: string; source: string; name: string };

/** The load context, as far as this module cares. Kept structural so it works in loaders and actions alike. */
export type TenantContext = { tenant?: Tenant | null };

/** Whether a signed-in user belongs to the school whose address this page is being served at. */
export function sessionMatchesTenant(context: TenantContext, user: { school_id: string } | null | undefined): boolean {
  const tenant = context.tenant ?? null;
  if (!tenant || !user) return true;
  return String(user.school_id) === String(tenant.schoolId);
}

/**
 * A session for another school is not a session here.
 *
 * Arriving at one school's address holding another school's session gets a 404, never the school one
 * happens to be signed in to: the console is the one place where getting this wrong would put a
 * stranger's roll call on the screen under this school's name. There is no sign-in page to be sent
 * to either — this school's is behind a door only this school knows.
 *
 * `request` is kept in the signature because every caller passes it and a future answer may want it.
 */
export function requireTenantUser<T extends { school_id: string }>(context: TenantContext, user: T, _request?: Request): T {
  if (sessionMatchesTenant(context, user)) return user;
  throw new Response('Not found', { status: 404 });
}

/**
 * `/students` → `/saranjai/students` under a slug, and `/students` unchanged under a custom domain.
 *
 * Only absolute in-app paths are rewritten: a relative path, a query-only href and an absolute URL
 * are left exactly as they are, so `api()` calls to `/api/…` must never be passed through here — the
 * session decides the tenant on those and the server checks it.
 */
export function tenantPath(prefix: string | null | undefined, p: string): string {
  const pre = prefix ?? '';
  if (!pre || !p.startsWith('/') || p.startsWith('//')) return p;
  return p === '/' ? pre : pre + p;
}

/** The prefix carried by the page being rendered, from the root loader. */
export function useTenantPrefix(): string {
  const root = useRouteLoaderData('root') as { tenantPrefix?: string } | undefined;
  return root?.tenantPrefix ?? '';
}

/** `const tp = useTenantPath()` → `<Link to={tp('/students')}>`. */
export function useTenantPath(): (p: string) => string {
  const prefix = useTenantPrefix();
  return useCallback((p: string) => tenantPath(prefix, p), [prefix]);
}

/** The prefix on the server side, for a loader's or action's redirect. */
export function tenantPrefix(context: TenantContext): string {
  return context.tenant?.prefix ?? '';
}

/** `tenantPath(tenantPrefix(context), p)` — the shape almost every redirect wants. */
export function ctxPath(context: TenantContext, p: string): string {
  return tenantPath(tenantPrefix(context), p);
}

/**
 * Where to land after signing in. A `?next=` is a path somebody else can choose, so it may not send
 * the browser off this host, and under a slug it may not leave this school's address either; anything
 * else falls back to the school's own dashboard.
 */
export function safeNext(prefix: string, next: string | null | undefined, fallback = '/dashboard'): string {
  const home = tenantPath(prefix, fallback);
  if (!next || !next.startsWith('/') || next.startsWith('//')) return home;
  if (!prefix) return next;
  return next === prefix || next.startsWith(prefix + '/') ? next : home;
}
