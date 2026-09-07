import type { Db, Row } from '@pathshala/db';
import { nowSql } from '@pathshala/db';
import type { TimetableService } from './timetable.js';
import type { CmsService } from './cms.js';
import type { FileService } from '../files.js';
import { forbidden } from '../context.js';

/** Guardian PWA v0 data: the children linked to the signed-in guardian, each child's card, notices, timetable. */
export class PortalService {
  constructor(private db: Db, private timetable: TimetableService, private cms: CmsService, private files: FileService) {}

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

  /**
   * Everything else the guardian's app shows about one child: this month's attendance, what is owed,
   * published results, homework that is still open, and what the child has out from the library, the
   * bus and the hostel. One method so the app makes one round trip, and the parent-child check
   * happens once, here.
   */
  async childSummary(schoolId: string, userId: string, studentId: string) {
    const kids = await this.children(schoolId, userId);
    if (!kids.find(k => k.id === studentId)) throw forbidden('not your child');
    const today = nowSql().slice(0, 10);
    const monthStart = `${today.slice(0, 7)}-01`;
    const [attendance, dues, results, homework, books, transport, hostel, documents] = await Promise.all([
      this.db.query<{ present: number; total: number }>(`SELECT SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) AS present, COUNT(*) AS total FROM student_attendance WHERE student_id = ? AND on_date >= ?`, [studentId, monthStart]),
      this.db.query<{ due: number }>(`SELECT COALESCE(SUM(balance), 0) AS due FROM invoices WHERE student_id = ? AND balance > 0 AND status <> 'cancelled'`, [studentId]),
      this.db.query<Row>(`SELECT r.gpa, r.grade, r.percentage, r.rank_in_class, r.report_card_file_id, e.name AS exam_name, e.start_date FROM exam_results r JOIN exams e ON e.id = r.exam_id WHERE r.student_id = ? AND e.status = 'published' ORDER BY e.start_date DESC LIMIT 5`, [studentId]),
      this.db.query<Row>(`SELECT a.id, a.title, a.due_at, s.status AS submission_status, s.marks FROM assignments a JOIN student_enrollments en ON en.section_id = a.section_id AND en.student_id = ?
        LEFT JOIN assignment_submissions s ON s.assignment_id = a.id AND s.student_id = ? WHERE a.school_id = ? AND a.status = 'published' AND a.due_at >= ? ORDER BY a.due_at LIMIT 10`, [studentId, studentId, schoolId, `${today} 00:00:00`]),
      this.db.query<Row>(`SELECT b.title, i.due_at, i.status FROM library_issues i JOIN library_members m ON m.id = i.member_id JOIN library_book_copies c ON c.id = i.copy_id JOIN library_books b ON b.id = c.book_id WHERE m.student_id = ? AND i.status IN ('issued','overdue') ORDER BY i.due_at`, [studentId]),
      this.db.query<Row>(`SELECT r.name AS route_name, st.name AS stop_name, st.pickup_time, t.monthly_fee FROM student_transport t JOIN transport_routes r ON r.id = t.route_id JOIN route_stops st ON st.id = t.stop_id WHERE t.student_id = ? AND t.status = 'active'`, [studentId]),
      this.db.query<Row>(`SELECT h.name AS hostel_name, rm.room_no, b.bed_no FROM hostel_allocations a JOIN hostel_beds b ON b.id = a.bed_id JOIN hostel_rooms rm ON rm.id = b.room_id JOIN hostels h ON h.id = rm.hostel_id WHERE a.student_id = ? AND a.status = 'active'`, [studentId]),
      this.db.query<Row>(`SELECT doc_type, document_no, issued_at, verification_code, file_id FROM issued_documents WHERE student_id = ? AND revoked_at IS NULL ORDER BY issued_at DESC LIMIT 10`, [studentId]),
    ]);
    const present = Number(attendance[0]?.present ?? 0), total = Number(attendance[0]?.total ?? 0);
    // the report card is behind a signed link; the page is rendered on the server, so sign it here
    for (const r of results) r.report_card_url = r.report_card_file_id ? await this.files.url(String(r.report_card_file_id), schoolId, 3600) : null;
    return {
      attendance: { present, total, pct: total ? Math.round((present * 1000) / total) / 10 : null, since: monthStart },
      dues: Number(dues[0]?.due ?? 0), results, homework, books, transport: transport[0] ?? null, hostel: hostel[0] ?? null, documents,
    };
  }
}
