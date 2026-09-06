import type { Request, Response, Router } from 'express';
import { HttpError, type App } from '@pathshala/core';
import { z } from '@pathshala/schemas';

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (e?: unknown) => void) => void;
type User = { id: string; school_id: string; user_type: string };

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const marks = z.coerce.number().min(0).max(1000);
export const examSchema = z.object({ academicYearId: z.string().optional().nullable(), termId: z.string().optional().nullable(), examTypeId: z.string().optional().nullable(), gradingScaleId: z.string().optional().nullable(), name: z.string().min(1).max(120), startDate: dateSchema, endDate: dateSchema, classIds: z.array(z.string()).optional(), requireFeeClearance: z.coerce.boolean().optional(), minAttendancePct: z.coerce.number().min(0).max(100).optional().nullable(), rankScope: z.enum(['section', 'class', 'both']).optional(), tieRule: z.enum(['share_rank', 'dense', 'by_total']).optional() });
export const marksSchema = z.object({ scheduleId: z.string(), marks: z.array(z.object({ studentId: z.string(), theory: marks.optional().nullable(), practical: marks.optional().nullable(), ca: marks.optional().nullable(), isAbsent: z.coerce.boolean().optional(), remarks: z.string().max(120).optional().nullable() })).max(500) });

/** Phase 4 API: exams, seat plans, marks entry and lock, results, report cards, promotion, question bank. */
export function mountPhase4(api: Router, app: App, wrap: Wrap, requirePerm: (req: Request, perm: string) => User, requireUser: (req: Request) => User) {
  const q = (req: Request, k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : undefined);
  const yearOf = async (req: Request, schoolId: string) => String((await app.academic.requireYear(schoolId, q(req, 'yearId'))).id);

  api.get('/exams', wrap(async req => { const u = requirePerm(req, 'assessment.view'); return { exams: await app.assessment.exams(u.school_id, await yearOf(req, u.school_id)), types: await app.assessment.examTypes(u.school_id), scales: await app.assessment.gradingScales(u.school_id) }; }));
  api.post('/exams', wrap(async req => { const u = requirePerm(req, 'assessment.create'); const r = await app.assessment.createExam(u.school_id, examSchema.parse(req.body)); await app.audit.log({ action: 'create', entityType: 'exam', entityId: r.id, after: req.body }); return r; }));
  api.get('/exams/:id/schedules', wrap(async req => { const u = requirePerm(req, 'assessment.view'); return app.assessment.schedules(u.school_id, req.params.id as string); }));
  api.patch('/exams/schedules/:id', wrap(async req => { const u = requirePerm(req, 'assessment.edit'); const b = z.object({ examDate: dateSchema.optional(), startTime: z.string().optional().nullable(), endTime: z.string().optional().nullable(), roomId: z.string().optional().nullable(), fullMarks: marks.optional(), passMarks: marks.optional() }).parse(req.body); return { updated: await app.assessment.setSchedule(u.school_id, req.params.id as string, b) }; }));
  api.post('/exams/:id/seat-plan', wrap(async req => {
    const u = requirePerm(req, 'assessment.edit');
    const r = await app.assessment.buildSeatPlan(u.school_id, req.params.id as string);
    await app.outbox.emitNow({ type: 'exam.scheduled', schoolId: u.school_id, aggregateType: 'assessment.exam', aggregateId: req.params.id as string, payload: { examId: req.params.id as string, ...r } });
    return r;
  }));
  api.get('/exams/:id/seat-plan', wrap(async req => { const u = requirePerm(req, 'assessment.view'); return app.assessment.seatPlan(u.school_id, req.params.id as string); }));

  // ---------- marks ----------
  api.get('/exams/marks', wrap(async req => { const u = requirePerm(req, 'assessment.view'); const scheduleId = q(req, 'scheduleId'); if (!scheduleId) throw new HttpError(400, 'scheduleId required'); return app.assessment.marksGrid(u.school_id, scheduleId, q(req, 'sectionId')); }));
  api.post('/exams/marks', wrap(async req => { const u = requirePerm(req, 'assessment.edit'); const b = marksSchema.parse(req.body); return app.assessment.saveMarks(u.school_id, b.scheduleId, b.marks as never, u.id); }));
  api.post('/exams/marks/:scheduleId/verify', wrap(async req => { const u = requirePerm(req, 'assessment.approve'); return app.assessment.verifyMarks(u.school_id, req.params.scheduleId as string, u.id); }));
  api.post('/exams/marks/:scheduleId/lock', wrap(async req => { const u = requirePerm(req, 'assessment.approve'); return app.assessment.lockMarks(u.school_id, req.params.scheduleId as string); }));
  api.post('/exams/marks/:scheduleId/unlock', wrap(async req => { const u = requirePerm(req, 'assessment.approve'); return app.assessment.unlockMarks(u.school_id, req.params.scheduleId as string); }));
  api.get('/exams/:id/missing-marks', wrap(async req => { const u = requirePerm(req, 'assessment.view'); return app.assessment.missingMarks(u.school_id, req.params.id as string); }));

  // ---------- promotion (registered before /exams/:id/* so 'annual' is not read as an exam id) ----------
  api.post('/exams/annual/compute', wrap(async req => { const u = requirePerm(req, 'assessment.approve'); return app.assessment.computeAnnual(u.school_id, await yearOf(req, u.school_id)); }));
  api.post('/exams/annual/promote', wrap(async req => {
    const u = requirePerm(req, 'assessment.approve');
    const b = z.object({ fromYearId: z.string(), toYearId: z.string(), apply: z.coerce.boolean().optional() }).parse(req.body);
    const r = await app.assessment.promote(u.school_id, b.fromYearId, b.toYearId, { apply: b.apply });
    if (b.apply) await app.outbox.emitNow({ type: 'promotion.applied', schoolId: u.school_id, aggregateType: 'assessment.promotion', aggregateId: b.toYearId, payload: { fromYearId: b.fromYearId, toYearId: b.toYearId, promoted: r.promoted, retained: r.retained } });
    return r;
  }));
  api.get('/exams/annual', wrap(async req => { const u = requirePerm(req, 'assessment.view'); return app.db.query(`SELECT a.*, s.first_name, s.last_name, s.admission_no, c.name AS class_name FROM annual_results a JOIN students s ON s.id = a.student_id LEFT JOIN classes c ON c.id = s.current_class_id WHERE a.school_id = ? AND a.academic_year_id = ? ORDER BY a.weighted_gpa DESC LIMIT 2000`, [u.school_id, await yearOf(req, u.school_id)]); }));

  // ---------- results ----------
  api.post('/exams/:id/compute', wrap(async req => { const u = requirePerm(req, 'assessment.approve'); const r = await app.assessment.computeResults(u.school_id, req.params.id as string); await app.audit.log({ action: 'compute', entityType: 'exam', entityId: req.params.id as string, after: r }); return r; }));
  api.get('/exams/:id/results', wrap(async req => { const u = requirePerm(req, 'assessment.view'); return app.assessment.results(u.school_id, req.params.id as string, { sectionId: q(req, 'sectionId'), classId: q(req, 'classId') }); }));
  api.post('/exams/:id/publish', wrap(async req => { const u = requirePerm(req, 'assessment.approve'); const b = z.object({ publishAt: z.string().optional().nullable() }).parse(req.body ?? {}); return app.assessment.publish(u.school_id, req.params.id as string, b); }));
  api.get('/exams/:id/students/:studentId', wrap(async req => { const u = requirePerm(req, 'assessment.view'); return app.assessment.studentResult(u.school_id, req.params.id as string, req.params.studentId as string); }));

  // ---------- question bank ----------
  api.get('/questions', wrap(async req => { const u = requirePerm(req, 'assessment.view'); const where: Record<string, unknown> = { school_id: u.school_id }; if (q(req, 'subjectId')) where.subject_id = q(req, 'subjectId'); return app.db.findMany('questions', where as never, { orderBy: 'created_at DESC', limit: 200 }); }));
  api.post('/questions', wrap(async req => { const u = requirePerm(req, 'assessment.create'); const b = z.object({ subjectId: z.string(), classId: z.string().optional().nullable(), qType: z.enum(['mcq', 'true_false', 'short', 'long', 'fill_blank', 'match', 'numeric', 'essay']), difficulty: z.enum(['easy', 'medium', 'hard']).optional(), body: z.string().min(1).max(20000), bodyBn: z.string().max(20000).optional().nullable(), options: z.unknown().optional(), answer: z.unknown().optional(), marks: marks.optional() }).parse(req.body); return { id: await app.assessment.addQuestion(u.school_id, b) }; }));
  api.post('/questions/papers', wrap(async req => { const u = requirePerm(req, 'assessment.create'); const b = z.object({ classSubjectId: z.string(), title: z.string().min(1).max(200), blueprint: z.record(z.string(), z.object({ count: z.coerce.number().int().min(1).max(100), marks: marks.optional(), difficulty: z.enum(['easy', 'medium', 'hard']).optional() })), examId: z.string().optional().nullable(), durationMin: z.coerce.number().int().optional() }).parse(req.body); return app.assessment.generatePaper(u.school_id, b); }));
  api.get('/questions/papers/:id', wrap(async req => { const u = requirePerm(req, 'assessment.view'); return app.assessment.paper(u.school_id, req.params.id as string); }));

  // ---------- online exams ----------
  api.post('/exams/online', wrap(async req => { const u = requirePerm(req, 'assessment.create'); const b = z.object({ sectionId: z.string(), classSubjectId: z.string(), paperId: z.string().optional().nullable(), title: z.string().min(1).max(200), startsAt: z.string(), endsAt: z.string(), durationMin: z.coerce.number().int().min(5), totalMarks: marks, autoGrade: z.coerce.boolean().optional() }).parse(req.body); return { id: await app.assessment.createOnlineExam(u.school_id, b) }; }));
  api.post('/exams/online/:id/submit', wrap(async req => {
    const u = requireUser(req);
    const student = await app.db.findOne<{ id: string }>('students', { school_id: u.school_id, user_id: u.id });
    if (!student) throw new HttpError(403, 'only a student can submit an attempt');
    const b = z.object({ answers: z.record(z.string(), z.unknown()) }).parse(req.body);
    return app.assessment.submitAttempt(u.school_id, req.params.id as string, student.id, b.answers);
  }));

  // ---------- portal: a guardian sees the published result of their own child ----------
  api.get('/portal/results/:studentId', wrap(async req => {
    const u = requireUser(req);
    const guardian = await app.db.findOne<{ id: string }>('guardians', { school_id: u.school_id, user_id: u.id });
    if (!guardian) throw new HttpError(403, 'only a guardian can see results here');
    if (!(await app.db.findOne('student_guardians', { student_id: req.params.studentId as string, guardian_id: guardian.id }))) throw new HttpError(403, 'not your child');
    const results = await app.db.query(`SELECT r.*, e.name AS exam_name, e.status AS exam_status FROM exam_results r JOIN exams e ON e.id = r.exam_id WHERE r.school_id = ? AND r.student_id = ? AND e.status = 'published' ORDER BY e.start_date DESC`, [u.school_id, req.params.studentId as string]);
    return { results };
  }));
  api.get('/portal/results/:studentId/:examId', wrap(async req => {
    const u = requireUser(req);
    const guardian = await app.db.findOne<{ id: string }>('guardians', { school_id: u.school_id, user_id: u.id });
    if (!guardian || !(await app.db.findOne('student_guardians', { student_id: req.params.studentId as string, guardian_id: guardian.id }))) throw new HttpError(403, 'not your child');
    const exam = await app.db.findOne<{ status: string }>('exams', { id: req.params.examId as string, school_id: u.school_id });
    if (exam?.status !== 'published') throw new HttpError(403, 'that result is not published yet');
    const detail = await app.assessment.studentResult(u.school_id, req.params.examId as string, req.params.studentId as string);
    const fileId = detail.result?.report_card_file_id as string | undefined;
    return { ...detail, reportCardUrl: fileId ? await app.files.url(fileId, u.school_id, 900) : null };
  }));
}
