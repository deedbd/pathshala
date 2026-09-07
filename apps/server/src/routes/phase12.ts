import type { Request, Response, Router } from 'express';
import { HttpError, type App } from '@pathshala/core';
import { z } from '@pathshala/schemas';

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (e?: unknown) => void) => void;
type User = { id: string; school_id: string; user_type: string };

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const money = z.coerce.number().min(0).max(100_000_000);

/** Phase 12 API: dashboards and risk scores, broadcasts on every channel, competency, OMR, board forms. */
export function mountPhase12(api: Router, app: App, wrap: Wrap, requirePerm: (req: Request, perm: string) => User, requireUser: (req: Request) => User) {
  const q = (req: Request, k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : undefined);
  const staffOf = async (u: User) => {
    const s = await app.db.findOne<{ id: string }>('staff', { school_id: u.school_id, user_id: u.id });
    return s?.id ?? null;
  };

  // ---------- analytics ----------
  api.get('/analytics/dashboard', wrap(async req => { const u = requirePerm(req, 'analytics.view'); return app.analytics.dashboard(u.school_id, q(req, 'role') ?? 'admin', Number(q(req, 'days') ?? 30)); }));
  api.get('/analytics/metrics', wrap(async req => { const u = requirePerm(req, 'analytics.view'); const key = q(req, 'key'); return key ? { key, series: await app.analytics.series(u.school_id, key, Number(q(req, 'days') ?? 30)) } : { metrics: await app.analytics.metrics(u.school_id) }; }));
  api.post('/analytics/compute', wrap(async req => { const u = requirePerm(req, 'analytics.edit'); const b = z.object({ day: dateSchema.optional() }).parse(req.body ?? {}); const r = await app.analytics.computeDay(u.school_id, b.day); const a = await app.analytics.detectAnomalies(u.school_id, b.day); return { ...r, anomalies: a.anomalies }; }));
  api.get('/analytics/alerts', wrap(async req => { const u = requirePerm(req, 'analytics.view'); return app.analytics.alerts(u.school_id, q(req, 'status') ?? 'open'); }));
  api.post('/analytics/alerts/:id/status', wrap(async req => { const u = requirePerm(req, 'analytics.edit'); const b = z.object({ status: z.enum(['acknowledged', 'resolved']) }).parse(req.body); return app.analytics.resolveAlert(u.school_id, req.params.id as string, b.status); }));
  api.get('/analytics/risks', wrap(async req => { const u = requirePerm(req, 'analytics.view'); return app.analytics.risks(u.school_id, { riskType: q(req, 'type'), minScore: q(req, 'min') ? Number(q(req, 'min')) : undefined, studentId: q(req, 'studentId') }); }));
  api.post('/analytics/risks/compute', wrap(async req => { const u = requirePerm(req, 'analytics.edit'); return app.analytics.computeRisks(u.school_id); }));
  api.post('/analytics/risks/:id/acknowledge', wrap(async req => { const u = requirePerm(req, 'analytics.view'); return app.analytics.acknowledgeRisk(u.school_id, req.params.id as string, u.id); }));
  api.get('/analytics/benchmark', wrap(async req => { const u = requirePerm(req, 'analytics.view'); return app.analytics.benchmark(u.school_id, q(req, 'period')); }));

  // ---------- broadcast ----------
  api.post('/comms/broadcast', wrap(async req => {
    const u = requirePerm(req, 'communication.create');
    const b = z.object({
      title: z.string().min(2).max(200), body: z.string().min(2).max(4000),
      channels: z.array(z.enum(['sms', 'email', 'push', 'in_app', 'whatsapp', 'voice'])).min(1).max(6).optional(),
      audience: z.object({ roles: z.array(z.string().max(40)).optional(), classIds: z.array(z.string()).optional(), sectionIds: z.array(z.string()).optional(), studentIds: z.array(z.string()).optional(), guardians: z.coerce.boolean().optional(), staff: z.coerce.boolean().optional(), withDues: z.coerce.boolean().optional() }).optional(),
      urgent: z.coerce.boolean().optional(), noticeType: z.string().max(20).optional(),
      whatsappTemplate: z.string().max(120).optional().nullable(), whatsappVariables: z.array(z.string().max(200)).max(10).optional(),
    }).parse(req.body);
    const r = await app.communication.broadcast(u.school_id, { ...b, createdBy: u.id });
    await app.audit.log({ action: 'create', entityType: 'communication.notice', entityId: r.id, after: { recipients: r.recipients, channels: r.channels.join(',') } });
    return r;
  }));
  api.post('/comms/broadcast/preview', wrap(async req => {
    const u = requirePerm(req, 'communication.view');
    const b = z.object({ audience: z.object({ roles: z.array(z.string().max(40)).optional(), classIds: z.array(z.string()).optional(), sectionIds: z.array(z.string()).optional(), studentIds: z.array(z.string()).optional(), guardians: z.coerce.boolean().optional(), staff: z.coerce.boolean().optional(), withDues: z.coerce.boolean().optional() }) }).parse(req.body);
    const people = await app.communication.audience(u.school_id, b.audience);
    return { recipients: people.length, withPhone: people.filter(p => p.phone).length, withEmail: people.filter(p => p.email).length, withAccount: people.filter(p => p.userId).length };
  }));
  api.get('/comms/broadcast/:id', wrap(async req => { const u = requirePerm(req, 'communication.view'); return app.communication.broadcastStatus(u.school_id, req.params.id as string); }));

  // ---------- competency-based assessment ----------
  api.get('/exams/competency/scales', wrap(async req => { const u = requirePerm(req, 'assessment.view'); return app.assessment.scales(u.school_id); }));
  api.post('/exams/competency/scales', wrap(async req => { const u = requirePerm(req, 'assessment.create'); const b = z.object({ name: z.string().min(1).max(80).optional(), levels: z.array(z.object({ code: z.string().min(1).max(10), label: z.string().min(1).max(80), labelBn: z.string().max(80).optional(), value: z.coerce.number().int().min(1).max(10) })).min(2).max(10).optional() }).parse(req.body ?? {}); return { id: await app.assessment.ensureCompetencyScale(u.school_id, b.name, b.levels) }; }));
  api.get('/exams/competency/outcomes', wrap(async req => { const u = requirePerm(req, 'assessment.view'); const cs = q(req, 'classSubjectId'); if (!cs) throw new HttpError(400, 'classSubjectId required'); return app.assessment.outcomes(u.school_id, cs); }));
  api.post('/exams/competency/outcomes', wrap(async req => { const u = requirePerm(req, 'assessment.create'); const b = z.object({ classSubjectId: z.string(), code: z.string().min(1).max(30), statement: z.string().min(2).max(2000), statementBn: z.string().max(2000).optional().nullable(), unitId: z.string().optional().nullable(), bloomLevel: z.enum(['remember', 'understand', 'apply', 'analyse', 'evaluate', 'create']).optional().nullable(), weight: z.coerce.number().min(0.1).max(10).optional() }).parse(req.body); return { id: await app.assessment.addOutcome(u.school_id, b) }; }));
  api.post('/exams/competency/assess', wrap(async req => {
    const u = requirePerm(req, 'assessment.edit');
    const b = z.object({ scaleId: z.string().optional(), rows: z.array(z.object({ studentId: z.string(), outcomeId: z.string(), termId: z.string(), levelCode: z.string().min(1).max(10), evidence: z.unknown().optional() })).min(1).max(500) }).parse(req.body);
    return app.assessment.assessCompetency(u.school_id, b.rows as never, { scaleId: b.scaleId, assessedBy: await staffOf(u) });
  }));
  api.get('/exams/competency/report', wrap(async req => { const u = requirePerm(req, 'assessment.view'); const studentId = q(req, 'studentId'); const termId = q(req, 'termId'); if (!studentId || !termId) throw new HttpError(400, 'studentId and termId required'); return app.assessment.competencyReport(u.school_id, studentId, termId); }));
  // a guardian reading their own child's competency report
  api.get('/portal/competency/:studentId', wrap(async req => {
    const u = requireUser(req);
    const student = await app.db.findOne<{ id: string; user_id: string | null }>('students', { id: req.params.studentId as string, school_id: u.school_id });
    if (!student) throw new HttpError(404, 'student not found');
    const guardian = await app.db.findOne<{ id: string }>('guardians', { school_id: u.school_id, user_id: u.id });
    const isChild = guardian && await app.db.findOne('student_guardians', { student_id: student.id, guardian_id: guardian.id });
    if (!isChild && student.user_id !== u.id) throw new HttpError(403, 'not your child');
    const termId = q(req, 'termId') ?? String((await app.db.findMany<{ id: string }>('terms', { school_id: u.school_id }, { orderBy: 'start_date DESC', limit: 1 }))[0]?.id ?? '');
    if (!termId) throw new HttpError(404, 'no term');
    return app.assessment.competencyReport(u.school_id, student.id, termId);
  }));

  // ---------- OMR ----------
  api.get('/exams/omr', wrap(async req => { const u = requirePerm(req, 'assessment.view'); return app.assessment.omrSheets(u.school_id, { scheduleId: q(req, 'scheduleId'), status: q(req, 'status') }); }));
  api.post('/exams/omr', wrap(async req => {
    const u = requirePerm(req, 'assessment.edit');
    const b = z.object({ sheets: z.array(z.object({ fileId: z.string(), scheduleId: z.string().optional().nullable(), detectedRoll: z.string().max(20).optional().nullable(), answers: z.unknown().optional(), score: money.optional().nullable(), confidence: z.coerce.number().min(0).max(100).optional().nullable() })).min(1).max(500) }).parse(req.body);
    return app.assessment.ingestOmr(u.school_id, b.sheets as never);
  }));
  api.post('/exams/omr/:id/review', wrap(async req => { const u = requirePerm(req, 'assessment.edit'); const b = z.object({ studentId: z.string().optional().nullable(), score: money.optional().nullable(), reject: z.coerce.boolean().optional() }).parse(req.body ?? {}); return app.assessment.reviewOmr(u.school_id, req.params.id as string, b); }));
  api.post('/exams/omr/apply/:scheduleId', wrap(async req => { const u = requirePerm(req, 'assessment.edit'); return app.assessment.applyOmr(u.school_id, req.params.scheduleId as string, u.id); }));

  // ---------- board registration ----------
  api.get('/exams/board', wrap(async req => { const u = requirePerm(req, 'assessment.view'); return app.assessment.boardRegistrations(u.school_id, { examName: q(req, 'exam'), status: q(req, 'status') }); }));
  api.post('/exams/board', wrap(async req => {
    const u = requirePerm(req, 'assessment.create');
    const b = z.object({ studentId: z.string(), academicYearId: z.string().optional(), board: z.string().min(2).max(40), examName: z.string().min(2).max(40), groupName: z.string().max(30).optional().nullable(), subjects: z.array(z.string().max(80)).max(20).optional(), centre: z.string().max(120).optional().nullable(), registrationNo: z.string().max(30).optional().nullable(), rollNo: z.string().max(30).optional().nullable() }).parse(req.body);
    const academicYearId = b.academicYearId ?? String((await app.academic.requireYear(u.school_id, null)).id);
    return app.assessment.registerForBoard(u.school_id, { ...b, academicYearId });
  }));
  api.post('/exams/board/:id/submit', wrap(async req => { const u = requirePerm(req, 'assessment.approve'); const b = z.object({ fee: money.optional(), feeHeadId: z.string().optional().nullable() }).parse(req.body ?? {}); return app.assessment.submitBoardForm(u.school_id, req.params.id as string, b); }));
  api.post('/exams/board/results', wrap(async req => {
    const u = requirePerm(req, 'assessment.approve');
    const b = z.object({ examName: z.string().min(2).max(40), results: z.array(z.object({ rollNo: z.string().max(30).optional().nullable(), registrationNo: z.string().max(30).optional().nullable(), gpa: z.coerce.number().min(0).max(5).optional().nullable(), grade: z.string().max(10).optional().nullable(), subjects: z.unknown().optional() })).min(1).max(2000) }).parse(req.body);
    return app.assessment.importBoardResults(u.school_id, b.examName, b.results as never);
  }));
}
