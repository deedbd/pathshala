import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { SettingsService } from '../settings.js';
import { HttpError, badRequest, notFound } from '../context.js';

export interface YearInput { name: string; startDate: string; endDate: string; setCurrent?: boolean; cloneFromYearId?: string | null }
export interface ClassInput { name: string; nameBn?: string | null; numericLevel: number; stream?: string | null; programId?: string | null }
export interface SubjectInput { name: string; nameBn?: string | null; code: string; subjectType?: 'theory' | 'practical' | 'both' | 'activity'; isOptional?: boolean }
export interface SectionInput { academicYearId: string; classId: string; name: string; capacity?: number; shiftId?: string | null; roomId?: string | null; campusId?: string | null; classTeacherId?: string | null; genderPolicy?: 'mixed' | 'boys' | 'girls'; medium?: 'bangla' | 'english' | 'arabic' }
export interface ClassSubjectInput { academicYearId: string; classId: string; subjectId: string; isCompulsory?: boolean; fullMarks?: number; passMarks?: number; weeklyPeriods?: number; sortOrder?: number; credit?: number }
export type ProgramLevel = 'secondary' | 'higher_secondary' | 'bachelor' | 'master' | 'diploma' | 'coaching';
export interface ProgramInput { name: string; code: string; level: ProgramLevel; durationTerms?: number | null; totalCredits?: number | null; departmentId?: string | null }
export interface PeriodInput { shiftId?: string | null; name: string; sequence: number; startTime: string; endTime: string; isBreak?: boolean }
export interface CalendarEventInput { academicYearId?: string | null; title: string; eventType: 'holiday' | 'vacation' | 'exam' | 'event' | 'ptm' | 'deadline' | 'meeting'; startDate: string; endDate: string; isHoliday?: boolean; appliesTo?: unknown; description?: string | null }

const DAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * Academic structure: years → terms, classes (levels/streams for school, college, madrasa, coaching),
 * subjects, class-subject matrix, sections, shifts/periods, rooms, calendar, weekly offs.
 * `institution_type` on the school only changes defaults and labels; the tables are the same.
 */
export class AcademicService {
  constructor(private db: Db, private outbox: OutboxService, private settings: SettingsService) {}

  // ---------- years ----------
  async createYear(schoolId: string, input: YearInput) {
    if (input.startDate >= input.endDate) throw badRequest('end date must be after start date');
    const id = ulid();
    await this.db.transaction(async tx => {
      if (input.setCurrent) await tx.update('academic_years', { is_current: false, updated_at: nowSql() }, { school_id: schoolId });
      await tx.insert('academic_years', { id, school_id: schoolId, name: input.name, start_date: input.startDate, end_date: input.endDate, is_current: !!input.setCurrent, status: input.setCurrent ? 'active' : 'planned' });
      await this.outbox.emit(tx, { type: 'academic_year.created', schoolId, aggregateType: 'academic.year', aggregateId: id, payload: { academicYearId: id, previousYearId: input.cloneFromYearId ?? null } });
    });
    if (input.cloneFromYearId) await this.cloneYear(schoolId, input.cloneFromYearId, id);
    return id;
  }
  async setCurrentYear(schoolId: string, yearId: string) {
    await this.db.transaction(async tx => {
      await tx.update('academic_years', { is_current: false, updated_at: nowSql() }, { school_id: schoolId });
      const n = await tx.update('academic_years', { is_current: true, status: 'active', updated_at: nowSql() }, { id: yearId, school_id: schoolId });
      if (!n) throw notFound('academic year');
    });
  }
  async currentYear(schoolId: string) { return this.db.findOne<Row>('academic_years', { school_id: schoolId, is_current: true }); }
  async years(schoolId: string) { return this.db.findMany<Row>('academic_years', { school_id: schoolId }, { orderBy: 'start_date DESC' }); }

  /** B1: copy class-subject matrix and section skeletons from the previous year. */
  async cloneYear(schoolId: string, fromYearId: string, toYearId: string) {
    const cs = await this.db.findMany<Row>('class_subjects', { school_id: schoolId, academic_year_id: fromYearId });
    const existing = new Set((await this.db.findMany<Row>('class_subjects', { school_id: schoolId, academic_year_id: toYearId })).map(r => `${r.class_id}:${r.subject_id}`));
    const rows = cs.filter(r => !existing.has(`${r.class_id}:${r.subject_id}`)).map(r => ({ ...r, id: ulid(), academic_year_id: toYearId, created_at: undefined, updated_at: undefined }));
    for (const r of rows) { delete (r as Row).created_at; delete (r as Row).updated_at; }
    if (rows.length) await this.db.insertMany('class_subjects', rows);
    const secs = await this.db.findMany<Row>('sections', { school_id: schoolId, academic_year_id: fromYearId, status: 'active' });
    const haveSecs = new Set((await this.db.findMany<Row>('sections', { school_id: schoolId, academic_year_id: toYearId })).map(r => `${r.class_id}:${r.name}`));
    const secRows = secs.filter(s => !haveSecs.has(`${s.class_id}:${s.name}`)).map(s => ({ id: ulid(), school_id: schoolId, academic_year_id: toYearId, class_id: s.class_id, campus_id: s.campus_id, shift_id: s.shift_id, name: s.name, capacity: s.capacity, room_id: s.room_id, class_teacher_id: null, gender_policy: s.gender_policy, medium: s.medium, status: 'active' }));
    if (secRows.length) await this.db.insertMany('sections', secRows);
    return { classSubjects: rows.length, sections: secRows.length };
  }

  async addTerm(schoolId: string, yearId: string, t: { name: string; sequence: number; startDate: string; endDate: string; kind?: 'term' | 'semester' | 'trimester' }) {
    const id = ulid();
    await this.db.insert('terms', { id, school_id: schoolId, academic_year_id: yearId, name: t.name, sequence: t.sequence, start_date: t.startDate, end_date: t.endDate, kind: t.kind ?? 'term' });
    return id;
  }
  /**
   * The term today falls inside. In the gap between two terms — the fortnight around the exams, when
   * a school still wants a report — no term contains the date, so the most recent one stands in
   * rather than the caller getting nothing back and quietly doing nothing.
   */
  async currentTerm(schoolId: string, onDate?: string) {
    const day = onDate ?? new Date().toISOString().slice(0, 10);
    const hit = await this.db.query<Row>(`SELECT * FROM terms WHERE school_id = ? AND start_date <= ? AND end_date >= ? ORDER BY start_date DESC, id DESC LIMIT 1`, [schoolId, day, day]);
    if (hit[0]) return hit[0];
    // the most recent term that has actually started. Next year's calendar is usually entered before
    // this year ends, and a term that has not begun has no marks, no register and no assessments —
    // planning against it looks like healthy output and does nothing at all.
    const past = await this.db.query<Row>(`SELECT * FROM terms WHERE school_id = ? AND start_date <= ? ORDER BY start_date DESC, id DESC LIMIT 1`, [schoolId, day]);
    return past[0] ?? null;
  }

  // ---------- programmes ----------
  /**
   * A programme is what a college or a coaching centre admits into: HSC Science, BBA, a six-month
   * spoken-English batch. Classes hang off it as its years or levels. The tables are the school's
   * tables — `programs` only adds the two numbers that a credit system needs, how many terms it runs
   * for and how many credits it takes to finish.
   */
  async createProgram(schoolId: string, p: ProgramInput) {
    const code = p.code.trim().toUpperCase();
    const ex = await this.db.findOne<{ id: string }>('programs', { school_id: schoolId, code });
    if (ex) { await this.updateProgram(schoolId, ex.id, p); return ex.id; }
    const id = ulid();
    await this.db.insert('programs', { id, school_id: schoolId, name: p.name, code, level: p.level, duration_terms: p.durationTerms ?? null, total_credits: p.totalCredits ?? null, department_id: p.departmentId ?? null, status: 'active' });
    return id;
  }
  async updateProgram(schoolId: string, id: string, patch: Partial<ProgramInput> & { status?: 'active' | 'inactive' }) {
    const set: Row = {};
    if (patch.name) set.name = patch.name;
    if (patch.level) set.level = patch.level;
    if ('durationTerms' in patch) set.duration_terms = patch.durationTerms ?? null;
    if ('totalCredits' in patch) set.total_credits = patch.totalCredits ?? null;
    if ('departmentId' in patch) set.department_id = patch.departmentId ?? null;
    if (patch.status) set.status = patch.status;
    if (!Object.keys(set).length) return 0;
    return this.db.update('programs', { ...set, updated_at: nowSql() }, { id, school_id: schoolId });
  }
  async programs(schoolId: string) { return this.db.findMany<Row>('programs', { school_id: schoolId }, { orderBy: 'name ASC' }); }
  async setClassProgram(schoolId: string, classId: string, programId: string | null) {
    if (programId && !(await this.db.findOne('programs', { id: programId, school_id: schoolId }))) throw notFound('programme');
    if (!(await this.db.update('classes', { program_id: programId, updated_at: nowSql() }, { id: classId, school_id: schoolId }))) throw notFound('class');
    return { classId, programId };
  }

  // ---------- classes / subjects / matrix ----------
  async createClass(schoolId: string, c: ClassInput) {
    const id = ulid();
    await this.db.insert('classes', { id, school_id: schoolId, name: c.name, name_bn: c.nameBn ?? null, numeric_level: c.numericLevel, stream: c.stream ?? null, program_id: c.programId ?? null, status: 'active' });
    return id;
  }
  async classes(schoolId: string) { return this.db.findMany<Row>('classes', { school_id: schoolId, status: 'active' }, { orderBy: 'numeric_level ASC, name ASC' }); }
  async createSubject(schoolId: string, s: SubjectInput) {
    const id = ulid();
    await this.db.insert('subjects', { id, school_id: schoolId, name: s.name, name_bn: s.nameBn ?? null, code: s.code.toUpperCase(), subject_type: s.subjectType ?? 'theory', is_optional: !!s.isOptional, status: 'active' });
    return id;
  }
  async subjects(schoolId: string) { return this.db.findMany<Row>('subjects', { school_id: schoolId, status: 'active' }, { orderBy: 'name ASC' }); }
  async setClassSubject(schoolId: string, cs: ClassSubjectInput) {
    const ex = await this.db.findOne<{ id: string }>('class_subjects', { school_id: schoolId, academic_year_id: cs.academicYearId, class_id: cs.classId, subject_id: cs.subjectId });
    const row = { is_compulsory: cs.isCompulsory ?? true, full_marks: cs.fullMarks ?? 100, pass_marks: cs.passMarks ?? 33, weekly_periods: cs.weeklyPeriods ?? 5, sort_order: cs.sortOrder ?? 0 };
    // credit is only touched when the caller says so: a school that never thinks about credits keeps the 1 it was given
    if (ex) { await this.db.update('class_subjects', { ...row, ...(cs.credit != null ? { credit: cs.credit } : {}), updated_at: nowSql() }, { id: ex.id }); return ex.id; }
    const id = ulid();
    await this.db.insert('class_subjects', { id, school_id: schoolId, academic_year_id: cs.academicYearId, class_id: cs.classId, subject_id: cs.subjectId, ...row, credit: cs.credit ?? 1, assessment_mode: 'marks' });
    return id;
  }
  async classSubjects(schoolId: string, yearId: string, classId?: string) {
    const where: Row = { school_id: schoolId, academic_year_id: yearId }; if (classId) where.class_id = classId;
    return this.db.query<Row>(`SELECT cs.*, s.name AS subject_name, s.name_bn AS subject_name_bn, s.code AS subject_code, c.name AS class_name FROM class_subjects cs JOIN subjects s ON s.id = cs.subject_id JOIN classes c ON c.id = cs.class_id WHERE cs.school_id = ? AND cs.academic_year_id = ?${classId ? ' AND cs.class_id = ?' : ''} ORDER BY c.numeric_level, cs.sort_order, s.name`, classId ? [schoolId, yearId, classId] : [schoolId, yearId]);
  }

  // ---------- sections ----------
  async createSection(schoolId: string, s: SectionInput) {
    const id = ulid();
    const shiftId = s.shiftId ?? (String((await this.shifts(schoolId))[0]?.id ?? '') || null); // a section always belongs to a shift so its periods are unambiguous
    await this.db.insert('sections', { id, school_id: schoolId, academic_year_id: s.academicYearId, class_id: s.classId, campus_id: s.campusId ?? null, shift_id: shiftId, name: s.name, capacity: s.capacity ?? 40, room_id: s.roomId ?? null, class_teacher_id: s.classTeacherId ?? null, gender_policy: s.genderPolicy ?? 'mixed', medium: s.medium ?? 'bangla', status: 'active' });
    return id;
  }
  async sections(schoolId: string, yearId: string, classId?: string) {
    return this.db.query<Row>(`SELECT sec.*, c.name AS class_name, c.numeric_level, (SELECT COUNT(*) FROM student_enrollments e WHERE e.section_id = sec.id AND e.status = 'active') AS enrolled FROM sections sec JOIN classes c ON c.id = sec.class_id WHERE sec.school_id = ? AND sec.academic_year_id = ?${classId ? ' AND sec.class_id = ?' : ''} ORDER BY c.numeric_level, sec.name`, classId ? [schoolId, yearId, classId] : [schoolId, yearId]);
  }
  async updateSection(schoolId: string, id: string, patch: Partial<SectionInput> & { status?: 'active' | 'inactive' }) {
    const set: Row = {};
    if (patch.name) set.name = patch.name; if (patch.capacity != null) set.capacity = patch.capacity; if ('roomId' in patch) set.room_id = patch.roomId ?? null;
    if ('classTeacherId' in patch) set.class_teacher_id = patch.classTeacherId ?? null; if ('shiftId' in patch) set.shift_id = patch.shiftId ?? null; if (patch.status) set.status = patch.status;
    if (patch.genderPolicy) set.gender_policy = patch.genderPolicy; if (patch.medium) set.medium = patch.medium;
    if (!Object.keys(set).length) return 0;
    return this.db.update('sections', { ...set, updated_at: nowSql() }, { id, school_id: schoolId });
  }

  // ---------- shifts / periods / rooms ----------
  async shifts(schoolId: string) { return this.db.findMany<Row>('shifts', { school_id: schoolId }, { orderBy: 'start_time ASC' }); }
  async periods(schoolId: string, shiftId?: string | null) {
    const rows = await this.db.findMany<Row>('periods', { school_id: schoolId }, { orderBy: 'sequence ASC' });
    return shiftId === undefined ? rows : rows.filter(p => p.shift_id === shiftId || p.shift_id == null);
  }
  async setPeriods(schoolId: string, shiftId: string | null, list: PeriodInput[]) {
    await this.db.transaction(async tx => {
      await tx.delete('periods', shiftId ? { school_id: schoolId, shift_id: shiftId } : { school_id: schoolId });
      await tx.insertMany('periods', list.map(p => ({ id: ulid(), school_id: schoolId, shift_id: shiftId, name: p.name, sequence: p.sequence, start_time: p.startTime, end_time: p.endTime, is_break: !!p.isBreak })));
    });
  }
  /** Default 8-period day for a shift when none is configured (installer/first year). */
  async ensureDefaultPeriods(schoolId: string) {
    if (await this.db.count('periods', { school_id: schoolId })) return 0;
    const shifts = await this.shifts(schoolId);
    let n = 0;
    for (const s of shifts) {
      const [h, m] = String(s.start_time).split(':').map(Number);
      const start = h * 60 + m; const list: PeriodInput[] = [];
      for (let i = 0; i < 8; i++) {
        const t0 = start + i * 45 + (i >= 4 ? 20 : 0);
        if (i === 4) list.push({ shiftId: String(s.id), name: 'Break', sequence: 5, startTime: hhmm(t0 - 20), endTime: hhmm(t0), isBreak: true });
        list.push({ shiftId: String(s.id), name: `Period ${i + 1}`, sequence: i < 4 ? i + 1 : i + 2, startTime: hhmm(t0), endTime: hhmm(t0 + 45) });
      }
      await this.setPeriods(schoolId, String(s.id), list); n += list.length;
    }
    return n;
  }
  async createRoom(schoolId: string, r: { campusId: string; name: string; building?: string; floor?: string; capacity?: number; roomType?: string }) {
    const id = ulid();
    await this.db.insert('rooms', { id, school_id: schoolId, campus_id: r.campusId, name: r.name, building: r.building ?? null, floor: r.floor ?? null, capacity: r.capacity ?? null, room_type: r.roomType ?? 'classroom', amenities: null });
    return id;
  }
  async rooms(schoolId: string) { return this.db.findMany<Row>('rooms', { school_id: schoolId }, { orderBy: 'name ASC' }); }
  async mainCampus(schoolId: string) { return (await this.db.findOne<Row>('campuses', { school_id: schoolId, is_main: true })) ?? (await this.db.findOne<Row>('campuses', { school_id: schoolId })); }

  // ---------- calendar ----------
  async addCalendarEvent(schoolId: string, e: CalendarEventInput) {
    if (e.startDate > e.endDate) throw badRequest('end date before start date');
    const id = ulid();
    await this.db.transaction(async tx => {
      await tx.insert('calendar_events', { id, school_id: schoolId, academic_year_id: e.academicYearId ?? null, title: e.title, event_type: e.eventType, start_date: e.startDate, end_date: e.endDate, is_holiday: e.isHoliday ?? (e.eventType === 'holiday' || e.eventType === 'vacation'), applies_to: (e.appliesTo ?? null) as never, description: e.description ?? null, created_by: null });
      if (e.isHoliday ?? (e.eventType === 'holiday' || e.eventType === 'vacation')) await this.outbox.emit(tx, { type: 'calendar.holiday_added', schoolId, aggregateType: 'academic.calendar_event', aggregateId: id, payload: { eventId: id, startDate: e.startDate, endDate: e.endDate } });
    });
    return id;
  }
  async calendar(schoolId: string, from: string, to: string) {
    return this.db.query<Row>(`SELECT * FROM calendar_events WHERE school_id = ? AND end_date >= ? AND start_date <= ? ORDER BY start_date ASC`, [schoolId, from, to]);
  }
  /** Weekend days (0 = Sunday … 6 = Saturday) from `weekly_offs`, falling back to settings `calendar.weekend`. */
  async weeklyOffs(schoolId: string): Promise<number[]> {
    const rows = await this.db.findMany<{ day_of_week: number }>('weekly_offs', { school_id: schoolId });
    if (rows.length) return rows.map(r => Number(r.day_of_week)).sort();
    const names = (await this.settings.get<string[]>(schoolId, 'calendar.weekend')) ?? ['fri', 'sat'];
    return names.map(n => DAY_INDEX[n.slice(0, 3).toLowerCase()]).filter(n => n != null).sort();
  }
  async setWeeklyOffs(schoolId: string, days: number[]) {
    await this.db.transaction(async tx => {
      await tx.delete('weekly_offs', { school_id: schoolId });
      if (days.length) await tx.insertMany('weekly_offs', days.map(d => ({ id: ulid(), school_id: schoolId, day_of_week: d })));
    });
  }
  async isHoliday(schoolId: string, date: string): Promise<boolean> {
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    if ((await this.weeklyOffs(schoolId)).includes(dow)) return true;
    const rows = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM calendar_events WHERE school_id = ? AND is_holiday = TRUE AND start_date <= ? AND end_date >= ?`, [schoolId, date, date]);
    return Number(rows[0]?.n) > 0;
  }

  /** Overview for the console: counts per year. */
  async structure(schoolId: string, yearId: string) {
    const [classes, sections, subjects, cs, students] = await Promise.all([
      this.db.count('classes', { school_id: schoolId, status: 'active' }),
      this.db.count('sections', { school_id: schoolId, academic_year_id: yearId, status: 'active' }),
      this.db.count('subjects', { school_id: schoolId, status: 'active' }),
      this.db.count('class_subjects', { school_id: schoolId, academic_year_id: yearId }),
      this.db.count('student_enrollments', { school_id: schoolId, academic_year_id: yearId, status: 'active' }),
    ]);
    return { classes, sections, subjects, classSubjects: cs, students };
  }

  /** Institution presets: what a fresh school of this type usually needs (classes + subjects). */
  async applyPreset(schoolId: string, institutionType: string, yearId: string) {
    const presets: Record<string, { classes: [string, string, number][]; subjects: [string, string, string][] }> = {
      school: { classes: [['Play', 'প্লে', -2], ['Nursery', 'নার্সারি', -1], ['KG', 'কেজি', 0], ['Class 1', 'প্রথম শ্রেণি', 1], ['Class 2', 'দ্বিতীয় শ্রেণি', 2], ['Class 3', 'তৃতীয় শ্রেণি', 3], ['Class 4', 'চতুর্থ শ্রেণি', 4], ['Class 5', 'পঞ্চম শ্রেণি', 5], ['Class 6', 'ষষ্ঠ শ্রেণি', 6], ['Class 7', 'সপ্তম শ্রেণি', 7], ['Class 8', 'অষ্টম শ্রেণি', 8], ['Class 9', 'নবম শ্রেণি', 9], ['Class 10', 'দশম শ্রেণি', 10]],
        subjects: [['Bangla', 'বাংলা', 'BAN'], ['English', 'ইংরেজি', 'ENG'], ['Mathematics', 'গণিত', 'MATH'], ['Science', 'বিজ্ঞান', 'SCI'], ['Bangladesh & Global Studies', 'বাংলাদেশ ও বিশ্বপরিচয়', 'BGS'], ['Religion & Moral Education', 'ধর্ম ও নৈতিক শিক্ষা', 'REL'], ['ICT', 'তথ্য ও যোগাযোগ প্রযুক্তি', 'ICT'], ['Physical Education', 'শারীরিক শিক্ষা', 'PE'], ['Arts & Crafts', 'চারু ও কারুকলা', 'ART']] },
      madrasa: { classes: [['Ebtedayee 1', 'ইবতেদায়ী ১', 1], ['Ebtedayee 2', 'ইবতেদায়ী ২', 2], ['Ebtedayee 3', 'ইবতেদায়ী ৩', 3], ['Ebtedayee 4', 'ইবতেদায়ী ৪', 4], ['Ebtedayee 5', 'ইবতেদায়ী ৫', 5], ['Dakhil 6', 'দাখিল ৬', 6], ['Dakhil 7', 'দাখিল ৭', 7], ['Dakhil 8', 'দাখিল ৮', 8], ['Dakhil 9', 'দাখিল ৯', 9], ['Dakhil 10', 'দাখিল ১০', 10]],
        subjects: [['Quran Majid', 'কুরআন মাজীদ', 'QUR'], ['Hadith', 'হাদীস', 'HAD'], ['Aqaid & Fiqh', 'আকাইদ ও ফিকহ', 'FIQ'], ['Arabic', 'আরবি', 'ARB'], ['Bangla', 'বাংলা', 'BAN'], ['English', 'ইংরেজি', 'ENG'], ['Mathematics', 'গণিত', 'MATH'], ['Science', 'বিজ্ঞান', 'SCI'], ['ICT', 'আইসিটি', 'ICT']] },
      college: { classes: [['XI Science', 'একাদশ বিজ্ঞান', 11], ['XI Humanities', 'একাদশ মানবিক', 11], ['XI Business', 'একাদশ ব্যবসায়', 11], ['XII Science', 'দ্বাদশ বিজ্ঞান', 12], ['XII Humanities', 'দ্বাদশ মানবিক', 12], ['XII Business', 'দ্বাদশ ব্যবসায়', 12]],
        subjects: [['Bangla', 'বাংলা', 'BAN'], ['English', 'ইংরেজি', 'ENG'], ['ICT', 'আইসিটি', 'ICT'], ['Physics', 'পদার্থবিজ্ঞান', 'PHY'], ['Chemistry', 'রসায়ন', 'CHE'], ['Biology', 'জীববিজ্ঞান', 'BIO'], ['Higher Mathematics', 'উচ্চতর গণিত', 'HMATH'], ['Accounting', 'হিসাববিজ্ঞান', 'ACC'], ['Economics', 'অর্থনীতি', 'ECO'], ['Civics', 'পৌরনীতি', 'CIV']] },
      coaching: { classes: [['Batch A', 'ব্যাচ এ', 1], ['Batch B', 'ব্যাচ বি', 2]], subjects: [['Mathematics', 'গণিত', 'MATH'], ['English', 'ইংরেজি', 'ENG'], ['Science', 'বিজ্ঞান', 'SCI']] },
    };
    const p = presets[institutionType] ?? presets[institutionType === 'school_college' ? 'school' : 'school'];
    const classIds: string[] = []; const subjectIds: string[] = [];
    for (const [name, nameBn, level] of p.classes) {
      const ex = await this.db.findOne<{ id: string }>('classes', { school_id: schoolId, name });
      classIds.push(ex ? ex.id : await this.createClass(schoolId, { name, nameBn, numericLevel: level }));
    }
    for (const [name, nameBn, code] of p.subjects) {
      const ex = await this.db.findOne<{ id: string }>('subjects', { school_id: schoolId, code });
      subjectIds.push(ex ? ex.id : await this.createSubject(schoolId, { name, nameBn, code }));
    }
    const core = subjectIds.slice(0, Math.min(6, subjectIds.length));
    for (const cid of classIds) for (const sid of core) await this.setClassSubject(schoolId, { academicYearId: yearId, classId: cid, subjectId: sid, weeklyPeriods: 5 });
    for (const cid of classIds) { if (!(await this.db.findOne('sections', { school_id: schoolId, academic_year_id: yearId, class_id: cid }))) await this.createSection(schoolId, { academicYearId: yearId, classId: cid, name: 'A' }); }
    if (institutionType === 'school_college') await this.applyPreset(schoolId, 'college', yearId);
    return { classes: classIds.length, subjects: subjectIds.length };
  }

  // ---------- scheduled ----------
  /**
   * B9: next year, made before it is needed.
   *
   * Everything the year-end depends on needs a year to point at — the promotion that creates next
   * year's enrolments, the fee structures cloned into it, the sections a promoted child lands in — and
   * a school that has not created one in December finds that out in the first week of January, with
   * the children in front of them. So the last month of the year builds it: the dates shifted by a
   * year, the class-subject matrix and section skeletons cloned from this year (that is what
   * `cloneYear` is for), the name taken from this year's if it is a plain number.
   *
   * It is created `planned`, never made current. Which year the school is *running* is the one
   * decision here that changes what every page shows, and that stays a person's to make.
   */
  async ensureNextYear(schoolId: string, opts: { onDate?: string; withinDays?: number } = {}) {
    const today = opts.onDate ?? nowSql().slice(0, 10);
    const year = await this.currentYear(schoolId);
    if (!year) return { created: null as string | null, skipped: 'no current year' as string | null };
    const start = String(year.start_date).slice(0, 10), end = String(year.end_date).slice(0, 10);
    const endsIn = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    if (endsIn > (opts.withinDays ?? 30)) return { created: null as string | null, skipped: `the year still has ${endsIn} days` as string | null };
    const already = await this.db.query<Row>(`SELECT id FROM academic_years WHERE school_id = ? AND start_date > ? LIMIT 1`, [schoolId, start]);
    if (already.length) return { created: null as string | null, skipped: 'a later year already exists' as string | null };
    const shift = (d: string) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCFullYear(x.getUTCFullYear() + 1); return x.toISOString().slice(0, 10); };
    const name = /^\d{4}$/.test(String(year.name)) ? String(Number(year.name) + 1) : `${year.name} (next)`;
    const id = await this.createYear(schoolId, { name, startDate: shift(start), endDate: shift(end), setCurrent: false, cloneFromYearId: String(year.id) });
    return { created: id, name, startDate: shift(start), endDate: shift(end), skipped: null as string | null };
  }

  jobs(): Record<string, ScheduledFn> {
    return {
      // B9: the next academic year, cloned and planned, before the current one runs out
      'academic.year_rollover': async ({ schoolId, payload }) => this.ensureNextYear(schoolId, payload as { onDate?: string }),
    };
  }

  async requireYear(schoolId: string, yearId?: string | null) {
    const y = yearId ? await this.db.findOne<Row>('academic_years', { id: yearId, school_id: schoolId }) : await this.currentYear(schoolId);
    if (!y) throw new HttpError(409, 'no academic year: create one first', 'no_year');
    return y;
  }
}

function hhmm(min: number) { return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00`; }
export const parseJson = json;
