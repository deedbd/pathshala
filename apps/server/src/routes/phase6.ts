import type { Request, Response, Router } from 'express';
import { HttpError, type App } from '@pathshala/core';
import { z } from '@pathshala/schemas';

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (e?: unknown) => void) => void;
type User = { id: string; school_id: string; user_type: string };

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const money = z.coerce.number().min(0).max(100_000_000);
export const campaignSchema = z.object({
  academicYearId: z.string().optional().nullable(), name: z.string().min(2).max(120), opensAt: z.string(), closesAt: z.string(), formFee: money.optional(),
  selectionMode: z.enum(['test', 'lottery', 'first_come', 'interview', 'mixed']).optional(), requiresTest: z.coerce.boolean().optional(), autoMeritList: z.coerce.boolean().optional(),
  autoOffer: z.coerce.boolean().optional(), offerValidityDays: z.coerce.number().int().min(1).max(90).optional(), siblingPriority: z.coerce.boolean().optional(), slug: z.string().max(70).optional(),
  classes: z.array(z.object({ classId: z.string(), seats: z.coerce.number().int().min(1).max(2000), minAgeYears: z.coerce.number().min(0).max(30).optional().nullable(), maxAgeYears: z.coerce.number().min(0).max(30).optional().nullable() })).optional(),
});
export const applicationSchema = z.object({
  classId: z.string(), shiftId: z.string().optional().nullable(), firstName: z.string().min(1).max(80), lastName: z.string().max(80).optional().nullable(),
  gender: z.enum(['male', 'female', 'other']), dateOfBirth: dateSchema, guardianName: z.string().min(2).max(160), guardianPhone: z.string().min(6).max(20),
  guardianEmail: z.string().email().max(160).optional().nullable(), guardianRelation: z.string().max(30).optional().nullable(),
  address: z.unknown().optional(), previousSchool: z.unknown().optional(), extraFields: z.record(z.string(), z.unknown()).optional().nullable(), enquiryId: z.string().optional().nullable(),
});

/** Phase 6 API: admission campaigns, enquiries, applications, tests, merit, offers, enrolment; documents and ID cards. */
export function mountPhase6(api: Router, app: App, wrap: Wrap, requirePerm: (req: Request, perm: string) => User, requireUser: (req: Request) => User) {
  const q = (req: Request, k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : undefined);

  // ---------- campaigns ----------
  api.get('/admissions/campaigns', wrap(async req => { const u = requirePerm(req, 'admissions.view'); return app.admissions.campaigns(u.school_id); }));
  api.post('/admissions/campaigns', wrap(async req => { const u = requirePerm(req, 'admissions.create'); const r = await app.admissions.createCampaign(u.school_id, campaignSchema.parse(req.body)); await app.audit.log({ action: 'create', entityType: 'admissions.campaign', entityId: r.id, after: r }); return r; }));
  api.get('/admissions/campaigns/:id', wrap(async req => { const u = requirePerm(req, 'admissions.view'); return app.admissions.campaign(u.school_id, req.params.id as string); }));
  api.patch('/admissions/campaigns/:id', wrap(async req => { const u = requirePerm(req, 'admissions.edit'); const b = z.object({ status: z.enum(['draft', 'open', 'closed', 'archived']) }).parse(req.body); return { updated: await app.admissions.setCampaignStatus(u.school_id, req.params.id as string, b.status) }; }));

  // ---------- enquiries ----------
  api.get('/admissions/enquiries', wrap(async req => { const u = requirePerm(req, 'admissions.view'); return app.admissions.enquiries(u.school_id, { status: q(req, 'status'), campaignId: q(req, 'campaignId') }); }));
  api.get('/admissions/enquiries/:id/followups', wrap(async req => { const u = requirePerm(req, 'admissions.view'); return app.admissions.followups(u.school_id, req.params.id as string); }));
  api.post('/admissions/enquiries/:id/followups', wrap(async req => { const u = requirePerm(req, 'admissions.edit'); const b = z.object({ note: z.string().min(1).max(4000), channel: z.enum(['call', 'visit', 'sms', 'email', 'whatsapp']).optional(), nextAt: z.string().optional().nullable(), status: z.enum(['new', 'contacted', 'visited', 'converted', 'lost']).optional(), lostReason: z.string().max(120).optional().nullable() }).parse(req.body); return { id: await app.admissions.addFollowup(u.school_id, req.params.id as string, { ...b, byUserId: u.id }) }; }));

  // ---------- applications ----------
  api.get('/admissions/applications', wrap(async req => { const u = requirePerm(req, 'admissions.view'); return app.admissions.applications(u.school_id, { campaignId: q(req, 'campaignId'), classId: q(req, 'classId'), status: q(req, 'status') }); }));
  api.get('/admissions/applications/:id', wrap(async req => { const u = requirePerm(req, 'admissions.view'); return app.admissions.application(u.school_id, req.params.id as string); }));
  api.post('/admissions/applications', wrap(async req => { const u = requirePerm(req, 'admissions.create'); const b = z.object({ campaignId: z.string() }).and(applicationSchema).parse(req.body); return app.admissions.apply(u.school_id, b.campaignId, b as never); }));
  api.post('/admissions/applications/:id/enrol', wrap(async req => { const u = requirePerm(req, 'admissions.approve'); const r = await app.admissions.enrol(u.school_id, req.params.id as string); await app.audit.log({ action: 'enrol', entityType: 'admissions.application', entityId: req.params.id as string, after: r }); return r; }));

  // ---------- tests ----------
  api.get('/admissions/tests', wrap(async req => { const u = requirePerm(req, 'admissions.view'); return app.admissions.tests(u.school_id, q(req, 'campaignId')); }));
  api.post('/admissions/tests', wrap(async req => { const u = requirePerm(req, 'admissions.create'); const b = z.object({ campaignId: z.string(), classId: z.string(), name: z.string().min(1).max(120), heldAt: z.string(), durationMin: z.coerce.number().int().min(10).max(600).optional(), venue: z.string().max(120).optional().nullable(), totalMarks: money.optional(), passMarks: money.optional().nullable(), components: z.record(z.string(), z.coerce.number()).optional().nullable() }).parse(req.body); return { id: await app.admissions.createTest(u.school_id, b) }; }));
  api.post('/admissions/tests/:id/results', wrap(async req => { const u = requirePerm(req, 'admissions.edit'); const b = z.object({ results: z.array(z.object({ applicationId: z.string(), totalMarks: money.optional().nullable(), componentMarks: z.record(z.string(), z.coerce.number()).optional().nullable(), isAbsent: z.coerce.boolean().optional(), remarks: z.string().max(255).optional().nullable() })).max(500) }).parse(req.body); return app.admissions.enterResults(u.school_id, req.params.id as string, b.results, u.id); }));

  // ---------- merit and offers ----------
  api.post('/admissions/campaigns/:id/merit', wrap(async req => {
    const u = requirePerm(req, 'admissions.approve');
    const classId = q(req, 'classId') ?? (req.body?.classId as string | undefined);
    if (classId) return app.admissions.computeMerit(u.school_id, req.params.id as string, classId);
    await app.adapters.queue.push({ name: 'admissions.merit', queue: 'batch', schoolId: u.school_id, payload: { campaignId: req.params.id as string }, triggeredBy: 'admissions.merit' });
    return { queued: true };
  }));
  api.get('/admissions/campaigns/:id/merit', wrap(async req => { const u = requirePerm(req, 'admissions.view'); return app.admissions.meritList(u.school_id, req.params.id as string, q(req, 'classId')); }));
  api.post('/admissions/campaigns/:id/offers', wrap(async req => { const u = requirePerm(req, 'admissions.approve'); return app.admissions.makeOffers(u.school_id, req.params.id as string, q(req, 'classId')); }));
  api.get('/admissions/campaigns/:id/offers', wrap(async req => { const u = requirePerm(req, 'admissions.view'); return app.admissions.offers(u.school_id, req.params.id as string); }));
  api.post('/admissions/offers/:id/decline', wrap(async req => { const u = requirePerm(req, 'admissions.edit'); const b = z.object({ reason: z.string().max(120).optional() }).parse(req.body ?? {}); return app.admissions.declineOffer(u.school_id, req.params.id as string, b.reason); }));

  // ---------- documents ----------
  api.get('/documents/templates', wrap(async req => { const u = requirePerm(req, 'documents.view'); return app.documents.templates(u.school_id); }));
  api.post('/documents/templates', wrap(async req => { const u = requirePerm(req, 'documents.create'); const b = z.object({ docType: z.string().max(40), name: z.string().min(1).max(120), body: z.string().min(1).max(50_000), variables: z.array(z.string().max(40)).optional(), pageSize: z.string().max(20).optional(), orientation: z.enum(['portrait', 'landscape']).optional(), isDefault: z.coerce.boolean().optional() }).parse(req.body); return { id: await app.documents.saveTemplate(u.school_id, b as never) }; }));
  api.get('/documents/requests', wrap(async req => { const u = requirePerm(req, 'documents.view'); return app.documents.requests(u.school_id, { status: q(req, 'status'), studentId: q(req, 'studentId') }); }));
  api.post('/documents/requests', wrap(async req => { const u = requirePerm(req, 'documents.create'); const b = z.object({ docType: z.string().max(40), personType: z.enum(['student', 'staff', 'alumni']), studentId: z.string().optional().nullable(), staffId: z.string().optional().nullable(), reason: z.string().max(255).optional().nullable() }).parse(req.body); return app.documents.request(u.school_id, { ...b, requestedBy: u.id }); }));
  api.post('/documents/requests/:id/issue', wrap(async req => { const u = requirePerm(req, 'documents.approve'); const b = z.object({ extra: z.record(z.string(), z.string().max(500)).optional() }).parse(req.body ?? {}); const r = await app.documents.fulfil(u.school_id, req.params.id as string, b.extra); await app.audit.log({ action: 'issue', entityType: 'documents.issued', entityId: r.id, after: { documentNo: r.documentNo } }); return r; }));
  api.get('/documents/issued', wrap(async req => { const u = requirePerm(req, 'documents.view'); return app.documents.issued(u.school_id, { studentId: q(req, 'studentId'), docType: q(req, 'docType') }); }));
  api.post('/documents/issued/:id/revoke', wrap(async req => { const u = requirePerm(req, 'documents.approve'); const b = z.object({ reason: z.string().min(2).max(160) }).parse(req.body); return { updated: await app.documents.revoke(u.school_id, req.params.id as string, b.reason) }; }));
  api.post('/documents/id-cards', wrap(async req => { const u = requirePerm(req, 'documents.create'); const b = z.object({ personType: z.enum(['student', 'staff']), validFrom: dateSchema, validTo: dateSchema, ids: z.array(z.string()).max(5000).optional() }).parse(req.body); return app.documents.issueIdCards(u.school_id, { ...b, createdBy: u.id }); }));
  api.get('/documents/print-jobs', wrap(async req => { const u = requirePerm(req, 'documents.view'); return app.documents.printJobs(u.school_id); }));

  // ---------- guardian portal: my child's documents ----------
  api.get('/portal/documents/:studentId', wrap(async req => {
    const u = requireUser(req);
    const guardian = await app.db.findOne<{ id: string }>('guardians', { school_id: u.school_id, user_id: u.id });
    if (!guardian || !(await app.db.findOne('student_guardians', { student_id: req.params.studentId as string, guardian_id: guardian.id }))) throw new HttpError(403, 'not your child');
    return { documents: await app.documents.issued(u.school_id, { studentId: req.params.studentId as string }) };
  }));
}

/** The website's admission form, the application tracker, and the public document check. */
export function mountPublicAdmissions(pub: Router, app: App, wrap: Wrap, verifyTurnstile: (token: string | undefined, ip?: string) => Promise<void>) {
  pub.get('/admission/:slug', wrap(async req => app.admissions.publicForm(req.params.slug as string)));
  pub.post('/admission/:slug/apply', wrap(async req => {
    const form = await app.admissions.publicForm(req.params.slug as string);
    const b = applicationSchema.parse(req.body);
    await verifyTurnstile((req.body as { turnstile?: string })?.turnstile, req.ip);
    return app.admissions.apply(form.campaign.schoolId, form.campaign.id, b as never);
  }));
  pub.post('/admission/:slug/track', wrap(async req => {
    const form = await app.admissions.publicForm(req.params.slug as string);
    const b = z.object({ applicationNo: z.string().max(30), phone: z.string().max(20) }).parse(req.body);
    return app.admissions.track(form.campaign.schoolId, b.applicationNo, b.phone);
  }));
  pub.get('/verify/:code', wrap(async req => app.documents.verify(req.params.code as string, { ip: req.ip, userAgent: req.headers['user-agent'] ?? null })));
}
