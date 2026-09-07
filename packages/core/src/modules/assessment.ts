import * as XLSX from 'xlsx';
import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { Adapters, JobContext, ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { AcademicService } from './academic.js';
import type { FileService } from '../files.js';
import type { DocumentService } from './documents.js';
import type { FeesService } from './fees.js';
import { HttpError, badRequest, notFound } from '../context.js';

export interface ExamInput { academicYearId?: string | null; termId?: string | null; examTypeId?: string | null; gradingScaleId?: string | null; name: string; startDate: string; endDate: string; classIds?: string[]; requireFeeClearance?: boolean; minAttendancePct?: number | null; rankScope?: 'section' | 'class' | 'both'; tieRule?: 'share_rank' | 'dense' | 'by_total' }
export interface MarkInput { studentId: string; theory?: number | null; practical?: number | null; ca?: number | null; isAbsent?: boolean; remarks?: string | null }

/**
 * Assessment: exams and their per-subject schedules, eligibility (fee clearance, attendance), seat
 * plans and admit cards, marks entry with verification and lock, the result engine (grade bands,
 * GPA, fail rules, ranks with tie handling), report-card PDFs rendered in chunks, publication, and
 * promotion. The engine is deterministic: recomputing an exam gives the same numbers.
 */
export class AssessmentService {
  constructor(private db: Db, private outbox: OutboxService, private notifications: NotificationService, private academic: AcademicService, private files: FileService, private adapters: Adapters, private documents: DocumentService, private fees?: FeesService) {}

  // ---------- setup ----------
  async gradingScales(schoolId: string) {
    const scales = await this.db.findMany<Row>('grading_scales', { school_id: schoolId });
    const out = [];
    for (const s of scales) out.push({ ...s, bands: await this.db.findMany<Row>('grading_bands', { scale_id: String(s.id) }, { orderBy: 'min_percent DESC' }) });
    return out;
  }
  async ensureExamTypes(schoolId: string) {
    if (await this.db.count('exam_types', { school_id: schoolId })) return 0;
    const types: [string, number, boolean][] = [['Class test', 10, true], ['Half-yearly', 30, false], ['Annual', 60, false]];
    for (const [name, weight, internal] of types) await this.db.insert('exam_types', { id: ulid(), school_id: schoolId, name, weight_pct: weight, is_internal: internal });
    return types.length;
  }
  async examTypes(schoolId: string) { return this.db.findMany<Row>('exam_types', { school_id: schoolId }, { orderBy: 'weight_pct ASC' }); }
  /**
   * The school's own scale applied to one percentage. Anything outside this module that has to turn a
   * mark into a grade point — a college posting a semester result, say — comes through here, so one
   * school never ends up with two ideas of what 62% is worth.
   */
  async gradeFor(schoolId: string, percent: number, scaleId?: string | null) {
    const scale = scaleId ? await this.db.findOne<Row>('grading_scales', { id: scaleId, school_id: schoolId }) : await this.db.findOne<Row>('grading_scales', { school_id: schoolId, is_default: true });
    if (!scale) throw new HttpError(409, 'no grading scale — re-run the seeds', 'no_scale');
    const bands = await this.db.findMany<Row>('grading_bands', { scale_id: String(scale.id) }, { orderBy: 'min_percent DESC' });
    if (!bands.length) throw new HttpError(409, 'the grading scale has no bands', 'no_bands');
    const band = this.bandFor(bands, Math.max(0, Math.min(100, percent)));
    return { scaleId: String(scale.id), gpaMax: Number(scale.gpa_max), grade: String(band?.grade ?? ''), gradePoint: Number(band?.grade_point ?? 0), isFail: Number(band?.is_fail) === 1 };
  }

  /** Creates an exam and one schedule row per class-subject of the chosen classes. */
  async createExam(schoolId: string, e: ExamInput) {
    const year = await this.academic.requireYear(schoolId, e.academicYearId);
    const scale = e.gradingScaleId ? await this.db.findOne<Row>('grading_scales', { id: e.gradingScaleId, school_id: schoolId }) : await this.db.findOne<Row>('grading_scales', { school_id: schoolId, is_default: true });
    if (!scale) throw new HttpError(409, 'no grading scale — re-run the seeds', 'no_scale');
    await this.ensureExamTypes(schoolId);
    const type = e.examTypeId ? await this.db.findOne<Row>('exam_types', { id: e.examTypeId, school_id: schoolId }) : (await this.examTypes(schoolId)).at(-1);
    if (!type) throw new HttpError(409, 'no exam type', 'no_type');
    const id = ulid();
    await this.db.insert('exams', { id, school_id: schoolId, academic_year_id: String(year.id), term_id: e.termId ?? null, exam_type_id: String(type.id), grading_scale_id: String(scale.id), name: e.name, start_date: e.startDate, end_date: e.endDate, marks_entry_deadline: null, publish_at: null, status: 'draft', require_fee_clearance: e.requireFeeClearance ?? false, min_attendance_pct: e.minAttendancePct ?? null, rank_scope: e.rankScope ?? 'section', tie_rule: e.tieRule ?? 'share_rank', created_by: null });
    const cs = await this.academic.classSubjects(schoolId, String(year.id));
    const chosen = e.classIds?.length ? cs.filter(c => e.classIds!.includes(String(c.class_id))) : cs;
    if (chosen.length) await this.db.insertMany('exam_schedules', chosen.map(c => ({ id: ulid(), school_id: schoolId, exam_id: id, class_subject_id: String(c.id), exam_date: e.startDate, start_time: null, end_time: null, room_id: null, full_marks: Number(c.full_marks ?? 100), pass_marks: Number(c.pass_marks ?? 33), theory_marks: null, practical_marks: null, ca_marks: null, marks_entry_locked: false })));
    return { id, schedules: chosen.length };
  }
  async exams(schoolId: string, yearId?: string) {
    const where: Row = { school_id: schoolId }; if (yearId) where.academic_year_id = yearId;
    return this.db.query<Row>(`SELECT e.*, t.name AS exam_type, (SELECT COUNT(*) FROM exam_schedules s WHERE s.exam_id = e.id) AS subjects, (SELECT COUNT(*) FROM exam_results r WHERE r.exam_id = e.id) AS results FROM exams e JOIN exam_types t ON t.id = e.exam_type_id WHERE e.school_id = ?${yearId ? ' AND e.academic_year_id = ?' : ''} ORDER BY e.start_date DESC`, yearId ? [schoolId, yearId] : [schoolId]);
  }
  async schedules(schoolId: string, examId: string) {
    return this.db.query<Row>(`SELECT s.*, sub.name AS subject_name, sub.name_bn AS subject_name_bn, c.name AS class_name, c.id AS class_id, c.numeric_level,
      (SELECT COUNT(*) FROM marks m WHERE m.schedule_id = s.id) AS entered
      FROM exam_schedules s JOIN class_subjects cs ON cs.id = s.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id JOIN classes c ON c.id = cs.class_id
      WHERE s.school_id = ? AND s.exam_id = ? ORDER BY c.numeric_level, sub.name`, [schoolId, examId]);
  }
  async setSchedule(schoolId: string, scheduleId: string, patch: { examDate?: string; startTime?: string | null; endTime?: string | null; roomId?: string | null; fullMarks?: number; passMarks?: number }) {
    const set: Row = {};
    if (patch.examDate) set.exam_date = patch.examDate; if ('startTime' in patch) set.start_time = patch.startTime ?? null; if ('endTime' in patch) set.end_time = patch.endTime ?? null;
    if ('roomId' in patch) set.room_id = patch.roomId ?? null; if (patch.fullMarks != null) set.full_marks = patch.fullMarks; if (patch.passMarks != null) set.pass_marks = patch.passMarks;
    if (!Object.keys(set).length) return 0;
    return this.db.update('exam_schedules', { ...set, updated_at: nowSql() }, { id: scheduleId, school_id: schoolId });
  }

  /**
   * D2: eligibility + seat plan. A student is ineligible when fees are outstanding (if the exam
   * requires clearance) or attendance is below the minimum; the reason is recorded so the office can
   * explain it. Seats are allocated room by room in roll order.
   */
  async buildSeatPlan(schoolId: string, examId: string) {
    const exam = await this.db.findOne<Row>('exams', { id: examId, school_id: schoolId });
    if (!exam) throw notFound('exam');
    const classIds = [...new Set((await this.schedules(schoolId, examId)).map(s => String(s.class_id)))];
    if (!classIds.length) return { seated: 0, ineligible: 0 };
    const students = await this.db.query<Row>(`SELECT s.id, s.first_name, s.last_name, s.current_roll_no, s.current_section_id, e.class_id FROM student_enrollments e JOIN students s ON s.id = e.student_id
      WHERE e.school_id = ? AND e.academic_year_id = ? AND e.status = 'active' AND s.status = 'active' AND e.class_id IN (${classIds.map(() => '?').join(',')}) ORDER BY e.class_id, LENGTH(e.roll_no), e.roll_no`, [schoolId, String(exam.academic_year_id), ...classIds]);
    const rooms = await this.db.findMany<Row>('rooms', { school_id: schoolId, room_type: 'classroom' }, { orderBy: 'name ASC' });
    const dues = new Map<string, number>();
    if (Number(exam.require_fee_clearance)) {
      const rows = await this.db.query<{ student_id: string; due: number }>(`SELECT student_id, SUM(balance) AS due FROM invoices WHERE school_id = ? AND balance > 0 GROUP BY student_id`, [schoolId]);
      for (const r of rows) dues.set(String(r.student_id), Number(r.due));
    }
    const attendance = new Map<string, number>();
    if (exam.min_attendance_pct) {
      const rows = await this.db.query<{ student_id: string; pct: number }>(`SELECT student_id, AVG(pct) AS pct FROM attendance_monthly_summary WHERE school_id = ? GROUP BY student_id`, [schoolId]);
      for (const r of rows) attendance.set(String(r.student_id), Number(r.pct));
    }
    let seated = 0, ineligible = 0, roomIndex = 0, overCapacity = 0;
    const capacity = (r: Row) => Number(r.capacity ?? 40);
    // Seats are numbered per room, so the count of a room is also its next seat number. When every
    // room is full (a school with more candidates than rooms) seating continues round-robin above
    // capacity rather than failing: the numbers stay unique and the caller is told how many spilled.
    const used = new Map<string, number>();
    const nextRoom = (): Row | null => {
      if (!rooms.length) return null;
      for (let i = 0; i < rooms.length; i++) {
        const r = rooms[(roomIndex + i) % rooms.length] as Row;
        if ((used.get(String(r.id)) ?? 0) < capacity(r)) { roomIndex = (roomIndex + i) % rooms.length; return r; }
      }
      overCapacity++;
      const r = rooms[roomIndex % rooms.length] as Row;
      roomIndex++;
      return r;
    };
    await this.db.transaction(async tx => {
      await tx.delete('exam_seat_plans', { exam_id: examId });
      const rows: Row[] = [];
      for (const st of students) {
        let reason: string | null = null;
        if (dues.has(String(st.id))) reason = `fees due: ${dues.get(String(st.id))}`;
        else if (exam.min_attendance_pct && (attendance.get(String(st.id)) ?? 100) < Number(exam.min_attendance_pct)) reason = `attendance below ${exam.min_attendance_pct}%`;
        const useRoom = reason ? null : nextRoom();
        let seatNo = '—';
        if (useRoom) { const n = (used.get(String(useRoom.id)) ?? 0) + 1; used.set(String(useRoom.id), n); seatNo = String(n); }
        rows.push({ id: ulid(), school_id: schoolId, exam_id: examId, student_id: String(st.id), room_id: useRoom ? String(useRoom.id) : null, seat_no: seatNo, admit_card_file_id: null, is_eligible: !reason, ineligible_reason: reason });
        if (reason) ineligible++; else seated++;
      }
      if (rows.length) await tx.insertMany('exam_seat_plans', rows);
    });
    await this.db.update('exams', { status: 'scheduled', updated_at: nowSql() }, { id: examId });
    return { seated, ineligible, rooms: rooms.length, overCapacity };
  }
  async seatPlan(schoolId: string, examId: string) {
    return this.db.query<Row>(`SELECT p.*, s.first_name, s.last_name, s.admission_no, s.current_roll_no, r.name AS room_name, c.name AS class_name FROM exam_seat_plans p JOIN students s ON s.id = p.student_id LEFT JOIN rooms r ON r.id = p.room_id LEFT JOIN classes c ON c.id = s.current_class_id WHERE p.school_id = ? AND p.exam_id = ? ORDER BY c.numeric_level, LENGTH(p.seat_no), p.seat_no`, [schoolId, examId]);
  }

  /**
   * D2: admit cards for everyone the seat plan found eligible. Queued and chunked like the report
   * cards, because 1,500 cards is 1,500 PDFs and no request may take that long. A candidate who is
   * not eligible gets no card, which is the point of the eligibility check.
   */
  async issueAdmitCards(schoolId: string, examId: string) {
    const exam = await this.db.findOne<Row>('exams', { id: examId, school_id: schoolId });
    if (!exam) throw notFound('exam');
    const pending = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM exam_seat_plans WHERE exam_id = ? AND is_eligible = TRUE AND admit_card_file_id IS NULL`, [examId]);
    if (!Number(pending[0]?.n ?? 0)) return { queued: false, pending: 0 };
    await this.adapters.queue.push({ name: 'assessment.admit_cards', queue: 'batch', schoolId, payload: { examId }, triggeredBy: 'assessment.seat_plan' });
    return { queued: true, pending: Number(pending[0]!.n) };
  }
  async renderAdmitCards(payload: Record<string, unknown>, ctx: JobContext) {
    const examId = String(payload.examId);
    const exam = await this.db.findOne<Row>('exams', { id: examId });
    if (!exam) throw notFound('exam');
    const schoolId = String(exam.school_id);
    const schedules = await this.schedules(schoolId, examId);
    const papers = schedules.map(s => `${String(s.subject_name)} — ${String(s.exam_date ?? '').slice(0, 10)} ${String(s.start_time ?? '').slice(0, 5)}`).join('\n');
    const seats = await this.db.query<Row>(`SELECT p.*, s.first_name, s.last_name, s.admission_no, s.current_roll_no, r.name AS room_name, c.name AS class_name, sec.name AS section_name
      FROM exam_seat_plans p JOIN students s ON s.id = p.student_id LEFT JOIN rooms r ON r.id = p.room_id LEFT JOIN classes c ON c.id = s.current_class_id LEFT JOIN sections sec ON sec.id = s.current_section_id
      WHERE p.exam_id = ? AND p.is_eligible = TRUE ORDER BY p.id`, [examId]);
    const cursor = (ctx.job.cursor as { done?: number } | null) ?? {};
    let done = cursor.done ?? 0;
    const CHUNK = 25;
    while (done < seats.length) {
      for (const seat of seats.slice(done, done + CHUNK)) {
        if (seat.admit_card_file_id) continue;
        const issued = await this.documents.issue(schoolId, {
          docType: 'admit_card', personType: 'student', studentId: String(seat.student_id),
          data: {
            name: `${seat.first_name} ${seat.last_name ?? ''}`.trim(), application_no: String(seat.admission_no), test: String(exam.name),
            held_at: `${String(exam.start_date).slice(0, 10)} to ${String(exam.end_date).slice(0, 10)}`,
            venue: `${seat.room_name ?? 'the exam hall'} · seat ${seat.seat_no}`,
            guardian: `${seat.class_name ?? ''} ${seat.section_name ?? ''} · roll ${seat.current_roll_no ?? '—'}`,
            note: papers,
          },
          entityType: 'assessment.exam', entityId: examId,
        });
        await this.db.update('exam_seat_plans', { admit_card_file_id: issued.fileId, updated_at: nowSql() }, { id: String(seat.id) });
      }
      done = Math.min(seats.length, done + CHUNK);
      await ctx.progress(done, seats.length, { done });
      if (Date.now() > ctx.deadline && done < seats.length) return { continue: true as const, cursor: { done } };
    }
    // the guardians of the ineligible are told why, once, rather than finding out at the gate
    const blocked = await this.db.query<Row>(`SELECT p.*, s.first_name FROM exam_seat_plans p JOIN students s ON s.id = p.student_id WHERE p.exam_id = ? AND p.is_eligible = FALSE`, [examId]);
    for (const b of blocked) {
      const guardians = await this.db.query<{ user_id: string | null; phone: string }>(`SELECT g.user_id, g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND sg.receives_notifications = TRUE`, [String(b.student_id)]);
      for (const g of guardians) await this.notifications.notify({ schoolId, userId: g.user_id, address: g.phone, channels: ['sms', 'push', 'in_app'], eventKey: 'assessment.not_eligible', data: { student: String(b.first_name), exam: String(exam.name), reason: String(b.ineligible_reason ?? '') }, title: 'Admit card not issued', body: `${b.first_name} cannot sit ${exam.name} yet: ${b.ineligible_reason}. Clear it and the card will be issued.`, entityType: 'assessment.exam', entityId: examId });
    }
    return { result: { admitCards: seats.length, ineligible: blocked.length } };
  }

  // ---------- marks ----------
  /** The marks grid for one exam subject: every eligible student with what has been entered. */
  async marksGrid(schoolId: string, scheduleId: string, sectionId?: string) {
    const sched = await this.db.query<Row>(`SELECT s.*, cs.class_id, sub.name AS subject_name, c.name AS class_name FROM exam_schedules s JOIN class_subjects cs ON cs.id = s.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id JOIN classes c ON c.id = cs.class_id WHERE s.id = ? AND s.school_id = ?`, [scheduleId, schoolId]);
    if (!sched[0]) throw notFound('exam schedule');
    const schedule = sched[0];
    const rows = await this.db.query<Row>(`SELECT s.id AS student_id, s.first_name, s.last_name, s.current_roll_no, sec.name AS section_name, m.id AS mark_id, m.theory_obtained, m.practical_obtained, m.ca_obtained, m.total_obtained, m.is_absent, m.grade, m.status
      FROM student_enrollments e JOIN students s ON s.id = e.student_id LEFT JOIN sections sec ON sec.id = e.section_id LEFT JOIN marks m ON m.student_id = s.id AND m.schedule_id = ?
      WHERE e.school_id = ? AND e.class_id = ? AND e.status = 'active' AND s.status = 'active'${sectionId ? ' AND e.section_id = ?' : ''}
      ORDER BY sec.name, LENGTH(e.roll_no), e.roll_no`, sectionId ? [scheduleId, schoolId, String(schedule.class_id), sectionId] : [scheduleId, schoolId, String(schedule.class_id)]);
    return { schedule, students: rows };
  }
  /** Saves marks for one subject. Refuses out-of-range values and anything on a locked schedule. */
  async saveMarks(schoolId: string, scheduleId: string, marks: MarkInput[], enteredBy?: string | null) {
    const schedule = await this.db.findOne<Row>('exam_schedules', { id: scheduleId, school_id: schoolId });
    if (!schedule) throw notFound('exam schedule');
    if (Number(schedule.marks_entry_locked)) throw new HttpError(409, 'marks for this subject are locked', 'locked');
    const full = Number(schedule.full_marks);
    let saved = 0;
    await this.db.transaction(async tx => {
      for (const m of marks) {
        const theory = m.theory ?? null, practical = m.practical ?? null, ca = m.ca ?? null;
        const total = m.isAbsent ? 0 : round2((theory ?? 0) + (practical ?? 0) + (ca ?? 0));
        if (!m.isAbsent && total > full) throw badRequest(`${total} is more than the full marks (${full})`);
        if ([theory, practical, ca].some(v => v != null && Number(v) < 0)) throw badRequest('marks cannot be negative');
        const row: Row = { school_id: schoolId, schedule_id: scheduleId, student_id: m.studentId, theory_obtained: theory, practical_obtained: practical, ca_obtained: ca, total_obtained: total, is_absent: !!m.isAbsent, status: 'submitted', entered_by: enteredBy ?? null, entered_at: nowSql(), remarks: m.remarks ?? null };
        const ex = await tx.findOne<{ id: string }>('marks', { schedule_id: scheduleId, student_id: m.studentId });
        if (ex) await tx.update('marks', { ...row, updated_at: nowSql() }, { id: ex.id });
        else await tx.insert('marks', { id: ulid(), ...row });
        saved++;
      }
    });
    await this.db.update('exams', { status: 'marks_entry', updated_at: nowSql() }, { id: String(schedule.exam_id), status: 'scheduled' });
    return { saved };
  }
  /**
   * The marks sheet a subject teacher fills in offline. It carries the student ids, so a row cannot
   * be matched to the wrong child when someone sorts the sheet or a roll number changes mid-term.
   */
  async marksSheet(schoolId: string, scheduleId: string, sectionId?: string): Promise<Buffer> {
    const { schedule, students } = await this.marksGrid(schoolId, scheduleId, sectionId);
    const aoa: (string | number)[][] = [
      [`${schedule.class_name} - ${schedule.subject_name}`, `full ${Number(schedule.full_marks)}`, `theory ${Number(schedule.theory_marks ?? 0)}`, `practical ${Number(schedule.practical_marks ?? 0)}`, `ca ${Number(schedule.ca_marks ?? 0)}`],
      ['student_id', 'roll', 'name', 'theory', 'practical', 'ca', 'absent'],
      ...students.map(r => [String(r.student_id), String(r.current_roll_no ?? ''), `${r.first_name} ${r.last_name ?? ''}`.trim(),
        r.theory_obtained == null ? '' : Number(r.theory_obtained), r.practical_obtained == null ? '' : Number(r.practical_obtained),
        r.ca_obtained == null ? '' : Number(r.ca_obtained), Number(r.is_absent) ? 'yes' : '']),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Marks');
    return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  }
  /**
   * Reads that sheet back. Every row is checked before anything is saved — a sheet with one bad
   * number saves nothing and comes back with the row numbers, because a half-entered subject is
   * worse than an empty one.
   */
  async importMarks(schoolId: string, scheduleId: string, buffer: Buffer, enteredBy?: string | null) {
    const schedule = await this.db.findOne<Row>('exam_schedules', { id: scheduleId, school_id: schoolId });
    if (!schedule) throw notFound('exam schedule');
    if (Number(schedule.marks_entry_locked)) throw new HttpError(409, 'marks for this subject are locked', 'locked');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]!];
    if (!ws) throw badRequest('the file has no sheet');
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: '' });
    const headerAt = aoa.findIndex(r => String(r[0] ?? '').trim().toLowerCase() === 'student_id');
    if (headerAt < 0) throw badRequest('the sheet needs a student_id column; download the template first');
    const headers = (aoa[headerAt] as unknown[]).map(h => String(h ?? '').trim().toLowerCase());
    const col = (name: string) => headers.indexOf(name);
    const { students } = await this.marksGrid(schoolId, scheduleId);
    const known = new Map(students.map(r => [String(r.student_id), `${r.first_name} ${r.last_name ?? ''}`.trim()]));
    const full = Number(schedule.full_marks);
    const errors: { row: number; message: string }[] = [];
    const marks: MarkInput[] = [];
    const seen = new Set<string>();
    for (let i = headerAt + 1; i < aoa.length; i++) {
      const r = aoa[i] as unknown[];
      const studentId = String(r[col('student_id')] ?? '').trim();
      if (!studentId) continue;
      const line = i + 1;
      if (!known.has(studentId)) { errors.push({ row: line, message: 'this student is not in the class for this subject' }); continue; }
      if (seen.has(studentId)) { errors.push({ row: line, message: `${known.get(studentId)} appears twice in the sheet` }); continue; }
      seen.add(studentId);
      const absent = ['yes', 'y', 'true', '1', 'a'].includes(String(r[col('absent')] ?? '').trim().toLowerCase());
      const num = (name: string): number | null | undefined => {
        const at = col(name); if (at < 0) return null;
        const raw = String(r[at] ?? '').trim(); if (!raw) return null;
        const v = Number(raw);
        if (!Number.isFinite(v)) { errors.push({ row: line, message: `"${raw}" in ${name} is not a number` }); return undefined; }
        if (v < 0) { errors.push({ row: line, message: `${name} cannot be negative` }); return undefined; }
        return round2(v);
      };
      const theory = num('theory'), practical = num('practical'), ca = num('ca');
      if (theory === undefined || practical === undefined || ca === undefined) continue;
      if (!absent && theory == null && practical == null && ca == null) continue;   // simply not entered yet
      const total = round2((theory ?? 0) + (practical ?? 0) + (ca ?? 0));
      if (!absent && total > full) { errors.push({ row: line, message: `${known.get(studentId)} has ${total}, more than the full marks (${full})` }); continue; }
      marks.push({ studentId, theory, practical, ca, isAbsent: absent });
    }
    if (errors.length) return { saved: 0, errors, read: marks.length + errors.length };
    const r = await this.saveMarks(schoolId, scheduleId, marks, enteredBy);
    return { saved: r.saved, errors: [] as { row: number; message: string }[], read: marks.length };
  }
  /** Verification and lock: after this only an admin reversal can change a mark. */
  async verifyMarks(schoolId: string, scheduleId: string, verifiedBy?: string | null) {
    const n = await this.db.update('marks', { status: 'verified', verified_by: verifiedBy ?? null, verified_at: nowSql(), updated_at: nowSql() }, { schedule_id: scheduleId, school_id: schoolId });
    return { verified: n };
  }
  async lockMarks(schoolId: string, scheduleId: string) {
    await this.db.update('marks', { status: 'locked', updated_at: nowSql() }, { schedule_id: scheduleId, school_id: schoolId });
    await this.db.update('exam_schedules', { marks_entry_locked: true, updated_at: nowSql() }, { id: scheduleId, school_id: schoolId });
    const schedule = await this.db.findOne<Row>('exam_schedules', { id: scheduleId });
    await this.outbox.emitNow({ type: 'marks.locked', schoolId, aggregateType: 'assessment.schedule', aggregateId: scheduleId, payload: { scheduleId, examId: String(schedule?.exam_id) } as never });
    return { locked: true };
  }
  async unlockMarks(schoolId: string, scheduleId: string) {
    await this.db.update('exam_schedules', { marks_entry_locked: false, updated_at: nowSql() }, { id: scheduleId, school_id: schoolId });
    await this.db.update('marks', { status: 'verified', updated_at: nowSql() }, { schedule_id: scheduleId, school_id: schoolId });
    return { locked: false };
  }
  /** Which subjects still owe marks — drives the D3 deadline reminders. */
  async missingMarks(schoolId: string, examId: string) {
    return this.db.query<Row>(`SELECT s.id AS schedule_id, sub.name AS subject_name, c.name AS class_name,
        (SELECT COUNT(*) FROM student_enrollments e WHERE e.class_id = cs.class_id AND e.status = 'active') AS expected,
        (SELECT COUNT(*) FROM marks m WHERE m.schedule_id = s.id) AS entered
      FROM exam_schedules s JOIN class_subjects cs ON cs.id = s.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id JOIN classes c ON c.id = cs.class_id
      WHERE s.school_id = ? AND s.exam_id = ?`, [schoolId, examId]);
  }

  // ---------- result engine ----------
  private bandFor(bands: Row[], percent: number) {
    return bands.find(b => percent >= Number(b.min_percent) && percent <= Number(b.max_percent)) ?? bands[bands.length - 1];
  }
  /**
   * Computes every student's result for an exam: per-subject grade points, GPA (failing any subject
   * makes the GPA 0 when the scale says so — the Bangladesh rule), percentage, ranks inside the
   * section and the class with the exam's tie rule.
   */
  async computeResults(schoolId: string, examId: string) {
    const exam = await this.db.findOne<Row>('exams', { id: examId, school_id: schoolId });
    if (!exam) throw notFound('exam');
    const bands = await this.db.findMany<Row>('grading_bands', { scale_id: String(exam.grading_scale_id) }, { orderBy: 'min_percent DESC' });
    if (!bands.length) throw new HttpError(409, 'the grading scale has no bands', 'no_bands');
    const scale = await this.db.findOne<Row>('grading_scales', { id: String(exam.grading_scale_id) });
    const failZero = Number(scale?.fail_gpa_zero ?? 1) === 1;
    const rows = await this.db.query<Row>(`SELECT m.*, s.full_marks, s.pass_marks, cs.class_id, st.current_section_id, st.id AS student_id
      FROM marks m JOIN exam_schedules s ON s.id = m.schedule_id JOIN class_subjects cs ON cs.id = s.class_subject_id JOIN students st ON st.id = m.student_id
      WHERE m.school_id = ? AND s.exam_id = ?`, [schoolId, examId]);
    if (!rows.length) return { students: 0, message: 'no marks entered yet' };
    const perStudent = new Map<string, { classId: string; sectionId: string | null; full: number; obtained: number; points: number[]; failed: number }>();
    for (const r of rows) {
      const key = String(r.student_id);
      const cur = perStudent.get(key) ?? { classId: String(r.class_id), sectionId: (r.current_section_id as string) ?? null, full: 0, obtained: 0, points: [], failed: 0 };
      const full = Number(r.full_marks), obtained = Number(r.total_obtained ?? 0);
      const pct = full ? (obtained / full) * 100 : 0;
      const band = this.bandFor(bands, pct);
      const failed = Number(r.is_absent) === 1 || obtained < Number(r.pass_marks) || Number(band?.is_fail) === 1;
      cur.full += full; cur.obtained += obtained; cur.points.push(failed ? 0 : Number(band?.grade_point ?? 0)); if (failed) cur.failed++;
      perStudent.set(key, cur);
      await this.db.update('marks', { grade: String(band?.grade ?? ''), grade_point: failed ? 0 : Number(band?.grade_point ?? 0), is_pass: !failed }, { id: String(r.id) });
    }
    const attendance = new Map<string, number>();
    for (const a of await this.db.query<{ student_id: string; pct: number }>(`SELECT student_id, AVG(pct) AS pct FROM attendance_monthly_summary WHERE school_id = ? GROUP BY student_id`, [schoolId])) attendance.set(String(a.student_id), Number(a.pct));

    const results: { studentId: string; sectionId: string | null; classId: string; percentage: number; gpa: number; grade: string; failed: number; isPass: boolean; full: number; obtained: number }[] = [];
    for (const [studentId, v] of perStudent) {
      const percentage = v.full ? round2((v.obtained / v.full) * 100) : 0;
      const rawGpa = v.points.length ? round2(v.points.reduce((a, p) => a + p, 0) / v.points.length) : 0;
      const gpa = v.failed && failZero ? 0 : rawGpa;
      const grade = v.failed && failZero ? String(bands[bands.length - 1].grade) : String(this.bandFor(bands, percentage)?.grade ?? '');
      results.push({ studentId, sectionId: v.sectionId, classId: v.classId, percentage, gpa, grade, failed: v.failed, isPass: v.failed === 0, full: v.full, obtained: v.obtained });
    }
    const rank = (list: typeof results, key: 'sectionId' | 'classId') => {
      const groups = new Map<string, typeof results>();
      for (const r of list) { const g = String(r[key] ?? ''); groups.set(g, [...(groups.get(g) ?? []), r]); }
      const ranks = new Map<string, number>();
      for (const [, group] of groups) {
        const sorted = [...group].sort((a, b) => b.gpa - a.gpa || b.percentage - a.percentage || b.obtained - a.obtained);
        let lastKey = ''; let lastRank = 0;
        sorted.forEach((r, i) => {
          const k = exam.tie_rule === 'by_total' ? `${r.gpa}:${r.obtained}` : `${r.gpa}:${r.percentage}`;
          const position = exam.tie_rule === 'dense' ? (k === lastKey ? lastRank : lastRank + 1) : (k === lastKey ? lastRank : i + 1);
          ranks.set(r.studentId, position); lastKey = k; lastRank = position;
        });
      }
      return ranks;
    };
    const sectionRanks = rank(results, 'sectionId'), classRanks = rank(results, 'classId');
    await this.db.transaction(async tx => {
      for (const r of results) {
        const row: Row = { school_id: schoolId, exam_id: examId, student_id: r.studentId, section_id: r.sectionId, total_full_marks: r.full, total_obtained: r.obtained, percentage: r.percentage, gpa: r.gpa, grade: r.grade, failed_subjects: r.failed, is_pass: r.isPass, rank_in_section: sectionRanks.get(r.studentId) ?? null, rank_in_class: classRanks.get(r.studentId) ?? null, attendance_pct: attendance.get(r.studentId) ?? null, computed_at: nowSql() };
        const ex = await tx.findOne<{ id: string }>('exam_results', { exam_id: examId, student_id: r.studentId });
        if (ex) await tx.update('exam_results', row, { id: ex.id }); else await tx.insert('exam_results', { id: ulid(), ...row });
      }
    });
    await this.db.update('exams', { status: 'processing', updated_at: nowSql() }, { id: examId });
    return { students: results.length, passed: results.filter(r => r.isPass).length, failed: results.filter(r => !r.isPass).length };
  }

  async results(schoolId: string, examId: string, f: { sectionId?: string; classId?: string } = {}) {
    const where = ['r.school_id = ?', 'r.exam_id = ?']; const params: unknown[] = [schoolId, examId];
    if (f.sectionId) { where.push('r.section_id = ?'); params.push(f.sectionId); }
    if (f.classId) { where.push('s.current_class_id = ?'); params.push(f.classId); }
    return this.db.query<Row>(`SELECT r.*, s.first_name, s.last_name, s.admission_no, s.current_roll_no, c.name AS class_name, sec.name AS section_name FROM exam_results r JOIN students s ON s.id = r.student_id LEFT JOIN classes c ON c.id = s.current_class_id LEFT JOIN sections sec ON sec.id = r.section_id WHERE ${where.join(' AND ')} ORDER BY r.rank_in_class, r.gpa DESC LIMIT 2000`, params);
  }
  async studentResult(schoolId: string, examId: string, studentId: string) {
    const result = await this.db.findOne<Row>('exam_results', { exam_id: examId, student_id: studentId, school_id: schoolId });
    const subjects = await this.db.query<Row>(`SELECT m.*, sub.name AS subject_name, sub.name_bn AS subject_name_bn, s.full_marks, s.pass_marks FROM marks m JOIN exam_schedules s ON s.id = m.schedule_id JOIN class_subjects cs ON cs.id = s.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id WHERE m.student_id = ? AND s.exam_id = ? ORDER BY sub.name`, [studentId, examId]);
    return { result, subjects };
  }

  /**
   * Publishes an exam: report-card PDFs are rendered by a chunked queue job (so 1,500 students finish
   * inside a shared-hosting request budget), then guardians are told.
   */
  async publish(schoolId: string, examId: string, opts: { publishAt?: string | null } = {}) {
    const exam = await this.db.findOne<Row>('exams', { id: examId, school_id: schoolId });
    if (!exam) throw notFound('exam');
    if (!(await this.db.count('exam_results', { exam_id: examId }))) throw new HttpError(409, 'compute the results first', 'no_results');
    if (opts.publishAt && opts.publishAt > nowSql()) {
      await this.db.update('exams', { publish_at: opts.publishAt, status: 'processing', updated_at: nowSql() }, { id: examId });
      return { scheduled: opts.publishAt };
    }
    await this.adapters.queue.push({ name: 'assessment.report_cards', queue: 'pdf', schoolId, payload: { examId }, triggeredBy: 'assessment.publish' });
    return { queued: true };
  }

  /** Queue handler: renders report cards in chunks of 25, then marks the exam published. */
  async renderReportCards(payload: Record<string, unknown>, ctx: JobContext) {
    const examId = String(payload.examId);
    const exam = await this.db.findOne<Row>('exams', { id: examId });
    if (!exam) throw notFound('exam');
    const schoolId = String(exam.school_id);
    const school = await this.db.findOne<Row>('schools', { id: schoolId });
    const results = await this.db.query<Row>(`SELECT r.*, s.first_name, s.last_name, s.name_bn, s.admission_no, s.current_roll_no, c.name AS class_name, sec.name AS section_name FROM exam_results r JOIN students s ON s.id = r.student_id LEFT JOIN classes c ON c.id = s.current_class_id LEFT JOIN sections sec ON sec.id = r.section_id WHERE r.exam_id = ? ORDER BY r.id`, [examId]);
    const cursor = (ctx.job.cursor as { done?: number } | null) ?? {};
    let done = cursor.done ?? 0;
    const CHUNK = 25;
    while (done < results.length) {
      for (const r of results.slice(done, done + CHUNK)) {
        if (r.report_card_file_id) continue;
        const { subjects } = await this.studentResult(schoolId, examId, String(r.student_id));
        const pdf = await this.adapters.pdf.render(this.reportCardDoc(school, exam, r, subjects));
        const f = await this.files.store({ schoolId, data: pdf, fileName: `report-${r.admission_no}-${String(exam.name).replace(/\W+/g, '-')}.pdf`, mimeType: 'application/pdf', purpose: 'report_card', entityType: 'assessment.result', entityId: String(r.id) });
        await this.db.update('exam_results', { report_card_file_id: f.id, published_at: nowSql() }, { id: String(r.id) });
      }
      done = Math.min(results.length, done + CHUNK);
      await ctx.progress(done, results.length, { done });
      if (Date.now() > ctx.deadline && done < results.length) return { continue: true as const, cursor: { done } };
    }
    await this.db.update('exams', { status: 'published', publish_at: nowSql(), updated_at: nowSql() }, { id: examId });
    await this.outbox.emitNow({ type: 'result.published', schoolId, aggregateType: 'assessment.exam', aggregateId: examId, payload: { examId, name: String(exam.name), students: results.length } as never });
    // guardians hear about it once, with the child's GPA
    for (const r of results) {
      const guardians = await this.db.query<{ user_id: string | null; phone: string }>(`SELECT g.user_id, g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND sg.receives_notifications = TRUE`, [String(r.student_id)]);
      for (const g of guardians) await this.notifications.notify({ schoolId, userId: g.user_id, address: g.phone, channels: ['sms', 'push', 'in_app'], eventKey: 'assessment.result_published', data: { student: String(r.first_name), exam: String(exam.name), gpa: Number(r.gpa), grade: String(r.grade) }, title: 'Result published', body: `${r.first_name}: ${exam.name} — GPA ${Number(r.gpa)} (${r.grade}).`, entityType: 'assessment.result', entityId: String(r.id) });
    }
    return { result: { reportCards: results.length } };
  }

  /** pdfmake document for one report card. Bangla renders with the bundled Noto Sans Bengali. */
  private reportCardDoc(school: Row | null, exam: Row, r: Row, subjects: Row[]) {
    const head = [['Subject', 'Full', 'Obtained', 'Grade', 'Point']];
    const body = subjects.map(s => [String(s.subject_name), String(Number(s.full_marks)), s.is_absent ? 'Absent' : String(Number(s.total_obtained ?? 0)), String(s.grade ?? ''), String(Number(s.grade_point ?? 0))]);
    return {
      pageSize: 'A4', pageMargins: [36, 40, 36, 40],
      content: [
        { text: String(school?.name ?? 'School'), style: 'h1' },
        school?.name_bn ? { text: String(school.name_bn), style: 'h2' } : {},
        { text: `${exam.name} · Report card`, style: 'h2', margin: [0, 8, 0, 12] },
        { columns: [
          { width: '*', stack: [{ text: `${r.first_name} ${r.last_name ?? ''}`.trim(), style: 'name' }, r.name_bn ? { text: String(r.name_bn) } : {}, { text: `Admission ${r.admission_no} · Roll ${r.current_roll_no ?? '—'}` }] },
          { width: 'auto', stack: [{ text: `${r.class_name ?? ''} ${r.section_name ?? ''}` }, { text: `GPA ${Number(r.gpa)} (${r.grade})`, style: 'gpa' }, { text: `Rank ${r.rank_in_section ?? '—'} in section` }] },
        ], margin: [0, 0, 0, 12] },
        { table: { headerRows: 1, widths: ['*', 40, 60, 40, 40], body: [...head, ...body] }, layout: 'lightHorizontalLines' },
        { text: `Total ${Number(r.total_obtained)} / ${Number(r.total_full_marks)} · ${Number(r.percentage)}%${r.attendance_pct ? ` · Attendance ${Number(r.attendance_pct)}%` : ''}`, margin: [0, 12, 0, 0] },
        { text: Number(r.is_pass) ? 'Promoted to the next assessment' : `Failed in ${Number(r.failed_subjects)} subject(s)`, style: Number(r.is_pass) ? 'pass' : 'fail', margin: [0, 6, 0, 0] },
        { text: r.teacher_remark ? `Teacher: ${r.teacher_remark}` : '', margin: [0, 12, 0, 0] },
      ],
      styles: { h1: { fontSize: 18, bold: true }, h2: { fontSize: 12 }, name: { fontSize: 14, bold: true }, gpa: { fontSize: 14, bold: true }, pass: { color: '#1E7F4F' }, fail: { color: '#B9352F' } },
    } as Record<string, unknown>;
  }

  // ---------- promotion ----------
  /** Weighted annual result across every exam of the year, then promote/retain by the rules. */
  async computeAnnual(schoolId: string, yearId: string) {
    const exams = await this.db.query<Row>(`SELECT e.id, t.weight_pct FROM exams e JOIN exam_types t ON t.id = e.exam_type_id WHERE e.school_id = ? AND e.academic_year_id = ? AND e.status IN ('published','locked','processing')`, [schoolId, yearId]);
    if (!exams.length) return { students: 0 };
    const weights = new Map(exams.map(e => [String(e.id), Number(e.weight_pct) || 100]));
    const rows = await this.db.query<Row>(`SELECT r.student_id, r.exam_id, r.gpa, r.percentage, r.failed_subjects FROM exam_results r WHERE r.exam_id IN (${exams.map(() => '?').join(',')})`, exams.map(e => e.id));
    const per = new Map<string, { gpa: number; pct: number; weight: number; failed: number }>();
    for (const r of rows) {
      const w = weights.get(String(r.exam_id)) ?? 100;
      const cur = per.get(String(r.student_id)) ?? { gpa: 0, pct: 0, weight: 0, failed: 0 };
      cur.gpa += Number(r.gpa) * w; cur.pct += Number(r.percentage) * w; cur.weight += w; cur.failed = Math.max(cur.failed, Number(r.failed_subjects));
      per.set(String(r.student_id), cur);
    }
    const rules = await this.db.findMany<Row>('promotion_rules', { school_id: schoolId, academic_year_id: yearId });
    const defaultRule = { min_gpa: 1, max_failed_subjects: 0, min_attendance_pct: 0 };
    let count = 0;
    for (const [studentId, v] of per) {
      const gpa = v.weight ? round2(v.gpa / v.weight) : 0;
      const pct = v.weight ? round2(v.pct / v.weight) : 0;
      const student = await this.db.findOne<Row>('students', { id: studentId });
      const rule = rules.find(r => r.class_id === student?.current_class_id) ?? rules.find(r => !r.class_id) ?? defaultRule as unknown as Row;
      const decision = gpa >= Number(rule.min_gpa) && v.failed <= Number(rule.max_failed_subjects) ? 'promoted' : 'retained';
      const ex = await this.db.findOne<{ id: string }>('annual_results', { academic_year_id: yearId, student_id: studentId });
      const row = { school_id: schoolId, academic_year_id: yearId, student_id: studentId, weighted_gpa: gpa, weighted_pct: pct, rank_in_class: null, decision, computed_at: nowSql() };
      if (ex) await this.db.update('annual_results', row, { id: ex.id }); else await this.db.insert('annual_results', { id: ulid(), ...row });
      count++;
    }
    return { students: count };
  }
  /** Moves promoted students into next year's enrollment; retained students keep their class. */
  async promote(schoolId: string, fromYearId: string, toYearId: string, opts: { apply?: boolean } = {}) {
    const results = await this.db.query<Row>(`SELECT a.*, s.current_class_id, s.current_section_id, e.id AS enrollment_id, e.class_id FROM annual_results a JOIN students s ON s.id = a.student_id JOIN student_enrollments e ON e.student_id = a.student_id AND e.academic_year_id = ? WHERE a.school_id = ? AND a.academic_year_id = ?`, [fromYearId, schoolId, fromYearId]);
    const classes = await this.academic.classes(schoolId);
    const byLevel = new Map(classes.map(c => [Number(c.numeric_level), c]));
    let promoted = 0, retained = 0;
    for (const r of results) {
      const current = classes.find(c => String(c.id) === String(r.class_id));
      const nextClass = r.decision === 'promoted' ? byLevel.get(Number(current?.numeric_level ?? 0) + 1) : current;
      if (!nextClass) { retained++; continue; }
      if (opts.apply) {
        const sections = await this.academic.sections(schoolId, toYearId, String(nextClass.id));
        const target = sections.find(s => Number(s.enrolled) < Number(s.capacity)) ?? sections[0];
        const exists = await this.db.findOne('student_enrollments', { student_id: String(r.student_id), academic_year_id: toYearId });
        let toEnrollmentId: string | null = exists ? String((exists as Row).id) : null;
        if (!exists && target) {
          toEnrollmentId = ulid();
          await this.db.insert('student_enrollments', { id: toEnrollmentId, school_id: schoolId, student_id: String(r.student_id), academic_year_id: toYearId, class_id: String(nextClass.id), section_id: String(target.id), roll_no: null, enrolled_on: nowSql().slice(0, 10), status: 'active', promoted_from_id: String(r.enrollment_id) });
          await this.db.update('students', { current_academic_year_id: toYearId, current_class_id: String(nextClass.id), current_section_id: String(target.id), updated_at: nowSql() }, { id: String(r.student_id) });
          await this.db.update('student_enrollments', { status: r.decision === 'promoted' ? 'promoted' : 'retained' }, { id: String(r.enrollment_id) });
        }
        await this.db.insert('promotions', { id: ulid(), school_id: schoolId, student_id: String(r.student_id), from_enrollment_id: String(r.enrollment_id), to_enrollment_id: toEnrollmentId, decision: r.decision as never, annual_gpa: Number(r.weighted_gpa), is_auto: true, decided_by: null, note: null });
      }
      if (r.decision === 'promoted') promoted++; else retained++;
    }
    return { promoted, retained, applied: !!opts.apply };
  }

  // ---------- competency-based assessment ----------
  /**
   * The NCTB 2023 curriculum grades a child against what they can do, not out of a hundred. A scale
   * is a handful of levels (the triangle, circle and square), an outcome is one performance indicator,
   * and an assessment is one teacher's judgement of one child against one indicator in one term.
   *
   * Nothing here is averaged into a mark. A competency report says which indicators a child has met
   * and which they have not, because that is the only form of it a parent can act on.
   */
  async ensureCompetencyScale(schoolId: string, name = 'NCTB', levels?: { code: string; label: string; labelBn?: string; value: number }[]) {
    const ex = await this.db.findOne<{ id: string }>('competency_scales', { school_id: schoolId, name });
    if (ex) return ex.id;
    const id = ulid();
    const defaults = levels ?? [
      { code: '△', label: 'Needs support', labelBn: 'সহায়তা প্রয়োজন', value: 1 },
      { code: '○', label: 'Progressing', labelBn: 'অগ্রগতি হচ্ছে', value: 2 },
      { code: '□', label: 'Achieved', labelBn: 'অর্জিত', value: 3 },
    ];
    await this.db.insert('competency_scales', { id, school_id: schoolId, name, levels: defaults as never });
    return id;
  }
  async scales(schoolId: string) {
    const rows = await this.db.findMany<Row>('competency_scales', { school_id: schoolId });
    return rows.map(r => ({ ...r, levels: json(r.levels) }) as Row);
  }
  async addOutcome(schoolId: string, o: { classSubjectId: string; code: string; statement: string; statementBn?: string | null; unitId?: string | null; bloomLevel?: 'remember' | 'understand' | 'apply' | 'analyse' | 'evaluate' | 'create' | null; weight?: number }) {
    const ex = await this.db.findOne<{ id: string }>('learning_outcomes', { school_id: schoolId, class_subject_id: o.classSubjectId, code: o.code });
    if (ex) return ex.id;
    const id = ulid();
    await this.db.insert('learning_outcomes', { id, school_id: schoolId, class_subject_id: o.classSubjectId, unit_id: o.unitId ?? null, code: o.code, statement: o.statement, statement_bn: o.statementBn ?? null, bloom_level: o.bloomLevel ?? null, weight: o.weight ?? 1 });
    return id;
  }
  async outcomes(schoolId: string, classSubjectId: string) {
    return this.db.findMany<Row>('learning_outcomes', { school_id: schoolId, class_subject_id: classSubjectId }, { orderBy: 'code ASC', limit: 300 });
  }
  /** One teacher's judgement, per child per indicator. Re-rating replaces the old one. */
  async assessCompetency(schoolId: string, rows: { studentId: string; outcomeId: string; termId: string; levelCode: string; evidence?: unknown }[], opts: { scaleId?: string; assessedBy?: string | null } = {}) {
    const scaleId = opts.scaleId ?? await this.ensureCompetencyScale(schoolId);
    const scale = await this.db.findOne<Row>('competency_scales', { id: scaleId, school_id: schoolId });
    if (!scale) throw notFound('competency scale');
    const levels = json<{ code: string }[]>(scale.levels) ?? [];
    let saved = 0;
    for (const r of rows) {
      if (!levels.some(l => l.code === r.levelCode)) throw badRequest(`${r.levelCode} is not a level on the ${scale.name} scale`);
      const ex = await this.db.findOne<Row>('competency_assessments', { student_id: r.studentId, outcome_id: r.outcomeId, term_id: r.termId });
      const row = { school_id: schoolId, student_id: r.studentId, outcome_id: r.outcomeId, term_id: r.termId, scale_id: scaleId, level_code: r.levelCode, evidence: (r.evidence ?? null) as never, assessed_by: opts.assessedBy ?? null, assessed_at: nowSql() };
      if (ex) await this.db.update('competency_assessments', { ...row, updated_at: nowSql() }, { id: String(ex.id) });
      else await this.db.insert('competency_assessments', { id: ulid(), ...row });
      saved++;
    }
    return { saved, scaleId };
  }
  /**
   * A child's competency report for a term: every indicator that was assessed, and — the part that
   * matters to a parent — the ones still to be met, by name.
   */
  async competencyReport(schoolId: string, studentId: string, termId: string) {
    const rows = await this.db.query<Row>(`SELECT a.level_code, o.code, o.statement, o.statement_bn, sub.name AS subject, sc.levels
      FROM competency_assessments a JOIN learning_outcomes o ON o.id = a.outcome_id
      JOIN class_subjects cs ON cs.id = o.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
      JOIN competency_scales sc ON sc.id = a.scale_id
      WHERE a.school_id = ? AND a.student_id = ? AND a.term_id = ? ORDER BY sub.name, o.code`, [schoolId, studentId, termId]);
    const levels = json<{ code: string; label: string; value: number }[]>(rows[0]?.levels) ?? [];
    const top = Math.max(1, ...levels.map(l => l.value));
    const items = rows.map(r => {
      const level = levels.find(l => l.code === String(r.level_code));
      return { subject: String(r.subject), code: String(r.code), statement: String(r.statement), statementBn: (r.statement_bn as string) ?? null, level: String(r.level_code), label: level?.label ?? String(r.level_code), achieved: (level?.value ?? 0) >= top };
    });
    return { studentId, termId, assessed: items.length, achieved: items.filter(i => i.achieved).length, stillToMeet: items.filter(i => !i.achieved), items };
  }

  // ---------- OMR ----------
  /**
   * An answer sheet fed through a scanner. The engine that reads the bubbles is an adapter — this is
   * the part that decides what to do with what it read, and the rule is simple: a sheet the machine
   * is not sure about waits for a person. Applying a batch to the marks grid only ever takes the
   * confident ones, because a mis-read roll number puts one child's marks on another child.
   */
  async ingestOmr(schoolId: string, sheets: { fileId: string; scheduleId?: string | null; detectedRoll?: string | null; answers?: unknown; score?: number | null; confidence?: number | null }[]) {
    let stored = 0, needReview = 0;
    for (const sheet of sheets) {
      const confidence = sheet.confidence ?? 0;
      const student = sheet.detectedRoll ? await this.studentByRoll(schoolId, sheet.detectedRoll, sheet.scheduleId ?? null) : null;
      const status = !student || confidence < 90 ? 'needs_review' : 'processed';
      if (status === 'needs_review') needReview++;
      await this.db.insert('omr_sheets', { id: ulid(), school_id: schoolId, schedule_id: sheet.scheduleId ?? null, online_exam_id: null, student_id: student?.id ?? null, file_id: sheet.fileId, detected_roll: sheet.detectedRoll ?? null, answers: (sheet.answers ?? null) as never, score: sheet.score ?? null, confidence, status });
      stored++;
    }
    return { stored, needReview, processed: stored - needReview };
  }
  /** A person's decision on a sheet the machine was unsure of. */
  async reviewOmr(schoolId: string, sheetId: string, p: { studentId?: string | null; score?: number | null; reject?: boolean }) {
    const sheet = await this.db.findOne<Row>('omr_sheets', { id: sheetId, school_id: schoolId });
    if (!sheet) throw notFound('omr sheet');
    if (p.reject) { await this.db.update('omr_sheets', { status: 'rejected', updated_at: nowSql() }, { id: sheetId }); return { id: sheetId, status: 'rejected' as const }; }
    await this.db.update('omr_sheets', { student_id: p.studentId ?? sheet.student_id, score: p.score ?? sheet.score, confidence: 100, status: 'processed', updated_at: nowSql() }, { id: sheetId });
    return { id: sheetId, status: 'processed' as const };
  }
  /** Puts the confident sheets into the marks grid. Anything still unsure is left for a person. */
  async applyOmr(schoolId: string, scheduleId: string, enteredBy?: string | null) {
    const sheets = await this.db.findMany<Row>('omr_sheets', { school_id: schoolId, schedule_id: scheduleId, status: 'processed' }, { limit: 2000 });
    const marks = sheets.filter(s => s.student_id && s.score != null).map(s => ({ studentId: String(s.student_id), theory: Number(s.score) }));
    if (!marks.length) return { applied: 0, waiting: sheets.length };
    const r = await this.saveMarks(schoolId, scheduleId, marks as never, enteredBy);
    await this.db.execute(`UPDATE omr_sheets SET status = 'applied', updated_at = ? WHERE school_id = ? AND schedule_id = ? AND status = 'processed'`, [nowSql(), schoolId, scheduleId]);
    const waiting = await this.db.count('omr_sheets', { school_id: schoolId, schedule_id: scheduleId, status: 'needs_review' });
    return { applied: r.saved, waiting };
  }
  async omrSheets(schoolId: string, f: { scheduleId?: string; status?: string } = {}) {
    const where: Row = { school_id: schoolId };
    if (f.scheduleId) where.schedule_id = f.scheduleId;
    if (f.status) where.status = f.status;
    return this.db.findMany<Row>('omr_sheets', where, { orderBy: 'created_at DESC', limit: 500 });
  }
  private async studentByRoll(schoolId: string, roll: string, scheduleId: string | null) {
    if (scheduleId) {
      const rows = await this.db.query<{ id: string }>(`SELECT s.id FROM exam_seat_plans p JOIN students s ON s.id = p.student_id WHERE p.school_id = ? AND p.schedule_id IS NULL AND s.current_roll_no = ? LIMIT 1`, [schoolId, roll]).catch(() => []);
      if (rows[0]) return rows[0];
    }
    const byRoll = await this.db.query<{ id: string }>(`SELECT id FROM students WHERE school_id = ? AND (current_roll_no = ? OR admission_no = ?) AND status = 'active' LIMIT 2`, [schoolId, roll, roll]);
    return byRoll.length === 1 ? byRoll[0]! : null;      // two children with the same roll is a person's problem, not a guess
  }

  // ---------- board registration and form fill-up ----------
  /**
   * SSC, HSC, JSC, Dakhil: the school registers its candidates, fills their forms, collects the board
   * fee through the fee ledger, and later imports the result. The subject list is checked against what
   * the child actually studies, because a form filled with a subject they were never taught is found
   * out on results day.
   */
  async registerForBoard(schoolId: string, r: { studentId: string; academicYearId: string; board: string; examName: string; groupName?: string | null; subjects?: string[]; centre?: string | null; registrationNo?: string | null; rollNo?: string | null }) {
    const student = await this.db.findOne<Row>('students', { id: r.studentId, school_id: schoolId });
    if (!student) throw notFound('student');
    const ex = await this.db.findOne<Row>('board_registrations', { school_id: schoolId, student_id: r.studentId, exam_name: r.examName });
    if (ex) return { id: String(ex.id), alreadyRegistered: true };
    if (r.subjects?.length) {
      const taught = await this.db.query<{ name: string }>(`SELECT sub.name FROM class_subjects cs JOIN subjects sub ON sub.id = cs.subject_id WHERE cs.school_id = ? AND cs.class_id = ?`, [schoolId, String(student.current_class_id)]);
      const known = new Set(taught.map(t => String(t.name).toLowerCase()));
      const strange = r.subjects.filter(x => !known.has(x.toLowerCase()));
      if (strange.length && known.size) throw badRequest(`${strange.join(', ')} ${strange.length > 1 ? 'are' : 'is'} not taught in this class`);
    }
    const id = ulid();
    await this.db.insert('board_registrations', { id, school_id: schoolId, student_id: r.studentId, academic_year_id: r.academicYearId, board: r.board, exam_name: r.examName, registration_no: r.registrationNo ?? null, roll_no: r.rollNo ?? null, centre: r.centre ?? null, group_name: r.groupName ?? null, subjects: (r.subjects ?? null) as never, fee_invoice_id: null, status: 'draft', board_result: null });
    return { id };
  }
  /** Submitting the form is when the board fee becomes a bill the guardian can see and pay. */
  async submitBoardForm(schoolId: string, registrationId: string, opts: { fee?: number; feeHeadId?: string | null } = {}) {
    const reg = await this.db.findOne<Row>('board_registrations', { id: registrationId, school_id: schoolId });
    if (!reg) throw notFound('registration');
    if (reg.status !== 'draft') throw new HttpError(409, `this form is already ${reg.status}`, 'conflict');
    if (!reg.registration_no) throw badRequest('the board registration number has to be on the form before it is submitted');
    let invoiceId: string | null = (reg.fee_invoice_id as string) ?? null;
    if (opts.fee && opts.fee > 0 && !invoiceId && this.fees) {
      const inv = await this.fees.createInvoice(schoolId, { studentId: String(reg.student_id), items: [{ feeHeadId: opts.feeHeadId ?? null, description: `${reg.exam_name} board fee`, amount: opts.fee }], notes: `board:${registrationId}` });
      invoiceId = inv.id;
    }
    await this.db.update('board_registrations', { status: 'submitted', fee_invoice_id: invoiceId, updated_at: nowSql() }, { id: registrationId });
    return { id: registrationId, status: 'submitted' as const, invoiceId };
  }
  /**
   * The board's result, imported by registration or roll number. A result for somebody the school did
   * not register is reported rather than guessed at.
   */
  async importBoardResults(schoolId: string, examName: string, rows: { rollNo?: string | null; registrationNo?: string | null; gpa?: number | null; grade?: string | null; subjects?: unknown }[]) {
    let matched = 0; const unmatched: string[] = [];
    for (const r of rows) {
      const where: Row = { school_id: schoolId, exam_name: examName };
      if (r.registrationNo) where.registration_no = r.registrationNo;
      else if (r.rollNo) where.roll_no = r.rollNo;
      else { unmatched.push('a row with neither a roll nor a registration number'); continue; }
      const reg = await this.db.findOne<Row>('board_registrations', where);
      if (!reg) { unmatched.push(String(r.registrationNo ?? r.rollNo)); continue; }
      await this.db.update('board_registrations', { board_result: { gpa: r.gpa ?? null, grade: r.grade ?? null, subjects: r.subjects ?? null, importedAt: nowSql() } as never, status: 'result_received', updated_at: nowSql() }, { id: String(reg.id) });
      matched++;
    }
    return { examName, matched, unmatched };
  }
  async boardRegistrations(schoolId: string, f: { examName?: string; status?: string } = {}) {
    const where: string[] = ['b.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.examName) { where.push('b.exam_name = ?'); params.push(f.examName); }
    if (f.status) { where.push('b.status = ?'); params.push(f.status); }
    const rows = await this.db.query<Row>(`SELECT b.*, s.first_name, s.last_name, s.admission_no FROM board_registrations b JOIN students s ON s.id = b.student_id WHERE ${where.join(' AND ')} ORDER BY s.admission_no LIMIT 2000`, params);
    return rows.map(r => ({ ...r, subjects: json(r.subjects), board_result: json(r.board_result) }) as Row);
  }

  // ---------- question bank & papers ----------
  async addQuestion(schoolId: string, q: { subjectId: string; classId?: string | null; qType: 'mcq' | 'true_false' | 'short' | 'long' | 'fill_blank' | 'match' | 'numeric' | 'essay'; difficulty?: 'easy' | 'medium' | 'hard'; body: string; bodyBn?: string | null; options?: unknown; answer?: unknown; marks?: number; unitId?: string | null }) {
    const id = ulid();
    await this.db.insert('questions', { id, school_id: schoolId, subject_id: q.subjectId, class_id: q.classId ?? null, unit_id: q.unitId ?? null, outcome_id: null, q_type: q.qType, difficulty: q.difficulty ?? 'medium', body: q.body, body_bn: q.bodyBn ?? null, options: jsonCol(q.options), answer: jsonCol(q.answer), marks: q.marks ?? 1, tags: null, ai_generated: false, created_by: null, usage_count: 0 });
    return id;
  }
  /** Builds a paper from a blueprint like `{ mcq: { count: 10, marks: 1 }, short: { count: 5, marks: 4 } }`. */
  async generatePaper(schoolId: string, p: { classSubjectId: string; title: string; blueprint: Record<string, { count: number; marks?: number; difficulty?: 'easy' | 'medium' | 'hard' }>; examId?: string | null; durationMin?: number }) {
    const cs = await this.db.query<Row>(`SELECT cs.*, sub.id AS subject_id FROM class_subjects cs JOIN subjects sub ON sub.id = cs.subject_id WHERE cs.id = ? AND cs.school_id = ?`, [p.classSubjectId, schoolId]);
    if (!cs[0]) throw notFound('class subject');
    const paperId = ulid();
    const items: Row[] = []; let total = 0; let seq = 0; const missing: string[] = [];
    for (const [qType, spec] of Object.entries(p.blueprint)) {
      const params: unknown[] = [schoolId, String(cs[0].subject_id), qType];
      let sql = `SELECT id, marks FROM questions WHERE school_id = ? AND subject_id = ? AND q_type = ?`;
      if (spec.difficulty) { sql += ' AND difficulty = ?'; params.push(spec.difficulty); }
      sql += ` ORDER BY usage_count, id LIMIT ${Math.max(1, spec.count)}`;
      const picked = await this.db.query<Row>(sql, params);
      if (picked.length < spec.count) missing.push(`${qType}: wanted ${spec.count}, found ${picked.length}`);
      for (const q of picked) {
        const marks = spec.marks ?? Number(q.marks);
        items.push({ id: ulid(), school_id: schoolId, paper_id: paperId, question_id: String(q.id), sequence: ++seq, marks, section: qType });
        total = round2(total + marks);
        await this.db.execute(`UPDATE questions SET usage_count = usage_count + 1 WHERE id = ?`, [q.id]);
      }
    }
    await this.db.insert('question_papers', { id: paperId, school_id: schoolId, class_subject_id: p.classSubjectId, exam_id: p.examId ?? null, title: p.title, blueprint: p.blueprint as never, total_marks: total, duration_min: p.durationMin ?? 180, instructions: null, set_label: 'A', pdf_file_id: null, status: 'draft', created_by: null });
    if (items.length) await this.db.insertMany('question_paper_items', items);
    return { id: paperId, questions: items.length, totalMarks: total, missing };
  }
  async paper(schoolId: string, paperId: string) {
    const paper = await this.db.findOne<Row>('question_papers', { id: paperId, school_id: schoolId }); if (!paper) throw notFound('paper');
    const items = await this.db.query<Row>(`SELECT i.*, q.body, q.body_bn, q.q_type, q.options FROM question_paper_items i JOIN questions q ON q.id = i.question_id WHERE i.paper_id = ? ORDER BY i.sequence`, [paperId]);
    return { ...paper, blueprint: json(paper.blueprint), items };
  }

  // ---------- online exams ----------
  async createOnlineExam(schoolId: string, o: { sectionId: string; classSubjectId: string; paperId?: string | null; title: string; startsAt: string; endsAt: string; durationMin: number; totalMarks: number; autoGrade?: boolean }) {
    const id = ulid();
    await this.db.insert('online_exams', { id, school_id: schoolId, schedule_id: null, section_id: o.sectionId, class_subject_id: o.classSubjectId, paper_id: o.paperId ?? null, title: o.title, instructions: null, starts_at: o.startsAt, ends_at: o.endsAt, duration_min: o.durationMin, total_marks: o.totalMarks, shuffle_questions: true, auto_grade: o.autoGrade ?? true, auto_publish: false, proctoring: null, status: 'scheduled', created_by: null });
    return id;
  }
  async submitAttempt(schoolId: string, onlineExamId: string, studentId: string, answers: Record<string, unknown>) {
    const exam = await this.db.findOne<Row>('online_exams', { id: onlineExamId, school_id: schoolId });
    if (!exam) throw notFound('online exam');
    if (String(exam.ends_at) < nowSql()) throw new HttpError(409, 'the exam window has closed', 'closed');
    let score: number | null = null;
    if (Number(exam.auto_grade) && exam.paper_id) {
      const items = await this.db.query<Row>(`SELECT i.marks, q.id, q.answer, q.q_type FROM question_paper_items i JOIN questions q ON q.id = i.question_id WHERE i.paper_id = ?`, [String(exam.paper_id)]);
      score = 0;
      for (const it of items) {
        const correct = json<unknown>(it.answer);
        const given = answers[String(it.id)];
        if (correct != null && given != null && JSON.stringify(correct) === JSON.stringify(given)) score = round2(score + Number(it.marks));
      }
    }
    const ex = await this.db.findOne<{ id: string }>('online_exam_attempts', { online_exam_id: onlineExamId, student_id: studentId });
    const row: Row = { school_id: schoolId, online_exam_id: onlineExamId, student_id: studentId, submitted_at: nowSql(), answers: answers as never, auto_score: score, final_score: score, status: score == null ? 'submitted' : 'auto_graded' };
    if (ex) { await this.db.update('online_exam_attempts', row, { id: ex.id }); return { id: ex.id, score }; }
    const id = ulid(); await this.db.insert('online_exam_attempts', { id, started_at: nowSql(), ...row }); return { id, score };
  }

  /** Scheduled handlers: D2 pre-exam prep and D3 marks-deadline reminders. */
  jobs(): Record<string, ScheduledFn> {
    return {
      'exams.pre_exam_prep': async ({ schoolId }) => {
        const soon = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
        const exams = await this.db.query<Row>(`SELECT * FROM exams WHERE school_id = ? AND status = 'draft' AND start_date <= ? AND start_date >= ?`, [schoolId, soon, nowSql().slice(0, 10)]);
        let prepared = 0;
        for (const e of exams) { await this.buildSeatPlan(schoolId, String(e.id)); prepared++; }
        return { prepared };
      },
      'exams.marks_deadline_reminders': async ({ schoolId }) => {
        const exams = await this.db.query<Row>(`SELECT * FROM exams WHERE school_id = ? AND status IN ('ongoing','marks_entry') AND (marks_entry_deadline IS NULL OR marks_entry_deadline >= ?)`, [schoolId, nowSql()]);
        let reminded = 0;
        for (const e of exams) {
          const missing = (await this.missingMarks(schoolId, String(e.id))).filter(m => Number(m.entered) < Number(m.expected));
          if (!missing.length) continue;
          await this.notifications.notifyRole(schoolId, 'principal', { channels: ['in_app', 'push'], eventKey: 'assessment.marks_pending', title: 'Marks still pending', body: `${e.name}: ${missing.length} subject(s) have not been entered yet.`, entityType: 'assessment.exam', entityId: String(e.id) });
          reminded++;
        }
        return { reminded };
      },
    };
  }
}

/** JSON columns must hold valid JSON on every engine, so a bare scalar is encoded too. */
const jsonCol = (v: unknown) => (v == null ? null : (JSON.stringify(v) as never));
const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
