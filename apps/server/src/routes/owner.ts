import type { NextFunction, Request, Response, Router } from 'express';
import { HttpError, type App } from '@pathshala/core';
import { bdPhoneSchema, emailSchema, localeSchema, passwordSchema, z } from '@pathshala/schemas';

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (e?: unknown) => void) => void;
type User = { id: string; school_id: string; user_type: string };

const institutionType = z.enum(['school', 'college', 'school_college', 'madrasa', 'kindergarten', 'coaching', 'university']);
const statusFilter = z.enum(['active', 'trial', 'past_due', 'suspended', 'closed']);

/**
 * The vendor's API: `/api/owner/*`, the console the owner of Pathshala runs their business from.
 *
 * `requirePerm` is here for what it is good at — refusing a portal account and refusing a role that
 * has no business with `saas.*` at all — and it decides nothing about who the vendor is. It cannot:
 * every school's own super admin passes any permission check inside their own tenant, and this API
 * reads and writes *other people's* tenants. `OwnerService.requireOwner` is the gate, it runs inside
 * every service method, and these routes would be safe with no permission check at all.
 */
export function mountOwner(api: Router, app: App, wrap: Wrap, requirePerm: (req: Request, perm: string) => User) {
  const q = (req: Request, k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : undefined);

  // ---------- the business at a glance ----------
  api.get('/overview', wrap(async req => app.owner.overview(requirePerm(req, 'saas.view'))));

  // ---------- clients ----------
  api.get('/schools', wrap(async req => {
    const u = requirePerm(req, 'saas.view');
    const f = z.object({ q: z.string().max(80).optional(), status: statusFilter.optional(), planId: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional() })
      .parse({ q: q(req, 'q'), status: q(req, 'status'), planId: q(req, 'planId'), limit: q(req, 'limit'), offset: q(req, 'offset') });
    return app.owner.schools(u, f);
  }));

  /**
   * A new client. The reply carries the administrator's password once; it is a bcrypt hash everywhere
   * else from this moment on, so the console must show it to the person on the phone now or never.
   */
  api.post('/schools', wrap(async req => {
    const u = requirePerm(req, 'saas.create');
    const b = z.object({
      schoolName: z.string().trim().min(2).max(160),
      schoolNameBn: z.string().trim().max(160).optional().nullable(),
      schoolCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,12}$/, '2–12 letters or digits').or(z.literal('')).optional().nullable(),
      institutionType: institutionType.default('school'),
      locale: localeSchema.default('bn'),
      adminName: z.string().trim().min(2).max(160),
      adminPhone: bdPhoneSchema,
      adminEmail: emailSchema.or(z.literal('')).optional().nullable(),
      adminPassword: passwordSchema.or(z.literal('')).optional().nullable(),
      planId: z.string().max(40).optional().nullable(),
      billingCycle: z.enum(['monthly', 'yearly']).optional(),
      trialDays: z.coerce.number().int().min(0).max(365).optional(),
      discountPct: z.coerce.number().min(0).max(100).optional(),
      referralCode: z.string().trim().max(40).optional().nullable(),
    }).parse(req.body);
    return app.owner.provision(u, b);
  }));

  api.get('/schools/:id', wrap(async req => app.owner.school(requirePerm(req, 'saas.view'), req.params.id as string)));

  api.post('/schools/:id/status', wrap(async req => {
    const u = requirePerm(req, 'saas.edit');
    const b = z.object({ status: z.enum(['active', 'suspended']), reason: z.string().trim().max(255).optional().nullable() }).parse(req.body);
    return app.owner.setStatus(u, req.params.id as string, b.status, b.reason ?? null);
  }));

  api.post('/schools/:id/plan', wrap(async req => {
    const u = requirePerm(req, 'saas.edit');
    const b = z.object({ planId: z.string().min(1).max(40), billingCycle: z.enum(['monthly', 'yearly']).optional(), trialDays: z.coerce.number().int().min(0).max(365).optional(), discountPct: z.coerce.number().min(0).max(100).optional(), referralCode: z.string().trim().max(40).optional().nullable() }).parse(req.body);
    return app.owner.setPlan(u, req.params.id as string, b);
  }));

  /**
   * Where a school opens. The GET is what the vendor reads down a telephone to a school's IT person
   * — the DNS records carry this server's real address, and the second one says in words that `www.`
   * is covered. The POST names the school and, where a cPanel token is configured, adds the alias
   * that makes an unknown hostname reach our folder at all; where it is not, the reply says exactly
   * what to add by hand instead of failing silently.
   */
  api.get('/schools/:id/web', wrap(async req => app.owner.webAddress(requirePerm(req, 'saas.view'), req.params.id as string)));
  api.post('/schools/:id/web', wrap(async req => {
    const u = requirePerm(req, 'saas.edit');
    const b = z.object({
      slug: z.string().trim().toLowerCase().min(2).max(40).optional(),
      // null removes the domain; the string form is validated properly in TenantService
      customDomain: z.string().trim().toLowerCase().max(160).nullable().optional(),
    }).parse(req.body ?? {});
    return app.owner.setWebAddress(u, req.params.id as string, b);
  }));

  /**
   * The school's own sign-in door. `send` posts the address to the school's registered email again
   * — the vendor reads it out on the telephone often enough that a button is cheaper — and `rotate`
   * replaces it, which kills the old address at once and emails the new one in the same call.
   * Literal paths, and registered before nothing that shares their shape, so neither is read as an id.
   */
  api.post('/schools/:id/door/send', wrap(async req => app.owner.sendSignInLink(requirePerm(req, 'saas.edit'), req.params.id as string, { reason: 'resent' })));
  api.post('/schools/:id/door/rotate', wrap(async req => app.owner.rotateDoor(requirePerm(req, 'saas.edit'), req.params.id as string)));

  api.post('/schools/:id/admin', wrap(async req => {
    const u = requirePerm(req, 'saas.create');
    const b = z.object({ name: z.string().trim().min(2).max(160), phone: bdPhoneSchema, email: emailSchema.or(z.literal('')).optional().nullable(), password: passwordSchema.or(z.literal('')).optional().nullable() }).parse(req.body);
    return app.owner.addAdmin(u, req.params.id as string, b);
  }));

  // ---------- money in ----------
  api.get('/billing', wrap(async req => {
    const u = requirePerm(req, 'saas.view');
    const f = z.object({ status: z.enum(['draft', 'issued', 'paid', 'overdue', 'void']).optional(), schoolId: z.string().max(40).optional() })
      .parse({ status: q(req, 'status'), schoolId: q(req, 'schoolId') });
    return app.owner.billing(u, f);
  }));
  api.post('/invoices/:id/paid', wrap(async req => {
    const u = requirePerm(req, 'saas.edit');
    const b = z.object({ paidAt: z.string().max(30).optional(), reference: z.string().trim().max(120).optional().nullable() }).parse(req.body ?? {});
    return app.owner.markInvoicePaid(u, req.params.id as string, b);
  }));

  // ---------- support ----------
  api.get('/tickets', wrap(async req => {
    const u = requirePerm(req, 'saas.view');
    const f = z.object({ status: z.enum(['open', 'answered', 'closed']).optional(), schoolId: z.string().max(40).optional() })
      .parse({ status: q(req, 'status'), schoolId: q(req, 'schoolId') });
    return app.owner.tickets(u, f);
  }));
  api.post('/tickets/:id/close', wrap(async req => {
    const u = requirePerm(req, 'saas.edit');
    const b = z.object({ resolution: z.string().trim().max(1000).optional().nullable() }).parse(req.body ?? {});
    return app.owner.closeTicket(u, req.params.id as string, b.resolution ?? null);
  }));

  // ---------- the machinery, across every client ----------
  api.get('/health', wrap(async req => app.owner.health(requirePerm(req, 'saas.view'))));
}

/**
 * What being suspended actually costs a school: new entries, and nothing else.
 *
 * The rule is `SaasService`'s, written for an unpaid bill and applied here to the vendor's own
 * switch — a school in arrears or under suspension stops *adding* to its records and never stops
 * reading them. So this refuses writes and lets every GET through, and `OwnerService.newWorkAllowed`
 * is the one place that decides; this middleware only asks it.
 *
 * Signing in and out, reading notifications and the owner's own API are exempt: the point is to stop
 * a suspended school entering new work, not to lock the people in it out of the building.
 */
export function suspendedSchoolGuard(app: App) {
  const exempt = /^\/(owner|auth|install|notifications|push)(\/|$)/;
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const user = req.ps?.user;
    if (!user || exempt.test(req.path)) return next();
    app.owner.newWorkAllowed(user.school_id)
      .then(r => next(r.allowed ? undefined : new HttpError(403, r.reason, 'school_suspended')))
      .catch(next);
  };
}
