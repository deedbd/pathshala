import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { AcademicService } from './academic.js';
import type { DocumentService } from './documents.js';
import { round } from './accounting.js';
import { HttpError, badRequest, notFound } from '../context.js';

export interface CourseInput { title: string; slug?: string; classSubjectId?: string | null; description?: string | null; teacherId?: string | null; isPaid?: boolean; price?: number }
export interface AssignmentInput { sectionId: string; classSubjectId: string; teacherId: string; title: string; description?: string | null; dueAt: string; maxMarks?: number | null; allowLate?: boolean; latePenaltyPct?: number; submissionType?: 'file' | 'text' | 'both' | 'offline' | 'photo' }

/** Who is reading or writing in a discussion. Staff see every course; a learner sees their own. */
export interface DiscussionViewer { userId: string | null; isStaff: boolean; studentId?: string | null }
export interface DiscussionPost { id: string; courseId: string; lessonId: string | null; parentId: string | null; authorId: string | null; author: string; body: string; isAnswer: boolean; upvotes: number; createdAt: string; replies: DiscussionPost[] }
export interface CoverageItem { id: string; title: string; kind: 'lesson' | 'quiz' | 'material'; lessonType?: string; courseId?: string; courseTitle?: string; courseSlug?: string; enrolled?: boolean; done?: boolean; durationMin?: number | null; materialType?: string; url?: string | null }
export interface UnitCoverage { unitId: string; unitTitle: string | null; lessons: CoverageItem[]; quizzes: CoverageItem[]; materials: CoverageItem[] }

/** A video counts as watched once this much of its running time has actually gone past the player. */
const WATCHED_ENOUGH_PCT = 85;
/** The most seconds one heartbeat may add to a lesson. See `watch`. */
const MAX_BEAT_SECONDS = 180;
/** Similarity is measured over overlapping runs of this many words. */
const SHINGLE_WORDS = 5;
/** Below this many words an answer is not compared at all — see `similarityReport`. */
const MIN_WORDS_TO_COMPARE = 40;
/** Pairs at or above this percentage are put in front of a person. Nothing happens automatically. */
const SIMILARITY_REPORT_AT = 40;
/** Pairs grow with the square of the class, and a shared-hosting request dies at about 30 s. */
const MAX_SUBMISSIONS_COMPARED = 300;

/**
 * The LMS: courses with modules and lessons, enrolment (automatic for a class-subject course),
 * per-lesson progress that rolls up to a percentage, video watch time that has to have actually
 * happened, assignments with a late penalty applied at marking time rather than argued about later,
 * a similarity check between text answers that only ever asks a teacher to look, study materials,
 * live classes with their join link, and discussion threads scoped to the reader's own course.
 * Reminders for unsubmitted work run hourly as one job.
 */
export class LmsService {
  constructor(private db: Db, private outbox: OutboxService, private notifications: NotificationService, private academic: AcademicService, private documents: DocumentService) {}

  // ---------- courses ----------
  async courses(schoolId: string, f: { status?: string; teacherId?: string } = {}) {
    const where = ['c.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.status) { where.push('c.status = ?'); params.push(f.status); }
    if (f.teacherId) { where.push('c.teacher_id = ?'); params.push(f.teacherId); }
    return this.db.query<Row>(`SELECT c.*, (SELECT COUNT(*) FROM course_enrollments e WHERE e.course_id = c.id) AS students,
      (SELECT COUNT(*) FROM lessons l JOIN course_modules m ON m.id = l.module_id WHERE m.course_id = c.id) AS lessons
      FROM courses c WHERE ${where.join(' AND ')} AND c.deleted_at IS NULL ORDER BY c.created_at DESC LIMIT 200`, params);
  }
  async createCourse(schoolId: string, c: CourseInput) {
    const slug = (c.slug ?? c.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 110) || ulid().slice(-8).toLowerCase();
    if (await this.db.findOne('courses', { school_id: schoolId, slug })) throw new HttpError(409, `a course already lives at /${slug}`, 'conflict');
    const id = ulid();
    await this.db.insert('courses', { id, school_id: schoolId, class_subject_id: c.classSubjectId ?? null, title: c.title, slug, description: c.description ?? null, cover_file_id: null, teacher_id: c.teacherId ?? null, is_paid: !!c.isPaid, price: c.price ?? 0, fee_head_id: null, status: 'draft', published_at: null });
    return { id, slug };
  }
  async addModule(schoolId: string, courseId: string, title: string, sequence?: number) {
    const n = await this.db.count('course_modules', { course_id: courseId });
    const id = ulid();
    await this.db.insert('course_modules', { id, school_id: schoolId, course_id: courseId, title, sequence: sequence ?? n + 1 });
    return id;
  }
  async addLesson(schoolId: string, l: { moduleId: string; title: string; lessonType: 'video' | 'note' | 'link' | 'file' | 'quiz' | 'assignment' | 'live'; body?: string | null; videoUrl?: string | null; fileId?: string | null; durationMin?: number | null; sequence?: number; isFreePreview?: boolean; unitId?: string | null }) {
    const n = await this.db.count('lessons', { module_id: l.moduleId });
    const id = ulid();
    await this.db.insert('lessons', { id, school_id: schoolId, module_id: l.moduleId, title: l.title, sequence: l.sequence ?? n + 1, lesson_type: l.lessonType, body: l.body ?? null, file_id: l.fileId ?? null, video_url: l.videoUrl ?? null, duration_min: l.durationMin ?? null, is_free_preview: !!l.isFreePreview, unit_id: l.unitId ?? null });
    return id;
  }
  async course(schoolId: string, id: string) {
    const c = await this.db.findOne<Row>('courses', { id, school_id: schoolId });
    if (!c) throw notFound('course');
    const modules = await this.db.findMany<Row>('course_modules', { course_id: id }, { orderBy: 'sequence ASC' });
    const lessons = await this.db.query<Row>(`SELECT l.* FROM lessons l JOIN course_modules m ON m.id = l.module_id WHERE m.course_id = ? ORDER BY m.sequence, l.sequence`, [id]);
    return { course: c, modules, lessons };
  }
  /**
   * Publishing a course tied to a class subject enrols that year's students of every section that
   * studies it — nobody types a class list into a course.
   */
  async publishCourse(schoolId: string, id: string) {
    const c = await this.db.findOne<Row>('courses', { id, school_id: schoolId });
    if (!c) throw notFound('course');
    await this.db.update('courses', { status: 'published', published_at: nowSql(), updated_at: nowSql() }, { id });
    let enrolled = 0;
    if (c.class_subject_id) {
      const cs = await this.db.findOne<Row>('class_subjects', { id: String(c.class_subject_id) });
      if (cs) {
        const students = await this.db.query<{ student_id: string }>(`SELECT e.student_id FROM student_enrollments e WHERE e.school_id = ? AND e.academic_year_id = ? AND e.class_id = ? AND e.status = 'active'`, [schoolId, String(cs.academic_year_id), String(cs.class_id)]);
        for (const s of students) if (await this.enrol(schoolId, id, String(s.student_id))) enrolled++;
      }
    }
    await this.outbox.emitNow({ type: 'course.published', schoolId, aggregateType: 'lms.course', aggregateId: id, payload: { courseId: id, title: String(c.title), enrolled } });
    return { id, enrolled };
  }
  async enrol(schoolId: string, courseId: string, studentId: string) {
    if (await this.db.findOne('course_enrollments', { course_id: courseId, student_id: studentId })) return false;
    await this.db.insert('course_enrollments', { id: ulid(), school_id: schoolId, course_id: courseId, student_id: studentId, enrolled_at: nowSql(), progress_pct: 0, completed_at: null, certificate_doc_id: null });
    return true;
  }

  // ---------- progress ----------
  /** A lesson marked complete moves the course percentage; finishing every lesson closes it. */
  async markProgress(schoolId: string, p: { lessonId: string; studentId: string; status?: 'not_started' | 'in_progress' | 'completed'; secondsWatched?: number; lastPosition?: number }) {
    const lesson = await this.db.findOne<Row>('lessons', { id: p.lessonId, school_id: schoolId });
    if (!lesson) throw notFound('lesson');
    const module = await this.db.findOne<Row>('course_modules', { id: String(lesson.module_id) });
    const courseId = String(module?.course_id);
    if (!(await this.db.findOne('course_enrollments', { course_id: courseId, student_id: p.studentId }))) throw new HttpError(403, 'this student is not enrolled on the course', 'forbidden');
    const status = p.status ?? 'completed';
    const ex = await this.db.findOne<Row>('lesson_progress', { lesson_id: p.lessonId, student_id: p.studentId });
    const row = { school_id: schoolId, lesson_id: p.lessonId, student_id: p.studentId, status, seconds_watched: p.secondsWatched ?? Number(ex?.seconds_watched ?? 0), last_position: p.lastPosition ?? Number(ex?.last_position ?? 0), completed_at: status === 'completed' ? nowSql() : null };
    if (ex) await this.db.update('lesson_progress', row, { id: String(ex.id) });
    else await this.db.insert('lesson_progress', { id: ulid(), ...row });
    const total = Number((await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM lessons l JOIN course_modules m ON m.id = l.module_id WHERE m.course_id = ?`, [courseId]))[0]?.n ?? 0);
    const done = Number((await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM lesson_progress p JOIN lessons l ON l.id = p.lesson_id JOIN course_modules m ON m.id = l.module_id WHERE m.course_id = ? AND p.student_id = ? AND p.status = 'completed'`, [courseId, p.studentId]))[0]?.n ?? 0);
    const pct = total ? round((done * 100) / total) : 0;
    await this.db.execute(`UPDATE course_enrollments SET progress_pct = ?, completed_at = ?, updated_at = ? WHERE course_id = ? AND student_id = ?`, [pct, pct >= 100 ? nowSql() : null, nowSql(), courseId, p.studentId]);
    // the certificate is part of finishing, not a separate errand for the office
    let certificateId: string | null = null;
    if (pct >= 100) certificateId = (await this.issueCourseCertificate(schoolId, courseId, p.studentId).catch(() => null))?.certificateId ?? null;
    return { courseId, progressPct: pct, lessonsDone: done, lessons: total, certificateId };
  }

  /**
   * A heartbeat from the video player: how many seconds went past since the last one, and where the
   * needle is now. Two things make the number mean something.
   *
   * A beat may only ever add a few minutes. Without that cap a page can post "3600 seconds" once and
   * finish an hour-long lesson nobody sat through — which is exactly what a student does when the
   * certificate at the end of the course is the point. The running time is the other ceiling: total
   * watch time can never exceed the lesson's own length however many beats arrive.
   *
   * `last_position` is where the needle is, and dragging it moves the needle without watching
   * anything, so it is kept only to resume where the student left off and never counted towards
   * completion. A lesson with no running time on it cannot be measured at all, and says so instead
   * of pretending to a percentage.
   */
  async watch(schoolId: string, p: { lessonId: string; studentId: string; seconds?: number; position?: number }) {
    const lesson = await this.db.findOne<Row>('lessons', { id: p.lessonId, school_id: schoolId });
    if (!lesson) throw notFound('lesson');
    const before = await this.db.findOne<Row>('lesson_progress', { lesson_id: p.lessonId, student_id: p.studentId });
    const beat = Math.min(Math.max(0, Math.round(Number(p.seconds ?? 0) || 0)), MAX_BEAT_SECONDS);
    const durationSec = Math.max(0, Math.round(Number(lesson.duration_min ?? 0) * 60));
    const already = Math.max(0, Number(before?.seconds_watched ?? 0));
    const total = durationSec ? Math.min(already + beat, durationSec) : already + beat;
    const position = Math.max(0, Math.round(Number(p.position ?? before?.last_position ?? 0) || 0));
    const watchedPct = durationSec ? round(Math.min(100, (total * 100) / durationSec)) : null;
    const done = watchedPct !== null && watchedPct >= WATCHED_ENOUGH_PCT;
    // a lesson already finished stays finished: a quiz lesson is completed by passing it, and a
    // stray beat from a player left open on the page must not take that back and, with it, the
    // course percentage and the certificate that followed
    const wasDone = String(before?.status ?? '') === 'completed';
    const status = done || wasDone ? 'completed' : total > 0 ? 'in_progress' : 'not_started';
    const progress = await this.markProgress(schoolId, { lessonId: p.lessonId, studentId: p.studentId, status, secondsWatched: total, lastPosition: position });
    // only the crossing is an event; a beat every thirty seconds would otherwise flood the outbox
    if (done && !wasDone) {
      await this.outbox.emitNow({ type: 'lesson.completed', schoolId, aggregateType: 'lms.lesson', aggregateId: p.lessonId, payload: { lessonId: p.lessonId, courseId: progress.courseId, studentId: p.studentId, watchedPct } });
    }
    return {
      lessonId: p.lessonId, secondsWatched: total, lastPosition: position, watchedPct, requiredPct: WATCHED_ENOUGH_PCT, status,
      note: watchedPct === null ? 'this lesson carries no running time, so watching cannot be measured — it is completed by hand' : null,
      progress,
    };
  }

  /**
   * What a teacher wants to know about a video course: for each lesson, how many started it, how many
   * actually watched it through, and how far the average student got. The average is over the
   * students who opened the lesson at all — mixing in the ones who never started it would make a
   * lesson everybody finished look half-watched.
   */
  async watchReport(schoolId: string, courseId: string) {
    const course = await this.db.findOne<Row>('courses', { id: courseId, school_id: schoolId });
    if (!course) throw notFound('course');
    const enrolled = await this.db.count('course_enrollments', { course_id: courseId });
    const rows = await this.db.query<Row>(`SELECT l.id, l.title, l.lesson_type, l.duration_min, m.sequence AS module_sequence, l.sequence,
        COUNT(p.id) AS started, SUM(CASE WHEN p.status = 'completed' THEN 1 ELSE 0 END) AS completed, AVG(p.seconds_watched) AS avg_seconds
      FROM lessons l JOIN course_modules m ON m.id = l.module_id
      LEFT JOIN lesson_progress p ON p.lesson_id = l.id
      WHERE l.school_id = ? AND m.course_id = ?
      GROUP BY l.id, l.title, l.lesson_type, l.duration_min, m.sequence, l.sequence
      ORDER BY m.sequence, l.sequence`, [schoolId, courseId]);
    return {
      courseId, title: String(course.title), enrolled, requiredPct: WATCHED_ENOUGH_PCT,
      lessons: rows.map(r => {
        const durationSec = Math.round(Number(r.duration_min ?? 0) * 60);
        const avgSeconds = Math.round(Number(r.avg_seconds ?? 0));
        return {
          lessonId: String(r.id), title: String(r.title), lessonType: String(r.lesson_type), durationMin: r.duration_min === null ? null : Number(r.duration_min),
          started: Number(r.started ?? 0), completed: Number(r.completed ?? 0), notStarted: Math.max(0, enrolled - Number(r.started ?? 0)),
          avgSeconds, avgWatchedPct: durationSec ? round(Math.min(100, (avgSeconds * 100) / durationSec)) : null,
        };
      }),
    };
  }
  // ---------- the quiz inside a lesson ----------
  /**
   * A lesson quiz is a handful of multiple-choice questions kept with the lesson itself, not a formal
   * exam: it exists so a student finds out whether they followed the lesson. The answers live in the
   * lesson body and never leave the server until the attempt is submitted.
   */
  async setLessonQuiz(schoolId: string, lessonId: string, quiz: { passMark?: number; maxAttempts?: number; questions: { text: string; options: string[]; answer: number; marks?: number }[] }) {
    const lesson = await this.db.findOne<Row>('lessons', { id: lessonId, school_id: schoolId });
    if (!lesson) throw notFound('lesson');
    if (!quiz.questions.length) throw badRequest('a quiz needs at least one question');
    if (quiz.questions.length > 100) throw badRequest('a lesson quiz holds at most 100 questions');
    quiz.questions.forEach((q, i) => {
      if (q.options.length < 2) throw badRequest(`question ${i + 1} needs at least two options`);
      if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length) throw badRequest(`question ${i + 1} points at an option that is not there`);
    });
    const body = JSON.stringify({ passMark: quiz.passMark ?? 50, maxAttempts: quiz.maxAttempts ?? 3, questions: quiz.questions.map(q => ({ ...q, marks: q.marks ?? 1 })) });
    await this.db.update('lessons', { lesson_type: 'quiz', body, updated_at: nowSql() }, { id: lessonId });
    return { lessonId, questions: quiz.questions.length, maxScore: quiz.questions.reduce((a, q) => a + (q.marks ?? 1), 0) };
  }
  /** What the student is shown: the questions, never which option is right. */
  async lessonQuiz(schoolId: string, lessonId: string, studentId?: string) {
    const lesson = await this.db.findOne<Row>('lessons', { id: lessonId, school_id: schoolId });
    if (!lesson) throw notFound('lesson');
    const quiz = this.quizOf(lesson);
    const attempts = studentId ? await this.db.findMany<Row>('lesson_quiz_attempts', { lesson_id: lessonId, student_id: studentId }, { orderBy: 'attempt_no DESC' }) : [];
    return {
      lessonId, title: String(lesson.title), passMark: quiz.passMark, maxAttempts: quiz.maxAttempts,
      questions: quiz.questions.map((q, i) => ({ no: i + 1, text: q.text, options: q.options, marks: q.marks })),
      maxScore: quiz.questions.reduce((a, q) => a + q.marks, 0),
      attempts: attempts.map(a => ({ attemptNo: Number(a.attempt_no), score: Number(a.score), passed: !!Number(a.passed), submittedAt: String(a.submitted_at) })),
      attemptsLeft: Math.max(0, quiz.maxAttempts - attempts.length),
    };
  }
  /**
   * Grades the attempt. The correct answers come back with the result, because the point is to learn
   * what was got wrong — and only after the attempt is in, so the page cannot be read for them first.
   */
  async submitQuiz(schoolId: string, lessonId: string, studentId: string, answers: (number | null)[]) {
    const lesson = await this.db.findOne<Row>('lessons', { id: lessonId, school_id: schoolId });
    if (!lesson) throw notFound('lesson');
    const quiz = this.quizOf(lesson);
    const module = await this.db.findOne<Row>('course_modules', { id: String(lesson.module_id) });
    if (!(await this.db.findOne('course_enrollments', { course_id: String(module?.course_id), student_id: studentId }))) throw new HttpError(403, 'this student is not enrolled on the course', 'forbidden');
    const before = await this.db.findMany<Row>('lesson_quiz_attempts', { lesson_id: lessonId, student_id: studentId });
    if (before.length >= quiz.maxAttempts) throw new HttpError(409, `this quiz allows ${quiz.maxAttempts} attempts`, 'conflict');
    const maxScore = quiz.questions.reduce((a, q) => a + q.marks, 0);
    let score = 0;
    const marked = quiz.questions.map((q, i) => {
      const given = answers[i] ?? null;
      const right = given === q.answer;
      if (right) score = round(score + q.marks);
      return { no: i + 1, given, correct: q.answer, right, marks: right ? q.marks : 0 };
    });
    const pct = maxScore ? round((score * 100) / maxScore) : 0;
    const passed = pct >= quiz.passMark;
    const attemptNo = before.length + 1;
    await this.db.insert('lesson_quiz_attempts', { id: ulid(), school_id: schoolId, lesson_id: lessonId, student_id: studentId, attempt_no: attemptNo, answers: answers as never, score, max_score: maxScore, passed, submitted_at: nowSql() });
    // passing is what completes the lesson; a failed attempt leaves it in progress
    const progress = await this.markProgress(schoolId, { lessonId, studentId, status: passed ? 'completed' : 'in_progress' });
    return { attemptNo, score, maxScore, percent: pct, passed, attemptsLeft: Math.max(0, quiz.maxAttempts - attemptNo), marked, progress };
  }
  private quizOf(lesson: Row) {
    const quiz = json<{ passMark?: number; maxAttempts?: number; questions?: { text: string; options: string[]; answer: number; marks: number }[] }>(lesson.body);
    if (!quiz?.questions?.length) throw badRequest('this lesson has no quiz on it');
    return { passMark: quiz.passMark ?? 50, maxAttempts: quiz.maxAttempts ?? 3, questions: quiz.questions };
  }

  // ---------- the certificate at the end ----------
  /**
   * A certificate for finishing the course. It is issued once, when every lesson is done, and the
   * enrolment keeps the document id so the student can find it again — and so the school can tell a
   * genuine certificate from a screenshot by its verification code.
   */
  async issueCourseCertificate(schoolId: string, courseId: string, studentId: string) {
    const enrolment = await this.db.findOne<Row>('course_enrollments', { school_id: schoolId, course_id: courseId, student_id: studentId });
    if (!enrolment) throw notFound('enrolment');
    if (enrolment.certificate_doc_id) return { certificateId: String(enrolment.certificate_doc_id), alreadyIssued: true };
    if (Number(enrolment.progress_pct) < 100) throw new HttpError(409, `the course is ${Number(enrolment.progress_pct)}% done; a certificate comes at the end`, 'conflict');
    const course = await this.db.findOne<Row>('courses', { id: courseId });
    const student = await this.db.findOne<Row>('students', { id: studentId });
    const issued = await this.documents.issue(schoolId, {
      docType: 'certificate', personType: 'student', studentId,
      data: {
        name: `${student?.first_name ?? ''} ${student?.last_name ?? ''}`.trim(), admission_no: String(student?.admission_no ?? ''),
        course: String(course?.title ?? ''), completed_on: String(enrolment.completed_at ?? nowSql()).slice(0, 10),
      },
      entityType: 'lms.course', entityId: courseId,
    });
    await this.db.update('course_enrollments', { certificate_doc_id: issued.id, updated_at: nowSql() }, { id: String(enrolment.id) });
    await this.notifications.notify({ schoolId, address: null, channels: ['in_app', 'push'], eventKey: 'lms.certificate_issued', data: { course: String(course?.title ?? '') }, title: 'Course certificate', body: `${student?.first_name} finished ${course?.title}. The certificate is ready.`, entityType: 'lms.course', entityId: courseId });
    return { certificateId: issued.id, fileId: issued.fileId, documentNo: issued.documentNo, verificationCode: issued.verificationCode };
  }

  async progress(schoolId: string, courseId: string) {
    return this.db.query<Row>(`SELECT e.*, s.first_name, s.last_name, s.admission_no FROM course_enrollments e JOIN students s ON s.id = e.student_id WHERE e.school_id = ? AND e.course_id = ? ORDER BY e.progress_pct DESC, s.first_name`, [schoolId, courseId]);
  }

  // ---------- assignments ----------
  /** E1: publishing tells the section's students and their guardians. */
  async createAssignment(schoolId: string, a: AssignmentInput) {
    const id = ulid();
    await this.db.insert('assignments', {
      id, school_id: schoolId, section_id: a.sectionId, class_subject_id: a.classSubjectId, teacher_id: a.teacherId, lesson_id: null, title: a.title, description: a.description ?? null,
      attachments: null, assigned_at: nowSql(), due_at: a.dueAt, max_marks: a.maxMarks ?? 20, allow_late: a.allowLate ?? true, late_penalty_pct: a.latePenaltyPct ?? 10,
      submission_type: a.submissionType ?? 'file', status: 'published', reminder_sent_at: null,
    });
    await this.outbox.emitNow({ type: 'assignment.published', schoolId, aggregateType: 'lms.assignment', aggregateId: id, payload: { assignmentId: id, sectionId: a.sectionId, title: a.title, dueAt: a.dueAt } });
    await this.notifySection(schoolId, a.sectionId, 'lms.assignment_published', 'New assignment', `${a.title} — due ${a.dueAt.slice(0, 16)}.`, id);
    return id;
  }
  async assignments(schoolId: string, f: { sectionId?: string; teacherId?: string; openOnly?: boolean } = {}) {
    const where = ['a.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.sectionId) { where.push('a.section_id = ?'); params.push(f.sectionId); }
    if (f.teacherId) { where.push('a.teacher_id = ?'); params.push(f.teacherId); }
    if (f.openOnly) { where.push('a.due_at >= ?'); params.push(nowSql()); }
    return this.db.query<Row>(`SELECT a.*, sec.name AS section_name, sub.name AS subject_name, (SELECT COUNT(*) FROM assignment_submissions s WHERE s.assignment_id = a.id) AS submissions
      FROM assignments a JOIN sections sec ON sec.id = a.section_id JOIN class_subjects cs ON cs.id = a.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
      WHERE ${where.join(' AND ')} ORDER BY a.due_at DESC LIMIT 300`, params);
  }
  /** A late submission is accepted or refused by the assignment's own rule, not by the marker. */
  async submit(schoolId: string, a: { assignmentId: string; studentId: string; textAnswer?: string | null; attachments?: unknown }) {
    const assignment = await this.db.findOne<Row>('assignments', { id: a.assignmentId, school_id: schoolId });
    if (!assignment) throw notFound('assignment');
    if (assignment.status === 'closed') throw new HttpError(409, 'this assignment is closed', 'closed');
    const late = nowSql() > String(assignment.due_at);
    if (late && !Number(assignment.allow_late)) throw new HttpError(409, 'the deadline has passed and late work is not accepted', 'late');
    const ex = await this.db.findOne<Row>('assignment_submissions', { assignment_id: a.assignmentId, student_id: a.studentId });
    if (ex && ex.status === 'graded') throw new HttpError(409, 'this submission has already been marked', 'graded');
    const row = { school_id: schoolId, assignment_id: a.assignmentId, student_id: a.studentId, submitted_at: nowSql(), is_late: late, text_answer: a.textAnswer ?? null, attachments: (a.attachments ?? null) as never, marks: null, feedback: null, similarity_pct: null, graded_by: null, graded_at: null, status: 'submitted' };
    const id = (ex?.id as string) ?? ulid();
    if (ex) await this.db.update('assignment_submissions', { ...row, updated_at: nowSql() }, { id });
    else await this.db.insert('assignment_submissions', { id, ...row });
    return { id, late };
  }
  /** The late penalty comes off here, once, and is visible in the feedback. */
  async grade(schoolId: string, submissionId: string, g: { marks: number; feedback?: string | null; gradedBy?: string | null }) {
    const s = await this.db.findOne<Row>('assignment_submissions', { id: submissionId, school_id: schoolId });
    if (!s) throw notFound('submission');
    const a = await this.db.findOne<Row>('assignments', { id: String(s.assignment_id) });
    const max = Number(a?.max_marks ?? 0);
    if (max && g.marks > max) throw badRequest(`${g.marks} is more than the ${max} marks this assignment carries`);
    const penaltyPct = Number(s.is_late ? a?.late_penalty_pct ?? 0 : 0);
    const marks = round(g.marks - (g.marks * penaltyPct) / 100);
    const feedback = penaltyPct ? `${g.feedback ?? ''}${g.feedback ? ' ' : ''}(${penaltyPct}% deducted for a late submission)`.trim() : g.feedback ?? null;
    await this.db.update('assignment_submissions', { marks, feedback, graded_by: g.gradedBy ?? null, graded_at: nowSql(), status: 'graded', updated_at: nowSql() }, { id: submissionId });
    const student = await this.db.findOne<Row>('students', { id: String(s.student_id) });
    await this.notifyGuardians(schoolId, String(s.student_id), 'lms.assignment_graded', 'Assignment marked', `${student?.first_name}: ${a?.title} — ${marks}/${max}.`, submissionId);
    return { id: submissionId, marks, penaltyPct };
  }
  async submissions(schoolId: string, assignmentId: string) {
    return this.db.query<Row>(`SELECT s.*, st.first_name, st.last_name, st.current_roll_no FROM assignment_submissions s JOIN students st ON st.id = s.student_id WHERE s.school_id = ? AND s.assignment_id = ? ORDER BY st.current_roll_no`, [schoolId, assignmentId]);
  }

  // ---------- materials, live classes, discussion ----------
  async addMaterial(schoolId: string, m: { classSubjectId?: string | null; sectionId?: string | null; unitId?: string | null; title: string; materialType: 'note' | 'slide' | 'video' | 'link' | 'book' | 'audio'; fileId?: string | null; externalUrl?: string | null; uploadedBy?: string | null }) {
    const id = ulid();
    await this.db.insert('study_materials', { id, school_id: schoolId, class_subject_id: m.classSubjectId ?? null, section_id: m.sectionId ?? null, unit_id: m.unitId ?? null, title: m.title, material_type: m.materialType, file_id: m.fileId ?? null, external_url: m.externalUrl ?? null, uploaded_by: m.uploadedBy ?? null, published_at: nowSql(), view_count: 0 });
    if (m.sectionId) await this.notifySection(schoolId, m.sectionId, 'lms.material_added', 'New material', m.title, id);
    return id;
  }
  async materials(schoolId: string, f: { sectionId?: string; classSubjectId?: string } = {}) {
    const where: Row = { school_id: schoolId };
    if (f.sectionId) where.section_id = f.sectionId;
    if (f.classSubjectId) where.class_subject_id = f.classSubjectId;
    return this.db.findMany<Row>('study_materials', where, { orderBy: 'published_at DESC', limit: 200 });
  }
  async scheduleClass(schoolId: string, c: { sectionId: string; classSubjectId?: string | null; teacherId: string; title: string; platform?: 'zoom' | 'google_meet' | 'jitsi' | 'bbb' | 'youtube_live'; startsAt: string; durationMin?: number; joinUrl?: string | null }) {
    const id = ulid();
    const platform = c.platform ?? 'jitsi';
    // Jitsi needs no account and no API call, which is what a school on shared hosting can actually use
    const meetingId = `pathshala-${id.slice(-10).toLowerCase()}`;
    const joinUrl = c.joinUrl ?? (platform === 'jitsi' ? `https://meet.jit.si/${meetingId}` : null);
    await this.db.insert('online_classes', { id, school_id: schoolId, section_id: c.sectionId, class_subject_id: c.classSubjectId ?? null, teacher_id: c.teacherId, slot_id: null, title: c.title, platform, meeting_id: meetingId, join_url: joinUrl, host_url: joinUrl, starts_at: c.startsAt, duration_min: c.durationMin ?? 40, recording_url: null, status: 'scheduled', reminder_sent_at: null });
    return { id, joinUrl };
  }
  async onlineClasses(schoolId: string, f: { sectionId?: string; from?: string } = {}) {
    const where = ['c.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.sectionId) { where.push('c.section_id = ?'); params.push(f.sectionId); }
    if (f.from) { where.push('c.starts_at >= ?'); params.push(f.from); }
    return this.db.query<Row>(`SELECT c.*, s.name AS section_name FROM online_classes c JOIN sections s ON s.id = c.section_id WHERE ${where.join(' AND ')} ORDER BY c.starts_at DESC LIMIT 200`, params);
  }
  /** E5: the platform's webhook says who was in the room and for how long. */
  async classAttendance(schoolId: string, onlineClassId: string, rows: { studentId: string; joinedAt?: string | null; leftAt?: string | null; minutes?: number | null }[]) {
    const c = await this.db.findOne<Row>('online_classes', { id: onlineClassId, school_id: schoolId });
    if (!c) throw notFound('online class');
    let saved = 0;
    for (const r of rows) {
      const minutes = r.minutes ?? (r.joinedAt && r.leftAt ? Math.max(0, Math.round((Date.parse(`${r.leftAt.replace(' ', 'T')}Z`) - Date.parse(`${r.joinedAt.replace(' ', 'T')}Z`)) / 60_000)) : null);
      const ex = await this.db.findOne<Row>('online_class_attendance', { online_class_id: onlineClassId, student_id: r.studentId });
      const row = { school_id: schoolId, online_class_id: onlineClassId, student_id: r.studentId, joined_at: r.joinedAt ?? null, left_at: r.leftAt ?? null, minutes };
      if (ex) await this.db.update('online_class_attendance', row, { id: String(ex.id) });
      else await this.db.insert('online_class_attendance', { id: ulid(), ...row });
      saved++;
    }
    await this.db.update('online_classes', { status: 'ended', updated_at: nowSql() }, { id: onlineClassId });
    return { saved };
  }
  /**
   * Who may read and write in a course's threads. Staff see every course; a student — or the guardian
   * reading on that student's behalf — sees only the courses that student is enrolled on. Without
   * this a guardian who guessed a course id would read another class's questions, and a question
   * carries the asker's name and usually what they got wrong.
   */
  private async assertCourseVisible(schoolId: string, courseId: string, viewer?: DiscussionViewer) {
    const course = await this.db.findOne<Row>('courses', { id: courseId, school_id: schoolId });
    if (!course) throw notFound('course');
    if (!viewer || viewer.isStaff) return course;
    if (!viewer.studentId) throw new HttpError(403, 'these threads belong to a course, and this account is not on one', 'forbidden');
    if (!(await this.db.findOne('course_enrollments', { course_id: courseId, student_id: viewer.studentId }))) throw new HttpError(403, 'this discussion belongs to a course this student is not enrolled on', 'forbidden');
    return course;
  }
  private async courseOfLesson(schoolId: string, lessonId: string) {
    const lesson = await this.db.findOne<Row>('lessons', { id: lessonId, school_id: schoolId });
    if (!lesson) throw notFound('lesson');
    const module = await this.db.findOne<Row>('course_modules', { id: String(lesson.module_id) });
    if (!module) throw notFound('the lesson’s course');
    return String(module.course_id);
  }

  /**
   * A question or a reply. A reply takes its course and lesson from the post it answers, so a thread
   * cannot be dragged into another course by sending a different courseId alongside the reply — and
   * a reply to a reply still hangs off the original question, which keeps a thread two levels deep
   * and readable on a phone.
   */
  async ask(schoolId: string, d: { courseId?: string | null; lessonId?: string | null; parentId?: string | null; body: string; authorId?: string | null }, viewer?: DiscussionViewer) {
    let courseId = d.courseId ?? null;
    let lessonId = d.lessonId ?? null;
    let parentId = d.parentId ?? null;
    let parent: Row | null = null;
    if (parentId) {
      parent = await this.db.findOne<Row>('discussions', { id: parentId, school_id: schoolId });
      if (!parent) throw notFound('the post being replied to');
      courseId = (parent.course_id as string) ?? null;
      lessonId = (parent.lesson_id as string) ?? null;
      parentId = (parent.parent_id as string) ?? String(parent.id);
    }
    if (!courseId && lessonId) courseId = await this.courseOfLesson(schoolId, lessonId);
    if (!courseId) throw badRequest('a question belongs to a course or to a lesson; name one of them');
    await this.assertCourseVisible(schoolId, courseId, viewer);
    const id = ulid();
    await this.db.insert('discussions', { id, school_id: schoolId, course_id: courseId, lesson_id: lessonId, author_id: d.authorId ?? null, parent_id: parentId, body: d.body, is_answer: false, upvotes: 0 });
    if (parent) {
      await this.outbox.emitNow({ type: 'discussion.replied', schoolId, aggregateType: 'lms.discussion', aggregateId: id, payload: { discussionId: id, threadId: parentId as string, courseId, lessonId, authorId: d.authorId ?? null } });
      // the person who asked is the one waiting; a thread nobody is told about is a suggestion box
      const root = String(parent.id) === String(parentId) ? parent : await this.db.findOne<Row>('discussions', { id: parentId as string });
      const askerId = (root?.author_id as string) ?? null;
      if (askerId && askerId !== d.authorId) {
        const course = await this.db.findOne<Row>('courses', { id: courseId });
        await this.notifications.notify({ schoolId, userId: askerId, channels: ['in_app', 'push'], eventKey: 'lms.discussion_reply', title: 'Reply to your question', body: `${String(course?.title ?? 'A course')}: ${d.body.slice(0, 140)}`, entityType: 'lms.discussion', entityId: id });
      }
    }
    return id;
  }
  /**
   * A course's (or one lesson's) threads, questions with their replies nested underneath. Second
   * precision ties on a busy thread, so the ULID breaks it — ULIDs sort by the time they were made.
   */
  async threads(schoolId: string, f: { courseId?: string | null; lessonId?: string | null }, viewer?: DiscussionViewer) {
    let courseId = f.courseId ?? null;
    if (!courseId && f.lessonId) courseId = await this.courseOfLesson(schoolId, f.lessonId);
    if (!courseId) throw badRequest('name the course or the lesson whose threads you want');
    const course = await this.assertCourseVisible(schoolId, courseId, viewer);
    const where = ['d.school_id = ?', 'd.course_id = ?'];
    const params: unknown[] = [schoolId, courseId];
    if (f.lessonId) { where.push('d.lesson_id = ?'); params.push(f.lessonId); }
    const rows = await this.db.query<Row>(`SELECT d.*, u.display_name FROM discussions d LEFT JOIN users u ON u.id = d.author_id
      WHERE ${where.join(' AND ')} ORDER BY d.created_at ASC, d.id ASC LIMIT 500`, params);
    const byId = new Map<string, DiscussionPost>();
    for (const r of rows) {
      byId.set(String(r.id), {
        id: String(r.id), courseId, lessonId: (r.lesson_id as string) ?? null, parentId: (r.parent_id as string) ?? null,
        authorId: (r.author_id as string) ?? null, author: String(r.display_name ?? 'Someone'), body: String(r.body),
        isAnswer: !!Number(r.is_answer), upvotes: Number(r.upvotes ?? 0), createdAt: String(r.created_at), replies: [],
      });
    }
    const threads: DiscussionPost[] = [];
    for (const post of byId.values()) {
      const parent = post.parentId ? byId.get(post.parentId) : undefined;
      if (parent) parent.replies.push(post); else threads.push(post);
    }
    return { courseId, courseTitle: String(course.title), lessonId: f.lessonId ?? null, posts: rows.length, threads };
  }
  /** Kept for callers that want the flat rows; `threads` is what a page should ask for. */
  async discussion(schoolId: string, courseId: string) {
    return this.db.query<Row>(`SELECT d.*, u.display_name FROM discussions d LEFT JOIN users u ON u.id = d.author_id WHERE d.school_id = ? AND d.course_id = ? ORDER BY d.created_at ASC, d.id ASC LIMIT 500`, [schoolId, courseId]);
  }
  async upvote(schoolId: string, id: string, viewer?: DiscussionViewer) {
    const post = await this.db.findOne<Row>('discussions', { id, school_id: schoolId });
    if (!post) throw notFound('post');
    if (post.course_id) await this.assertCourseVisible(schoolId, String(post.course_id), viewer);
    // counted in the database rather than read-then-written: two students voting at once both count
    await this.db.execute(`UPDATE discussions SET upvotes = upvotes + 1, updated_at = ? WHERE id = ? AND school_id = ?`, [nowSql(), id, schoolId]);
    return { id, upvotes: Number(post.upvotes ?? 0) + 1 };
  }
  async markAnswer(schoolId: string, id: string) { return this.db.update('discussions', { is_answer: true, updated_at: nowSql() }, { id, school_id: schoolId }); }

  // ---------- how alike two answers are ----------
  /**
   * Word-shingle Jaccard similarity between the text answers of one assignment: the fraction of
   * five-word runs the two answers share. It runs entirely on this server, needs no service and no
   * model, and works the same on Bangla as on English.
   *
   * What it is *not* is an accusation. Two students who learned the same definition from the same
   * textbook will look alike and have done nothing wrong, so this never touches a mark, never
   * changes a submission's status and never tells a guardian anything. It puts a pair in front of the
   * teacher and asks them to read both. Short answers are skipped for the same reason: below about
   * forty words there is only one sensible way to write the sentence, and a percentage over "the
   * mitochondrion is the powerhouse of the cell" measures the language, not the student.
   */
  async similarityReport(schoolId: string, assignmentId: string, opts: { minWords?: number; reportAt?: number } = {}) {
    const assignment = await this.db.findOne<Row>('assignments', { id: assignmentId, school_id: schoolId });
    if (!assignment) throw notFound('assignment');
    const minWords = Math.max(SHINGLE_WORDS + 1, Math.round(opts.minWords ?? MIN_WORDS_TO_COMPARE));
    const reportAt = opts.reportAt ?? SIMILARITY_REPORT_AT;
    const rows = await this.db.query<Row>(`SELECT s.id, s.student_id, s.text_answer, st.first_name, st.last_name, st.current_roll_no
      FROM assignment_submissions s JOIN students st ON st.id = s.student_id
      WHERE s.school_id = ? AND s.assignment_id = ? ORDER BY s.submitted_at ASC, s.id ASC LIMIT ${MAX_SUBMISSIONS_COMPARED}`, [schoolId, assignmentId]);

    type Doc = { submissionId: string; studentId: string; name: string; roll: string | null; words: string[]; shingles: Set<string> };
    const docs: Doc[] = [];
    const skipped: { submissionId: string; studentId: string; name: string; words: number; reason: string }[] = [];
    for (const r of rows) {
      const name = `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim();
      const words = wordsOf(String(r.text_answer ?? ''));
      if (words.length < minWords) {
        skipped.push({
          submissionId: String(r.id), studentId: String(r.student_id), name, words: words.length,
          reason: words.length ? `only ${words.length} words — too short to tell copying from a shared definition` : 'nothing was typed; this work came in as a file',
        });
        continue;
      }
      docs.push({ submissionId: String(r.id), studentId: String(r.student_id), name, roll: r.current_roll_no == null ? null : String(r.current_roll_no), words, shingles: shinglesOf(words) });
    }

    const highest = new Map<string, number>();
    const pairs: { similarityPct: number; a: { submissionId: string; studentId: string; name: string; roll: string | null }; b: { submissionId: string; studentId: string; name: string; roll: string | null }; sharedPhrases: string[] }[] = [];
    for (let i = 0; i < docs.length; i++) {
      for (let j = i + 1; j < docs.length; j++) {
        const a = docs[i] as Doc, b = docs[j] as Doc;
        const small = a.shingles.size <= b.shingles.size ? a.shingles : b.shingles;
        const big = small === a.shingles ? b.shingles : a.shingles;
        const common = new Set<string>();
        for (const s of small) if (big.has(s)) common.add(s);
        const union = a.shingles.size + b.shingles.size - common.size;
        const pct = union ? round((common.size * 100) / union) : 0;
        highest.set(a.submissionId, Math.max(highest.get(a.submissionId) ?? 0, pct));
        highest.set(b.submissionId, Math.max(highest.get(b.submissionId) ?? 0, pct));
        if (pct >= reportAt) {
          pairs.push({
            similarityPct: pct,
            a: { submissionId: a.submissionId, studentId: a.studentId, name: a.name, roll: a.roll },
            b: { submissionId: b.submissionId, studentId: b.studentId, name: b.name, roll: b.roll },
            // the wording they actually share, so the teacher opens the two answers already knowing where to look
            sharedPhrases: sharedPhrases(a.words, common),
          });
        }
      }
    }
    pairs.sort((x, y) => y.similarityPct - x.similarityPct);
    // the number is kept beside the submission so a marker sees it without re-running the check;
    // a submission that was skipped keeps its empty similarity_pct rather than a misleading zero
    for (const d of docs) await this.db.update('assignment_submissions', { similarity_pct: highest.get(d.submissionId) ?? 0, updated_at: nowSql() }, { id: d.submissionId });

    if (pairs.length) {
      await this.outbox.emitNow({ type: 'assignment.similarity_flagged', schoolId, aggregateType: 'lms.assignment', aggregateId: assignmentId, payload: { assignmentId, title: String(assignment.title), pairs: pairs.length, highestPct: (pairs[0] as { similarityPct: number }).similarityPct, checked: docs.length } });
      const teacher = await this.db.findOne<{ user_id: string | null }>('staff', { id: String(assignment.teacher_id) });
      if (teacher?.user_id) {
        await this.notifications.notify({
          schoolId, userId: teacher.user_id, channels: ['in_app'], eventKey: 'lms.similarity_found',
          title: 'Two answers look alike',
          body: `${String(assignment.title)}: ${pairs.length} pair(s) share a lot of wording, the closest ${(pairs[0] as { similarityPct: number }).similarityPct}%. Please read them side by side before deciding anything.`,
          entityType: 'lms.assignment', entityId: assignmentId,
        });
      }
    }
    return {
      assignmentId, title: String(assignment.title), checked: docs.length, skipped, pairs,
      highestPct: (pairs[0]?.similarityPct as number | undefined) ?? 0, reportAt, minWords, shingleWords: SHINGLE_WORDS,
      // said out loud rather than left to be discovered: a very large intake is only partly compared
      truncated: rows.length >= MAX_SUBMISSIONS_COMPARED ? `only the first ${MAX_SUBMISSIONS_COMPARED} submissions were compared` : null,
      note: 'A percentage is a reason to read two answers side by side, not a finding. Students who learned the same definition will look alike; nothing here changes a mark or reaches a guardian.',
    };
  }

  // ---------- what the library has on a syllabus unit ----------
  /**
   * Everything published that teaches a given set of syllabus units, and — when a student is named —
   * whether that student can open it and whether they have already been through it. The revision
   * planner asks this once for every unit it needs rather than once per indicator, because a child
   * with fifteen indicators still to meet must get an answer inside a shared-hosting request.
   */
  async coverageForUnits(schoolId: string, unitIds: string[], studentId?: string | null): Promise<Record<string, UnitCoverage>> {
    const ids = [...new Set(unitIds.filter(Boolean))];
    const out: Record<string, UnitCoverage> = {};
    if (!ids.length) return out;
    const holes = ids.map(() => '?').join(',');
    const units = await this.db.query<Row>(`SELECT id, title FROM syllabus_units WHERE school_id = ? AND id IN (${holes})`, [schoolId, ...ids]);
    for (const id of ids) out[id] = { unitId: id, unitTitle: (units.find(u => String(u.id) === id)?.title as string) ?? null, lessons: [], quizzes: [], materials: [] };
    // with no student named the two LEFT JOINs match nothing, which is exactly right: the class-wide
    // answer carries no "enrolled" or "already done" because there is nobody for them to be about
    const lessons = await this.db.query<Row>(`SELECT l.id, l.title, l.lesson_type, l.unit_id, l.duration_min, c.id AS course_id, c.title AS course_title, c.slug,
        e.id AS enrolment_id, p.status AS progress_status
      FROM lessons l JOIN course_modules m ON m.id = l.module_id JOIN courses c ON c.id = m.course_id
      LEFT JOIN course_enrollments e ON e.course_id = c.id AND e.student_id = ?
      LEFT JOIN lesson_progress p ON p.lesson_id = l.id AND p.student_id = ?
      WHERE l.school_id = ? AND c.status = 'published' AND c.deleted_at IS NULL AND l.unit_id IN (${holes})
      ORDER BY m.sequence, l.sequence`, [studentId ?? '', studentId ?? '', schoolId, ...ids]);
    for (const l of lessons) {
      const bucket = out[String(l.unit_id)];
      if (!bucket) continue;
      const item: CoverageItem = {
        id: String(l.id), title: String(l.title), kind: String(l.lesson_type) === 'quiz' ? 'quiz' : 'lesson', lessonType: String(l.lesson_type),
        courseId: String(l.course_id), courseTitle: String(l.course_title), courseSlug: String(l.slug),
        enrolled: !!l.enrolment_id, done: String(l.progress_status ?? '') === 'completed',
        durationMin: l.duration_min === null ? null : Number(l.duration_min),
      };
      (item.kind === 'quiz' ? bucket.quizzes : bucket.lessons).push(item);
    }
    const materials = await this.db.query<Row>(`SELECT id, title, material_type, unit_id, external_url FROM study_materials
      WHERE school_id = ? AND unit_id IN (${holes}) ORDER BY published_at DESC`, [schoolId, ...ids]);
    for (const m of materials) {
      const bucket = out[String(m.unit_id)];
      if (bucket) bucket.materials.push({ id: String(m.id), title: String(m.title), kind: 'material', materialType: String(m.material_type), url: (m.external_url as string) ?? null });
    }
    return out;
  }

  private async notifySection(schoolId: string, sectionId: string, eventKey: string, title: string, body: string, entityId: string) {
    const students = await this.db.query<{ student_id: string }>(`SELECT student_id FROM student_enrollments WHERE section_id = ? AND status = 'active'`, [sectionId]);
    for (const s of students) await this.notifyGuardians(schoolId, String(s.student_id), eventKey, title, body, entityId);
  }
  private async notifyGuardians(schoolId: string, studentId: string, eventKey: string, title: string, body: string, entityId: string) {
    const student = await this.db.findOne<{ user_id: string | null }>('students', { id: studentId });
    if (student?.user_id) await this.notifications.notify({ schoolId, userId: student.user_id, channels: ['push', 'in_app'], eventKey, title, body, entityType: 'lms.assignment', entityId });
    const guardians = await this.db.query<{ user_id: string | null; phone: string }>(`SELECT g.user_id, g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND sg.receives_notifications = TRUE`, [studentId]);
    for (const g of guardians) await this.notifications.notify({ schoolId, userId: g.user_id, address: g.phone, channels: ['push', 'in_app'], eventKey, title, body, entityType: 'lms.assignment', entityId });
  }

  // ---------- scheduled ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      // E2 and E4: work due tomorrow that has not arrived, and a class about to start
      'lms.assignment_reminders': async ({ schoolId }) => {
        const now = nowSql();
        const soon = nowSql(new Date(Date.now() + 24 * 3600_000));
        const due = await this.db.query<Row>(`SELECT * FROM assignments WHERE school_id = ? AND status = 'published' AND reminder_sent_at IS NULL AND due_at > ? AND due_at <= ?`, [schoolId, now, soon]);
        let reminded = 0;
        for (const a of due) {
          const missing = await this.db.query<Row>(`SELECT e.student_id, s.first_name FROM student_enrollments e JOIN students s ON s.id = e.student_id
            WHERE e.section_id = ? AND e.status = 'active' AND NOT EXISTS (SELECT 1 FROM assignment_submissions sub WHERE sub.assignment_id = ? AND sub.student_id = e.student_id)`, [String(a.section_id), String(a.id)]);
          for (const m of missing) await this.notifyGuardians(schoolId, String(m.student_id), 'lms.assignment_due', 'Assignment due tomorrow', `${m.first_name}: ${a.title} is due at ${String(a.due_at).slice(0, 16)} and has not been handed in.`, String(a.id));
          await this.db.update('assignments', { reminder_sent_at: now, updated_at: nowSql() }, { id: String(a.id) });
          reminded += missing.length;
        }
        const classes = await this.db.query<Row>(`SELECT * FROM online_classes WHERE school_id = ? AND status = 'scheduled' AND reminder_sent_at IS NULL AND starts_at > ? AND starts_at <= ?`, [schoolId, now, nowSql(new Date(Date.now() + 15 * 60_000))]);
        for (const c of classes) {
          await this.notifySection(schoolId, String(c.section_id), 'lms.class_starting', 'Live class starting', `${c.title} starts at ${String(c.starts_at).slice(11, 16)}. Join: ${c.join_url ?? 'see the app'}`, String(c.id));
          await this.db.update('online_classes', { reminder_sent_at: now, updated_at: nowSql() }, { id: String(c.id) });
        }
        return { reminded, classes: classes.length };
      },
    };
  }
}

/**
 * Words for the similarity check: lowercased, punctuation dropped, Unicode-aware — `\w` matches no
 * Bengali letter at all, so an answer written in Bangla would otherwise come out as zero words and
 * be silently skipped as "nothing was typed".
 */
function wordsOf(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean);
}
/** Overlapping runs of SHINGLE_WORDS words. Order matters: shuffled sentences share few shingles. */
function shinglesOf(words: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) out.add(words.slice(i, i + SHINGLE_WORDS).join(' '));
  return out;
}
/**
 * The longest stretches of wording the two answers actually share, in the order the first one wrote
 * them. A teacher opening two scripts needs to know where to look, not that a number was 78.
 */
function sharedPhrases(words: string[], shared: Set<string>, max = 2, maxChars = 200): string[] {
  const runs: { from: number; to: number }[] = [];
  let start = -1;
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) {
    const hit = shared.has(words.slice(i, i + SHINGLE_WORDS).join(' '));
    if (hit && start < 0) start = i;
    if (!hit && start >= 0) { runs.push({ from: start, to: i - 1 + SHINGLE_WORDS }); start = -1; }
  }
  if (start >= 0) runs.push({ from: start, to: words.length });
  return runs
    .sort((a, b) => (b.to - b.from) - (a.to - a.from))
    .slice(0, max)
    .map(r => { const s = words.slice(r.from, r.to).join(' '); return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s; });
}
