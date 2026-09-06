import type { Db, Row } from '@pathshala/db';
import { nowSql } from '@pathshala/db';
import type { TimetableService } from './timetable.js';
import type { CmsService } from './cms.js';
import { forbidden } from '../context.js';

/** Guardian PWA v0 data: the children linked to the signed-in guardian, each child's card, notices, timetable. */
export class PortalService {
  constructor(private db: Db, private timetable: TimetableService, private cms: CmsService) {}

  async guardianFor(userId: string) { return this.db.findOne<Row>('guardians', { user_id: userId }); }

  async children(schoolId: string, userId: string) {
    return this.db.query<Row>(`SELECT s.id, s.first_name, s.last_name, s.name_bn, s.admission_no, s.current_roll_no, s.gender, s.date_of_birth, s.photo_file_id, s.status, c.name AS class_name, c.name_bn AS class_name_bn, sec.name AS section_name, sec.id AS section_id, sec.shift_id, sg.relation, sg.is_primary
      FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id JOIN students s ON s.id = sg.student_id LEFT JOIN classes c ON c.id = s.current_class_id LEFT JOIN sections sec ON sec.id = s.current_section_id
      WHERE g.school_id = ? AND g.user_id = ? AND s.status = 'active' ORDER BY s.date_of_birth`, [schoolId, userId]);
  }

  /** Child card + this week's timetable + notices; refuses children the guardian is not linked to. */
  async child(schoolId: string, userId: string, studentId: string) {
    const kids = await this.children(schoolId, userId);
    const kid = kids.find(k => k.id === studentId);
    if (!kid) throw forbidden('not your child');
    const year = await this.db.findOne<Row>('academic_years', { school_id: schoolId, is_current: true });
    let timetable: Row[] = [];
    if (year && kid.section_id) {
      const v = await this.timetable.publishedVersion(schoolId, String(year.id));
      if (v) timetable = await this.timetable.grid(schoolId, String(v.id), String(kid.section_id));
    }
    const today = nowSql().slice(0, 10);
    const substitutions = kid.section_id ? await this.db.query<Row>(`SELECT s.on_date, p.name AS period_name, sub.first_name AS sub_first, sub.last_name AS sub_last FROM timetable_substitutions s JOIN timetable_slots ts ON ts.id = s.slot_id JOIN periods p ON p.id = ts.period_id LEFT JOIN staff sub ON sub.id = s.substitute_teacher_id WHERE s.school_id = ? AND ts.section_id = ? AND s.on_date >= ? AND s.status = 'approved' ORDER BY s.on_date, p.sequence LIMIT 20`, [schoolId, kid.section_id, today]) : [];
    const classTeacher = kid.section_id ? await this.db.query<Row>(`SELECT st.first_name, st.last_name, st.phone FROM sections sec JOIN staff st ON st.id = sec.class_teacher_id WHERE sec.id = ?`, [kid.section_id]) : [];
    const events = await this.db.query<Row>(`SELECT title, event_type, start_date, end_date, is_holiday FROM calendar_events WHERE school_id = ? AND end_date >= ? ORDER BY start_date LIMIT 10`, [schoolId, today]);
    return { child: kid, timetable, substitutions, classTeacher: classTeacher[0] ?? null, events, notices: await this.cms.publicNotices(schoolId, 10) };
  }
}
