import type { Request, Response, Router } from 'express';
import { HttpError, type App } from '@pathshala/core';
import { z } from '@pathshala/schemas';

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (e?: unknown) => void) => void;
type User = { id: string; school_id: string; user_type: string };

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const money = z.coerce.number().min(0).max(100_000_000);
const lines = z.array(z.object({ productId: z.string(), quantity: z.coerce.number().min(0.01).max(999).optional() })).min(1).max(50);

/** Phase 10 API: wallet and shop, scholarships and fundraising, alumni, competitions and event crews. */
export function mountPhase10(api: Router, app: App, wrap: Wrap, requirePerm: (req: Request, perm: string) => User, requireUser: (req: Request) => User) {
  const q = (req: Request, k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : undefined);
  /** A guardian may only ever act on a child of theirs. */
  const childOf = async (u: User, studentId: string) => {
    const guardian = await app.db.findOne<{ id: string }>('guardians', { school_id: u.school_id, user_id: u.id });
    const linked = guardian && await app.db.findOne('student_guardians', { student_id: studentId, guardian_id: guardian.id });
    const self = await app.db.findOne('students', { id: studentId, school_id: u.school_id, user_id: u.id });
    if (!linked && !self) throw new HttpError(403, 'not your child');
    return studentId;
  };

  // ---------- wallet ----------
  api.get('/commerce/wallets/:studentId', wrap(async req => { const u = requirePerm(req, 'wallet.view'); return app.commerce.walletStatement(u.school_id, req.params.studentId as string); }));
  api.post('/commerce/wallets/:studentId/topup', wrap(async req => {
    const u = requirePerm(req, 'wallet.create');
    const b = z.object({ amount: money, method: z.enum(['cash', 'bkash', 'nagad', 'bank_transfer', 'card']).optional(), paymentId: z.string().optional().nullable(), description: z.string().max(200).optional().nullable() }).parse(req.body);
    const r = await app.commerce.topUp(u.school_id, req.params.studentId as string, b.amount, { ...b, createdBy: u.id });
    await app.audit.log({ action: 'create', entityType: 'commerce.wallet', entityId: r.walletId, after: { amount: b.amount } });
    return r;
  }));
  api.patch('/commerce/wallets/:studentId', wrap(async req => { const u = requirePerm(req, 'wallet.edit'); const b = z.object({ dailyLimit: money.optional().nullable(), status: z.enum(['active', 'frozen', 'closed']).optional() }).parse(req.body); return app.commerce.setWallet(u.school_id, req.params.studentId as string, b); }));
  api.get('/commerce/wallets/:studentId/card', wrap(async req => { const u = requirePerm(req, 'wallet.view'); const w = await app.commerce.wallet(u.school_id, req.params.studentId as string); const serial = Number(q(req, 'serial') ?? 1); return { walletId: String(w.id), serial, code: app.commerce.cardCode(u.school_id, String(w.id), serial) }; }));

  // ---------- outlets, products, the till ----------
  api.get('/commerce/outlets', wrap(async req => { const u = requirePerm(req, 'wallet.view'); return { outlets: await app.commerce.outlets(u.school_id), products: await app.commerce.products(u.school_id, q(req, 'outletId')) }; }));
  api.post('/commerce/outlets', wrap(async req => { const u = requirePerm(req, 'wallet.create'); const b = z.object({ name: z.string().min(1).max(80), kind: z.enum(['canteen', 'bookshop', 'uniform', 'stationery', 'other']).optional(), campusId: z.string().optional().nullable() }).parse(req.body); return { id: await app.commerce.createOutlet(u.school_id, b) }; }));
  api.post('/commerce/products', wrap(async req => { const u = requirePerm(req, 'wallet.create'); const b = z.object({ outletId: z.string(), name: z.string().min(1).max(160), price: money, sku: z.string().max(40).optional().nullable(), category: z.string().max(60).optional().nullable(), inventoryItemId: z.string().optional().nullable() }).parse(req.body); return { id: await app.commerce.addProduct(u.school_id, b) }; }));
  api.patch('/commerce/products/:id', wrap(async req => { const u = requirePerm(req, 'wallet.edit'); const b = z.object({ price: money.optional(), isActive: z.coerce.boolean().optional(), name: z.string().min(1).max(160).optional() }).parse(req.body); return app.commerce.setProduct(u.school_id, req.params.id as string, b); }));
  api.post('/commerce/sales', wrap(async req => {
    const u = requirePerm(req, 'wallet.create');
    const b = z.object({ outletId: z.string(), lines, studentId: z.string().optional().nullable(), cardCode: z.string().max(40).optional().nullable(), paidBy: z.enum(['wallet', 'cash', 'bkash', 'card', 'invoice']).optional() }).parse(req.body);
    return app.commerce.sell(u.school_id, { ...b, cashierId: u.id });
  }));
  api.post('/commerce/sales/:id/refund', wrap(async req => { const u = requirePerm(req, 'wallet.approve'); const b = z.object({ reason: z.string().min(3).max(200) }).parse(req.body); return app.commerce.refundSale(u.school_id, req.params.id as string, b.reason); }));
  api.get('/commerce/sales', wrap(async req => { const u = requirePerm(req, 'wallet.view'); return app.commerce.sales(u.school_id, { outletId: q(req, 'outletId'), studentId: q(req, 'studentId'), from: q(req, 'from'), to: q(req, 'to') }); }));
  api.get('/commerce/daybook', wrap(async req => { const u = requirePerm(req, 'wallet.view'); const outletId = q(req, 'outletId'); if (!outletId) throw new HttpError(400, 'outletId required'); return app.commerce.dayBook(u.school_id, outletId, q(req, 'date')); }));

  // ---------- shop orders ----------
  api.get('/commerce/orders', wrap(async req => { const u = requirePerm(req, 'wallet.view'); return app.commerce.orders(u.school_id, { studentId: q(req, 'studentId'), status: q(req, 'status') }); }));
  api.post('/commerce/orders/:id/status', wrap(async req => { const u = requirePerm(req, 'wallet.edit'); const b = z.object({ status: z.enum(['paid', 'ready', 'delivered', 'cancelled']) }).parse(req.body); return app.commerce.setOrderStatus(u.school_id, req.params.id as string, b.status); }));

  // what a guardian sees and does from the app
  api.get('/portal/wallet/:studentId', wrap(async req => { const u = requireUser(req); await childOf(u, req.params.studentId as string); return app.commerce.walletStatement(u.school_id, req.params.studentId as string, 30); }));
  api.get('/portal/shop', wrap(async req => { const u = requireUser(req); return { outlets: await app.commerce.outlets(u.school_id), products: await app.commerce.products(u.school_id, q(req, 'outletId')) }; }));
  api.post('/portal/shop/orders', wrap(async req => {
    const u = requireUser(req);
    const b = z.object({ studentId: z.string(), outletId: z.string(), lines, notes: z.string().max(255).optional().nullable() }).parse(req.body);
    await childOf(u, b.studentId);
    return app.commerce.placeOrder(u.school_id, b);
  }));

  // ---------- scholarships and funds ----------
  api.get('/giving/funds', wrap(async req => { const u = requirePerm(req, 'scholarships.view'); return app.giving.funds(u.school_id); }));
  api.get('/giving/funds/:id', wrap(async req => { const u = requirePerm(req, 'scholarships.view'); return app.giving.fund(u.school_id, req.params.id as string); }));
  api.post('/giving/funds', wrap(async req => { const u = requirePerm(req, 'scholarships.create'); const b = z.object({ name: z.string().min(2).max(160), kind: z.enum(['internal', 'government_stipend', 'donor', 'zakat', 'alumni']).optional(), opening: money.optional(), rules: z.record(z.string(), z.unknown()).optional().nullable() }).parse(req.body); return { id: await app.giving.createFund(u.school_id, b) }; }));
  api.get('/giving/awards', wrap(async req => { const u = requirePerm(req, 'scholarships.view'); return app.giving.awards(u.school_id, { fundId: q(req, 'fundId'), studentId: q(req, 'studentId'), status: q(req, 'status') }); }));
  api.post('/giving/awards', wrap(async req => {
    const u = requirePerm(req, 'scholarships.create');
    const b = z.object({ fundId: z.string(), studentId: z.string(), amount: money, academicYearId: z.string().optional(), frequency: z.enum(['monthly', 'yearly', 'one_time']).optional(), needBased: z.coerce.boolean().optional(), sponsorDonorId: z.string().optional().nullable() }).parse(req.body);
    return app.giving.award(u.school_id, b);
  }));
  api.post('/giving/awards/:id/decide', wrap(async req => { const u = requirePerm(req, 'scholarships.approve'); const b = z.object({ decision: z.enum(['approved', 'rejected']) }).parse(req.body); const r = await app.giving.decideAward(u.school_id, req.params.id as string, b.decision, u.id); await app.audit.log({ action: 'approve', entityType: 'giving.award', entityId: req.params.id as string, after: r }); return r; }));
  api.post('/giving/awards/:id/end', wrap(async req => { const u = requirePerm(req, 'scholarships.approve'); const b = z.object({ reason: z.string().min(3).max(200), monthsUsed: z.coerce.number().int().min(0).max(12).optional() }).parse(req.body); return app.giving.endAward(u.school_id, req.params.id as string, b.reason, b.monthsUsed); }));

  // ---------- donors, campaigns, donations ----------
  api.get('/giving/donors', wrap(async req => { const u = requirePerm(req, 'scholarships.view'); return app.giving.donors(u.school_id); }));
  api.post('/giving/donors', wrap(async req => { const u = requirePerm(req, 'scholarships.create'); const b = z.object({ name: z.string().min(2).max(160), kind: z.enum(['individual', 'organisation', 'alumni']).optional(), phone: z.string().max(30).optional().nullable(), email: z.string().max(160).optional().nullable(), alumniId: z.string().optional().nullable(), isAnonymous: z.coerce.boolean().optional() }).parse(req.body); return { id: await app.giving.donor(u.school_id, b) }; }));
  api.get('/giving/campaigns', wrap(async req => { const u = requirePerm(req, 'scholarships.view'); return app.giving.campaigns(u.school_id); }));
  api.post('/giving/campaigns', wrap(async req => { const u = requirePerm(req, 'scholarships.create'); const b = z.object({ title: z.string().min(2).max(200), goalAmount: money, startsAt: dateSchema.optional().nullable(), endsAt: dateSchema.optional().nullable(), description: z.string().max(50_000).optional().nullable() }).parse(req.body); return app.giving.createCampaign(u.school_id, b); }));
  api.post('/giving/campaigns/:id/status', wrap(async req => { const u = requirePerm(req, 'scholarships.approve'); const b = z.object({ status: z.enum(['draft', 'live', 'closed']) }).parse(req.body); return app.giving.setCampaignStatus(u.school_id, req.params.id as string, b.status); }));
  api.get('/giving/donations', wrap(async req => { const u = requirePerm(req, 'scholarships.view'); return app.giving.donations(u.school_id, { campaignId: q(req, 'campaignId'), donorId: q(req, 'donorId'), kind: q(req, 'kind') as 'pledge' | 'received' | undefined }); }));
  api.post('/giving/donations', wrap(async req => {
    const u = requirePerm(req, 'scholarships.create');
    const b = z.object({ donorId: z.string(), amount: money, campaignId: z.string().optional().nullable(), fundId: z.string().optional().nullable(), kind: z.enum(['pledge', 'received']).optional(), method: z.string().max(20).optional().nullable(), reference: z.string().max(120).optional().nullable(), message: z.string().max(2000).optional().nullable(), receivedAt: z.string().optional() }).parse(req.body);
    const r = await app.giving.donate(u.school_id, b);
    await app.audit.log({ action: 'create', entityType: 'giving.donation', entityId: r.id, after: { amount: b.amount, kind: r.kind } });
    return r;
  }));
  api.post('/giving/donations/:id/receive', wrap(async req => { const u = requirePerm(req, 'scholarships.create'); const b = z.object({ method: z.string().max(20).optional().nullable(), reference: z.string().max(120).optional().nullable(), receivedAt: z.string().optional() }).parse(req.body ?? {}); return app.giving.receivePledge(u.school_id, req.params.id as string, b); }));
  api.post('/giving/donations/:id/receipt', wrap(async req => { const u = requirePerm(req, 'scholarships.view'); return app.giving.issueReceipt(u.school_id, req.params.id as string); }));

  // ---------- alumni ----------
  api.get('/alumni', wrap(async req => { const u = requirePerm(req, 'alumni.view'); return { directory: await app.alumni.directory(u.school_id, { year: q(req, 'year') ? Number(q(req, 'year')) : undefined, q: q(req, 'q'), mentorsOnly: q(req, 'mentors') === '1' }), batches: await app.alumni.batches(u.school_id) }; }));
  api.post('/alumni/graduate', wrap(async req => { const u = requirePerm(req, 'alumni.create'); const b = z.object({ classId: z.string(), academicYearId: z.string().optional(), graduationYear: z.coerce.number().int().min(1900).max(2200).optional(), leftOn: dateSchema.optional() }).parse(req.body); const r = await app.alumni.graduateClass(u.school_id, b); await app.audit.log({ action: 'create', entityType: 'alumni.batch', entityId: r.batchId, after: r }); return r; }));
  api.patch('/alumni/:id', wrap(async req => { const u = requirePerm(req, 'alumni.edit'); const b = z.object({ currentOrganisation: z.string().max(160).optional().nullable(), currentPosition: z.string().max(120).optional().nullable(), city: z.string().max(80).optional().nullable(), country: z.string().max(60).optional().nullable(), linkedinUrl: z.string().max(255).optional().nullable(), bio: z.string().max(4000).optional().nullable(), isPublic: z.coerce.boolean().optional(), isMentor: z.coerce.boolean().optional(), phone: z.string().max(20).optional().nullable(), email: z.string().max(160).optional().nullable() }).parse(req.body); return app.alumni.updateProfile(u.school_id, req.params.id as string, b); }));
  api.post('/alumni/batches/:year/rep', wrap(async req => { const u = requirePerm(req, 'alumni.edit'); const b = z.object({ alumniId: z.string() }).parse(req.body); return app.alumni.setBatchRep(u.school_id, Number(req.params.year), b.alumniId); }));
  api.get('/alumni/mentorships', wrap(async req => { const u = requirePerm(req, 'alumni.view'); return app.alumni.pairs(u.school_id, { mentorId: q(req, 'mentorId'), studentId: q(req, 'studentId'), activeOnly: q(req, 'active') === '1' }); }));
  api.post('/alumni/mentorships', wrap(async req => { const u = requirePerm(req, 'alumni.create'); const b = z.object({ mentorId: z.string(), studentId: z.string(), topic: z.string().max(160).optional().nullable(), startedOn: dateSchema.optional() }).parse(req.body); return app.alumni.pair(u.school_id, b); }));
  api.post('/alumni/mentorships/:id/end', wrap(async req => { const u = requirePerm(req, 'alumni.edit'); return app.alumni.endPair(u.school_id, req.params.id as string, q(req, 'on')); }));
  api.get('/alumni/jobs', wrap(async req => { const u = requirePerm(req, 'alumni.view'); return app.alumni.jobBoard(u.school_id); }));
  api.post('/alumni/jobs', wrap(async req => { const u = requirePerm(req, 'alumni.create'); const b = z.object({ title: z.string().min(2).max(160), company: z.string().max(160).optional().nullable(), location: z.string().max(120).optional().nullable(), description: z.string().max(20_000).optional().nullable(), applyUrl: z.string().max(500).optional().nullable(), expiresAt: dateSchema.optional().nullable(), postedByAlumniId: z.string().optional().nullable() }).parse(req.body); return { id: await app.alumni.postJob(u.school_id, b) }; }));
  api.post('/alumni/jobs/:id/close', wrap(async req => { const u = requirePerm(req, 'alumni.edit'); return app.alumni.closeJob(u.school_id, req.params.id as string); }));
  // a former student's own entry, which only they may change
  api.get('/portal/alumni/me', wrap(async req => { const u = requireUser(req); return app.alumni.me(u.school_id, u.id); }));
  api.patch('/portal/alumni/me', wrap(async req => {
    const u = requireUser(req);
    const mine = await app.alumni.me(u.school_id, u.id);
    const b = z.object({ currentOrganisation: z.string().max(160).optional().nullable(), currentPosition: z.string().max(120).optional().nullable(), city: z.string().max(80).optional().nullable(), country: z.string().max(60).optional().nullable(), linkedinUrl: z.string().max(255).optional().nullable(), bio: z.string().max(4000).optional().nullable(), isPublic: z.coerce.boolean().optional(), isMentor: z.coerce.boolean().optional(), phone: z.string().max(20).optional().nullable(), email: z.string().max(160).optional().nullable() }).parse(req.body);
    return app.alumni.updateProfile(u.school_id, String(mine.profile.id), b, u.id);
  }));

  // ---------- competitions and event crews ----------
  api.get('/engagement/competitions', wrap(async req => { const u = requirePerm(req, 'cocurricular.view'); const id = q(req, 'id'); return id ? { competition: await app.db.findOne('competitions', { id, school_id: u.school_id }), results: await app.engagement.competitionResults(u.school_id, id) } : { competitions: await app.engagement.competitions(u.school_id) }; }));
  api.post('/engagement/competitions', wrap(async req => { const u = requirePerm(req, 'cocurricular.create'); const b = z.object({ name: z.string().min(2).max(200), kind: z.enum(['sports', 'academic', 'cultural', 'science', 'debate', 'olympiad', 'other']).optional(), level: z.enum(['intra', 'inter_school', 'district', 'national', 'international']).optional(), heldOn: dateSchema.optional().nullable(), venue: z.string().max(160).optional().nullable(), organiser: z.string().max(160).optional().nullable(), eventId: z.string().optional().nullable() }).parse(req.body); return { id: await app.engagement.createCompetition(u.school_id, b) }; }));
  api.post('/engagement/competitions/:id/results', wrap(async req => {
    const u = requirePerm(req, 'cocurricular.edit');
    const b = z.object({ results: z.array(z.object({ studentId: z.string().optional().nullable(), clubId: z.string().optional().nullable(), houseId: z.string().optional().nullable(), position: z.coerce.number().int().min(1).max(999).optional().nullable(), award: z.string().max(120).optional().nullable(), points: z.coerce.number().int().min(-1000).max(1000).optional() })).min(1).max(300), certificates: z.coerce.boolean().optional() }).parse(req.body);
    return app.engagement.recordResults(u.school_id, req.params.id as string, b.results, { certificates: b.certificates });
  }));
  api.get('/engagement/events/:id/programme', wrap(async req => { const u = requirePerm(req, 'events.view'); return { schedule: await app.engagement.schedule(u.school_id, req.params.id as string), volunteers: await app.engagement.volunteers(u.school_id, req.params.id as string) }; }));
  api.put('/engagement/events/:id/programme', wrap(async req => { const u = requirePerm(req, 'events.edit'); const b = z.object({ items: z.array(z.object({ startsAt: z.string(), title: z.string().min(1).max(200), presenter: z.string().max(160).optional().nullable() })).max(100) }).parse(req.body); return app.engagement.setSchedule(u.school_id, req.params.id as string, b.items); }));
  api.post('/engagement/events/:id/volunteers', wrap(async req => { const u = requireUser(req); const b = z.object({ role: z.string().max(80).optional().nullable(), userId: z.string().optional() }).parse(req.body ?? {}); return app.engagement.volunteer(u.school_id, req.params.id as string, b.userId ?? u.id, b.role); }));
  api.post('/engagement/volunteers/:id/decide', wrap(async req => { const u = requirePerm(req, 'events.approve'); const b = z.object({ status: z.enum(['confirmed', 'declined']) }).parse(req.body); return app.engagement.decideVolunteer(u.school_id, req.params.id as string, b.status); }));
}

/** Public: the appeal page anybody can open, and the alumni who chose to be listed. */
export function mountPublicGiving(pub: Router, app: App, wrap: Wrap) {
  const schoolOf = async (req: Request) => { const s = await app.cms.resolveSchool(req.headers.host ?? null); if (!s) throw new HttpError(404, 'no school configured yet'); return s; };
  pub.get('/site/appeals', wrap(async req => { const s = await schoolOf(req); const rows = await app.giving.campaigns(String(s.id), true); return rows.map(c => ({ title: String(c.title), slug: String(c.slug), goal: Number(c.goal_amount), raised: Number(c.raised_amount) })); }));
  pub.get('/site/appeals/:slug', wrap(async req => { const s = await schoolOf(req); return app.giving.publicCampaign(String(s.id), req.params.slug as string); }));
  pub.get('/site/alumni', wrap(async req => { const s = await schoolOf(req); return app.alumni.publicDirectory(String(s.id), { year: req.query.year ? Number(req.query.year) : undefined, q: typeof req.query.q === 'string' ? req.query.q : undefined }); }));
}
