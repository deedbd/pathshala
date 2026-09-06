import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { OutboxService } from '../automation/outbox.js';
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
  constructor(private db: Db, private outbox: OutboxService, private academic: AcademicService) {}

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
    for (const sec of sections) {
      const periods = allPeriods.filter(p => !Number(p.is_break) && (p.shift_id == null || p.shift_id === sec.shift_id || sec.shift_id == null));
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
        for (const c of candidates) {
          if (got >= need) break;
          const key = `${c.day}:${c.period.id}`;
          if ((perDay.get(`${sub.id}:${c.day}`) ?? 0) >= limit) continue;
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
}

function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
