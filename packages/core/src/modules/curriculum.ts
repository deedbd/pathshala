import type { Db, Row } from '@pathshala/db';
import { nowSql, ulid } from '@pathshala/db';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import { notFound } from '../context.js';

export interface SyllabusInput { classSubjectId: string; title: string; termId?: string | null; units: { title: string; plannedPeriods?: number; plannedEndDate?: string | null }[] }
export interface LessonPlanInput { teacherId: string; sectionId: string; classSubjectId: string; unitId?: string | null; planDate: string; topic: string; objectives?: string | null; activities?: string | null; homework?: string | null; resources?: unknown }

/** Syllabi with units, lesson plans, syllabus progress roll-up per section, and the weekly "behind schedule" check (B6). */
export class CurriculumService {
  constructor(private db: Db, private outbox: OutboxService, private notifications: NotificationService) {}

  async createSyllabus(schoolId: string, s: SyllabusInput) {
    const id = ulid();
    await this.db.transaction(async tx => {
      await tx.insert('syllabi', { id, school_id: schoolId, class_subject_id: s.classSubjectId, term_id: s.termId ?? null, title: s.title, file_id: null, created_by: null });
      await tx.insertMany('syllabus_units', s.units.map((u, i) => ({ id: ulid(), school_id: schoolId, syllabus_id: id, title: u.title, sequence: i + 1, planned_periods: u.plannedPeriods ?? 1, planned_end_date: u.plannedEndDate ?? null })));
    });
    return id;
  }
  async syllabi(schoolId: string, yearId: string) {
    return this.db.query<Row>(`SELECT sy.*, s.name AS subject_name, c.name AS class_name, (SELECT COUNT(*) FROM syllabus_units u WHERE u.syllabus_id = sy.id) AS units FROM syllabi sy JOIN class_subjects cs ON cs.id = sy.class_subject_id JOIN subjects s ON s.id = cs.subject_id JOIN classes c ON c.id = cs.class_id WHERE sy.school_id = ? AND cs.academic_year_id = ? ORDER BY c.numeric_level, s.name`, [schoolId, yearId]);
  }
  async units(schoolId: string, syllabusId: string) { return this.db.findMany<Row>('syllabus_units', { school_id: schoolId, syllabus_id: syllabusId }, { orderBy: 'sequence ASC' }); }

  async planLesson(schoolId: string, p: LessonPlanInput) {
    const id = ulid();
    await this.db.insert('lesson_plans', { id, school_id: schoolId, teacher_id: p.teacherId, section_id: p.sectionId, class_subject_id: p.classSubjectId, unit_id: p.unitId ?? null, plan_date: p.planDate, topic: p.topic, objectives: p.objectives ?? null, activities: p.activities ?? null, outcomes: null, resources: (p.resources ?? null) as never, homework: p.homework ?? null, status: 'planned' });
    return id;
  }
  async markTaught(schoolId: string, lessonPlanId: string, status: 'taught' | 'skipped' = 'taught') {
    const lp = await this.db.findOne<Row>('lesson_plans', { id: lessonPlanId, school_id: schoolId }); if (!lp) throw notFound('lesson plan');
    await this.db.transaction(async tx => {
      await tx.update('lesson_plans', { status, taught_at: status === 'taught' ? nowSql() : null, updated_at: nowSql() }, { id: lessonPlanId });
      if (status === 'taught') await this.outbox.emit(tx, { type: 'lesson.taught', schoolId, aggregateType: 'curriculum.lesson_plan', aggregateId: lessonPlanId, payload: { lessonPlanId, sectionId: String(lp.section_id), classSubjectId: String(lp.class_subject_id), unitId: (lp.unit_id as string) ?? null } });
    });
    await this.refreshProgress(schoolId, String(lp.class_subject_id), String(lp.section_id));
  }
  async lessons(schoolId: string, f: { sectionId?: string; teacherId?: string; from?: string; to?: string }) {
    const where = ['lp.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.sectionId) { where.push('lp.section_id = ?'); params.push(f.sectionId); } if (f.teacherId) { where.push('lp.teacher_id = ?'); params.push(f.teacherId); }
    if (f.from) { where.push('lp.plan_date >= ?'); params.push(f.from); } if (f.to) { where.push('lp.plan_date <= ?'); params.push(f.to); }
    return this.db.query<Row>(`SELECT lp.*, s.name AS subject_name, sec.name AS section_name, c.name AS class_name, u.title AS unit_title FROM lesson_plans lp JOIN class_subjects cs ON cs.id = lp.class_subject_id JOIN subjects s ON s.id = cs.subject_id JOIN sections sec ON sec.id = lp.section_id JOIN classes c ON c.id = sec.class_id LEFT JOIN syllabus_units u ON u.id = lp.unit_id WHERE ${where.join(' AND ')} ORDER BY lp.plan_date DESC LIMIT 200`, params);
  }

  /** A unit counts as taught for a section once any lesson plan on it is taught. */
  async refreshProgress(schoolId: string, classSubjectId: string, sectionId: string) {
    const syllabi = await this.db.findMany<Row>('syllabi', { school_id: schoolId, class_subject_id: classSubjectId });
    for (const sy of syllabi) {
      const total = await this.db.count('syllabus_units', { syllabus_id: String(sy.id) });
      const taught = await this.db.query<{ n: number }>(`SELECT COUNT(DISTINCT u.id) AS n FROM syllabus_units u JOIN lesson_plans lp ON lp.unit_id = u.id AND lp.section_id = ? AND lp.status = 'taught' WHERE u.syllabus_id = ?`, [sectionId, sy.id]);
      const t = Number(taught[0]?.n ?? 0); const pct = total ? Math.round((t / total) * 10000) / 100 : 0;
      const ex = await this.db.findOne<{ id: string }>('syllabus_progress', { syllabus_id: String(sy.id), section_id: sectionId });
      if (ex) await this.db.update('syllabus_progress', { total_units: total, taught_units: t, pct, refreshed_at: nowSql() }, { id: ex.id });
      else await this.db.insert('syllabus_progress', { id: ulid(), school_id: schoolId, syllabus_id: sy.id, section_id: sectionId, total_units: total, taught_units: t, pct, refreshed_at: nowSql() });
    }
  }
  async progress(schoolId: string, yearId: string) {
    return this.db.query<Row>(`SELECT sp.*, sy.title, s.name AS subject_name, sec.name AS section_name, c.name AS class_name FROM syllabus_progress sp JOIN syllabi sy ON sy.id = sp.syllabus_id JOIN class_subjects cs ON cs.id = sy.class_subject_id JOIN subjects s ON s.id = cs.subject_id JOIN sections sec ON sec.id = sp.section_id JOIN classes c ON c.id = sec.class_id WHERE sp.school_id = ? AND cs.academic_year_id = ? ORDER BY c.numeric_level, sec.name, s.name`, [schoolId, yearId]);
  }

  /** B6 (weekly): units whose planned end date passed without being taught → alert teacher + HOD (admins for now). */
  async syllabusLagCheck(schoolId: string, today = nowSql().slice(0, 10)) {
    const overdue = await this.db.query<Row>(`SELECT u.id AS unit_id, u.title, u.planned_end_date, sy.id AS syllabus_id, sy.class_subject_id, sec.id AS section_id, sec.name AS section_name, c.name AS class_name, s.name AS subject_name
      FROM syllabus_units u JOIN syllabi sy ON sy.id = u.syllabus_id JOIN class_subjects cs ON cs.id = sy.class_subject_id JOIN subjects s ON s.id = cs.subject_id JOIN classes c ON c.id = cs.class_id JOIN sections sec ON sec.class_id = cs.class_id AND sec.academic_year_id = cs.academic_year_id AND sec.status = 'active'
      WHERE u.school_id = ? AND u.planned_end_date IS NOT NULL AND u.planned_end_date < ? AND NOT EXISTS (SELECT 1 FROM lesson_plans lp WHERE lp.unit_id = u.id AND lp.section_id = sec.id AND lp.status = 'taught')`, [schoolId, today]);
    const bySection = new Map<string, Row[]>();
    for (const o of overdue) { const k = `${o.syllabus_id}:${o.section_id}`; bySection.set(k, [...(bySection.get(k) ?? []), o]); }
    let alerts = 0;
    for (const [, list] of bySection) {
      const o = list[0];
      await this.refreshProgress(schoolId, String(o.class_subject_id), String(o.section_id));
      const prog = await this.db.findOne<{ pct: number }>('syllabus_progress', { syllabus_id: String(o.syllabus_id), section_id: String(o.section_id) });
      const teachers = await this.db.query<{ user_id: string | null }>(`SELECT st.user_id FROM section_subject_teachers t JOIN staff st ON st.id = t.teacher_id WHERE t.section_id = ? AND t.class_subject_id = ?`, [o.section_id, o.class_subject_id]);
      const body = `${o.class_name} ${o.section_name} · ${o.subject_name}: ${list.length} unit(s) behind schedule (${Number(prog?.pct ?? 0)}% done). First: ${o.title}`;
      for (const t of teachers) if (t.user_id) await this.notifications.notify({ schoolId, userId: t.user_id, channels: ['push', 'in_app'], eventKey: 'academic.syllabus_lag', title: 'Syllabus behind schedule', body, entityType: 'curriculum.syllabus', entityId: String(o.syllabus_id) });
      await this.notifications.notifyRole(schoolId, 'principal', { channels: ['in_app'], eventKey: 'academic.syllabus_lag', title: 'Syllabus behind schedule', body, entityType: 'curriculum.syllabus', entityId: String(o.syllabus_id) });
      await this.outbox.emitNow({ type: 'syllabus.behind', schoolId, aggregateType: 'curriculum.syllabus', aggregateId: String(o.syllabus_id), payload: { syllabusId: String(o.syllabus_id), sectionId: String(o.section_id), pct: Number(prog?.pct ?? 0), overdueUnits: list.length } });
      alerts++;
    }
    return { overdueUnits: overdue.length, alerts };
  }
}
