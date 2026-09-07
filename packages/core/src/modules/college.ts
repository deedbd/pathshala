import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { AcademicService, ProgramInput } from './academic.js';
import type { PeopleService } from './people.js';
import type { FeesService } from './fees.js';
import type { LmsService } from './lms.js';
import type { AssessmentService } from './assessment.js';
import type { DocumentService } from './documents.js';
import type { TaskService } from '../tasks.js';
import { round } from './accounting.js';
import { HttpError, badRequest, notFound } from '../context.js';

export interface RegisterInput { studentId: string; termId: string; classSubjectIds: string[] }
export interface SellCourseInput { courseId: string; studentId: string; price?: number; count?: number; firstDue?: string; instalments?: { due: string; amount: number }[]; approvedBy?: string | null }

type Graded = { subjectId: string; subject: string; code: string; credit: number; gradePoint: number; grade: string; passed: boolean };

/**
 * College and coaching modes: the same tables a school uses, read the way an institution that counts
 * credits rather than classes needs them.
 *
 * Three things separate a college from a school and all of them live here. A student registers for
 * named courses each semester instead of inheriting whatever their class studies, so the register is
 * `course_registrations` — one row per student per term per subject, carrying the credit the subject
 * was worth *on the day it was taken*. A grade point is then weighted by that credit, because a
 * four-credit paper and a one-credit lab are not the same result even when the marks are. And the
 * programme, not the year, is what a student finishes: the certificate comes when the credits the
 * programme asks for have actually been earned, never because someone reached the last semester.
 *
 * The coaching half sells a batch instead of admitting a child. A sale is an instalment plan, and the
 * seat is handed over by the payment, not by the plan — a centre that enrols on a promise spends the
 * term teaching people who never paid.
 *
 * Nothing here writes another module's tables: programmes and credits go through `AcademicService`,
 * departments through `PeopleService`, the money through `FeesService`, the seat and its certificate
 * through `LmsService`, and grades are struck against the school's own scale by `AssessmentService`.
 */
export class CollegeService {
  constructor(
    private db: Db, private outbox: OutboxService, private notifications: NotificationService,
    private academic: AcademicService, private people: PeopleService, private fees: FeesService,
    private lms: LmsService, private assessment: AssessmentService, private documents: DocumentService,
    private tasks: TaskService,
  ) {}

  // ---------- programmes ----------
  async createProgram(schoolId: string, p: ProgramInput & { classIds?: string[] }) {
    if (p.durationTerms != null && p.durationTerms < 1) throw badRequest('a programme runs for at least one term');
    // a create is a create. Quietly rewriting the programme that already holds this code would move
    // the per-term ceiling a cohort is registering against and the credits its certificate asks for,
    // from a form somebody opened to fix a typo in the name.
    const code = p.code.trim().toUpperCase();
    if (await this.db.findOne('programs', { school_id: schoolId, code })) {
      throw new HttpError(409, `a programme with the code ${code} already exists; edit that one instead`, 'duplicate');
    }
    const id = await this.academic.createProgram(schoolId, p);
    for (const classId of p.classIds ?? []) await this.academic.setClassProgram(schoolId, classId, id);
    return { id, ceiling: this.termCeiling({ total_credits: p.totalCredits, duration_terms: p.durationTerms }) };
  }
  async programs(schoolId: string) {
    return this.db.query<Row>(`SELECT p.*, d.name AS department_name,
      (SELECT COUNT(*) FROM classes c WHERE c.program_id = p.id) AS classes,
      (SELECT COUNT(*) FROM student_enrollments e JOIN classes c ON c.id = e.class_id WHERE c.program_id = p.id AND e.status = 'active') AS students
      FROM programs p LEFT JOIN departments d ON d.id = p.department_id WHERE p.school_id = ? ORDER BY p.name`, [schoolId]);
  }
  async program(schoolId: string, programId: string) {
    const program = await this.requireProgram(schoolId, programId);
    const classes = await this.db.findMany<Row>('classes', { school_id: schoolId, program_id: programId }, { orderBy: 'numeric_level ASC, name ASC' });
    // what the programme actually offers this year, which is the number a registrar checks against total_credits
    const offered = await this.db.query<Row>(`SELECT cs.id, cs.credit, cs.class_id, s.name AS subject_name, s.code AS subject_code, c.name AS class_name, y.name AS year_name
      FROM class_subjects cs JOIN subjects s ON s.id = cs.subject_id JOIN classes c ON c.id = cs.class_id JOIN academic_years y ON y.id = cs.academic_year_id
      WHERE cs.school_id = ? AND c.program_id = ? ORDER BY c.numeric_level, s.name`, [schoolId, programId]);
    return {
      program, classes, offered,
      creditsOffered: round(offered.reduce((a, o) => a + Number(o.credit ?? 0), 0)),
      creditsRequired: program.total_credits == null ? null : Number(program.total_credits),
      ceiling: this.termCeiling(program),
    };
  }
  /** Credit hours are set on the class-subject, so the same row the marks and the timetable already use carries them. */
  async setCredit(schoolId: string, c: { academicYearId: string; classId: string; subjectId: string; credit: number }) {
    if (c.credit <= 0 || c.credit > 20) throw badRequest('a credit is between 0 and 20 hours');
    return { id: await this.academic.setClassSubject(schoolId, { academicYearId: c.academicYearId, classId: c.classId, subjectId: c.subjectId, credit: c.credit }), credit: c.credit };
  }

  /**
   * How many credits one term of a programme may hold. Dividing the programme evenly across its terms
   * is the load the timetable, the rooms and the teachers were sized for; a student who wants more
   * than that is asking for an overload, which is a conversation with the registrar and not something
   * a registration form should be able to do quietly.
   */
  private termCeiling(p: { total_credits?: unknown; duration_terms?: unknown; totalCredits?: number | null; durationTerms?: number | null }): number | null {
    const total = Number(p.total_credits ?? p.totalCredits ?? 0);
    const terms = Number(p.duration_terms ?? p.durationTerms ?? 0);
    if (!(total > 0) || !(terms > 0)) return null;
    return round(total / terms);
  }
  private async requireProgram(schoolId: string, programId: string) {
    const p = await this.db.findOne<Row>('programs', { id: programId, school_id: schoolId });
    if (!p) throw notFound('programme');
    return p;
  }

  // ---------- course registration ----------
  /**
   * Registering a student for a semester. Everything is checked before anything is written: a
   * half-registered student is worse than one who was told to try again, because the credit ceiling
   * is then enforced against a total nobody agreed to.
   */
  async register(schoolId: string, r: RegisterInput) {
    const term = await this.db.findOne<Row>('terms', { id: r.termId, school_id: schoolId });
    if (!term) throw notFound('term');
    const today = nowSql().slice(0, 10);
    // once the semester is over its register is history; a late correction is a result entry, not a registration
    if (String(term.end_date).slice(0, 10) < today) throw new HttpError(409, `${term.name} ended on ${String(term.end_date).slice(0, 10)}`, 'term_closed');

    const enrolment = await this.db.findOne<Row>('student_enrollments', { school_id: schoolId, student_id: r.studentId, academic_year_id: String(term.academic_year_id), status: 'active' });
    if (!enrolment) throw new HttpError(409, 'this student is not on the roll for that year', 'not_enrolled');
    const cls = await this.db.findOne<Row>('classes', { id: String(enrolment.class_id), school_id: schoolId });
    const program = cls?.program_id ? await this.requireProgram(schoolId, String(cls.program_id)) : null;
    const ceiling = program ? this.termCeiling(program) : null;

    const existing = await this.db.findMany<Row>('course_registrations', { school_id: schoolId, student_id: r.studentId, term_id: r.termId });
    let taken = round(existing.filter(e => e.status !== 'dropped').reduce((a, e) => a + Number(e.credit), 0));

    const add: { row: Row; subject: string; credit: number }[] = [];
    const alreadyOn: string[] = [];
    for (const csId of [...new Set(r.classSubjectIds)]) {
      const cs = await this.db.findOne<Row>('class_subjects', { id: csId, school_id: schoolId, academic_year_id: String(term.academic_year_id) });
      if (!cs) throw notFound(`class subject ${csId}`);
      // a student may only take what their own class is offered: the marks, the seat and the teacher all follow the class-subject
      if (String(cs.class_id) !== String(enrolment.class_id)) throw badRequest('that subject belongs to another class');
      const subject = await this.db.findOne<Row>('subjects', { id: String(cs.subject_id) });
      const prior = existing.find(e => String(e.class_subject_id) === csId);
      if (prior && prior.status !== 'dropped') { alreadyOn.push(String(subject?.name ?? csId)); continue; }
      const credit = round(Number(cs.credit ?? 0));
      if (ceiling != null && round(taken + credit) > ceiling) {
        throw new HttpError(409, `${program!.name} allows ${ceiling} credits a term; ${subject?.name ?? 'this course'} would make ${round(taken + credit)}`, 'over_credit_limit');
      }
      taken = round(taken + credit);
      add.push({
        subject: String(subject?.name ?? ''), credit,
        row: {
          id: prior ? String(prior.id) : ulid(), school_id: schoolId, academic_year_id: String(term.academic_year_id), term_id: r.termId,
          student_id: r.studentId, class_subject_id: csId, program_id: program ? String(program.id) : null,
          // the credit is copied, not looked up later: repricing a subject next year must not rewrite this semester's GPA
          credit, status: 'registered', percent: null, grade: null, grade_point: null,
          registered_on: today, dropped_on: null, completed_on: null,
        },
      });
    }

    await this.db.transaction(async tx => {
      for (const a of add) {
        const revive = existing.find(e => String(e.id) === String(a.row.id));
        if (revive) await tx.update('course_registrations', { status: 'registered', credit: a.credit, registered_on: today, dropped_on: null, updated_at: nowSql() }, { id: String(revive.id) });
        else await tx.insert('course_registrations', a.row);
      }
      if (add.length) {
        await this.outbox.emit(tx, {
          type: 'course.registered', schoolId, aggregateType: 'college.registration', aggregateId: r.termId,
          payload: { studentId: r.studentId, termId: r.termId, programId: program ? String(program.id) : null, courses: add.length, credits: taken },
        });
      }
    });
    return { termId: r.termId, registered: add.map(a => ({ subject: a.subject, credit: a.credit })), alreadyRegistered: alreadyOn, credits: taken, ceiling };
  }

  /** Dropping is only ever possible while the semester runs and only before a result exists — a graded course is a fact. */
  async drop(schoolId: string, registrationId: string, reason?: string | null) {
    const reg = await this.db.findOne<Row>('course_registrations', { id: registrationId, school_id: schoolId });
    if (!reg) throw notFound('registration');
    if (reg.status === 'dropped') return { id: registrationId, status: 'dropped' as const, alreadyDropped: true };
    if (reg.status !== 'registered') throw new HttpError(409, `this course is ${reg.status} and carries a grade`, 'conflict');
    const term = await this.db.findOne<Row>('terms', { id: String(reg.term_id) });
    const today = nowSql().slice(0, 10);
    if (term && String(term.end_date).slice(0, 10) < today) throw new HttpError(409, `${term.name} is over; the result stands`, 'term_closed');
    await this.db.update('course_registrations', { status: 'dropped', dropped_on: today, updated_at: nowSql() }, { id: registrationId });
    return { id: registrationId, status: 'dropped' as const, freedCredits: round(Number(reg.credit)), reason: reason ?? null };
  }

  async registrations(schoolId: string, f: { studentId?: string; termId?: string; classSubjectId?: string; status?: string } = {}) {
    const where = ['r.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.studentId) { where.push('r.student_id = ?'); params.push(f.studentId); }
    if (f.termId) { where.push('r.term_id = ?'); params.push(f.termId); }
    if (f.classSubjectId) { where.push('r.class_subject_id = ?'); params.push(f.classSubjectId); }
    if (f.status) { where.push('r.status = ?'); params.push(f.status); }
    return this.db.query<Row>(`SELECT r.*, t.name AS term_name, t.sequence AS term_sequence, sub.name AS subject_name, sub.code AS subject_code, c.name AS class_name, s.first_name, s.last_name, s.admission_no
      FROM course_registrations r JOIN terms t ON t.id = r.term_id JOIN class_subjects cs ON cs.id = r.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
      JOIN classes c ON c.id = cs.class_id JOIN students s ON s.id = r.student_id
      WHERE ${where.join(' AND ')} ORDER BY t.sequence, sub.name LIMIT 500`, params);
  }

  /** What a student is carrying this term, and what the programme still lets them add. */
  async load(schoolId: string, studentId: string, termId: string) {
    const rows = await this.db.findMany<Row>('course_registrations', { school_id: schoolId, student_id: studentId, term_id: termId });
    const live = rows.filter(r => r.status !== 'dropped');
    const program = live[0]?.program_id ? await this.requireProgram(schoolId, String(live[0]!.program_id)) : null;
    const ceiling = program ? this.termCeiling(program) : null;
    const credits = round(live.reduce((a, r) => a + Number(r.credit), 0));
    return { studentId, termId, courses: live.length, credits, ceiling, room: ceiling == null ? null : round(ceiling - credits) };
  }

  // ---------- results ----------
  /**
   * A semester result against the school's own grading scale. A failed course keeps its credit in the
   * GPA and earns none of it — that is the whole point of a credit system, and hiding the failure by
   * dropping the row would let a transcript lie about how hard the year was.
   */
  async recordResult(schoolId: string, r: { registrationId: string; percent: number; scaleId?: string | null }) {
    const reg = await this.db.findOne<Row>('course_registrations', { id: r.registrationId, school_id: schoolId });
    if (!reg) throw notFound('registration');
    if (reg.status === 'dropped') throw new HttpError(409, 'a dropped course has no result', 'conflict');
    if (r.percent < 0 || r.percent > 100) throw badRequest('a percentage is between 0 and 100');
    const g = await this.assessment.gradeFor(schoolId, r.percent, r.scaleId);
    const status = g.isFail ? 'failed' : 'completed';
    await this.db.update('course_registrations', {
      percent: round(r.percent), grade: g.grade, grade_point: g.gradePoint, status,
      completed_on: nowSql().slice(0, 10), updated_at: nowSql(),
    }, { id: r.registrationId });
    return { id: r.registrationId, status, grade: g.grade, gradePoint: g.gradePoint, credit: round(Number(reg.credit)), creditEarned: g.isFail ? 0 : round(Number(reg.credit)) };
  }

  /**
   * The transcript, term by term, with a GPA weighted by credit rather than by how many subjects
   * happen to be on the sheet. A retake replaces the attempt it repeats: counting a failure and the
   * pass that cancelled it would punish the student twice for the same course, which no registrar in
   * the country would sign.
   */
  async transcript(schoolId: string, studentId: string, programId?: string | null) {
    const params: unknown[] = [schoolId, studentId];
    if (programId) params.push(programId);
    const rows = await this.db.query<Row>(`SELECT r.*, t.name AS term_name, t.sequence AS term_sequence, t.start_date AS term_start, sub.id AS subject_id, sub.name AS subject_name, sub.code AS subject_code
      FROM course_registrations r JOIN terms t ON t.id = r.term_id JOIN class_subjects cs ON cs.id = r.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
      WHERE r.school_id = ? AND r.student_id = ?${programId ? ' AND r.program_id = ?' : ''} AND r.status <> 'dropped'
      ORDER BY t.start_date, t.sequence, sub.name`, params);

    const terms: { termId: string; name: string; sequence: number; courses: Row[]; creditsAttempted: number; creditsEarned: number; gpa: number | null; inProgress: number }[] = [];
    const best = new Map<string, Graded>();
    for (const row of rows) {
      const termId = String(row.term_id);
      let term = terms.find(t => t.termId === termId);
      if (!term) { term = { termId, name: String(row.term_name), sequence: Number(row.term_sequence), courses: [], creditsAttempted: 0, creditsEarned: 0, gpa: null, inProgress: 0 }; terms.push(term); }
      term.courses.push(row);
      if (row.status === 'registered') { term.inProgress++; continue; }
      const credit = Number(row.credit), point = Number(row.grade_point ?? 0);
      term.creditsAttempted = round(term.creditsAttempted + credit);
      if (row.status === 'completed') term.creditsEarned = round(term.creditsEarned + credit);
      // keyed on the subject, not the class-subject row: a paper retaken in a later year is a new row
      // in the matrix but the same course, and the transcript has to know that
      const key = String(row.subject_id);
      const prior = best.get(key);
      if (!prior || point > prior.gradePoint) {
        best.set(key, { subjectId: key, subject: String(row.subject_name), code: String(row.subject_code), credit, gradePoint: point, grade: String(row.grade ?? ''), passed: row.status === 'completed' });
      }
    }
    for (const t of terms) {
      const graded = t.courses.filter(c => c.status !== 'registered');
      t.gpa = graded.length ? this.weighted(graded.map(c => ({ credit: Number(c.credit), gradePoint: Number(c.grade_point ?? 0) }))) : null;
    }
    const attempts = [...best.values()];
    return {
      studentId, programId: programId ?? null, terms,
      creditsAttempted: round(attempts.reduce((a, x) => a + x.credit, 0)),
      creditsEarned: round(attempts.filter(x => x.passed).reduce((a, x) => a + x.credit, 0)),
      cgpa: attempts.length ? this.weighted(attempts) : null,
    };
  }
  /** Σ(grade point × credit) ÷ Σ(credit): a four-credit paper moves the average four times as far as a one-credit lab. */
  private weighted(rows: { credit: number; gradePoint: number }[]) {
    const credits = rows.reduce((a, r) => a + r.credit, 0);
    if (!credits) return 0;
    return round(rows.reduce((a, r) => a + r.gradePoint * r.credit, 0) / credits);
  }

  // ---------- certificates ----------
  /**
   * The certificate for finishing a programme. It is earned by credits, not by time served: a student
   * who reached the last semester with two papers outstanding has not finished, and the shortfall is
   * named so the office can tell them exactly what is left.
   */
  async certifyProgram(schoolId: string, p: { studentId: string; programId: string; signedBy?: string | null }) {
    const program = await this.requireProgram(schoolId, p.programId);
    const required = Number(program.total_credits ?? 0);
    if (!(required > 0)) throw badRequest(`${program.name} does not say how many credits it takes to finish`);
    const student = await this.db.findOne<Row>('students', { id: p.studentId, school_id: schoolId });
    if (!student) throw notFound('student');
    const t = await this.transcript(schoolId, p.studentId, p.programId);
    if (t.creditsEarned < required) throw new HttpError(409, `${t.creditsEarned} of ${required} credits are earned; ${round(required - t.creditsEarned)} still to go`, 'credits_short');

    const before = await this.programCertificate(schoolId, p.studentId, String(program.code));
    if (before) return { certificateId: before, alreadyIssued: true, creditsEarned: t.creditsEarned, cgpa: t.cgpa };
    const issued = await this.documents.issue(schoolId, {
      docType: 'certificate', personType: 'student', studentId: p.studentId, signedBy: p.signedBy ?? null,
      data: {
        name: `${student.first_name ?? ''} ${student.last_name ?? ''}`.trim(), admission_no: String(student.admission_no ?? ''),
        course: `${program.name} (${program.code})`, completed_on: nowSql().slice(0, 10),
        credits: String(t.creditsEarned), cgpa: t.cgpa == null ? '' : t.cgpa.toFixed(2), program_code: String(program.code),
      },
      entityType: 'college.program', entityId: p.programId,
    });
    await this.outbox.emitNow({
      type: 'program.completed', schoolId, aggregateType: 'college.program', aggregateId: p.programId,
      payload: { programId: p.programId, studentId: p.studentId, creditsEarned: t.creditsEarned, cgpa: t.cgpa ?? 0, certificateId: issued.id },
    });
    await this.tellTheFamily(schoolId, p.studentId, 'college.program_completed', `${program.name} completed`, `${student.first_name} has earned all ${required} credits of ${program.name}. The certificate is ready, verification code ${issued.verificationCode}.`);
    return { certificateId: issued.id, fileId: issued.fileId, documentNo: issued.documentNo, verificationCode: issued.verificationCode, creditsEarned: t.creditsEarned, cgpa: t.cgpa };
  }
  /**
   * `issued_documents` has no column pointing back at a programme, so the snapshot it already keeps is
   * what makes a second certificate for the same programme impossible. A revoked one does not count —
   * that is the case where a replacement is exactly what is wanted.
   */
  private async programCertificate(schoolId: string, studentId: string, code: string) {
    const rows = await this.db.findMany<Row>('issued_documents', { school_id: schoolId, student_id: studentId, doc_type: 'certificate' }, { orderBy: 'issued_at DESC', limit: 100 });
    for (const r of rows) {
      if (r.revoked_at) continue;
      if ((json<Record<string, string>>(r.data_snapshot) ?? {}).program_code === code) return String(r.id);
    }
    return null;
  }

  // ---------- coaching: selling a batch ----------
  /**
   * Selling a course to one student. The price becomes an instalment plan against a fee head of the
   * course's own, so a centre running six batches can see what each one earned instead of one heap
   * called "course fee". Nobody is enrolled here: see `onPaymentReceived`.
   */
  async sell(schoolId: string, s: SellCourseInput) {
    const course = await this.db.findOne<Row>('courses', { id: s.courseId, school_id: schoolId });
    if (!course) throw notFound('course');
    if (course.status !== 'published') throw new HttpError(409, 'a course nobody can see yet cannot be sold', 'conflict');
    if (!Number(course.is_paid)) throw badRequest('this course is free — enrol the student instead of selling a place on it');
    const student = await this.db.findOne<Row>('students', { id: s.studentId, school_id: schoolId });
    if (!student) throw notFound('student');
    if (await this.db.findOne('course_enrollments', { school_id: schoolId, course_id: s.courseId, student_id: s.studentId })) throw new HttpError(409, 'this student is already on the course', 'duplicate');
    const price = round(s.price ?? Number(course.price ?? 0));
    if (!(price > 0)) throw badRequest('a paid course needs a price');

    let feeHeadId = (course.fee_head_id as string) ?? null;
    // selling the same batch to the same student twice bills them twice; the counter clerk who was
    // told "it did not go through" is exactly how that happens, so the second sale is refused instead
    if (feeHeadId) {
      const open = await this.db.query<{ id: string }>(`SELECT id FROM instalment_plans WHERE school_id = ? AND student_id = ? AND fee_head_id = ? AND status <> 'cancelled' LIMIT 1`, [schoolId, s.studentId, feeHeadId]);
      if (open.length) throw new HttpError(409, 'this student already has a payment plan for this course', 'duplicate');
    }
    if (!feeHeadId) {
      // the code carries the course id, not the first letters of its slug: "Spoken English Batch A"
      // and "Spoken English Batch B" agree for fifteen characters, and one fee head between them
      // would bill the two batches as one and hand a seat in each to whoever paid for either
      const slug = String(course.slug).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      feeHeadId = await this.fees.ensureHead(schoolId, { name: `Course: ${course.title}`, code: `CRS-${slug}-${s.courseId.slice(-6).toUpperCase()}`, kind: 'course' });
      await this.lms.setCourseFeeHead(schoolId, s.courseId, feeHeadId);
    }
    const plan = await this.fees.createInstalmentPlan(schoolId, {
      studentId: s.studentId, feeHeadId, totalAmount: price,
      instalments: s.instalments, count: s.count, firstDue: s.firstDue, approvedBy: s.approvedBy ?? null,
    });
    await this.outbox.emitNow({
      type: 'course.sold', schoolId, aggregateType: 'college.course_sale', aggregateId: s.courseId,
      payload: { courseId: s.courseId, studentId: s.studentId, planId: plan.id, total: price, instalments: plan.instalments.length },
    });
    return { planId: plan.id, courseId: s.courseId, feeHeadId, total: price, instalments: plan.instalments, enrolled: false };
  }

  /**
   * The seat is handed over by the money, not by the plan. Called for every paid invoice, it finds the
   * courses whose fee head that invoice was raised against and puts the student on them. It has to be
   * safe to call twice — the relay delivers at least once, and a plan pays in instalments, so every
   * later payment arrives here again and must change nothing.
   */
  async onPaymentReceived(schoolId: string, invoiceId: string) {
    const rows = await this.db.query<Row>(`SELECT DISTINCT c.id AS course_id, c.title, i.student_id
      FROM invoices i JOIN invoice_items it ON it.invoice_id = i.id JOIN courses c ON c.fee_head_id = it.fee_head_id
      WHERE i.id = ? AND i.school_id = ? AND i.student_id IS NOT NULL AND i.paid_total > 0 AND c.deleted_at IS NULL`, [invoiceId, schoolId]);
    const enrolled: string[] = [];
    for (const r of rows) {
      if (!(await this.lms.enrol(schoolId, String(r.course_id), String(r.student_id)))) continue;
      enrolled.push(String(r.course_id));
      await this.tellTheFamily(schoolId, String(r.student_id), 'college.course_enrolled', 'Place confirmed', `The first payment for ${r.title} has been received and the place is confirmed.`);
    }
    return { invoiceId, enrolled: enrolled.length, courseIds: enrolled };
  }

  async sales(schoolId: string, f: { courseId?: string; studentId?: string } = {}) {
    const where = ['p.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.courseId) { where.push('c.id = ?'); params.push(f.courseId); }
    if (f.studentId) { where.push('p.student_id = ?'); params.push(f.studentId); }
    return this.db.query<Row>(`SELECT p.id, p.student_id, p.total_amount, p.status, p.created_at, c.id AS course_id, c.title AS course_title,
      s.first_name, s.last_name, s.admission_no,
      (SELECT COUNT(*) FROM course_enrollments e WHERE e.course_id = c.id AND e.student_id = p.student_id) AS enrolled
      FROM instalment_plans p JOIN courses c ON c.fee_head_id = p.fee_head_id JOIN students s ON s.id = p.student_id
      WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC, p.id DESC LIMIT 300`, params);
  }

  /**
   * What is still owed on a course: the balance of the invoices already raised for it plus the
   * instalments the plan has not billed yet. Leaving the unbilled ones out would call a student who
   * has paid one of six instalments settled, which is how a certificate escapes before the money does.
   */
  async outstandingFor(schoolId: string, courseId: string, studentId: string) {
    const course = await this.db.findOne<Row>('courses', { id: courseId, school_id: schoolId });
    if (!course) throw notFound('course');
    const feeHeadId = (course.fee_head_id as string) ?? null;
    if (!feeHeadId) return { courseId, studentId, billed: 0, unbilled: 0, outstanding: 0 };
    // Only this course's share of each invoice. A monthly bill carrying the course fee beside tuition
    // has one balance, and charging the whole of it to the course tells a guardian they owe eight
    // thousand for a three-thousand-taka batch — and holds the certificate over the tuition.
    // A payment is allocated to the invoice rather than to its lines, so the share is proportional:
    // the head's own lines over the invoice total, applied to what is left unpaid.
    const touching = await this.db.query<{ balance: number; total: number; head_amount: number }>(
      `SELECT i.balance, i.total, (SELECT COALESCE(SUM(it.amount), 0) FROM invoice_items it WHERE it.invoice_id = i.id AND it.fee_head_id = ?) AS head_amount
       FROM invoices i WHERE i.school_id = ? AND i.student_id = ? AND i.status <> 'cancelled'
         AND EXISTS (SELECT 1 FROM invoice_items it WHERE it.invoice_id = i.id AND it.fee_head_id = ?)`,
      [feeHeadId, schoolId, studentId, feeHeadId]);
    let billedDue = 0;
    for (const inv of touching) {
      const total = Number(inv.total ?? 0), balance = Number(inv.balance ?? 0), head = Number(inv.head_amount ?? 0);
      if (balance <= 0) continue;
      billedDue = round(billedDue + (total > 0 ? Math.min(balance, round((balance * Math.min(head, total)) / total)) : balance));
    }
    const plans = await this.db.findMany<Row>('instalment_plans', { school_id: schoolId, student_id: studentId, fee_head_id: feeHeadId });
    let unbilled = 0;
    for (const p of plans) {
      if (p.status === 'cancelled') continue;
      for (const i of json<{ due: string; amount: number; invoiceId: string | null }[]>(p.instalments) ?? []) if (!i.invoiceId) unbilled = round(unbilled + Number(i.amount));
    }
    return { courseId, studentId, billed: round(billedDue), unbilled, outstanding: round(billedDue + unbilled) };
  }

  /** The certificate for a batch that met in a room. It waits for the last instalment: a certificate handed over with money owing never gets that money. */
  async certifyCourse(schoolId: string, c: { courseId: string; studentId: string; onDate?: string }) {
    const owed = await this.outstandingFor(schoolId, c.courseId, c.studentId);
    if (owed.outstanding > 0) throw new HttpError(409, `Tk ${owed.outstanding} of the course fee is still to come`, 'unpaid');
    return this.lms.completeEnrolment(schoolId, c.courseId, c.studentId, c.onDate);
  }

  // ---------- department portals ----------
  async departments(schoolId: string) {
    return this.db.query<Row>(`SELECT d.*, st.first_name AS head_first_name, st.last_name AS head_last_name,
      (SELECT COUNT(*) FROM staff s WHERE s.department_id = d.id AND s.deleted_at IS NULL) AS staff,
      (SELECT COUNT(*) FROM subjects sub WHERE sub.department_id = d.id AND sub.status = 'active') AS subjects,
      (SELECT COUNT(*) FROM programs p WHERE p.department_id = d.id) AS programs
      FROM departments d LEFT JOIN staff st ON st.id = d.head_staff_id WHERE d.school_id = ? ORDER BY d.name`, [schoolId]);
  }
  async createDepartment(schoolId: string, name: string, kind: 'academic' | 'admin' | 'support' = 'academic') {
    return { id: await this.people.createDepartment(schoolId, name, kind) };
  }
  async setHead(schoolId: string, departmentId: string, staffId: string | null) {
    return this.people.setDepartmentHead(schoolId, departmentId, staffId);
  }
  /**
   * What one department is carrying: its people, its subjects and programmes, and the registrations
   * riding on them. The teaching load is the number a head of department is actually asked for at the
   * start of every semester, and it is the one nobody can work out from the class list alone.
   */
  async department(schoolId: string, departmentId: string) {
    const dep = await this.db.findOne<Row>('departments', { id: departmentId, school_id: schoolId });
    if (!dep) throw notFound('department');
    const [staff, subjects, programs] = await Promise.all([
      this.db.query<Row>(`SELECT s.id, s.first_name, s.last_name, s.employee_no, s.staff_category, s.status, g.name AS designation FROM staff s LEFT JOIN designations g ON g.id = s.designation_id
        WHERE s.school_id = ? AND s.department_id = ? AND s.deleted_at IS NULL ORDER BY s.first_name`, [schoolId, departmentId]),
      this.db.findMany<Row>('subjects', { school_id: schoolId, department_id: departmentId }, { orderBy: 'name ASC' }),
      this.db.findMany<Row>('programs', { school_id: schoolId, department_id: departmentId }, { orderBy: 'name ASC' }),
    ]);
    // this year only: a department head asked "what are we carrying" means now, not since the college opened
    const year = await this.academic.currentYear(schoolId);
    const params: unknown[] = [schoolId, departmentId];
    if (year) params.push(String(year.id));
    const load = await this.db.query<Row>(`SELECT sub.id AS subject_id, sub.name AS subject_name, COUNT(r.id) AS registrations, COALESCE(SUM(r.credit), 0) AS credits
      FROM subjects sub JOIN class_subjects cs ON cs.subject_id = sub.id
      LEFT JOIN course_registrations r ON r.class_subject_id = cs.id AND r.status <> 'dropped'
      WHERE sub.school_id = ? AND sub.department_id = ?${year ? ' AND cs.academic_year_id = ?' : ''}
      GROUP BY sub.id, sub.name ORDER BY sub.name`, params);
    const head = dep.head_staff_id ? await this.db.findOne<Row>('staff', { id: String(dep.head_staff_id) }) : null;
    return { department: dep, head, staff, subjects, programs, load };
  }

  // ---------- scheduled ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      /**
       * R1: a week into every semester, the students who have registered for barely anything are
       * chased. A week is the whole rule — any earlier and half of them simply have not got round to
       * it, any later and the timetable has already been built around the wrong numbers. Firing on
       * exactly one day narrows it to one date; the guard against sending the same family the same
       * message twice is on what was actually delivered, because the scheduler is at-least-once and a
       * process recycled mid-job (which is the normal end of a Passenger app on shared hosting) leaves
       * `next_run_at` in the past and runs the whole job again.
       */
      'college.registration_watch': async ({ schoolId, payload }) => {
        const today = String((payload as { onDate?: string }).onDate ?? nowSql()).slice(0, 10);
        const terms = await this.db.query<Row>(`SELECT t.* FROM terms t JOIN academic_years y ON y.id = t.academic_year_id
          WHERE t.school_id = ? AND y.is_current = TRUE`, [schoolId]);
        const due = terms.filter(t => addDays(String(t.start_date).slice(0, 10), 7) === today);
        let chased = 0;
        for (const term of due) {
          const students = await this.db.query<Row>(`SELECT e.student_id, s.first_name, p.name AS program_name, p.total_credits, p.duration_terms,
            (SELECT COALESCE(SUM(r.credit), 0) FROM course_registrations r WHERE r.school_id = e.school_id AND r.student_id = e.student_id AND r.term_id = ? AND r.status <> 'dropped') AS credits
            FROM student_enrollments e JOIN students s ON s.id = e.student_id JOIN classes c ON c.id = e.class_id JOIN programs p ON p.id = c.program_id
            WHERE e.school_id = ? AND e.academic_year_id = ? AND e.status = 'active' AND p.status = 'active'`, [String(term.id), schoolId, String(term.academic_year_id)]);
          for (const s of students) {
            const ceiling = this.termCeiling(s);
            // half a load is the line: below it the student either loses the semester or has simply forgotten to register
            if (ceiling == null || Number(s.credits) >= round(ceiling / 2)) continue;
            if (await this.chasedToday(schoolId, String(s.student_id), today)) continue;
            await this.tellTheFamily(schoolId, String(s.student_id), 'college.registration_short',
              `${term.name} registration`, `${s.first_name} has registered for ${round(Number(s.credits))} of ${ceiling} credits in ${term.name}. ${s.program_name} needs a full load — please see the registrar this week.`);
            chased++;
          }
        }
        return { terms: due.length, chased };
      },
      /**
       * R2: the two ways a semester register stops telling the truth.
       *
       * A term that ended with rows still `registered` is a transcript that will never close: the
       * transcript counts them as in progress, the term GPA stays null, and the certificate that waits
       * on credits waits for ever. Nobody can be graded automatically — a percentage is a result a
       * person enters — so the registrar gets the list, by name, once.
       *
       * And the credit ceiling can be breached without anybody registering for anything. A
       * registration copies the credit it was worth on the day, which protects it from a subject being
       * repriced, but the ceiling itself is `total_credits ÷ duration_terms` on the **programme** —
       * edit either and every register already taken against the old ceiling is suddenly over it. The
       * rows are never unwound (a student who sat the course sat it); the registrar is told, so the
       * next conversation is about the programme rather than about a form that quietly refuses.
       */
      'college.term_watch': async ({ schoolId, payload }) => {
        const today = String((payload as { onDate?: string }).onDate ?? nowSql()).slice(0, 10);
        const terms = await this.db.query<Row>(`SELECT t.* FROM terms t JOIN academic_years y ON y.id = t.academic_year_id WHERE t.school_id = ? AND y.is_current = TRUE`, [schoolId]);
        let openRegisters = 0, overCeiling = 0;
        // a term that closed inside the last month: older than that and the office has moved on
        for (const term of terms.filter(t => String(t.end_date).slice(0, 10) < today && addDays(String(t.end_date).slice(0, 10), 30) >= today)) {
          if (await this.taskPending(schoolId, 'college.open_register', String(term.id))) continue;
          const open = await this.db.query<Row>(`SELECT r.student_id, s.first_name, s.last_name, s.admission_no, sub.name AS subject_name
            FROM course_registrations r JOIN students s ON s.id = r.student_id JOIN class_subjects cs ON cs.id = r.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
            WHERE r.school_id = ? AND r.term_id = ? AND r.status = 'registered' ORDER BY s.admission_no LIMIT 200`, [schoolId, String(term.id)]);
          if (!open.length) continue;
          const lines = open.slice(0, 40).map(o => `${o.admission_no} ${o.first_name} ${o.last_name ?? ''} · ${o.subject_name}`);
          await this.tasks.create({ schoolId, title: `${open.length} course(s) still open in ${String(term.name)}`, description: `${String(term.name)} ended on ${String(term.end_date).slice(0, 10)} and these carry no result, so no term GPA can be struck:\n${lines.join('\n')}${open.length > lines.length ? `\n… and ${open.length - lines.length} more` : ''}`, taskType: 'college.open_register', assignedRole: 'admin', entityType: 'college.term', entityId: String(term.id), priority: 'high' });
          await this.notifications.notifyRole(schoolId, 'admin', { channels: ['in_app', 'push'], eventKey: 'college.open_register', title: 'A semester closed with results outstanding', body: `${String(term.name)}: ${open.length} registration(s) have no result.`, entityType: 'college.term', entityId: String(term.id) });
          openRegisters++;
        }
        for (const term of terms.filter(t => String(t.start_date).slice(0, 10) <= today && String(t.end_date).slice(0, 10) >= today)) {
          const loads = await this.db.query<Row>(`SELECT r.student_id, r.program_id, s.first_name, s.last_name, s.admission_no, p.name AS program_name, p.total_credits, p.duration_terms, SUM(r.credit) AS credits
            FROM course_registrations r JOIN students s ON s.id = r.student_id JOIN programs p ON p.id = r.program_id
            WHERE r.school_id = ? AND r.term_id = ? AND r.status <> 'dropped' GROUP BY r.student_id, r.program_id, s.first_name, s.last_name, s.admission_no, p.name, p.total_credits, p.duration_terms`, [schoolId, String(term.id)]);
          for (const l of loads) {
            const ceiling = this.termCeiling(l);
            if (ceiling == null || round(Number(l.credits)) <= ceiling) continue;
            if (await this.taskPending(schoolId, 'college.over_ceiling', String(l.student_id))) continue;
            await this.tasks.create({ schoolId, title: `${l.first_name} ${l.last_name ?? ''} is over the credit ceiling`.trim(), description: `${l.admission_no} carries ${round(Number(l.credits))} credits in ${String(term.name)}; ${l.program_name} allows ${ceiling}. Nothing has been unwound — the programme's total credits or its number of terms has moved since these were registered.`, taskType: 'college.over_ceiling', assignedRole: 'admin', entityType: 'people.student', entityId: String(l.student_id), priority: 'high' });
            overCeiling++;
          }
        }
        return { openRegisters, overCeiling };
      },
    };
  }

  /** Whether a task of this kind is already waiting on this thing, whichever run left it there. */
  private async taskPending(schoolId: string, taskType: string, entityId: string) {
    const rows = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE school_id = ? AND task_type = ? AND entity_id = ? AND status = 'open'`, [schoolId, taskType, entityId]);
    return Number(rows[0]?.n ?? 0) > 0;
  }

  /** Whether this family has already been chased about registration today, whichever run did it. */
  private async chasedToday(schoolId: string, studentId: string, day: string) {
    const rows = await this.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM notifications WHERE school_id = ? AND event_key = 'college.registration_short' AND entity_id = ? AND created_at >= ?`,
      [schoolId, studentId, `${day} 00:00:00`]);
    return Number(rows[0]?.n ?? 0) > 0;
  }

  private async tellTheFamily(schoolId: string, studentId: string, eventKey: string, title: string, body: string) {
    const guardians = await this.db.query<{ user_id: string | null; phone: string }>(`SELECT g.user_id, g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND sg.receives_notifications = TRUE`, [studentId]);
    for (const g of guardians) {
      await this.notifications.notify({ schoolId, userId: g.user_id, address: g.phone, channels: ['sms', 'push', 'in_app'], eventKey, title, body, entityType: 'people.student', entityId: studentId });
    }
  }
}

/** Date arithmetic on a plain 'YYYY-MM-DD', in UTC, so a job answers the same on every host. */
function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
