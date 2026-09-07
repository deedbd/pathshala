import type { Request, Response, Router } from 'express';
import { HttpError, type App } from '@pathshala/core';
import { z } from '@pathshala/schemas';

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (e?: unknown) => void) => void;
type User = { id: string; school_id: string; user_type: string };

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const money = z.coerce.number().min(0).max(100_000_000);

/** Phase 13 API: subscriptions and partners, the marketplace, the public API, and the assistant. */
export function mountPhase13(api: Router, app: App, wrap: Wrap, requirePerm: (req: Request, perm: string) => User, requireUser: (req: Request) => User) {
  const q = (req: Request, k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : undefined);

  // ---------- SaaS: only ever with a saas.* permission, which no school role carries ----------
  api.get('/saas/plans', wrap(async req => { requirePerm(req, 'saas.view'); await app.saas.ensurePlans(); return app.saas.plans(); }));
  api.post('/saas/plans', wrap(async req => { requirePerm(req, 'saas.create'); const b = z.object({ name: z.string().min(1).max(80), priceMonthly: money.optional(), priceYearly: money.optional(), studentLimit: z.coerce.number().int().min(1).max(1_000_000).optional().nullable(), smsIncluded: z.coerce.number().int().min(0).optional(), storageGb: z.coerce.number().int().min(1).optional(), modules: z.array(z.string().max(40)).optional().nullable(), isPublic: z.coerce.boolean().optional(), sortOrder: z.coerce.number().int().optional() }).parse(req.body); return { id: await app.saas.savePlan(b) }; }));
  api.get('/saas/subscriptions', wrap(async req => { requirePerm(req, 'saas.view'); return app.saas.subscriptions({ status: q(req, 'status') }); }));
  api.post('/saas/subscriptions', wrap(async req => { const u = requirePerm(req, 'saas.create'); const b = z.object({ schoolId: z.string().optional(), planId: z.string(), billingCycle: z.enum(['monthly', 'yearly']).optional(), startsAt: dateSchema.optional(), trialDays: z.coerce.number().int().min(0).max(365).optional(), discountPct: z.coerce.number().min(0).max(100).optional(), referralCode: z.string().max(30).optional().nullable() }).parse(req.body); return app.saas.subscribe(b.schoolId ?? u.school_id, b); }));
  api.post('/saas/subscriptions/cancel', wrap(async req => { const u = requirePerm(req, 'saas.approve'); const b = z.object({ schoolId: z.string().optional(), reason: z.string().max(200).optional() }).parse(req.body ?? {}); return app.saas.cancel(b.schoolId ?? u.school_id, b.reason); }));
  api.get('/saas/invoices', wrap(async req => { requirePerm(req, 'saas.view'); return app.saas.invoices({ schoolId: q(req, 'schoolId'), status: q(req, 'status') }); }));
  api.post('/saas/invoices', wrap(async req => { const u = requirePerm(req, 'saas.create'); const b = z.object({ schoolId: z.string().optional(), periodStart: dateSchema.optional(), dueDays: z.coerce.number().int().min(1).max(90).optional() }).parse(req.body ?? {}); return app.saas.invoice(b.schoolId ?? u.school_id, b); }));
  api.post('/saas/invoices/:id/paid', wrap(async req => { requirePerm(req, 'saas.approve'); const b = z.object({ paidAt: z.string().optional(), reference: z.string().max(120).optional().nullable() }).parse(req.body ?? {}); return app.saas.markPaid(req.params.id as string, b); }));
  api.get('/saas/partners', wrap(async req => { requirePerm(req, 'saas.view'); return { partners: await app.saas.partners(), payouts: await app.saas.payouts(q(req, 'partnerId')) }; }));
  api.post('/saas/partners', wrap(async req => { requirePerm(req, 'saas.create'); const b = z.object({ name: z.string().min(2).max(160), commissionPct: z.coerce.number().min(0).max(50).optional(), referralCode: z.string().max(30).optional(), contact: z.record(z.string(), z.unknown()).optional().nullable() }).parse(req.body); return { id: await app.saas.createPartner(b) }; }));
  api.post('/saas/payouts/:id/paid', wrap(async req => { requirePerm(req, 'saas.approve'); return app.saas.payPayout(req.params.id as string); }));
  api.get('/saas/tickets', wrap(async req => { requirePerm(req, 'saas.view'); return app.saas.tickets({ schoolId: q(req, 'schoolId'), status: q(req, 'status') }); }));
  api.post('/saas/tickets/:id/close', wrap(async req => { requirePerm(req, 'saas.edit'); const b = z.object({ resolution: z.string().max(2000).optional() }).parse(req.body ?? {}); return app.saas.closeTicket(req.params.id as string, b.resolution); }));

  // what a school itself may see and do about its own subscription: read it, meter it, ask for help
  api.get('/billing/me', wrap(async req => {
    const u = requirePerm(req, 'platform.view');
    const [subscription, usage, invoices] = await Promise.all([app.saas.subscription(u.school_id), app.saas.meter(u.school_id), app.saas.invoices({ schoolId: u.school_id })]);
    return { subscription, usage: usage.usage, invoices };
  }));
  api.post('/billing/support', wrap(async req => { const u = requirePerm(req, 'platform.view'); const b = z.object({ subject: z.string().min(3).max(200), body: z.string().min(3).max(8000), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional() }).parse(req.body); return { id: await app.saas.openTicket(u.school_id, { ...b, openedBy: u.id }) }; }));

  // ---------- marketplace ----------
  api.get('/marketplace/plugins', wrap(async req => { const u = requirePerm(req, 'marketplace.view'); return { available: await app.marketplace.plugins(), installed: await app.marketplace.installs(u.school_id) }; }));
  api.post('/marketplace/plugins', wrap(async req => { requirePerm(req, 'marketplace.create'); const b = z.object({ slug: z.string().min(2).max(80), name: z.string().min(2).max(160), vendor: z.string().max(160).optional().nullable(), description: z.string().max(4000).optional().nullable(), version: z.string().min(1).max(20), hooks: z.array(z.string().max(60)).max(30).optional(), settingsSchema: z.unknown().optional(), priceMonthly: money.optional() }).parse(req.body); return { id: await app.marketplace.publishPlugin(b) }; }));
  api.post('/marketplace/plugins/:id/install', wrap(async req => { const u = requirePerm(req, 'marketplace.create'); const b = z.object({ webhookUrl: z.string().max(500).optional().nullable(), settings: z.record(z.string(), z.unknown()).optional() }).parse(req.body ?? {}); const r = await app.marketplace.install(u.school_id, req.params.id as string, { ...b, installedBy: u.id }); await app.audit.log({ action: 'create', entityType: 'marketplace.install', entityId: r.id, after: { pluginId: req.params.id } }); return r; }));
  api.post('/marketplace/installs/:id/enabled', wrap(async req => { const u = requirePerm(req, 'marketplace.edit'); const b = z.object({ enabled: z.coerce.boolean() }).parse(req.body); return app.marketplace.setPluginEnabled(u.school_id, req.params.id as string, b.enabled); }));
  api.post('/marketplace/installs/:id/uninstall', wrap(async req => { const u = requirePerm(req, 'marketplace.delete'); return app.marketplace.uninstall(u.school_id, req.params.id as string); }));
  api.get('/marketplace/packs', wrap(async req => { requirePerm(req, 'marketplace.view'); return app.marketplace.packs(q(req, 'kind')); }));
  api.post('/marketplace/packs', wrap(async req => { requirePerm(req, 'marketplace.create'); const b = z.object({ slug: z.string().min(2).max(80), name: z.string().min(2).max(160), kind: z.enum(['documents', 'notifications', 'accounting', 'grading', 'curriculum', 'forms']), locale: z.string().max(10).optional().nullable(), content: z.unknown(), version: z.string().min(1).max(20) }).parse(req.body); return { id: await app.marketplace.publishPack(b as never) }; }));
  api.post('/marketplace/packs/:id/apply', wrap(async req => { const u = requirePerm(req, 'marketplace.create'); return app.marketplace.applyPack(u.school_id, req.params.id as string); }));

  // ---------- OAuth2 clients ----------
  api.get('/oauth/clients', wrap(async req => { const u = requirePerm(req, 'marketplace.view'); return app.marketplace.clients(u.school_id); }));
  api.post('/oauth/clients', wrap(async req => { const u = requirePerm(req, 'marketplace.create'); const b = z.object({ name: z.string().min(2).max(160), redirectUris: z.array(z.string().max(500)).max(10).optional(), scopes: z.array(z.string().max(40)).max(20).optional(), isConfidential: z.coerce.boolean().optional() }).parse(req.body); const r = await app.marketplace.createClient(u.school_id, b as never); await app.audit.log({ action: 'create', entityType: 'oauth.client', entityId: r.id, after: { name: b.name, scopes: r.scopes.join(' ') } }); return r; }));
  api.post('/oauth/clients/:id/revoke', wrap(async req => { const u = requirePerm(req, 'marketplace.delete'); return app.marketplace.revokeClient(u.school_id, req.params.id as string); }));

  // ---------- the assistant ----------
  api.post('/ai/ask', wrap(async req => {
    const u = requireUser(req);
    const b = z.object({ question: z.string().min(2).max(1000), conversationId: z.string().optional() }).parse(req.body);
    const access = await app.rbac.accessFor(u.id);
    return app.ai.ask(u.school_id, { userId: u.id, userType: u.user_type, roles: access.roles }, b.question, b.conversationId);
  }));
  api.get('/ai/history', wrap(async req => { const u = requireUser(req); return app.ai.history(u.school_id, u.id); }));
  api.get('/ai/skills', wrap(async req => { const u = requireUser(req); return { skills: app.ai.skills(), budget: await app.ai.budgetLeft(u.school_id), provider: app.adapters.ai.kind }; }));
  api.post('/ai/generate', wrap(async req => {
    const u = requirePerm(req, 'ai.create');
    const b = z.object({ kind: z.enum(['questions', 'remarks', 'lesson_plan', 'notice', 'summary', 'translation', 'report_narrative', 'other']), prompt: z.string().min(3).max(4000), context: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
    return app.ai.generate(u.school_id, { ...b, requestedBy: u.id });
  }));
  api.get('/ai/generations', wrap(async req => { const u = requirePerm(req, 'ai.view'); return app.ai.generations(u.school_id, { kind: q(req, 'kind'), status: q(req, 'status') }); }));
  api.post('/ai/generations/:id/apply', wrap(async req => { const u = requirePerm(req, 'ai.edit'); const b = z.object({ type: z.string().min(2).max(60), id: z.string() }).parse(req.body); return app.ai.applyGeneration(u.school_id, req.params.id as string, b); }));
  api.post('/ai/generations/:id/discard', wrap(async req => { const u = requirePerm(req, 'ai.edit'); return app.ai.discardGeneration(u.school_id, req.params.id as string); }));
}

/**
 * The public API third-party applications talk to. It shares nothing with the console's session
 * cookie: every request carries a bearer token, and every route names the scope it needs, so an
 * application can only ever do what the school ticked when it issued the token.
 */
export function mountPublicApi(v1: Router, app: App, wrap: Wrap) {
  const bearer = (req: Request) => {
    const header = String(req.headers.authorization ?? '');
    if (!header.toLowerCase().startsWith('bearer ')) throw new HttpError(401, 'a bearer token is required', 'invalid_token');
    return header.slice(7).trim();
  };
  const auth = async (req: Request, scope: string) => app.marketplace.verifyToken(bearer(req), scope as never);

  v1.post('/token', wrap(async req => {
    const b = z.object({ grant_type: z.string().optional(), client_id: z.string(), client_secret: z.string(), scope: z.string().optional() }).parse(req.body);
    if (b.grant_type && b.grant_type !== 'client_credentials') throw new HttpError(400, 'only client_credentials is supported', 'unsupported_grant_type');
    const r = await app.marketplace.issueToken({ clientId: b.client_id, clientSecret: b.client_secret, scopes: b.scope ? b.scope.split(/\s+/) : undefined });
    return { access_token: r.accessToken, token_type: r.tokenType, expires_in: r.expiresIn, scope: r.scope };
  }));
  v1.get('/me', wrap(async req => { const t = await auth(req, 'profile.read'); const school = await app.db.findOne<{ name: string; code: string }>('schools', { id: t.schoolId }); return { school: { id: t.schoolId, name: school?.name, code: school?.code }, scopes: t.scopes }; }));
  v1.get('/students', wrap(async req => {
    const t = await auth(req, 'students.read');
    const rows = await app.people.students(t.schoolId, { limit: Math.min(200, Number(req.query.limit ?? 50)), q: typeof req.query.q === 'string' ? req.query.q : undefined });
    return { students: rows.rows.map(s => ({ id: s.id, admissionNo: s.admission_no, name: `${s.first_name} ${s.last_name ?? ''}`.trim(), class: s.class_name ?? null, status: s.status })), total: rows.total };
  }));
  v1.get('/attendance', wrap(async req => {
    const t = await auth(req, 'attendance.read');
    const onDate = typeof req.query.date === 'string' ? req.query.date : new Date().toISOString().slice(0, 10);
    const rows = await app.db.query(`SELECT a.student_id, s.admission_no, a.status, a.check_in FROM student_attendance a JOIN students s ON s.id = a.student_id WHERE a.school_id = ? AND a.on_date = ? LIMIT 2000`, [t.schoolId, onDate]);
    return { date: onDate, marks: rows };
  }));
  v1.get('/fees/outstanding', wrap(async req => {
    const t = await auth(req, 'fees.read');
    const rows = await app.db.query(`SELECT s.id AS student_id, s.admission_no, COALESCE(SUM(i.balance), 0) AS due FROM students s JOIN invoices i ON i.student_id = s.id AND i.balance > 0 WHERE s.school_id = ? GROUP BY s.id, s.admission_no ORDER BY due DESC LIMIT 500`, [t.schoolId]);
    return { students: rows };
  }));
  v1.post('/notices', wrap(async req => {
    const t = await auth(req, 'notices.write');
    const b = z.object({ title: z.string().min(2).max(200), body: z.string().min(2).max(20_000), noticeType: z.string().max(20).optional() }).parse(req.body);
    return { id: await app.cms.publishNotice(t.schoolId, { title: b.title, body: b.body, noticeType: b.noticeType }) };
  }));
}
