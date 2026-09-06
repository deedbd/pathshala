import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-request context: tenant, actor, request id. Services read it instead of taking schoolId everywhere. */
export interface RequestContext {
  requestId: string;
  schoolId?: string | null;
  userId?: string | null;
  actorType?: 'user' | 'system' | 'automation' | 'api';
  locale?: 'bn' | 'en';
  ip?: string | null;
  userAgent?: string | null;
  roles?: string[];
  permissions?: Set<string>;
}

const als = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T { return als.run(ctx, fn); }
export function currentContext(): RequestContext | undefined { return als.getStore(); }
export function requireTenant(): string {
  const s = als.getStore()?.schoolId;
  if (!s) throw new TenantError();
  return s;
}
export function systemContext(schoolId: string, extra: Partial<RequestContext> = {}): RequestContext {
  return { requestId: `sys-${Date.now().toString(36)}`, schoolId, actorType: 'system', userId: null, ...extra };
}

export class TenantError extends Error { constructor() { super('no tenant in context: refusing to touch tenant tables'); this.name = 'TenantError'; } }
export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'error', public details?: unknown) { super(message); this.name = 'HttpError'; }
}
export const notFound = (what = 'resource') => new HttpError(404, `${what} not found`, 'not_found');
export const forbidden = (msg = 'forbidden') => new HttpError(403, msg, 'forbidden');
export const unauthorized = (msg = 'sign in required') => new HttpError(401, msg, 'unauthorized');
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, 'bad_request', details);
