import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { AcademicService } from './academic.js';
import { round } from './accounting.js';
import { HttpError, badRequest, notFound } from '../context.js';

export interface CourseInput { title: string; slug?: string; classSubjectId?: string | null; description?: string | null; teacherId?: string | null; isPaid?: boolean; price?: number }
export interface AssignmentInput { sectionId: string; classSubjectId: string; teacherId: string; title: string; description?: string | null; dueAt: string; maxMarks?: number | null; allowLate?: boolean; latePenaltyPct?: number; submissionType?: 'file' | 'text' | 'both' | 'offline' | 'photo' }

/**
 * The LMS: courses with modules and lessons, enrolment (automatic for a class-subject course),
 * per-lesson progress that rolls up to a percentage, assignments with a late penalty applied at
 * marking time rather than argued about later, study materials, live classes with their join link,
 * and discussion threads. Reminders for unsubmitted work run hourly as one job.
 */
export class LmsService {
  constructor(private db: Db, private outbox: OutboxService, private notifications: NotificationService, private academic: AcademicService) {}

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
    return { courseId, progressPct: pct, lessonsDone: done, lessons: total };
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
  async ask(schoolId: string, d: { courseId?: string | null; lessonId?: string | null; parentId?: string | null; body: string; authorId?: string | null }) {
    const id = ulid();
    await this.db.insert('discussions', { id, school_id: schoolId, course_id: d.courseId ?? null, lesson_id: d.lessonId ?? null, author_id: d.authorId ?? null, parent_id: d.parentId ?? null, body: d.body, is_answer: false, upvotes: 0 });
    return id;
  }
  async discussion(schoolId: string, courseId: string) {
    return this.db.query<Row>(`SELECT d.*, u.display_name FROM discussions d LEFT JOIN users u ON u.id = d.author_id WHERE d.school_id = ? AND d.course_id = ? ORDER BY d.created_at ASC LIMIT 500`, [schoolId, courseId]);
  }
  async markAnswer(schoolId: string, id: string) { return this.db.update('discussions', { is_answer: true, updated_at: nowSql() }, { id, school_id: schoolId }); }

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
