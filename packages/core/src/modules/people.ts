import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { OutboxService } from '../automation/outbox.js';
import type { AuthService } from '../auth/service.js';
import type { NumberingService } from './numbering.js';
import { HttpError, badRequest, notFound } from '../context.js';
import { normalizeBdPhone } from '../util.js';

export interface GuardianInput { fullName: string; phone: string; relation: 'father' | 'mother' | 'grandparent' | 'sibling' | 'uncle' | 'aunt' | 'legal_guardian' | 'other'; email?: string | null; occupation?: string | null; isPrimary?: boolean; paysFees?: boolean; altPhone?: string | null; nidNo?: string | null }
export interface StudentInput {
  firstName: string; lastName?: string | null; nameBn?: string | null; gender: 'male' | 'female' | 'other'; dateOfBirth: string;
  admissionNo?: string | null; admissionDate?: string; academicYearId?: string | null; classId: string; sectionId?: string | null; rollNo?: string | null;
  bloodGroup?: string | null; religion?: string | null; birthCertificateNo?: string | null; presentAddress?: unknown; permanentAddress?: unknown; previousSchool?: unknown;
  guardians?: GuardianInput[]; createAccounts?: boolean; meta?: Record<string, unknown> | null;
}
export interface StaffInput {
  firstName: string; lastName?: string | null; nameBn?: string | null; gender?: 'male' | 'female' | 'other' | null; dateOfBirth?: string | null; phone?: string | null; email?: string | null;
  employeeNo?: string | null; joinDate?: string; designationId?: string | null; departmentId?: string | null; staffCategory?: 'teaching' | 'non_teaching' | 'admin' | 'support'; employmentType?: 'permanent' | 'contract' | 'part_time' | 'intern' | 'volunteer' | 'mpo';
  subjectIds?: string[]; createAccount?: boolean; role?: string; campusId?: string | null;
}

/** Students, guardians (linked by phone, sibling-aware), enrollments, staff. Numbers come from `number_sequences`. */
export class PeopleService {
  constructor(private db: Db, private outbox: OutboxService, private numbering: NumberingService, private auth: AuthService) {}

  // ---------- students ----------
  async createStudent(schoolId: string, s: StudentInput, tx?: Db): Promise<{ id: string; admissionNo: string; enrollmentId: string; guardianIds: string[] }> {
    const run = async (t: Db) => {
      const year = s.academicYearId ? await t.findOne<Row>('academic_years', { id: s.academicYearId, school_id: schoolId }) : await t.findOne<Row>('academic_years', { school_id: schoolId, is_current: true });
      if (!year) throw new HttpError(409, 'no academic year', 'no_year');
      const cls = await t.findOne<Row>('classes', { id: s.classId, school_id: schoolId });
      if (!cls) throw notFound('class');
      let sectionId = s.sectionId ?? null;
      if (!sectionId) sectionId = await this.autoSection(t, schoolId, String(year.id), s.classId, s.gender);
      const admissionNo = s.admissionNo?.trim() || await this.numbering.next(schoolId, 'admission_no', { prefix: '', padding: 5, resetYearly: true }, t);
      if (await t.findOne('students', { school_id: schoolId, admission_no: admissionNo })) throw new HttpError(409, `admission no ${admissionNo} already exists`, 'conflict');
      const id = ulid();
      const admissionDate = s.admissionDate ?? nowSql().slice(0, 10);
      await t.insert('students', {
        id, school_id: schoolId, admission_no: admissionNo, first_name: s.firstName.trim(), last_name: s.lastName?.trim() || null, name_bn: s.nameBn ?? null, gender: s.gender, date_of_birth: s.dateOfBirth,
        blood_group: s.bloodGroup ?? null, religion: s.religion ?? null, nationality: 'Bangladeshi', birth_certificate_no: s.birthCertificateNo ?? null, admission_date: admissionDate, admission_class_id: s.classId,
        current_academic_year_id: year.id, current_class_id: s.classId, current_section_id: sectionId, current_roll_no: s.rollNo ?? null, status: 'active', status_changed_at: nowSql(),
        present_address: (s.presentAddress ?? null) as never, permanent_address: (s.permanentAddress ?? null) as never, previous_school: (s.previousSchool ?? null) as never, meta: (s.meta ?? null) as never,
      });
      const enrollmentId = ulid();
      const rollNo = s.rollNo ?? (sectionId ? String(await this.nextRoll(t, sectionId)) : null);
      await t.insert('student_enrollments', { id: enrollmentId, school_id: schoolId, student_id: id, academic_year_id: year.id, class_id: s.classId, section_id: sectionId, roll_no: rollNo, enrolled_on: admissionDate, status: 'active' });
      if (rollNo && !s.rollNo) await t.update('students', { current_roll_no: rollNo }, { id });
      const guardianIds: string[] = [];
      for (const g of s.guardians ?? []) guardianIds.push(await this.linkGuardian(schoolId, id, g, t));
      if (s.createAccounts) {
        const uid = await this.auth.createUser({ schoolId, userType: 'student', displayName: `${s.firstName} ${s.lastName ?? ''}`.trim(), username: `s${admissionNo}`, roles: ['student'] }, t).catch(() => null);
        if (uid) await t.update('students', { user_id: uid }, { id });
      }
      await this.outbox.emit(t, { type: 'student.created', schoolId, aggregateType: 'people.student', aggregateId: id, payload: { studentId: id, admissionNo, classId: s.classId, sectionId, guardianUserIds: [] } });
      // separate from student.created: enrolment also happens on promotion and on transfer in, which fees/library react to
      await this.outbox.emit(t, { type: 'student.enrolled', schoolId, aggregateType: 'people.enrollment', aggregateId: enrollmentId, payload: { studentId: id, enrollmentId, academicYearId: String(year.id), classId: s.classId, sectionId } });
      return { id, admissionNo, enrollmentId, guardianIds };
    };
    return tx ? run(tx) : this.db.transaction(run);
  }

  private async autoSection(t: Db, schoolId: string, yearId: string, classId: string, gender: string): Promise<string | null> {
    const secs = await t.query<Row>(`SELECT sec.id, sec.capacity, sec.gender_policy, (SELECT COUNT(*) FROM student_enrollments e WHERE e.section_id = sec.id AND e.status = 'active') AS n FROM sections sec WHERE sec.school_id = ? AND sec.academic_year_id = ? AND sec.class_id = ? AND sec.status = 'active' ORDER BY sec.name`, [schoolId, yearId, classId]);
    const ok = secs.filter(x => x.gender_policy === 'mixed' || (x.gender_policy === 'boys' && gender === 'male') || (x.gender_policy === 'girls' && gender === 'female'));
    const free = ok.find(x => Number(x.n) < Number(x.capacity));
    return String((free ?? ok[0] ?? secs[0])?.id ?? '') || null;
  }
  private async nextRoll(t: Db, sectionId: string) {
    // LENGTH-then-value ordering is numeric for digit strings and works on SQLite, MySQL 8, MariaDB and Postgres (CAST syntax does not)
    const r = await t.query<{ roll_no: string | null }>(`SELECT roll_no FROM student_enrollments WHERE section_id = ? AND status = 'active' AND roll_no IS NOT NULL ORDER BY LENGTH(roll_no) DESC, roll_no DESC LIMIT 1`, [sectionId]);
    return (Number(r[0]?.roll_no) || 0) + 1;
  }

  /** Finds a guardian by phone (shared across siblings) or creates one, links to the student, optional portal account. */
  async linkGuardian(schoolId: string, studentId: string, g: GuardianInput, tx?: Db): Promise<string> {
    const run = async (t: Db) => {
      const phone = normalizeBdPhone(g.phone) ?? g.phone.trim();
      if (!phone) throw badRequest('guardian phone required');
      let guardian = await t.findOne<Row>('guardians', { school_id: schoolId, phone });
      if (!guardian) {
        const id = ulid();
        // Every guardian gets a portal account straight away (no password; they sign in by OTP).
        // Chat membership, push and the guardian portal all key off users.id, so creating it later
        // would leave the first guardians of a school invisible to those features.
        const existingUser = await this.auth.findByIdentifier(phone, schoolId);
        const userId = existingUser?.id ?? await this.auth.createUser({ schoolId, userType: 'guardian', displayName: g.fullName.trim(), phone, email: g.email?.toLowerCase() ?? null, roles: ['guardian'] }, t).catch(() => null);
        await t.insert('guardians', { id, school_id: schoolId, user_id: userId, full_name: g.fullName.trim(), phone, alt_phone: g.altPhone ?? null, email: g.email?.toLowerCase() ?? null, occupation: g.occupation ?? null, nid_no: g.nidNo ?? null, is_staff: false });
        guardian = { id };
      }
      const gid = String(guardian.id);
      const link = await t.findOne<{ id: string }>('student_guardians', { student_id: studentId, guardian_id: gid });
      if (!link) await t.insert('student_guardians', { id: ulid(), school_id: schoolId, student_id: studentId, guardian_id: gid, relation: g.relation, is_primary: !!g.isPrimary, is_emergency: !!g.isPrimary, can_pickup: true, receives_notifications: true, pays_fees: g.paysFees ?? !!g.isPrimary });
      await this.outbox.emit(t, { type: 'guardian.linked', schoolId, aggregateType: 'people.guardian', aggregateId: gid, payload: { guardianId: gid, studentId, phone, relation: g.relation } });
      return gid;
    };
    return tx ? run(tx) : this.db.transaction(run);
  }

  /** Creates the guardian's portal login (OTP by phone) if missing. Returns the user id. */
  async ensureGuardianAccount(schoolId: string, guardianId: string) {
    const g = await this.db.findOne<Row>('guardians', { id: guardianId, school_id: schoolId });
    if (!g) throw notFound('guardian');
    if (g.user_id) return String(g.user_id);
    const existing = await this.auth.findByIdentifier(String(g.phone), schoolId);
    const uid = existing?.id ?? await this.auth.createUser({ schoolId, userType: 'guardian', displayName: String(g.full_name), phone: String(g.phone), email: (g.email as string) ?? null, roles: ['guardian'] });
    await this.db.update('guardians', { user_id: uid, updated_at: nowSql() }, { id: guardianId });
    return uid;
  }

  async students(schoolId: string, f: { yearId?: string; classId?: string; sectionId?: string; q?: string; status?: string; limit?: number; offset?: number } = {}) {
    const where: string[] = ['s.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.status) { where.push('s.status = ?'); params.push(f.status); } else where.push(`s.status = 'active'`);
    if (f.classId) { where.push('s.current_class_id = ?'); params.push(f.classId); }
    if (f.sectionId) { where.push('s.current_section_id = ?'); params.push(f.sectionId); }
    if (f.yearId) { where.push('s.current_academic_year_id = ?'); params.push(f.yearId); }
    if (f.q) { where.push(`(s.first_name LIKE ? OR s.last_name LIKE ? OR s.admission_no LIKE ? OR s.name_bn LIKE ?)`); const like = `%${f.q}%`; params.push(like, like, like, like); }
    const limit = Math.min(200, f.limit ?? 50); const offset = f.offset ?? 0;
    const rows = await this.db.query<Row>(`SELECT s.id, s.admission_no, s.first_name, s.last_name, s.name_bn, s.gender, s.date_of_birth, s.current_roll_no, s.status, s.admission_date, c.name AS class_name, sec.name AS section_name, s.current_class_id, s.current_section_id,
      (SELECT g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = s.id ORDER BY sg.is_primary DESC LIMIT 1) AS guardian_phone
      FROM students s LEFT JOIN classes c ON c.id = s.current_class_id LEFT JOIN sections sec ON sec.id = s.current_section_id WHERE ${where.join(' AND ')} ORDER BY c.numeric_level, sec.name, LENGTH(s.current_roll_no), s.current_roll_no, s.first_name LIMIT ${limit} OFFSET ${offset}`, params);
    const total = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM students s WHERE ${where.join(' AND ')}`, params);
    return { rows, total: Number(total[0]?.n ?? 0), limit, offset };
  }
  async student(schoolId: string, id: string) {
    const s = await this.db.findOne<Row>('students', { id, school_id: schoolId });
    if (!s) throw notFound('student');
    const guardians = await this.db.query<Row>(`SELECT g.*, sg.relation, sg.is_primary, sg.pays_fees FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? ORDER BY sg.is_primary DESC`, [id]);
    const enrollments = await this.db.query<Row>(`SELECT e.*, y.name AS year_name, c.name AS class_name, sec.name AS section_name FROM student_enrollments e JOIN academic_years y ON y.id = e.academic_year_id JOIN classes c ON c.id = e.class_id LEFT JOIN sections sec ON sec.id = e.section_id WHERE e.student_id = ? ORDER BY y.start_date DESC`, [id]);
    const siblings = await this.db.query<Row>(`SELECT DISTINCT s2.id, s2.first_name, s2.last_name, s2.admission_no FROM student_guardians a JOIN student_guardians b ON a.guardian_id = b.guardian_id AND b.student_id <> a.student_id JOIN students s2 ON s2.id = b.student_id WHERE a.student_id = ? AND s2.status = 'active'`, [id]);
    return { ...s, present_address: json(s.present_address), permanent_address: json(s.permanent_address), meta: json(s.meta), guardians, enrollments, siblings };
  }
  async updateStudent(schoolId: string, id: string, patch: Partial<StudentInput> & { status?: string; statusReason?: string }) {
    const set: Row = {};
    if (patch.firstName) set.first_name = patch.firstName; if ('lastName' in patch) set.last_name = patch.lastName ?? null; if ('nameBn' in patch) set.name_bn = patch.nameBn ?? null;
    if (patch.gender) set.gender = patch.gender; if (patch.dateOfBirth) set.date_of_birth = patch.dateOfBirth; if ('bloodGroup' in patch) set.blood_group = patch.bloodGroup ?? null;
    if ('religion' in patch) set.religion = patch.religion ?? null; if ('presentAddress' in patch) set.present_address = (patch.presentAddress ?? null) as never; if ('meta' in patch) set.meta = (patch.meta ?? null) as never;
    if (patch.status) {
      const cur = await this.db.findOne<{ status: string }>('students', { id, school_id: schoolId });
      if (cur && cur.status !== patch.status) { set.status = patch.status; set.status_changed_at = nowSql(); set.status_reason = patch.statusReason ?? null; await this.db.insert('student_status_history', { id: ulid(), school_id: schoolId, student_id: id, from_status: cur.status, to_status: patch.status, reason: patch.statusReason ?? null, changed_by: null, changed_at: nowSql() }); }
    }
    if (!Object.keys(set).length) return 0;
    return this.db.update('students', { ...set, updated_at: nowSql() }, { id, school_id: schoolId });
  }
  async moveSection(schoolId: string, studentId: string, sectionId: string, rollNo?: string | null) {
    const sec = await this.db.findOne<Row>('sections', { id: sectionId, school_id: schoolId }); if (!sec) throw notFound('section');
    await this.db.transaction(async tx => {
      await tx.update('students', { current_section_id: sectionId, current_class_id: sec.class_id as string, current_roll_no: rollNo ?? null, updated_at: nowSql() }, { id: studentId, school_id: schoolId });
      await tx.update('student_enrollments', { section_id: sectionId, class_id: sec.class_id as string, roll_no: rollNo ?? null }, { student_id: studentId, academic_year_id: sec.academic_year_id as string, status: 'active' });
    });
  }

  // ---------- staff ----------
  async createStaff(schoolId: string, s: StaffInput, tx?: Db): Promise<{ id: string; employeeNo: string; userId: string | null }> {
    const run = async (t: Db) => {
      const employeeNo = s.employeeNo?.trim() || await this.numbering.next(schoolId, 'employee_no', { prefix: 'EMP-', padding: 4 }, t);
      if (await t.findOne('staff', { school_id: schoolId, employee_no: employeeNo })) throw new HttpError(409, `employee no ${employeeNo} exists`, 'conflict');
      const id = ulid();
      const phone = s.phone ? normalizeBdPhone(s.phone) ?? s.phone : null;
      let userId: string | null = null;
      if (s.createAccount !== false && (phone || s.email)) {
        const existing = phone ? await this.auth.findByIdentifier(phone, schoolId) : s.email ? await this.auth.findByIdentifier(s.email, schoolId) : null;
        userId = existing?.id ?? await this.auth.createUser({ schoolId, userType: 'staff', displayName: `${s.firstName} ${s.lastName ?? ''}`.trim(), phone, email: s.email ?? null, roles: [s.role ?? ((s.staffCategory ?? 'teaching') === 'teaching' ? 'teacher' : 'staff')] }, t);
      }
      await t.insert('staff', {
        id, school_id: schoolId, user_id: userId, employee_no: employeeNo, first_name: s.firstName.trim(), last_name: s.lastName?.trim() || null, name_bn: s.nameBn ?? null, gender: s.gender ?? null, date_of_birth: s.dateOfBirth ?? null, phone, email: s.email?.toLowerCase() ?? null,
        campus_id: s.campusId ?? null, department_id: s.departmentId ?? null, designation_id: s.designationId ?? null, staff_category: s.staffCategory ?? 'teaching', employment_type: s.employmentType ?? 'permanent', join_date: s.joinDate ?? nowSql().slice(0, 10), status: 'active',
      });
      for (const sid of s.subjectIds ?? []) await t.insert('staff_subjects', { id: ulid(), school_id: schoolId, staff_id: id, subject_id: sid, preference: 1 });
      await this.outbox.emit(t, { type: 'staff.created', schoolId, aggregateType: 'people.staff', aggregateId: id, payload: { staffId: id, employeeNo, userId } });
      return { id, employeeNo, userId };
    };
    return tx ? run(tx) : this.db.transaction(run);
  }
  async staff(schoolId: string, f: { category?: string; q?: string; teachingOnly?: boolean } = {}) {
    const where: string[] = ['st.school_id = ?', `st.status IN ('active','probation','on_leave')`]; const params: unknown[] = [schoolId];
    if (f.category) { where.push('st.staff_category = ?'); params.push(f.category); }
    if (f.teachingOnly) where.push(`st.staff_category = 'teaching'`);
    if (f.q) { where.push('(st.first_name LIKE ? OR st.last_name LIKE ? OR st.employee_no LIKE ?)'); const like = `%${f.q}%`; params.push(like, like, like); }
    return this.db.query<Row>(`SELECT st.*, d.name AS designation, dep.name AS department FROM staff st LEFT JOIN designations d ON d.id = st.designation_id LEFT JOIN departments dep ON dep.id = st.department_id WHERE ${where.join(' AND ')} ORDER BY st.first_name LIMIT 500`, params);
  }
  async staffSubjects(schoolId: string): Promise<Map<string, Set<string>>> {
    const rows = await this.db.findMany<{ staff_id: string; subject_id: string }>('staff_subjects', { school_id: schoolId });
    const m = new Map<string, Set<string>>();
    for (const r of rows) { if (!m.has(r.staff_id)) m.set(r.staff_id, new Set()); m.get(r.staff_id)!.add(r.subject_id); }
    return m;
  }
  async setStaffSubjects(schoolId: string, staffId: string, subjectIds: string[]) {
    await this.db.transaction(async tx => {
      await tx.delete('staff_subjects', { school_id: schoolId, staff_id: staffId });
      if (subjectIds.length) await tx.insertMany('staff_subjects', subjectIds.map((sid, i) => ({ id: ulid(), school_id: schoolId, staff_id: staffId, subject_id: sid, preference: i + 1 })));
    });
  }
  async createDesignation(schoolId: string, name: string, category: 'teaching' | 'non_teaching' | 'admin' | 'support' = 'teaching', level = 0) {
    const ex = await this.db.findOne<{ id: string }>('designations', { school_id: schoolId, name }); if (ex) return ex.id;
    const id = ulid(); await this.db.insert('designations', { id, school_id: schoolId, name, level, category }); return id;
  }
  async createDepartment(schoolId: string, name: string, kind: 'academic' | 'admin' | 'support' = 'academic') {
    const ex = await this.db.findOne<{ id: string }>('departments', { school_id: schoolId, name }); if (ex) return ex.id;
    const id = ulid(); await this.db.insert('departments', { id, school_id: schoolId, name, head_staff_id: null, kind }); return id;
  }
  async departments(schoolId: string) { return this.db.findMany<Row>('departments', { school_id: schoolId }, { orderBy: 'name ASC' }); }
  /** The head of department, who is the person a departmental view is scoped to. Only a member of the department can head it. */
  async setDepartmentHead(schoolId: string, departmentId: string, staffId: string | null) {
    if (!(await this.db.findOne('departments', { id: departmentId, school_id: schoolId }))) throw notFound('department');
    if (staffId) {
      const st = await this.db.findOne<Row>('staff', { id: staffId, school_id: schoolId });
      if (!st) throw notFound('staff');
      if (String(st.department_id ?? '') !== departmentId) throw badRequest('the head of a department has to belong to it');
    }
    await this.db.update('departments', { head_staff_id: staffId, updated_at: nowSql() }, { id: departmentId });
    return { departmentId, headStaffId: staffId };
  }
}
