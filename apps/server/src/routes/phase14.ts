import type { Request, Response, Router } from 'express';
import type { App } from '@pathshala/core';
import { z } from '@pathshala/schemas';

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (e?: unknown) => void) => void;
type User = { id: string; school_id: string; user_type: string };

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const money = z.coerce.number().min(0).max(100_000_000);
const credit = z.coerce.number().min(0).max(20);

/**
 * Phase 14 API: college and coaching modes — semester programmes with credits, per-term course
 * registration and a credit-weighted transcript, department portals, and batches sold on instalments.
 *
 * The permissions are the school's existing ones rather than a module of their own: a registrar is the
 * academic office, posting a semester result is assessment, and selling a batch is fees. A college
 * should not have to invent a new role for work its staff already do.
 */
export function mountPhase14(api: Router, app: App, wrap: Wrap, requirePerm: (req: Request, perm: string) => User) {
  const q = (req: Request, k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : undefined);

  // ---------- programmes ----------
  api.get('/college/programs', wrap(async req => { const u = requirePerm(req, 'academic.view'); return app.college.programs(u.school_id); }));
  api.post('/college/programs', wrap(async req => {
    const u = requirePerm(req, 'academic.create');
    const b = z.object({
      name: z.string().min(2).max(120), code: z.string().min(1).max(20),
      level: z.enum(['secondary', 'higher_secondary', 'bachelor', 'master', 'diploma', 'coaching']),
      durationTerms: z.coerce.number().int().min(1).max(24).optional().nullable(),
      totalCredits: z.coerce.number().min(0).max(1000).optional().nullable(),
      departmentId: z.string().optional().nullable(), classIds: z.array(z.string()).max(50).optional(),
    }).parse(req.body);
    return app.college.createProgram(u.school_id, b);
  }));
  api.get('/college/programs/:id', wrap(async req => { const u = requirePerm(req, 'academic.view'); return app.college.program(u.school_id, req.params.id as string); }));
  api.post('/college/credits', wrap(async req => {
    const u = requirePerm(req, 'academic.edit');
    const b = z.object({ academicYearId: z.string(), classId: z.string(), subjectId: z.string(), credit }).parse(req.body);
    return app.college.setCredit(u.school_id, b);
  }));

  // ---------- registration ----------
  api.get('/college/registrations', wrap(async req => {
    const u = requirePerm(req, 'academic.view');
    return app.college.registrations(u.school_id, { studentId: q(req, 'studentId'), termId: q(req, 'termId'), classSubjectId: q(req, 'classSubjectId'), status: q(req, 'status') });
  }));
  api.post('/college/registrations', wrap(async req => {
    const u = requirePerm(req, 'academic.create');
    const b = z.object({ studentId: z.string(), termId: z.string(), classSubjectIds: z.array(z.string()).min(1).max(30) }).parse(req.body);
    return app.college.register(u.school_id, b);
  }));
  // what the student is already carrying this term, and how much room the programme leaves
  api.get('/college/registrations/load', wrap(async req => {
    const u = requirePerm(req, 'academic.view');
    const b = z.object({ studentId: z.string(), termId: z.string() }).parse({ studentId: q(req, 'studentId'), termId: q(req, 'termId') });
    return app.college.load(u.school_id, b.studentId, b.termId);
  }));
  api.post('/college/registrations/:id/drop', wrap(async req => {
    const u = requirePerm(req, 'academic.edit');
    const b = z.object({ reason: z.string().max(200).optional() }).parse(req.body ?? {});
    return app.college.drop(u.school_id, req.params.id as string, b.reason ?? null);
  }));
  api.post('/college/registrations/:id/result', wrap(async req => {
    const u = requirePerm(req, 'assessment.edit');
    const b = z.object({ percent: z.coerce.number().min(0).max(100), scaleId: z.string().optional().nullable() }).parse(req.body);
    return app.college.recordResult(u.school_id, { registrationId: req.params.id as string, ...b });
  }));
  api.get('/college/transcript/:studentId', wrap(async req => {
    const u = requirePerm(req, 'assessment.view');
    return app.college.transcript(u.school_id, req.params.studentId as string, q(req, 'programId') ?? null);
  }));

  // ---------- certificates ----------
  api.post('/college/certificates/program', wrap(async req => {
    const u = requirePerm(req, 'documents.create');
    const b = z.object({ studentId: z.string(), programId: z.string() }).parse(req.body);
    const r = await app.college.certifyProgram(u.school_id, { ...b, signedBy: u.id });
    await app.audit.log({ action: 'create', entityType: 'college.program_certificate', entityId: b.programId, after: { studentId: b.studentId } });
    return r;
  }));
  api.post('/college/certificates/course', wrap(async req => {
    const u = requirePerm(req, 'documents.create');
    const b = z.object({ courseId: z.string(), studentId: z.string(), onDate: dateSchema.optional() }).parse(req.body);
    return app.college.certifyCourse(u.school_id, b);
  }));

  // ---------- departments ----------
  api.get('/college/departments', wrap(async req => { const u = requirePerm(req, 'people.view'); return app.college.departments(u.school_id); }));
  api.post('/college/departments', wrap(async req => {
    const u = requirePerm(req, 'people.create');
    const b = z.object({ name: z.string().min(2).max(80), kind: z.enum(['academic', 'admin', 'support']).optional() }).parse(req.body);
    return app.college.createDepartment(u.school_id, b.name, b.kind);
  }));
  api.get('/college/departments/:id', wrap(async req => { const u = requirePerm(req, 'people.view'); return app.college.department(u.school_id, req.params.id as string); }));
  api.post('/college/departments/:id/head', wrap(async req => {
    const u = requirePerm(req, 'people.edit');
    const b = z.object({ staffId: z.string().nullable() }).parse(req.body);
    return app.college.setHead(u.school_id, req.params.id as string, b.staffId);
  }));

  // ---------- coaching: selling a batch ----------
  api.get('/college/sales', wrap(async req => { const u = requirePerm(req, 'fees.view'); return app.college.sales(u.school_id, { courseId: q(req, 'courseId'), studentId: q(req, 'studentId') }); }));
  api.post('/college/sales', wrap(async req => {
    const u = requirePerm(req, 'fees.create');
    const b = z.object({
      courseId: z.string(), studentId: z.string(), price: money.optional(),
      count: z.coerce.number().int().min(2).max(24).optional(), firstDue: dateSchema.optional(),
      instalments: z.array(z.object({ due: dateSchema, amount: money })).min(1).max(24).optional(),
    }).parse(req.body);
    return app.college.sell(u.school_id, { ...b, approvedBy: u.id });
  }));
  api.get('/college/sales/outstanding', wrap(async req => {
    const u = requirePerm(req, 'fees.view');
    const b = z.object({ courseId: z.string(), studentId: z.string() }).parse({ courseId: q(req, 'courseId'), studentId: q(req, 'studentId') });
    return app.college.outstandingFor(u.school_id, b.courseId, b.studentId);
  }));
}
