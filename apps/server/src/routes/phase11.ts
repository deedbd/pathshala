import type { Request, Response, Router } from 'express';
import { HttpError, type App } from '@pathshala/core';
import { z } from '@pathshala/schemas';

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (e?: unknown) => void) => void;
type User = { id: string; school_id: string; user_type: string };

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const money = z.coerce.number().min(0).max(100_000_000);

/** Phase 11 API: the building (bookings, work orders, cleaning, meters, drills), governance, compliance. */
export function mountPhase11(api: Router, app: App, wrap: Wrap, requirePerm: (req: Request, perm: string) => User, requireUser: (req: Request) => User) {
  const q = (req: Request, k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : undefined);

  // ---------- rooms and bookings ----------
  api.get('/facilities/bookings', wrap(async req => { const u = requirePerm(req, 'facilities.view'); return app.facilities.bookings(u.school_id, { from: q(req, 'from'), roomId: q(req, 'roomId'), status: q(req, 'status') }); }));
  api.post('/facilities/bookings', wrap(async req => {
    const u = requirePerm(req, 'facilities.create');
    const b = z.object({ roomId: z.string(), purpose: z.string().min(2).max(160), startsAt: z.string(), endsAt: z.string(), autoApprove: z.coerce.boolean().optional() }).parse(req.body);
    return app.facilities.book(u.school_id, { ...b, bookedBy: u.id });
  }));
  api.post('/facilities/bookings/:id/decide', wrap(async req => { const u = requirePerm(req, 'facilities.approve'); const b = z.object({ status: z.enum(['approved', 'rejected', 'cancelled']) }).parse(req.body); return app.facilities.decideBooking(u.school_id, req.params.id as string, b.status, u.id); }));

  // ---------- work orders ----------
  api.get('/facilities/work-orders', wrap(async req => { const u = requirePerm(req, 'facilities.view'); return app.facilities.workOrders(u.school_id, { status: q(req, 'status'), category: q(req, 'category'), overdueOnly: q(req, 'overdue') === '1' }); }));
  api.post('/facilities/work-orders', wrap(async req => {
    const u = requirePerm(req, 'facilities.create');
    const b = z.object({ title: z.string().min(2).max(160), description: z.string().max(4000).optional().nullable(), category: z.enum(['electrical', 'plumbing', 'civil', 'it', 'furniture', 'cleaning', 'other']).optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), roomId: z.string().optional().nullable(), assetId: z.string().optional().nullable(), assignedTo: z.string().optional().nullable() }).parse(req.body);
    return app.facilities.raiseWorkOrder(u.school_id, { ...b, reportedBy: u.id });
  }));
  api.post('/facilities/work-orders/:id/assign', wrap(async req => { const u = requirePerm(req, 'facilities.edit'); const b = z.object({ staffId: z.string() }).parse(req.body); return app.facilities.assignWorkOrder(u.school_id, req.params.id as string, b.staffId); }));
  api.post('/facilities/work-orders/:id/complete', wrap(async req => { const u = requirePerm(req, 'facilities.edit'); const b = z.object({ cost: money.optional().nullable(), note: z.string().max(500).optional().nullable() }).parse(req.body ?? {}); return app.facilities.completeWorkOrder(u.school_id, req.params.id as string, { ...b, completedBy: u.id }); }));

  // ---------- cleaning, meters, drills ----------
  api.get('/facilities/cleaning', wrap(async req => { const u = requirePerm(req, 'facilities.view'); return { schedules: await app.db.findMany('cleaning_schedules', { school_id: u.school_id }, { orderBy: 'area ASC' }), due: await app.facilities.cleaningDue(u.school_id) }; }));
  api.post('/facilities/cleaning', wrap(async req => { const u = requirePerm(req, 'facilities.create'); const b = z.object({ area: z.string().min(2).max(120), frequency: z.enum(['daily', 'weekly', 'monthly']), assignedTo: z.string().optional().nullable(), checklist: z.array(z.string().max(120)).max(30).optional().nullable() }).parse(req.body); return { id: await app.facilities.setCleaningSchedule(u.school_id, b) }; }));
  api.post('/facilities/cleaning/:id/done', wrap(async req => { const u = requirePerm(req, 'facilities.edit'); return app.facilities.markCleaned(u.school_id, req.params.id as string); }));
  api.get('/facilities/utilities', wrap(async req => { const u = requirePerm(req, 'facilities.view'); return app.facilities.utilityHistory(u.school_id, q(req, 'utility') ?? 'electricity'); }));
  api.post('/facilities/utilities', wrap(async req => { const u = requirePerm(req, 'facilities.create'); const b = z.object({ utility: z.enum(['electricity', 'water', 'gas', 'internet', 'generator_fuel']), reading: z.coerce.number().min(0), readAt: dateSchema.optional(), cost: money.optional().nullable(), allowReset: z.coerce.boolean().optional() }).parse(req.body); return app.facilities.recordReading(u.school_id, b); }));
  api.get('/facilities/drills', wrap(async req => { const u = requirePerm(req, 'facilities.view'); return app.facilities.drillStatus(u.school_id); }));
  api.post('/facilities/drills', wrap(async req => { const u = requirePerm(req, 'facilities.create'); const b = z.object({ kind: z.enum(['fire', 'earthquake', 'evacuation', 'first_aid', 'inspection']), heldOn: dateSchema.optional(), participants: z.coerce.number().int().min(0).max(100_000).optional().nullable(), findings: z.string().max(4000).optional().nullable() }).parse(req.body); return { id: await app.facilities.recordDrill(u.school_id, b) }; }));

  // ---------- governance ----------
  api.get('/governance/committees', wrap(async req => { const u = requirePerm(req, 'governance.view'); const id = q(req, 'id'); return id ? { members: await app.governance.members(u.school_id, id) } : { committees: await app.governance.committees(u.school_id) }; }));
  api.post('/governance/committees', wrap(async req => { const u = requirePerm(req, 'governance.create'); const b = z.object({ name: z.string().min(2).max(120), kind: z.enum(['managing', 'academic', 'pta', 'student_council', 'disciplinary', 'other']).optional() }).parse(req.body); return { id: await app.governance.createCommittee(u.school_id, b) }; }));
  api.post('/governance/committees/:id/members', wrap(async req => { const u = requirePerm(req, 'governance.create'); const b = z.object({ personName: z.string().min(2).max(160), role: z.string().min(2).max(80), userId: z.string().optional().nullable(), termStart: dateSchema.optional().nullable(), termEnd: dateSchema.optional().nullable() }).parse(req.body); return { id: await app.governance.addMember(u.school_id, { ...b, committeeId: req.params.id as string }) }; }));
  api.get('/governance/meetings', wrap(async req => { const u = requirePerm(req, 'governance.view'); return { meetings: await app.governance.meetings(u.school_id, q(req, 'committeeId')), resolutions: await app.governance.resolutions(u.school_id, { status: q(req, 'status') }) }; }));
  api.post('/governance/meetings', wrap(async req => {
    const u = requirePerm(req, 'governance.create');
    const b = z.object({ committeeId: z.string().optional().nullable(), title: z.string().min(2).max(200), heldAt: z.string(), venue: z.string().max(160).optional().nullable(), agenda: z.array(z.object({ no: z.coerce.number().int().optional(), title: z.string().min(1).max(200), presenter: z.string().max(160).optional().nullable() })).max(50).optional() }).parse(req.body);
    return app.governance.scheduleMeeting(u.school_id, b);
  }));
  api.post('/governance/meetings/:id/minutes', wrap(async req => {
    const u = requirePerm(req, 'governance.edit');
    const b = z.object({ minutes: z.string().min(2).max(200_000), attendees: z.array(z.string().max(160)).max(200).optional(), minutesFileId: z.string().optional().nullable(), resolutions: z.array(z.object({ text: z.string().min(2).max(4000), ownerId: z.string().optional().nullable(), dueDate: dateSchema.optional().nullable(), number: z.string().max(20).optional().nullable() })).max(50).optional() }).parse(req.body);
    return app.governance.recordMinutes(u.school_id, req.params.id as string, b);
  }));
  api.post('/governance/resolutions/:id/close', wrap(async req => { const u = requirePerm(req, 'governance.edit'); const b = z.object({ status: z.enum(['done', 'dropped']), note: z.string().max(500).optional().nullable() }).parse(req.body); return app.governance.closeResolution(u.school_id, req.params.id as string, b.status, b.note); }));

  api.get('/governance/policies', wrap(async req => { const u = requirePerm(req, 'governance.view'); const id = q(req, 'id'); return id ? app.governance.policyStatus(u.school_id, id) : { policies: await app.governance.policies(u.school_id) }; }));
  api.post('/governance/policies', wrap(async req => { const u = requirePerm(req, 'governance.create'); const b = z.object({ title: z.string().min(2).max(200), category: z.string().max(60).optional().nullable(), body: z.string().max(200_000).optional().nullable(), fileId: z.string().optional().nullable(), appliesTo: z.array(z.string().max(40)).max(20).optional().nullable(), effectiveFrom: dateSchema.optional().nullable() }).parse(req.body); return app.governance.publishPolicy(u.school_id, b); }));
  api.post('/governance/policies/:id/acknowledge', wrap(async req => { const u = requireUser(req); return app.governance.acknowledgePolicy(u.school_id, req.params.id as string, u.id); }));

  api.get('/governance/elections', wrap(async req => { const u = requirePerm(req, 'governance.view'); return app.governance.elections(u.school_id); }));
  api.post('/governance/elections', wrap(async req => { const u = requirePerm(req, 'governance.create'); const b = z.object({ title: z.string().min(2).max(200), opensAt: z.string(), closesAt: z.string(), candidates: z.array(z.object({ id: z.string().min(1).max(40), name: z.string().min(1).max(160), post: z.string().max(80).optional().nullable() })).min(2).max(50), scope: z.record(z.string(), z.unknown()).optional().nullable() }).parse(req.body); return { id: await app.governance.createElection(u.school_id, b) }; }));
  api.post('/governance/elections/:id/status', wrap(async req => { const u = requirePerm(req, 'governance.approve'); const b = z.object({ status: z.enum(['draft', 'open', 'closed']) }).parse(req.body); return app.governance.setElectionStatus(u.school_id, req.params.id as string, b.status); }));
  // a vote is cast by the voter themselves, and the ballot is secret even from the school
  api.post('/governance/elections/:id/vote', wrap(async req => { const u = requireUser(req); const b = z.object({ candidateId: z.string().max(40) }).parse(req.body); return app.governance.vote(u.school_id, req.params.id as string, u.id, b.candidateId); }));

  // ---------- compliance ----------
  api.get('/compliance/reports', wrap(async req => { const u = requirePerm(req, 'compliance.view'); return app.compliance.reports(u.school_id, q(req, 'type')); }));
  api.post('/compliance/reports/census', wrap(async req => { const u = requirePerm(req, 'compliance.create'); const b = z.object({ academicYearId: z.string().optional(), asOf: dateSchema.optional() }).parse(req.body ?? {}); return app.compliance.banbeisCensus(u.school_id, b); }));
  api.post('/compliance/reports/stipend', wrap(async req => { const u = requirePerm(req, 'compliance.create'); const b = z.object({ programId: z.string(), period: z.string().max(20).optional() }).parse(req.body); return app.compliance.stipendList(u.school_id, b.programId, b.period); }));
  api.post('/compliance/reports/mpo', wrap(async req => { const u = requirePerm(req, 'compliance.create'); const b = z.object({ runId: z.string() }).parse(req.body); return app.compliance.mpoSalarySheet(u.school_id, b.runId); }));
  api.post('/compliance/reports/:id/submitted', wrap(async req => { const u = requirePerm(req, 'compliance.approve'); const b = z.object({ submittedAt: z.string().optional() }).parse(req.body ?? {}); return app.compliance.markSubmitted(u.school_id, req.params.id as string, b); }));

  api.get('/compliance/stipends', wrap(async req => { const u = requirePerm(req, 'compliance.view'); return { programs: await app.compliance.programs(u.school_id), enrolments: await app.compliance.stipends(u.school_id, q(req, 'programId')) }; }));
  api.post('/compliance/stipends/programs', wrap(async req => { const u = requirePerm(req, 'compliance.create'); const b = z.object({ name: z.string().min(2).max(160), authority: z.string().max(120).optional().nullable(), amount: money.optional().nullable(), frequency: z.enum(['monthly', 'quarterly', 'half_yearly', 'yearly']).optional(), criteria: z.record(z.string(), z.unknown()).optional().nullable() }).parse(req.body); return { id: await app.compliance.createProgram(u.school_id, b) }; }));
  api.post('/compliance/stipends/enrol', wrap(async req => { const u = requirePerm(req, 'compliance.create'); const b = z.object({ programId: z.string(), studentId: z.string(), bankOrMfs: z.object({ kind: z.string().max(30).optional(), number: z.string().max(40).optional() }).optional().nullable(), enrolledOn: dateSchema.optional() }).parse(req.body); return { id: await app.compliance.enrolInStipend(u.school_id, b) }; }));
  api.post('/compliance/stipends/:id/disbursement', wrap(async req => { const u = requirePerm(req, 'compliance.edit'); const b = z.object({ period: z.string().max(20), amount: money, paidOn: dateSchema.optional(), reference: z.string().max(120).optional().nullable() }).parse(req.body); return app.compliance.recordDisbursement(u.school_id, req.params.id as string, b); }));

  api.get('/compliance/consents', wrap(async req => { const u = requirePerm(req, 'compliance.view'); return app.compliance.consents(u.school_id, { userId: q(req, 'userId'), studentId: q(req, 'studentId'), consentType: q(req, 'type') }); }));
  api.post('/compliance/consents', wrap(async req => { const u = requirePerm(req, 'compliance.create'); const b = z.object({ userId: z.string(), consentType: z.string().min(2).max(60), granted: z.coerce.boolean(), studentId: z.string().optional().nullable(), expiresAt: z.string().optional().nullable(), evidence: z.record(z.string(), z.unknown()).optional().nullable() }).parse(req.body); return app.compliance.recordConsent(u.school_id, b); }));
  // a guardian answering for themselves, from the app
  api.post('/portal/consents', wrap(async req => { const u = requireUser(req); const b = z.object({ consentType: z.string().min(2).max(60), granted: z.coerce.boolean(), studentId: z.string().optional().nullable() }).parse(req.body); return app.compliance.recordConsent(u.school_id, { ...b, userId: u.id, evidence: { via: 'portal', at: new Date().toISOString() } }); }));
  api.get('/portal/consents', wrap(async req => { const u = requireUser(req); return app.compliance.consents(u.school_id, { userId: u.id }); }));

  api.get('/compliance/data-requests', wrap(async req => { const u = requirePerm(req, 'compliance.view'); return app.compliance.dataRequests(u.school_id, q(req, 'status')); }));
  api.post('/portal/data-requests', wrap(async req => { const u = requireUser(req); const b = z.object({ kind: z.enum(['export', 'delete', 'correct']) }).parse(req.body); return app.compliance.requestData(u.school_id, u.id, b.kind); }));
  api.post('/compliance/data-requests/:id/export', wrap(async req => { const u = requirePerm(req, 'compliance.approve'); return app.compliance.fulfilExport(u.school_id, req.params.id as string, u.id); }));
  api.post('/compliance/data-requests/:id/decide', wrap(async req => { const u = requirePerm(req, 'compliance.approve'); const b = z.object({ status: z.enum(['processing', 'done', 'rejected']) }).parse(req.body); return app.compliance.decideRequest(u.school_id, req.params.id as string, b.status, u.id); }));

  api.get('/compliance/retention', wrap(async req => { const u = requirePerm(req, 'compliance.view'); return { policies: await app.compliance.retentionPolicies(u.school_id), review: await app.compliance.retentionReview(u.school_id) }; }));
  api.post('/compliance/retention', wrap(async req => { const u = requirePerm(req, 'compliance.approve'); const b = z.object({ entityType: z.string().min(2).max(60), keepYears: z.coerce.number().int().min(1).max(100), action: z.enum(['archive', 'anonymise', 'delete']).optional(), isActive: z.coerce.boolean().optional() }).parse(req.body); return { id: await app.compliance.setRetention(u.school_id, b) }; }));
}
