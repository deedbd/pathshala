import type { Request, Response, Router } from 'express';
import { HttpError, type App, type DiscussionViewer } from '@pathshala/core';
import { z } from '@pathshala/schemas';

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (e?: unknown) => void) => void;
type User = { id: string; school_id: string; user_type: string };

/**
 * Phase 15 API: the advanced half of the LMS — watch time that has to have happened, discussion
 * threads scoped to the reader's own course, and the similarity check between text answers — plus
 * adaptive learning, which turns competency ratings into a revision plan naming the lessons that
 * close each gap. The portal endpoints matter as much as the console ones here: the player posting
 * its heartbeat, the student asking a question and the guardian reading the week's plan are all on
 * the parent side of the app.
 */
export function mountPhase15(api: Router, app: App, wrap: Wrap, requirePerm: (req: Request, perm: string) => User, requireUser: (req: Request) => User) {
  const q = (req: Request, k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : undefined);
  /** Staff see every course; the service still gets a viewer so the rule lives in one place. */
  const staffViewer = (u: User): DiscussionViewer => ({ userId: u.id, isStaff: true });
  /**
   * The learner a portal request is about: the signed-in student themselves, or a child of the
   * signed-in guardian. Anything else is somebody else's child, and the answer is 403 rather than an
   * empty list — an empty list would let a guardian probe for ids.
   */
  const learnerOf = async (u: User, studentId?: string | null): Promise<DiscussionViewer> => {
    const self = await app.db.findOne<{ id: string }>('students', { school_id: u.school_id, user_id: u.id });
    if (self && (!studentId || studentId === self.id)) return { userId: u.id, isStaff: false, studentId: self.id };
    if (!studentId) throw new HttpError(400, 'name the child (studentId) this is about', 'bad_request');
    const student = await app.db.findOne<{ id: string; user_id: string | null }>('students', { id: studentId, school_id: u.school_id });
    if (!student) throw new HttpError(404, 'student not found');
    const guardian = await app.db.findOne<{ id: string }>('guardians', { school_id: u.school_id, user_id: u.id });
    const linked = guardian && await app.db.findOne('student_guardians', { student_id: student.id, guardian_id: guardian.id });
    if (!linked && student.user_id !== u.id) throw new HttpError(403, 'not your child', 'forbidden');
    return { userId: u.id, isStaff: false, studentId: student.id };
  };
  const studentOf = async (u: User) => {
    const s = await app.db.findOne<{ id: string }>('students', { school_id: u.school_id, user_id: u.id });
    if (!s) throw new HttpError(403, 'only a student can do this for themselves', 'forbidden');
    return s.id;
  };

  // ---------- video lessons ----------
  // a teacher correcting the record for one student; the player's own beat is the portal route below
  api.post('/lms/lessons/:id/watch', wrap(async req => {
    const u = requirePerm(req, 'lms.edit');
    const b = z.object({ studentId: z.string(), seconds: z.coerce.number().int().min(0).max(86_400).optional(), position: z.coerce.number().int().min(0).max(86_400).optional() }).parse(req.body);
    return app.lms.watch(u.school_id, { lessonId: req.params.id as string, studentId: b.studentId, seconds: b.seconds, position: b.position });
  }));
  api.get('/lms/courses/:id/watch-report', wrap(async req => { const u = requirePerm(req, 'lms.view'); return app.lms.watchReport(u.school_id, req.params.id as string); }));

  // ---------- discussion threads ----------
  api.get('/lms/discussions', wrap(async req => {
    const u = requirePerm(req, 'lms.view');
    return app.lms.threads(u.school_id, { courseId: q(req, 'courseId'), lessonId: q(req, 'lessonId') }, staffViewer(u));
  }));
  api.post('/lms/discussions', wrap(async req => {
    const u = requirePerm(req, 'lms.create');
    const b = z.object({ courseId: z.string().optional().nullable(), lessonId: z.string().optional().nullable(), parentId: z.string().optional().nullable(), body: z.string().min(1).max(20_000) }).parse(req.body);
    return { id: await app.lms.ask(u.school_id, { ...b, authorId: u.id }, staffViewer(u)) };
  }));
  api.post('/lms/discussions/:id/upvote', wrap(async req => { const u = requirePerm(req, 'lms.view'); return app.lms.upvote(u.school_id, req.params.id as string, staffViewer(u)); }));
  // marking the answer is a teacher's call: it is what the next thirty readers of the thread will read
  api.post('/lms/discussions/:id/answer', wrap(async req => { const u = requirePerm(req, 'lms.edit'); return { updated: await app.lms.markAnswer(u.school_id, req.params.id as string) }; }));

  // ---------- similarity between text answers ----------
  api.post('/lms/assignments/:id/similarity', wrap(async req => {
    const u = requirePerm(req, 'lms.edit');
    const b = z.object({ minWords: z.coerce.number().int().min(6).max(2000).optional(), reportAt: z.coerce.number().min(1).max(100).optional() }).parse(req.body ?? {});
    return app.lms.similarityReport(u.school_id, req.params.id as string, b);
  }));

  // ---------- adaptive learning ----------
  api.get('/adaptive/plan/:studentId', wrap(async req => { const u = requirePerm(req, 'assessment.view'); return app.adaptive.revisionPlan(u.school_id, req.params.studentId as string, q(req, 'termId')); }));
  api.post('/adaptive/plan/:studentId/push', wrap(async req => {
    const u = requirePerm(req, 'assessment.edit');
    const b = z.object({ termId: z.string().optional().nullable() }).parse(req.body ?? {});
    return app.adaptive.push(u.school_id, req.params.studentId as string, b.termId);
  }));
  api.get('/adaptive/gaps', wrap(async req => {
    const u = requirePerm(req, 'assessment.view');
    const classSubjectId = q(req, 'classSubjectId');
    if (!classSubjectId) throw new HttpError(400, 'classSubjectId required', 'bad_request');
    return app.adaptive.classGaps(u.school_id, { classSubjectId, termId: q(req, 'termId') });
  }));
  // the weekly pass on demand, for a school that does not want to wait until Saturday morning
  api.post('/adaptive/run', wrap(async req => {
    const u = requirePerm(req, 'assessment.edit');
    const b = z.object({ termId: z.string().optional().nullable(), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.body ?? {});
    return app.adaptive.runWeekly(u.school_id, b);
  }));

  // ---------- the student's and guardian's own side ----------
  api.post('/portal/lessons/:id/watch', wrap(async req => {
    const u = requireUser(req);
    const b = z.object({ seconds: z.coerce.number().int().min(0).max(86_400).optional(), position: z.coerce.number().int().min(0).max(86_400).optional() }).parse(req.body ?? {});
    return app.lms.watch(u.school_id, { lessonId: req.params.id as string, studentId: await studentOf(u), seconds: b.seconds, position: b.position });
  }));
  api.get('/portal/discussions', wrap(async req => {
    const u = requireUser(req);
    const viewer = await learnerOf(u, q(req, 'studentId'));
    return app.lms.threads(u.school_id, { courseId: q(req, 'courseId'), lessonId: q(req, 'lessonId') }, viewer);
  }));
  api.post('/portal/discussions', wrap(async req => {
    const u = requireUser(req);
    const b = z.object({ courseId: z.string().optional().nullable(), lessonId: z.string().optional().nullable(), parentId: z.string().optional().nullable(), studentId: z.string().optional().nullable(), body: z.string().min(1).max(20_000) }).parse(req.body);
    const viewer = await learnerOf(u, b.studentId);
    return { id: await app.lms.ask(u.school_id, { courseId: b.courseId, lessonId: b.lessonId, parentId: b.parentId, body: b.body, authorId: u.id }, viewer) };
  }));
  api.get('/portal/revision/:studentId', wrap(async req => {
    const u = requireUser(req);
    const viewer = await learnerOf(u, req.params.studentId as string);
    return app.adaptive.revisionPlan(u.school_id, viewer.studentId as string, q(req, 'termId'));
  }));
}
