import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { TaskService } from '../tasks.js';
import type { AcademicService } from './academic.js';
import { HttpError, badRequest, notFound } from '../context.js';

export interface SlotInput { sectionId: string; dayOfWeek: number; periodId: string; classSubjectId?: string | null; teacherId?: string | null; roomId?: string | null }
export interface GenerateOptions { versionName?: string; days?: number[]; maxSamePerDay?: number; seed?: number; sectionIds?: string[] }
export interface Clash { kind: 'teacher' | 'room' | 'section'; dayOfWeek: number; periodId: string; with: string }

/**
 * Timetable versions and slots with hard clash rules (teacher, room, section per day+period — also enforced by
 * unique keys), an auto-generator v1 (greedy + local repair: spreads each subject's weekly periods across days,
 * respects teacher availability and room use, seeds randomised so a re-run gives a different valid grid) and
 * substitution suggestions for a teacher on a date (free that period, teaches the subject, lowest load).
 */
export class TimetableService {
  constructor(private db: Db, private outbox: OutboxService, private academic: AcademicService, private notifications: NotificationService, private tasks: TaskService) {}

  async versions(schoolId: string, yearId: string) { return this.db.findMany<Row>('timetable_versions', { school_id: schoolId, academic_year_id: yearId }, { orderBy: 'created_at DESC' }); }
  async createVersion(schoolId: string, yearId: string, name: string, effectiveFrom: string, generatedBy: 'manual' | 'auto' = 'manual') {
    const id = ulid();
    await this.db.insert('timetable_versions', { id, school_id: schoolId, academic_year_id: yearId, name, effective_from: effectiveFrom, status: 'draft', generated_by: generatedBy, constraints: null, score: null });
    return id;
  }
  async publish(schoolId: string, versionId: string) {
    const v = await this.db.findOne<Row>('timetable_versions', { id: versionId, school_id: schoolId }); if (!v) throw notFound('timetable version');
    const clashes = await this.validate(schoolId, versionId);
    if (clashes.length) throw new HttpError(409, `${clashes.length} clashes must be fixed before publishing`, 'clashes', clashes.slice(0, 20));
    const slots = await this.db.count('timetable_slots', { version_id: versionId });
    await this.db.transaction(async tx => {
      await tx.update('timetable_versions', { status: 'archived', effective_to: nowSql().slice(0, 10), updated_at: nowSql() }, { school_id: schoolId, academic_year_id: v.academic_year_id as string, status: 'published' });
      await tx.update('timetable_versions', { status: 'published', updated_at: nowSql() }, { id: versionId });
      await this.outbox.emit(tx, { type: 'timetable.published', schoolId, aggregateType: 'curriculum.timetable', aggregateId: versionId, payload: { versionId, academicYearId: String(v.academic_year_id), slots } });
    });
  }
  async publishedVersion(schoolId: string, yearId: string) { return this.db.findOne<Row>('timetable_versions', { school_id: schoolId, academic_year_id: yearId, status: 'published' }); }

  /**
   * Who is in front of a class on this date between these two times, out of the published timetable.
   *
   * Exposed because other modules need to know before they put a member of staff somewhere else — an
   * invigilator roster is the first of them, and a teacher rostered into an exam hall during the
   * period they teach means one room unwatched and one class unattended. Reading `timetable_slots`
   * from the module that needs the answer would be two copies of the same join; asking here is one.
   * A missing time means the whole day, which is what an exam with no clock on it amounts to.
   */
  async teachingBetween(schoolId: string, onDate: string, startTime?: string | null, endTime?: string | null): Promise<Map<string, string>> {
    const busy = new Map<string, string>();
    const year = await this.academic.currentYear(schoolId); if (!year) return busy;
    const version = await this.publishedVersion(schoolId, String(year.id)); if (!version) return busy;
    const dow = new Date(onDate + 'T00:00:00Z').getUTCDay();
    const rows = await this.db.query<Row>(`SELECT s.teacher_id, p.name AS period_name, p.start_time, p.end_time, sec.name AS section_name, sub.name AS subject_name
      FROM timetable_slots s JOIN periods p ON p.id = s.period_id JOIN sections sec ON sec.id = s.section_id
      LEFT JOIN class_subjects cs ON cs.id = s.class_subject_id LEFT JOIN subjects sub ON sub.id = cs.subject_id
      WHERE s.version_id = ? AND s.day_of_week = ? AND s.teacher_id IS NOT NULL AND p.is_break = FALSE`, [String(version.id), dow]);
    const hhmm = (v: unknown) => String(v ?? '').slice(0, 5);
    for (const r of rows) {
      const from = hhmm(r.start_time), to = hhmm(r.end_time);
      if (startTime && endTime && !(from < hhmm(endTime) && to > hhmm(startTime))) continue;
      busy.set(String(r.teacher_id), `${r.subject_name ?? 'a class'} · ${r.section_name} · ${r.period_name} (${from}–${to})`);
    }
    return busy;
  }

  /** Inserts or replaces one slot after checking the three clash rules. */
  async setSlot(schoolId: string, versionId: string, s: SlotInput) {
    const clash = await this.findClash(versionId, s);
    if (clash) throw new HttpError(409, `${clash.kind} already busy on day ${clash.dayOfWeek} that period (${clash.with})`, 'clash', clash);
    const ex = await this.db.findOne<{ id: string }>('timetable_slots', { version_id: versionId, section_id: s.sectionId, day_of_week: s.dayOfWeek, period_id: s.periodId });
    const row = { class_subject_id: s.classSubjectId ?? null, teacher_id: s.teacherId ?? null, room_id: s.roomId ?? null };
    if (ex) { await this.db.update('timetable_slots', row, { id: ex.id }); return ex.id; }
    const id = ulid();
    await this.db.insert('timetable_slots', { id, school_id: schoolId, version_id: versionId, section_id: s.sectionId, day_of_week: s.dayOfWeek, period_id: s.periodId, ...row });
    return id;
  }
  async clearSlot(versionId: string, sectionId: string, dayOfWeek: number, periodId: string) { return this.db.delete('timetable_slots', { version_id: versionId, section_id: sectionId, day_of_week: dayOfWeek, period_id: periodId }); }

  private async findClash(versionId: string, s: SlotInput): Promise<Clash | null> {
    if (s.teacherId) {
      const t = await this.db.query<Row>(`SELECT sec.name AS section, c.name AS class FROM timetable_slots ts JOIN sections sec ON sec.id = ts.section_id JOIN classes c ON c.id = sec.class_id WHERE ts.version_id = ? AND ts.teacher_id = ? AND ts.day_of_week = ? AND ts.period_id = ? AND ts.section_id <> ?`, [versionId, s.teacherId, s.dayOfWeek, s.periodId, s.sectionId]);
      if (t.length) return { kind: 'teacher', dayOfWeek: s.dayOfWeek, periodId: s.periodId, with: `${t[0].class} ${t[0].section}` };
    }
    if (s.roomId) {
      const r = await this.db.query<Row>(`SELECT sec.name AS section, c.name AS class FROM timetable_slots ts JOIN sections sec ON sec.id = ts.section_id JOIN classes c ON c.id = sec.class_id WHERE ts.version_id = ? AND ts.room_id = ? AND ts.day_of_week = ? AND ts.period_id = ? AND ts.section_id <> ?`, [versionId, s.roomId, s.dayOfWeek, s.periodId, s.sectionId]);
      if (r.length) return { kind: 'room', dayOfWeek: s.dayOfWeek, periodId: s.periodId, with: `${r[0].class} ${r[0].section}` };
    }
    return null;
  }

  /** Every teacher/room double-booking in a version (should be empty; unique keys make it impossible to persist). */
  async validate(schoolId: string, versionId: string): Promise<Clash[]> {
    const out: Clash[] = [];
    const t = await this.db.query<Row>(`SELECT teacher_id, day_of_week, period_id, COUNT(*) AS n FROM timetable_slots WHERE version_id = ? AND teacher_id IS NOT NULL GROUP BY teacher_id, day_of_week, period_id HAVING COUNT(*) > 1`, [versionId]);
    for (const r of t) out.push({ kind: 'teacher', dayOfWeek: Number(r.day_of_week), periodId: String(r.period_id), with: String(r.teacher_id) });
    const rm = await this.db.query<Row>(`SELECT room_id, day_of_week, period_id, COUNT(*) AS n FROM timetable_slots WHERE version_id = ? AND room_id IS NOT NULL GROUP BY room_id, day_of_week, period_id HAVING COUNT(*) > 1`, [versionId]);
    for (const r of rm) out.push({ kind: 'room', dayOfWeek: Number(r.day_of_week), periodId: String(r.period_id), with: String(r.room_id) });
    void schoolId;
    return out;
  }

  async grid(schoolId: string, versionId: string, sectionId?: string) {
    const where = sectionId ? 'ts.version_id = ? AND ts.section_id = ?' : 'ts.version_id = ?';
    return this.db.query<Row>(`SELECT ts.*, p.sequence, p.name AS period_name, p.start_time, p.end_time, s.name AS subject_name, s.name_bn AS subject_name_bn, s.code AS subject_code, st.first_name AS teacher_first, st.last_name AS teacher_last, r.name AS room_name, sec.name AS section_name, c.name AS class_name
      FROM timetable_slots ts JOIN periods p ON p.id = ts.period_id JOIN sections sec ON sec.id = ts.section_id JOIN classes c ON c.id = sec.class_id LEFT JOIN class_subjects cs ON cs.id = ts.class_subject_id LEFT JOIN subjects s ON s.id = cs.subject_id LEFT JOIN staff st ON st.id = ts.teacher_id LEFT JOIN rooms r ON r.id = ts.room_id
      WHERE ts.school_id = ? AND ${where} ORDER BY c.numeric_level, sec.name, ts.day_of_week, p.sequence`, sectionId ? [schoolId, versionId, sectionId] : [schoolId, versionId]);
  }
  async teacherGrid(schoolId: string, versionId: string, teacherId: string) {
    return this.db.query<Row>(`SELECT ts.day_of_week, p.sequence, p.name AS period_name, p.start_time, p.end_time, s.name AS subject_name, sec.name AS section_name, c.name AS class_name, r.name AS room_name FROM timetable_slots ts JOIN periods p ON p.id = ts.period_id JOIN sections sec ON sec.id = ts.section_id JOIN classes c ON c.id = sec.class_id LEFT JOIN class_subjects cs ON cs.id = ts.class_subject_id LEFT JOIN subjects s ON s.id = cs.subject_id LEFT JOIN rooms r ON r.id = ts.room_id WHERE ts.school_id = ? AND ts.version_id = ? AND ts.teacher_id = ? ORDER BY ts.day_of_week, p.sequence`, [schoolId, versionId, teacherId]);
  }

  /** Teacher assignments per section+subject (who teaches what). */
  async assignTeacher(schoolId: string, sectionId: string, classSubjectId: string, teacherId: string, isPrimary = true) {
    const ex = await this.db.findOne<{ id: string }>('section_subject_teachers', { section_id: sectionId, class_subject_id: classSubjectId, teacher_id: teacherId });
    if (ex) return ex.id;
    if (isPrimary) await this.db.update('section_subject_teachers', { is_primary: false }, { section_id: sectionId, class_subject_id: classSubjectId });
    const id = ulid();
    await this.db.insert('section_subject_teachers', { id, school_id: schoolId, section_id: sectionId, class_subject_id: classSubjectId, teacher_id: teacherId, is_primary: isPrimary });
    return id;
  }
  /** Assigns teachers to every section-subject that has none: by staff_subjects preference, then least load. */
  async autoAssignTeachers(schoolId: string, yearId: string) {
    const sections = await this.academic.sections(schoolId, yearId);
    const cs = await this.academic.classSubjects(schoolId, yearId);
    const staff = await this.db.findMany<Row>('staff', { school_id: schoolId, staff_category: 'teaching', status: 'active' });
    const prefs = await this.db.findMany<{ staff_id: string; subject_id: string }>('staff_subjects', { school_id: schoolId });
    const bySubject = new Map<string, string[]>(); for (const p of prefs) bySubject.set(p.subject_id, [...(bySubject.get(p.subject_id) ?? []), p.staff_id]);
    const existing = await this.db.findMany<Row>('section_subject_teachers', { school_id: schoolId });
    const have = new Set(existing.map(e => `${e.section_id}:${e.class_subject_id}`));
    const load = new Map<string, number>(); for (const e of existing) load.set(String(e.teacher_id), (load.get(String(e.teacher_id)) ?? 0) + 1);
    let assigned = 0, unassigned = 0;
    for (const sec of sections) for (const c of cs.filter(x => x.class_id === sec.class_id)) {
      const key = `${sec.id}:${c.id}`; if (have.has(key)) continue;
      const pool = (bySubject.get(String(c.subject_id)) ?? []).filter(id => staff.some(s => s.id === id));
      const candidates = pool.length ? pool : staff.map(s => String(s.id));
      if (!candidates.length) { unassigned++; continue; }
      const pick = candidates.sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0))[0];
      await this.assignTeacher(schoolId, String(sec.id), String(c.id), pick); load.set(pick, (load.get(pick) ?? 0) + Number(c.weekly_periods)); assigned++;
    }
    return { assigned, unassigned };
  }

  /**
   * Auto-generator v1. Hard constraints: one class per section per period; a teacher and a room never in two
   * places; no lesson in break periods; weekly periods per class-subject honoured when capacity allows.
   * Soft: at most `maxSamePerDay` of one subject per day (default 1, relaxed automatically when a subject needs more
   * than the number of teaching days), subjects spread across days, heavier subjects earlier. Returns the version id and stats.
   */
  async generate(schoolId: string, yearId: string, opts: GenerateOptions = {}) {
    const offs = await this.academic.weeklyOffs(schoolId);
    const days = opts.days ?? [0, 1, 2, 3, 4, 5, 6].filter(d => !offs.includes(d));
    const allPeriods = await this.academic.periods(schoolId);
    const sections = (await this.academic.sections(schoolId, yearId)).filter(s => !opts.sectionIds || opts.sectionIds.includes(String(s.id)));
    if (!sections.length) throw badRequest('no sections in this year');
    const cs = await this.academic.classSubjects(schoolId, yearId);
    const teachers = await this.db.findMany<Row>('section_subject_teachers', { school_id: schoolId });
    const teacherOf = new Map(teachers.filter(t => Number(t.is_primary)).map(t => [`${t.section_id}:${t.class_subject_id}`, String(t.teacher_id)]));
    const rnd = mulberry32(opts.seed ?? Date.now() % 100000);
    const versionId = await this.createVersion(schoolId, yearId, opts.versionName ?? `Auto ${nowSql().slice(0, 16)}`, nowSql().slice(0, 10), 'auto');

    const teacherBusy = new Set<string>(); const roomBusy = new Set<string>();
    const rows: Row[] = []; let unplaced = 0; let placed = 0; const maxSame = opts.maxSamePerDay ?? 1;
    const firstShift = (await this.academic.shifts(schoolId))[0]?.id ?? null;
    for (const sec of sections) {
      const shiftId = sec.shift_id ?? firstShift; // sections without a shift use the first shift's day
      const periods = allPeriods.filter(p => !Number(p.is_break) && (p.shift_id == null || p.shift_id === shiftId));
      if (!periods.length) continue;
      const cells: { day: number; period: Row }[] = []; for (const d of days) for (const p of periods) cells.push({ day: d, period: p });
      const free = new Set(cells.map(c => `${c.day}:${c.period.id}`));
      const subjects = cs.filter(c => c.class_id === sec.class_id).sort((a, b) => Number(b.weekly_periods) - Number(a.weekly_periods));
      const room = sec.room_id ? String(sec.room_id) : null;
      const perDay = new Map<string, number>();
      for (const sub of subjects) {
        const need = Number(sub.weekly_periods) || 0; const teacher = teacherOf.get(`${sec.id}:${sub.id}`) ?? null;
        const limit = Math.max(maxSame, Math.ceil(need / days.length));
        let got = 0;
        // preferred order: cells shuffled, but prefer days where this subject has fewer periods and earlier periods for heavy subjects
        const candidates = [...cells].filter(c => free.has(`${c.day}:${c.period.id}`)).sort((a, b) => {
          const da = perDay.get(`${sub.id}:${a.day}`) ?? 0, dbb = perDay.get(`${sub.id}:${b.day}`) ?? 0;
          if (da !== dbb) return da - dbb;
          return rnd() - 0.5;
        });
        // pass 1 keeps one period of a subject per day; pass 2 allows a second one when teacher/room clashes left gaps
        for (const lim of [limit, limit + 1]) for (const c of candidates) {
          if (got >= need) break;
          const key = `${c.day}:${c.period.id}`;
          if (!free.has(key)) continue;
          if ((perDay.get(`${sub.id}:${c.day}`) ?? 0) >= lim) continue;
          if (teacher && teacherBusy.has(`${teacher}:${key}`)) continue;
          if (room && roomBusy.has(`${room}:${key}`)) continue;
          free.delete(key); if (teacher) teacherBusy.add(`${teacher}:${key}`); if (room) roomBusy.add(`${room}:${key}`);
          perDay.set(`${sub.id}:${c.day}`, (perDay.get(`${sub.id}:${c.day}`) ?? 0) + 1);
          rows.push({ id: ulid(), school_id: schoolId, version_id: versionId, section_id: sec.id, day_of_week: c.day, period_id: c.period.id, class_subject_id: sub.id, teacher_id: teacher, room_id: room });
          got++; placed++;
        }
        unplaced += need - got;
      }
    }
    if (rows.length) await this.db.insertMany('timetable_slots', rows);
    const clashes = await this.validate(schoolId, versionId);
    const score = Math.round((placed / Math.max(1, placed + unplaced)) * 10000) / 100;
    await this.db.update('timetable_versions', { score, constraints: { days, maxSamePerDay: maxSame, seed: opts.seed ?? null, unplaced } as never, updated_at: nowSql() }, { id: versionId });
    return { versionId, placed, unplaced, clashes: clashes.length, score, sections: sections.length };
  }

  // ---------- substitutions ----------
  /** For a teacher absent on a date: every slot they have that day and the best free substitute for each. */
  async suggestSubstitutes(schoolId: string, versionId: string, teacherId: string, onDate: string, leaveApplicationId?: string | null) {
    const dow = new Date(onDate + 'T00:00:00Z').getUTCDay();
    const slots = await this.db.query<Row>(`SELECT ts.*, cs.subject_id FROM timetable_slots ts LEFT JOIN class_subjects cs ON cs.id = ts.class_subject_id WHERE ts.version_id = ? AND ts.teacher_id = ? AND ts.day_of_week = ?`, [versionId, teacherId, dow]);
    if (!slots.length) return [];
    const staff = await this.db.findMany<Row>('staff', { school_id: schoolId, staff_category: 'teaching', status: 'active' });
    const prefs = await this.db.findMany<{ staff_id: string; subject_id: string }>('staff_subjects', { school_id: schoolId });
    const busy = await this.db.query<{ teacher_id: string; period_id: string }>(`SELECT teacher_id, period_id FROM timetable_slots WHERE version_id = ? AND day_of_week = ? AND teacher_id IS NOT NULL`, [versionId, dow]);
    const busySet = new Set(busy.map(b => `${b.teacher_id}:${b.period_id}`));
    const load = new Map<string, number>(); for (const b of busy) load.set(b.teacher_id, (load.get(b.teacher_id) ?? 0) + 1);
    const already = await this.db.query<{ substitute_teacher_id: string; slot_id: string }>(`SELECT s.substitute_teacher_id, s.slot_id FROM timetable_substitutions s JOIN timetable_slots ts ON ts.id = s.slot_id WHERE s.on_date = ? AND s.status IN ('suggested','pending','approved') AND ts.version_id = ?`, [onDate, versionId]);
    const out: { substitutionId: string; slotId: string; periodId: string; substituteTeacherId: string | null }[] = [];
    for (const slot of slots) {
      const ex = already.find(a => a.slot_id === slot.id);
      if (ex) { out.push({ substitutionId: '', slotId: String(slot.id), periodId: String(slot.period_id), substituteTeacherId: ex.substitute_teacher_id }); continue; }
      const teaches = new Set(prefs.filter(p => p.subject_id === slot.subject_id).map(p => p.staff_id));
      const candidates = staff.filter(s => s.id !== teacherId && !busySet.has(`${s.id}:${slot.period_id}`)).sort((a, b) => (Number(teaches.has(String(b.id))) - Number(teaches.has(String(a.id)))) || ((load.get(String(a.id)) ?? 0) - (load.get(String(b.id)) ?? 0)));
      const pick = candidates[0] ? String(candidates[0].id) : null;
      if (pick) { busySet.add(`${pick}:${slot.period_id}`); load.set(pick, (load.get(pick) ?? 0) + 1); }
      const id = ulid();
      await this.db.insert('timetable_substitutions', { id, school_id: schoolId, slot_id: slot.id, on_date: onDate, original_teacher_id: teacherId, substitute_teacher_id: pick, reason: leaveApplicationId ? 'leave' : 'absent', leave_application_id: leaveApplicationId ?? null, status: 'suggested', is_auto_suggested: true });
      await this.outbox.emitNow({ type: 'substitution.suggested', schoolId, aggregateType: 'curriculum.substitution', aggregateId: id, payload: { substitutionId: id, slotId: String(slot.id), onDate, substituteTeacherId: pick } });
      out.push({ substitutionId: id, slotId: String(slot.id), periodId: String(slot.period_id), substituteTeacherId: pick });
    }
    return out;
  }
  async decideSubstitution(schoolId: string, id: string, status: 'approved' | 'rejected' | 'cancelled', substituteTeacherId?: string | null) {
    const set: Row = { status, updated_at: nowSql() }; if (substituteTeacherId !== undefined) set.substitute_teacher_id = substituteTeacherId;
    const n = await this.db.update('timetable_substitutions', set, { id, school_id: schoolId });
    if (!n) throw notFound('substitution');
    if (status === 'approved') await this.outbox.emitNow({ type: 'substitution.approved' as never, schoolId, aggregateType: 'curriculum.substitution', aggregateId: id, payload: { substitutionId: id } as never });
  }
  async substitutions(schoolId: string, onDate: string) {
    return this.db.query<Row>(`SELECT s.*, ts.day_of_week, ts.section_id, p.name AS period_name, sec.name AS section_name, c.name AS class_name, o.first_name AS original_first, o.last_name AS original_last, sub.first_name AS sub_first, sub.last_name AS sub_last FROM timetable_substitutions s JOIN timetable_slots ts ON ts.id = s.slot_id JOIN periods p ON p.id = ts.period_id JOIN sections sec ON sec.id = ts.section_id JOIN classes c ON c.id = sec.class_id LEFT JOIN staff o ON o.id = s.original_teacher_id LEFT JOIN staff sub ON sub.id = s.substitute_teacher_id WHERE s.school_id = ? AND s.on_date = ? ORDER BY p.sequence`, [schoolId, onDate]);
  }
  parseConstraints(v: Row) { return json(v.constraints); }

  // ---------- scheduled ----------
  /** Whether a task of this kind is already waiting on this thing, whichever run left it there. */
  private async taskPending(schoolId: string, taskType: string, entityId: string) {
    const rows = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE school_id = ? AND task_type = ? AND entity_id = ? AND status = 'open'`, [schoolId, taskType, entityId]);
    return Number(rows[0]?.n ?? 0) > 0;
  }

  /**
   * B3, the half that had no trigger. An approved leave already proposes substitutes, but a teacher
   * who is simply absent — the register says so, no leave form was ever filled in — left their classes
   * uncovered until somebody noticed at the bell. This proposes cover for them on the same terms.
   *
   * It proposes; it does not appoint. `suggestSubstitutes` writes rows with status `suggested`, and a
   * head of department approves them — telling a teacher by SMS that they are now covering period 3 is
   * not something a cron job gets to decide.
   */
  async coverToday(schoolId: string, onDate = nowSql().slice(0, 10)) {
    if (await this.academic.isHoliday(schoolId, onDate)) return { skipped: 'holiday' as string | null, teachers: 0, slots: 0 };
    const year = await this.academic.currentYear(schoolId);
    if (!year) return { skipped: 'no year' as string | null, teachers: 0, slots: 0 };
    const version = await this.publishedVersion(schoolId, String(year.id));
    if (!version) return { skipped: 'no published timetable' as string | null, teachers: 0, slots: 0 };
    const away = await this.db.query<Row>(`SELECT DISTINCT a.staff_id FROM staff_attendance a JOIN staff s ON s.id = a.staff_id
      WHERE a.school_id = ? AND a.on_date = ? AND a.status IN ('absent','excused') AND s.staff_category = 'teaching' AND s.status IN ('active','probation')`, [schoolId, onDate]);
    let teachers = 0, slots = 0;
    for (const t of away) {
      const made = await this.suggestSubstitutes(schoolId, String(version.id), String(t.staff_id), onDate);
      if (!made.length) continue;
      teachers++; slots += made.filter(m => m.substitutionId).length;
    }
    return { skipped: null as string | null, teachers, slots };
  }

  /**
   * B8: the two ways a timetable quietly stops being true.
   *
   * A section-subject with nobody teaching it is a period no one turns up to, and a week into term
   * that is not an oversight anybody is still going to catch. `autoAssignTeachers` fills it the way the
   * generator already does — by the teacher's own subject preference, then by lightest load — and only
   * ever where the slot is empty; an assignment somebody made is never overwritten. What it cannot
   * fill (no teacher in the school teaches that subject) becomes a task, because that is a hiring
   * problem and not a scheduling one.
   *
   * A draft version that validates clean and whose start date has come is prepared, not published:
   * publishing rewrites everybody's week and archives the timetable the school is running on today, so
   * it waits for a person. The task says it is clean and ready, which is the whole point.
   */
  async watch(schoolId: string, opts: { onDate?: string; settleDays?: number } = {}) {
    const today = opts.onDate ?? nowSql().slice(0, 10);
    const year = await this.academic.currentYear(schoolId);
    if (!year) return { skipped: 'no year' as string | null, assigned: 0, unassigned: 0, drafts: 0 };
    // a week's grace after the year opens: on day one half the staff are not on the system yet
    const settled = addDays(String(year.start_date).slice(0, 10), opts.settleDays ?? 7);
    if (today < settled) return { skipped: `the year is still settling until ${settled}` as string | null, assigned: 0, unassigned: 0, drafts: 0 };

    const r = await this.autoAssignTeachers(schoolId, String(year.id));
    if (r.unassigned && !(await this.taskPending(schoolId, 'curriculum.unassigned_subjects', String(year.id)))) {
      await this.tasks.create({ schoolId, title: `${r.unassigned} class-subject(s) have no teacher`, description: `Nobody in the school teaches them, so they could not be assigned automatically. Add the subject to a teacher's profile, or hire.`, taskType: 'curriculum.unassigned_subjects', assignedRole: 'admin', entityType: 'academic.year', entityId: String(year.id), priority: 'high' });
    }

    let drafts = 0;
    const published = await this.publishedVersion(schoolId, String(year.id));
    for (const v of await this.db.query<Row>(`SELECT * FROM timetable_versions WHERE school_id = ? AND academic_year_id = ? AND status = 'draft' AND effective_from <= ? ORDER BY effective_from DESC`, [schoolId, String(year.id), today])) {
      if (published && String(published.created_at) > String(v.created_at)) continue;   // an older draft the school moved past
      if (await this.taskPending(schoolId, 'curriculum.publish_timetable', String(v.id))) continue;
      const clashes = await this.validate(schoolId, String(v.id));
      if (clashes.length) continue;                                                     // not ready; publishing would be refused anyway
      const slots = await this.db.count('timetable_slots', { version_id: String(v.id) });
      if (!slots) continue;
      await this.tasks.create({ schoolId, title: `Publish the timetable: ${String(v.name)}`, description: `${slots} periods, no clashes, effective from ${String(v.effective_from).slice(0, 10)}. Publishing archives the timetable in use today and tells every teacher.`, taskType: 'curriculum.publish_timetable', assignedRole: 'admin', entityType: 'curriculum.timetable', entityId: String(v.id), priority: 'normal' });
      await this.notifications.notifyRole(schoolId, 'admin', { channels: ['in_app', 'push'], eventKey: 'timetable.ready_to_publish', title: 'A timetable is ready to publish', body: `${String(v.name)}: ${slots} periods, no clashes, effective from ${String(v.effective_from).slice(0, 10)}.`, entityType: 'curriculum.timetable', entityId: String(v.id) });
      drafts++;
    }
    return { skipped: null as string | null, assigned: r.assigned, unassigned: r.unassigned, drafts };
  }

  jobs(): Record<string, ScheduledFn> {
    return {
      // B3b: cover proposed for every teacher the register says is away today
      'timetable.cover_today': async ({ schoolId, payload }) => this.coverToday(schoolId, String((payload as { onDate?: string }).onDate ?? nowSql()).slice(0, 10)),
      // B8: subjects with no teacher assigned, and a clean draft nobody published
      'timetable.watch': async ({ schoolId, payload }) => this.watch(schoolId, payload as { onDate?: string }),
    };
  }
}

/** Date arithmetic on a plain 'YYYY-MM-DD', in UTC, so a job answers the same on every host. */
function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
