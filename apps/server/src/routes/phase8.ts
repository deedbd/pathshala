import type { Request, Response, Router } from 'express';
import { HttpError, type App } from '@pathshala/core';
import { z } from '@pathshala/schemas';

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (e?: unknown) => void) => void;
type User = { id: string; school_id: string; user_type: string };

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const money = z.coerce.number().min(0).max(100_000_000);

/** Phase 8 API: welfare (behaviour, health, clinic, counselling, safeguarding), the LMS, and engagement. */
export function mountPhase8(api: Router, app: App, wrap: Wrap, requirePerm: (req: Request, perm: string) => User, requireUser: (req: Request) => User) {
  const q = (req: Request, k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : undefined);
  /** The staff record behind the signed-in user; counselling and safeguarding are keyed to a person. */
  const staffOf = async (u: User) => {
    const s = await app.db.findOne<{ id: string }>('staff', { school_id: u.school_id, user_id: u.id });
    if (!s) throw new HttpError(403, 'this record has to name a member of staff, and this account is not linked to one — send the staff id explicitly', 'no_staff');
    return s.id;
  };

  // ---------- behaviour ----------
  api.get('/welfare/behaviour', wrap(async req => { const u = requirePerm(req, 'welfare.view'); return { categories: await app.welfare.categories(u.school_id), incidents: await app.welfare.incidents(u.school_id, { studentId: q(req, 'studentId') }), actions: await app.welfare.actions(u.school_id, q(req, 'studentId')) }; }));
  api.post('/welfare/incidents', wrap(async req => {
    const u = requirePerm(req, 'welfare.create');
    const b = z.object({ studentId: z.string(), categoryId: z.string(), incidentDate: dateSchema.optional(), points: z.coerce.number().int().min(-100).max(100).optional(), description: z.string().min(2).max(4000), witnesses: z.string().max(255).optional().nullable(), reportedBy: z.string().optional() }).parse(req.body);
    return app.welfare.recordIncident(u.school_id, { ...b, reportedBy: b.reportedBy ?? await staffOf(u) });
  }));
  api.get('/welfare/points/:studentId', wrap(async req => { const u = requirePerm(req, 'welfare.view'); return app.welfare.points(u.school_id, req.params.studentId as string, Number(q(req, 'days') ?? 30)); }));
  api.post('/welfare/actions', wrap(async req => { const u = requirePerm(req, 'welfare.approve'); const b = z.object({ studentId: z.string(), actionType: z.enum(['verbal_warning', 'written_warning', 'detention', 'suspension', 'expulsion', 'counselling', 'community_service']), incidentId: z.string().optional().nullable(), fromDate: dateSchema.optional().nullable(), toDate: dateSchema.optional().nullable(), description: z.string().max(2000).optional().nullable() }).parse(req.body); return app.welfare.proposeAction(u.school_id, b); }));
  api.post('/welfare/actions/:id/approve', wrap(async req => { const u = requirePerm(req, 'welfare.approve'); return app.welfare.approveAction(u.school_id, req.params.id as string, u.id); }));

  // ---------- health and clinic ----------
  api.get('/welfare/health/:studentId', wrap(async req => { const u = requirePerm(req, 'welfare.view'); return app.welfare.health(u.school_id, req.params.studentId as string); }));
  api.post('/welfare/health', wrap(async req => { const u = requirePerm(req, 'welfare.create'); const b = z.object({ studentId: z.string(), recordedOn: dateSchema.optional(), heightCm: z.coerce.number().min(30).max(250).optional().nullable(), weightKg: z.coerce.number().min(2).max(250).optional().nullable(), visionLeft: z.string().max(10).optional().nullable(), visionRight: z.string().max(10).optional().nullable(), hearing: z.string().max(20).optional().nullable(), dental: z.string().max(40).optional().nullable(), doctorNotes: z.string().max(4000).optional().nullable() }).parse(req.body); return app.welfare.recordHealth(u.school_id, b); }));
  api.post('/welfare/vaccinations', wrap(async req => { const u = requirePerm(req, 'welfare.create'); const b = z.object({ studentId: z.string(), vaccine: z.string().min(1).max(80), doseNo: z.coerce.number().int().min(1).max(10).optional(), givenOn: dateSchema.optional().nullable(), nextDueOn: dateSchema.optional().nullable() }).parse(req.body); return { id: await app.welfare.recordVaccination(u.school_id, b) }; }));
  api.post('/welfare/clinic', wrap(async req => {
    const u = requirePerm(req, 'welfare.create');
    const b = z.object({ personType: z.enum(['student', 'staff']).optional(), studentId: z.string().optional().nullable(), staffId: z.string().optional().nullable(), complaint: z.string().min(2).max(255), treatment: z.string().max(4000).optional().nullable(), medicines: z.array(z.object({ itemId: z.string(), quantity: z.coerce.number().min(0.01).max(1000) })).max(20).optional(), storeId: z.string().optional().nullable(), referredTo: z.string().max(160).optional().nullable(), sentHome: z.coerce.boolean().optional() }).parse(req.body);
    return app.welfare.clinicVisit(u.school_id, { ...b, attendedBy: await staffOf(u).catch(() => null) });
  }));

  // ---------- counselling and safeguarding ----------
  api.get('/welfare/counselling', wrap(async req => { const u = requirePerm(req, 'welfare.view'); return app.welfare.counsellingSessions(u.school_id, { studentId: q(req, 'studentId') }); }));
  api.post('/welfare/counselling', wrap(async req => { const u = requirePerm(req, 'welfare.create'); const b = z.object({ studentId: z.string(), counsellorId: z.string().optional(), sessionAt: z.string().optional(), referralSource: z.enum(['self', 'teacher', 'behaviour_rule', 'result_drop', 'guardian', 'clinic']).optional(), notes: z.string().max(20000).optional().nullable(), followUpAt: z.string().optional().nullable(), status: z.enum(['scheduled', 'done', 'no_show', 'cancelled']).optional() }).parse(req.body); return { id: await app.welfare.counsellingSession(u.school_id, { ...b, counsellorId: b.counsellorId ?? await staffOf(u) }) }; }));
  api.get('/welfare/counselling/:id/notes', wrap(async req => { const u = requirePerm(req, 'welfare.view'); return app.welfare.counsellingNotes(u.school_id, req.params.id as string, await staffOf(u)); }));
  api.get('/welfare/safeguarding', wrap(async req => { const u = requirePerm(req, 'welfare.approve'); return app.welfare.safeguardingCases(u.school_id); }));
  api.post('/welfare/safeguarding', wrap(async req => { const u = requirePerm(req, 'welfare.create'); const b = z.object({ studentId: z.string(), category: z.enum(['abuse', 'neglect', 'bullying', 'online_safety', 'self_harm', 'other']), details: z.string().min(2).max(20000), riskLevel: z.enum(['low', 'medium', 'high']).optional(), caseOwnerId: z.string().optional().nullable() }).parse(req.body); return { id: await app.welfare.safeguardingCase(u.school_id, { ...b, reportedBy: u.id }) }; }));
  api.get('/welfare/safeguarding/:id', wrap(async req => { const u = requirePerm(req, 'welfare.approve'); return app.welfare.safeguardingDetails(u.school_id, req.params.id as string, await staffOf(u)); }));
  api.get('/welfare/plans/:studentId', wrap(async req => { const u = requirePerm(req, 'welfare.view'); return app.welfare.plan(u.school_id, req.params.studentId as string); }));
  api.post('/welfare/plans', wrap(async req => { const u = requirePerm(req, 'welfare.create'); const b = z.object({ studentId: z.string(), diagnosis: z.string().max(200).optional().nullable(), accommodations: z.array(z.string().max(200)).max(30).optional(), goals: z.array(z.object({ goal: z.string().max(200), by: z.string().max(40) })).max(30).optional(), reviewDate: dateSchema.optional().nullable(), coordinatorId: z.string().optional().nullable() }).parse(req.body); return { id: await app.welfare.savePlan(u.school_id, b) }; }));

  // ---------- lms ----------
  api.get('/lms/courses', wrap(async req => { const u = requirePerm(req, 'lms.view'); return app.lms.courses(u.school_id, { status: q(req, 'status') }); }));
  api.post('/lms/courses', wrap(async req => { const u = requirePerm(req, 'lms.create'); const b = z.object({ title: z.string().min(2).max(200), slug: z.string().max(110).optional(), classSubjectId: z.string().optional().nullable(), description: z.string().max(50_000).optional().nullable(), teacherId: z.string().optional().nullable(), isPaid: z.coerce.boolean().optional(), price: money.optional() }).parse(req.body); return app.lms.createCourse(u.school_id, b); }));
  api.get('/lms/courses/:id', wrap(async req => { const u = requirePerm(req, 'lms.view'); return app.lms.course(u.school_id, req.params.id as string); }));
  api.post('/lms/courses/:id/modules', wrap(async req => { const u = requirePerm(req, 'lms.create'); const b = z.object({ title: z.string().min(1).max(200), sequence: z.coerce.number().int().optional() }).parse(req.body); return { id: await app.lms.addModule(u.school_id, req.params.id as string, b.title, b.sequence) }; }));
  api.post('/lms/lessons', wrap(async req => { const u = requirePerm(req, 'lms.create'); const b = z.object({ moduleId: z.string(), title: z.string().min(1).max(200), lessonType: z.enum(['video', 'note', 'link', 'file', 'quiz', 'assignment', 'live']), body: z.string().max(200_000).optional().nullable(), videoUrl: z.string().max(500).optional().nullable(), fileId: z.string().optional().nullable(), durationMin: z.coerce.number().int().min(1).max(600).optional().nullable(), isFreePreview: z.coerce.boolean().optional() }).parse(req.body); return { id: await app.lms.addLesson(u.school_id, b) }; }));
  api.post('/lms/courses/:id/publish', wrap(async req => { const u = requirePerm(req, 'lms.approve'); return app.lms.publishCourse(u.school_id, req.params.id as string); }));
  api.get('/lms/courses/:id/progress', wrap(async req => { const u = requirePerm(req, 'lms.view'); return app.lms.progress(u.school_id, req.params.id as string); }));
  api.post('/lms/lessons/:id/quiz', wrap(async req => { const u = requirePerm(req, 'lms.create'); const b = z.object({ passMark: z.coerce.number().min(0).max(100).optional(), maxAttempts: z.coerce.number().int().min(1).max(10).optional(), questions: z.array(z.object({ text: z.string().min(1).max(1000), options: z.array(z.string().min(1).max(300)).min(2).max(8), answer: z.coerce.number().int().min(0), marks: z.coerce.number().min(0.5).max(20).optional() })).min(1).max(100) }).parse(req.body); return app.lms.setLessonQuiz(u.school_id, req.params.id as string, b); }));
  api.get('/lms/lessons/:id/quiz', wrap(async req => { const u = requirePerm(req, 'lms.view'); return app.lms.lessonQuiz(u.school_id, req.params.id as string, q(req, 'studentId')); }));
  api.post('/lms/courses/:id/certificate', wrap(async req => { const u = requirePerm(req, 'lms.edit'); const b = z.object({ studentId: z.string() }).parse(req.body); return app.lms.issueCourseCertificate(u.school_id, req.params.id as string, b.studentId); }));
  api.get('/lms/assignments', wrap(async req => { const u = requirePerm(req, 'lms.view'); return app.lms.assignments(u.school_id, { sectionId: q(req, 'sectionId'), openOnly: q(req, 'open') === '1' }); }));
  api.post('/lms/assignments', wrap(async req => { const u = requirePerm(req, 'lms.create'); const b = z.object({ sectionId: z.string(), classSubjectId: z.string(), teacherId: z.string().optional(), title: z.string().min(2).max(200), description: z.string().max(50_000).optional().nullable(), dueAt: z.string(), maxMarks: money.optional().nullable(), allowLate: z.coerce.boolean().optional(), latePenaltyPct: z.coerce.number().min(0).max(100).optional(), submissionType: z.enum(['file', 'text', 'both', 'offline', 'photo']).optional() }).parse(req.body); return { id: await app.lms.createAssignment(u.school_id, { ...b, teacherId: b.teacherId ?? await staffOf(u) }) }; }));
  api.get('/lms/assignments/:id/submissions', wrap(async req => { const u = requirePerm(req, 'lms.view'); return app.lms.submissions(u.school_id, req.params.id as string); }));
  api.post('/lms/submissions/:id/grade', wrap(async req => { const u = requirePerm(req, 'lms.edit'); const b = z.object({ marks: money, feedback: z.string().max(4000).optional().nullable() }).parse(req.body); return app.lms.grade(u.school_id, req.params.id as string, { ...b, gradedBy: u.id }); }));
  api.get('/lms/materials', wrap(async req => { const u = requirePerm(req, 'lms.view'); return app.lms.materials(u.school_id, { sectionId: q(req, 'sectionId'), classSubjectId: q(req, 'classSubjectId') }); }));
  api.post('/lms/materials', wrap(async req => { const u = requirePerm(req, 'lms.create'); const b = z.object({ classSubjectId: z.string().optional().nullable(), sectionId: z.string().optional().nullable(), title: z.string().min(1).max(200), materialType: z.enum(['note', 'slide', 'video', 'link', 'book', 'audio']), fileId: z.string().optional().nullable(), externalUrl: z.string().max(500).optional().nullable() }).parse(req.body); return { id: await app.lms.addMaterial(u.school_id, { ...b, uploadedBy: u.id }) }; }));
  api.get('/lms/classes', wrap(async req => { const u = requirePerm(req, 'lms.view'); return app.lms.onlineClasses(u.school_id, { sectionId: q(req, 'sectionId'), from: q(req, 'from') }); }));
  api.post('/lms/classes', wrap(async req => { const u = requirePerm(req, 'lms.create'); const b = z.object({ sectionId: z.string(), classSubjectId: z.string().optional().nullable(), teacherId: z.string().optional(), title: z.string().min(2).max(200), platform: z.enum(['zoom', 'google_meet', 'jitsi', 'bbb', 'youtube_live']).optional(), startsAt: z.string(), durationMin: z.coerce.number().int().min(5).max(300).optional(), joinUrl: z.string().max(500).optional().nullable() }).parse(req.body); return app.lms.scheduleClass(u.school_id, { ...b, teacherId: b.teacherId ?? await staffOf(u) }); }));
  api.post('/lms/classes/:id/attendance', wrap(async req => { const u = requirePerm(req, 'lms.edit'); const b = z.object({ rows: z.array(z.object({ studentId: z.string(), joinedAt: z.string().optional().nullable(), leftAt: z.string().optional().nullable(), minutes: z.coerce.number().int().min(0).max(600).optional().nullable() })).max(500) }).parse(req.body); return app.lms.classAttendance(u.school_id, req.params.id as string, b.rows); }));

  // ---------- engagement ----------
  api.get('/engagement/surveys', wrap(async req => { const u = requirePerm(req, 'communication.view'); return app.engagement.surveys(u.school_id); }));
  api.post('/engagement/surveys', wrap(async req => { const u = requirePerm(req, 'communication.create'); const b = z.object({ title: z.string().min(2).max(200), questions: z.array(z.object({ key: z.string().max(40), label: z.string().max(200), type: z.enum(['text', 'choice', 'rating', 'yes_no']).optional(), options: z.array(z.string().max(120)).optional() })).min(1).max(50), audience: z.object({ roles: z.array(z.string().max(40)).optional(), classIds: z.array(z.string()).optional(), guardians: z.coerce.boolean().optional() }).optional(), isAnonymous: z.coerce.boolean().optional(), opensAt: z.string().optional().nullable(), closesAt: z.string().optional().nullable() }).parse(req.body); return app.engagement.createSurvey(u.school_id, b, u.id); }));
  api.post('/engagement/surveys/:id/open', wrap(async req => { const u = requirePerm(req, 'communication.create'); return app.engagement.openSurvey(u.school_id, req.params.id as string); }));
  api.get('/engagement/surveys/:id/results', wrap(async req => { const u = requirePerm(req, 'communication.view'); return app.engagement.surveyResults(u.school_id, req.params.id as string); }));
  api.get('/engagement/newsletters', wrap(async req => { const u = requirePerm(req, 'communication.view'); return app.engagement.newsletters(u.school_id); }));
  api.post('/engagement/newsletters', wrap(async req => { const u = requirePerm(req, 'communication.create'); const b = z.object({ title: z.string().min(2).max(200), body: z.string().min(2).max(200_000), channel: z.enum(['email', 'whatsapp', 'sms']).optional(), audience: z.object({ guardians: z.coerce.boolean().optional(), roles: z.array(z.string().max(40)).optional() }).optional(), scheduledFor: z.string().optional().nullable() }).parse(req.body); return { id: await app.engagement.createNewsletter(u.school_id, b) }; }));
  api.post('/engagement/newsletters/:id/send', wrap(async req => { const u = requirePerm(req, 'communication.approve'); return app.engagement.sendNewsletter(u.school_id, req.params.id as string); }));
  api.get('/engagement/events', wrap(async req => { const u = requirePerm(req, 'events.view'); return app.engagement.events(u.school_id, q(req, 'from')); }));
  api.post('/engagement/events', wrap(async req => { const u = requirePerm(req, 'events.create'); const b = z.object({ title: z.string().min(2).max(200), eventType: z.enum(['sports', 'cultural', 'ptm', 'seminar', 'trip', 'ceremony', 'competition', 'workshop', 'other']), startsAt: z.string(), endsAt: z.string().optional().nullable(), venue: z.string().max(160).optional().nullable(), description: z.string().max(50_000).optional().nullable(), rsvpRequired: z.coerce.boolean().optional(), ticketPrice: money.optional().nullable(), ticketLimit: z.coerce.number().int().min(1).max(100_000).optional().nullable() }).parse(req.body); return { id: await app.engagement.createEvent(u.school_id, b) }; }));
  api.post('/engagement/events/:id/announce', wrap(async req => { const u = requirePerm(req, 'events.create'); return app.engagement.announceEvent(u.school_id, req.params.id as string); }));
  api.post('/engagement/events/:id/tickets', wrap(async req => { const u = requirePerm(req, 'events.create'); const b = z.object({ holderUserId: z.string().optional().nullable(), holderName: z.string().max(160).optional().nullable(), quantity: z.coerce.number().int().min(1).max(20).optional() }).parse(req.body); return app.engagement.issueTicket(u.school_id, req.params.id as string, b); }));
  api.post('/engagement/tickets/check-in', wrap(async req => { const u = requirePerm(req, 'events.edit'); const b = z.object({ qr: z.string().min(4).max(64) }).parse(req.body); return app.engagement.checkInTicket(u.school_id, b.qr); }));
  api.get('/engagement/clubs', wrap(async req => { const u = requirePerm(req, 'cocurricular.view'); return { clubs: await app.engagement.clubs(u.school_id), houses: await app.engagement.houseTable(u.school_id) }; }));
  api.post('/engagement/clubs', wrap(async req => { const u = requirePerm(req, 'cocurricular.create'); const b = z.object({ name: z.string().min(2).max(120), category: z.enum(['academic', 'sports', 'arts', 'social', 'tech', 'religious', 'other']).optional(), advisorId: z.string().optional().nullable(), meetingSchedule: z.string().max(120).optional().nullable(), description: z.string().max(4000).optional().nullable() }).parse(req.body); return { id: await app.engagement.createClub(u.school_id, b) }; }));
  api.post('/engagement/clubs/:id/members', wrap(async req => { const u = requirePerm(req, 'cocurricular.edit'); const b = z.object({ studentId: z.string(), role: z.enum(['member', 'secretary', 'president', 'captain']).optional() }).parse(req.body); return { id: await app.engagement.joinClub(u.school_id, req.params.id as string, b.studentId, b.role) }; }));
  api.post('/engagement/house-points', wrap(async req => { const u = requirePerm(req, 'cocurricular.edit'); const b = z.object({ houseId: z.string(), studentId: z.string().optional().nullable(), points: z.coerce.number().int().min(-1000).max(1000), reason: z.string().min(2).max(160) }).parse(req.body); return { id: await app.engagement.awardHousePoints(u.school_id, b) }; }));
  api.post('/engagement/achievements', wrap(async req => { const u = requirePerm(req, 'cocurricular.create'); const b = z.object({ studentId: z.string(), title: z.string().min(2).max(200), category: z.string().max(60).optional().nullable(), achievedOn: dateSchema.optional().nullable(), description: z.string().max(4000).optional().nullable(), isPublic: z.coerce.boolean().optional() }).parse(req.body); return { id: await app.engagement.addAchievement(u.school_id, b) }; }));
  api.get('/engagement/portfolio/:studentId', wrap(async req => { const u = requirePerm(req, 'cocurricular.view'); return app.engagement.portfolio(u.school_id, req.params.studentId as string); }));

  // ---------- the student's and guardian's own view ----------
  api.get('/portal/learning/:studentId', wrap(async req => {
    const u = requireUser(req);
    const student = await app.db.findOne<{ id: string; user_id: string | null }>('students', { id: req.params.studentId as string, school_id: u.school_id });
    if (!student) throw new HttpError(404, 'student not found');
    const guardian = await app.db.findOne<{ id: string }>('guardians', { school_id: u.school_id, user_id: u.id });
    const isChild = guardian && (await app.db.findOne('student_guardians', { student_id: student.id, guardian_id: guardian.id }));
    if (!isChild && student.user_id !== u.id) throw new HttpError(403, 'not your child');
    const enrolment = await app.db.findOne<{ section_id: string }>('student_enrollments', { student_id: student.id, status: 'active' } as never);
    const [courses, assignments, classes, portfolio, plan] = await Promise.all([
      app.db.query(`SELECT c.title, c.slug, e.progress_pct, e.completed_at FROM course_enrollments e JOIN courses c ON c.id = e.course_id WHERE e.student_id = ? ORDER BY e.progress_pct DESC`, [student.id]),
      enrolment ? app.db.query(`SELECT a.id, a.title, a.due_at, a.max_marks, s.status, s.marks, s.is_late FROM assignments a LEFT JOIN assignment_submissions s ON s.assignment_id = a.id AND s.student_id = ? WHERE a.section_id = ? AND a.status = 'published' ORDER BY a.due_at DESC LIMIT 50`, [student.id, enrolment.section_id]) : [],
      enrolment ? app.lms.onlineClasses(u.school_id, { sectionId: enrolment.section_id, from: new Date(Date.now() - 86_400_000).toISOString().slice(0, 19).replace('T', ' ') }) : [],
      app.engagement.portfolio(u.school_id, student.id),
      app.welfare.plan(u.school_id, student.id),
    ]);
    return { courses, assignments, classes, portfolio, plan };
  }));
  api.get('/portal/lessons/:id/quiz', wrap(async req => {
    const u = requireUser(req);
    const student = await app.db.findOne<{ id: string }>('students', { school_id: u.school_id, user_id: u.id });
    if (!student) throw new HttpError(403, 'only a student can sit their own quiz');
    return app.lms.lessonQuiz(u.school_id, req.params.id as string, student.id);
  }));
  api.post('/portal/lessons/:id/quiz', wrap(async req => {
    const u = requireUser(req);
    const student = await app.db.findOne<{ id: string }>('students', { school_id: u.school_id, user_id: u.id });
    if (!student) throw new HttpError(403, 'only a student can sit their own quiz');
    const b = z.object({ answers: z.array(z.coerce.number().int().min(0).nullable()).max(100) }).parse(req.body);
    return app.lms.submitQuiz(u.school_id, req.params.id as string, student.id, b.answers);
  }));
  api.post('/portal/assignments/:id/submit', wrap(async req => {
    const u = requireUser(req);
    const student = await app.db.findOne<{ id: string }>('students', { school_id: u.school_id, user_id: u.id });
    if (!student) throw new HttpError(403, 'only a student can hand in their own work');
    const b = z.object({ textAnswer: z.string().max(100_000).optional().nullable(), attachments: z.unknown().optional() }).parse(req.body ?? {});
    return app.lms.submit(u.school_id, { assignmentId: req.params.id as string, studentId: student.id, ...b });
  }));
  api.post('/portal/surveys/:id/answer', wrap(async req => {
    const u = requireUser(req);
    const b = z.object({ answers: z.record(z.string(), z.unknown()) }).parse(req.body);
    return app.engagement.answerSurvey(u.school_id, req.params.id as string, b.answers, u.id);
  }));
  api.post('/portal/events/:id/rsvp', wrap(async req => {
    const u = requireUser(req);
    const b = z.object({ response: z.enum(['yes', 'no', 'maybe']), guests: z.coerce.number().int().min(0).max(10).optional() }).parse(req.body);
    return app.engagement.rsvp(u.school_id, req.params.id as string, u.id, b.response, b.guests);
  }));
  api.post('/portal/actions/:id/acknowledge', wrap(async req => {
    const u = requireUser(req);
    return app.welfare.acknowledgeAction(u.school_id, req.params.id as string, u.id);
  }));
}
