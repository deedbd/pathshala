import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { PeopleService } from './people.js';
import type { AnalyticsService } from './analytics.js';
import { round } from './accounting.js';
import { HttpError, badRequest, forbidden, notFound } from '../context.js';

export interface GroupInput { name: string; nameBn?: string | null; ownerUserId?: string | null; baseCurrency?: string | null; schoolIds?: string[] }
export interface TransferInput { studentId: string; toSchoolId: string; toClassId?: string | null; reason?: string | null; byUserId?: string | null }
export interface RateInput { baseCcy: string; quoteCcy: string; rate: number; asOf?: string; source?: string | null }
export interface UsedRate { from: string; to: string; rate: number; asOf: string | null; source: string; inverted?: boolean }

/**
 * Several schools of one owner — a trust, a chain, a school with a separate college — living in one
 * installation, plus the two things that only make sense once they do: a consolidated view for the
 * owner, and one guardian login that reaches children in more than one of them.
 *
 * Everything here crosses a tenant boundary, which is the one boundary the rest of the codebase never
 * crosses, so each crossing is named and gated:
 *
 *  - **Making a group** is for the school this installation was created with — the owner's own console.
 *    Any other school could otherwise group itself with its neighbour and read it.
 *  - **Reading another school's figures** needs the caller's school to be the group's *head*. Being a
 *    member is not enough: two schools in a trust are still competitors for the trust's money, and a
 *    branch principal who could read the other branch's collection would be a scandal, not a feature.
 *  - **A transfer** needs both schools in the same group. Between unrelated tenants that happen to
 *    share a database it is not a transfer, it is a leak.
 *  - **The parent super-app** is authorised by the guardian's own phone — the one they proved with an
 *    OTP to sign in — and never by a school role. A school's console gains nothing from this module.
 *
 * The numbers are not recomputed here. AnalyticsService writes `kpi_daily` from the register, and the
 * group view adds up those same rows, so the trust's dashboard and each head teacher's dashboard can
 * never disagree — which is the argument that ends the meeting.
 *
 * Money is the exception that refuses to be added. A group whose schools bill in different currencies
 * has no total until somebody records a rate: an unconverted sum of BDT and USD is a number that looks
 * right and is wrong by a factor of a hundred, so this returns no total at all and says which rate is
 * missing.
 */
export class GroupsService {
  constructor(
    private db: Db, private outbox: OutboxService, private notifications: NotificationService,
    private people: PeopleService, private analytics: AnalyticsService,
  ) {}

  // ---------- the group ----------
  /**
   * Only the school this installation was created with may shape a group. Without that rule the
   * gate below is decoration: a branch principal, who is quite legitimately a super admin inside
   * their own school, could make a group of their own, put the other branch into it, make themselves
   * its head and read the other branch's collection. The founding school is the one the owner typed
   * their own password into during the install; every other school in the database was added by that
   * same person through `addTenant`. ULIDs sort by time, so `id` breaks the tie when two schools were
   * created in the same second.
   */
  private async requireFounder(schoolId: string) {
    const first = await this.db.findOne<Row>('schools', {}, { orderBy: 'created_at ASC, id ASC' });
    if (!first || String(first.id) !== schoolId) throw forbidden('only the school this installation was created with can set up groups');
    return first;
  }

  /** Creates a group with the caller's school as its head; other schools of the installation join it. */
  async createGroup(headSchoolId: string, input: GroupInput) {
    const head = await this.requireFounder(headSchoolId);
    const base = (input.baseCurrency ?? String(head.currency ?? 'BDT')).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(base)) throw badRequest('base currency must be a three-letter code such as BDT or USD');
    const id = ulid();
    const today = nowSql().slice(0, 10);
    const joined = [headSchoolId];
    await this.db.transaction(async tx => {
      await tx.insert('school_groups', { id, name: input.name.trim(), name_bn: input.nameBn ?? null, owner_user_id: input.ownerUserId ?? null, base_currency: base, status: 'active', settings: null });
      await tx.insert('school_group_members', { id: ulid(), school_id: headSchoolId, group_id: id, is_head: true, joined_on: today });
      for (const schoolId of input.schoolIds ?? []) {
        if (schoolId === headSchoolId) continue;
        if (!(await tx.findOne('schools', { id: schoolId }))) throw notFound(`school ${schoolId}`);
        await tx.insert('school_group_members', { id: ulid(), school_id: schoolId, group_id: id, is_head: false, joined_on: today });
        joined.push(schoolId);
      }
      await this.outbox.emit(tx, { type: 'group.created', schoolId: headSchoolId, aggregateType: 'core.school_group', aggregateId: id, payload: { groupId: id, name: input.name.trim(), schools: joined.length } });
    });
    return { id, name: input.name.trim(), baseCurrency: base, schools: joined.length };
  }
  /** Adds a school to a group. Only the founding school, heading that group, may; adding twice is not an error. */
  async addSchool(groupId: string, callerSchoolId: string, schoolId: string) {
    await this.requireFounder(callerSchoolId);
    await this.requireHead(groupId, callerSchoolId);
    if (!(await this.db.findOne('schools', { id: schoolId }))) throw notFound('school');
    const ex = await this.db.findOne<Row>('school_group_members', { group_id: groupId, school_id: schoolId });
    if (ex) return { id: String(ex.id), added: false };
    const id = ulid();
    await this.db.insert('school_group_members', { id, school_id: schoolId, group_id: groupId, is_head: false, joined_on: nowSql().slice(0, 10) });
    return { id, added: true };
  }
  /**
   * Takes a school back out. The head cannot remove itself: a group with no head is a group whose
   * figures nobody may read and which nobody may repair.
   */
  async removeSchool(groupId: string, callerSchoolId: string, schoolId: string) {
    await this.requireFounder(callerSchoolId);
    await this.requireHead(groupId, callerSchoolId);
    const m = await this.db.findOne<Row>('school_group_members', { group_id: groupId, school_id: schoolId });
    if (!m) throw notFound('member school');
    if (Number(m.is_head)) throw new HttpError(409, 'the head school cannot leave its own group', 'conflict');
    await this.db.delete('school_group_members', { id: String(m.id) });
    return { removed: true };
  }
  /** The groups this school belongs to, and whether it is the one that may see the others. */
  async groups(schoolId: string) {
    return this.db.query<Row>(`SELECT g.id, g.name, g.name_bn, g.base_currency, g.status, m.is_head, m.joined_on,
      (SELECT COUNT(*) FROM school_group_members x WHERE x.group_id = g.id) AS schools
      FROM school_groups g JOIN school_group_members m ON m.group_id = g.id WHERE m.school_id = ? ORDER BY g.name, g.id`, [schoolId]);
  }
  /** Member schools with the name, code and currency each row's figures are expressed in. */
  async memberSchools(groupId: string) {
    return this.db.query<Row>(`SELECT m.school_id, m.is_head, s.name, s.code, s.currency, s.status FROM school_group_members m JOIN schools s ON s.id = m.school_id WHERE m.group_id = ? ORDER BY m.is_head DESC, s.name, s.id`, [groupId]);
  }
  /**
   * The schools this group could add: every other school on the installation that is not already a
   * member. Only the founder may ask, because the answer is the list of tenants on the host — which
   * is exactly what an unauthorised caller would like. Typing an id into a box was the alternative,
   * and an id typed wrong puts somebody else's school into a trust's consolidated figures.
   */
  async addableSchools(groupId: string, callerSchoolId: string) {
    await this.requireFounder(callerSchoolId);
    await this.requireGroup(groupId);
    return this.db.query<Row>(`SELECT s.id, s.name, s.code, s.currency, s.status FROM schools s
      WHERE s.status <> 'closed' AND NOT EXISTS (SELECT 1 FROM school_group_members m WHERE m.group_id = ? AND m.school_id = s.id)
      ORDER BY s.name, s.id LIMIT 200`, [groupId]);
  }

  private async requireGroup(groupId: string) {
    const g = await this.db.findOne<Row>('school_groups', { id: groupId });
    if (!g) throw notFound('group');
    return g;
  }
  /** The gate every cross-school read goes through. */
  async requireHead(groupId: string, schoolId: string) {
    const g = await this.requireGroup(groupId);
    const m = await this.db.findOne<Row>('school_group_members', { group_id: groupId, school_id: schoolId });
    if (!m) throw forbidden('your school is not in this group');
    if (!Number(m.is_head)) throw forbidden('only the head school of the group sees the other schools’ figures');
    if (String(g.status) !== 'active') throw new HttpError(409, 'this group is closed', 'conflict');
    return g;
  }

  // ---------- the consolidated view ----------
  /**
   * The owner's dashboard: roll, attendance, fees collected in the window, fees still outstanding and
   * staff on the payroll, per school and then added up.
   *
   * Each school's figures come from `kpi_daily`, which AnalyticsService writes from that school's own
   * register — today's row is refreshed first so the newest day is never a day stale. Days the nightly
   * job never ran are simply absent, so every row carries `daysCovered`: a collection figure that is
   * short by a fortnight must say so rather than read as a bad month. Nothing is counted a second way
   * here; a trust and a head teacher disagreeing about the roll is how a dashboard loses its authority.
   */
  async consolidated(groupId: string, callerSchoolId: string, opts: { day?: string; days?: number } = {}) {
    const group = await this.requireHead(groupId, callerSchoolId);
    const day = opts.day ?? nowSql().slice(0, 10);
    const days = Math.min(180, Math.max(1, opts.days ?? 30));
    const from = new Date(Date.parse(`${day}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const base = String(group.base_currency ?? 'BDT');
    const members = await this.memberSchools(groupId);
    const schools = [];
    // only today is recomputed: a past day was written by the nightly job and recomputing it would
    // change nothing but the time this request takes, which a group of twenty schools cannot afford
    // inside the ~30 s a shared host allows
    const refresh = day === nowSql().slice(0, 10);
    for (const m of members) {
      const schoolId = String(m.school_id);
      if (refresh) await this.analytics.computeDay(schoolId, day);
      // a school joined last week has no figures from before it joined, and reading them would let
      // the head add a school, read its whole history and remove it again
      const joined = m.joined_on ? String(m.joined_on).slice(0, 10) : from;
      const windowFrom = joined > from ? joined : from;
      const kpi = await this.db.query<Row>(`SELECT day, students_active, attendance_pct, fees_collected, fees_outstanding FROM kpi_daily WHERE school_id = ? AND day BETWEEN ? AND ? ORDER BY day DESC`, [schoolId, windowFrom, day]);
      const latest = kpi[0] ?? null;
      const staff = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM staff WHERE school_id = ? AND status IN ('active','probation','on_leave') AND deleted_at IS NULL`, [schoolId]);
      schools.push({
        schoolId, schoolName: String(m.name), code: String(m.code), currency: String(m.currency ?? base), isHead: !!Number(m.is_head),
        roll: latest ? Number(latest.students_active ?? 0) : 0,
        attendancePct: latest?.attendance_pct == null ? null : Number(latest.attendance_pct),
        collected: round(kpi.reduce((a, r) => a + Number(r.fees_collected ?? 0), 0)),
        outstanding: latest ? round(Number(latest.fees_outstanding ?? 0)) : 0,
        staff: Number(staff[0]?.n ?? 0),
        daysCovered: kpi.length,
        from: windowFrom,
      });
    }
    const totals = {
      roll: schools.reduce((a, s) => a + s.roll, 0),
      staff: schools.reduce((a, s) => a + s.staff, 0),
      // an average of averages would let a school of 90 children weigh as much as one of 1,500
      attendancePct: (() => {
        const weighted = schools.filter(s => s.attendancePct != null && s.roll > 0);
        const roll = weighted.reduce((a, s) => a + s.roll, 0);
        return roll ? round(weighted.reduce((a, s) => a + s.attendancePct! * s.roll, 0) / roll) : null;
      })(),
    };
    // A school whose nightly pass did not run has no row for the day, and `0` is not what we know
    // about it — it is what we do not. Adding it in would tell a trust it is owed half of what it is
    // owed, with nothing on the page to say a school is missing, so the total refuses just as it
    // does for a missing exchange rate and names the schools it could not read.
    const silent = schools.filter(s => s.daysCovered === 0).map(s => ({ schoolId: s.schoolId, schoolName: s.schoolName }));
    const money = await this.consolidateMoney(schools, base, day);
    const total = silent.length
      ? {
          ...money.total, collected: null, outstanding: null,
          error: `${silent.map(x => x.schoolName).join(', ')} ${silent.length === 1 ? 'has' : 'have'} no figures for ${day}; the nightly pass has not run there, so a group total would be short by whatever they collected`,
        }
      : money.total;
    return {
      groupId, group: String(group.name), baseCurrency: base, day, from, days,
      schools: schools.map(s => ({ ...s, ...(money.bySchool[s.schoolId] ?? {}) })),
      totals: { ...totals, schoolsWithoutFigures: silent.length }, money: total, silent,
    };
  }
  /**
   * Adds the money up, or refuses to. A school billing in the group's own currency needs no rate; any
   * other needs one recorded on or before the day being reported, and a group missing even one gets
   * counts but no money total, with the missing pair named. Every converted row carries the rate that
   * converted it, so a figure can always be traced back to what it was in the school's own books.
   */
  private async consolidateMoney(schools: { schoolId: string; currency: string; collected: number; outstanding: number }[], base: string, day: string) {
    const bySchool: Record<string, { rate: number | null; rateAsOf: string | null; collectedBase: number | null; outstandingBase: number | null }> = {};
    const used: UsedRate[] = [];
    const missing: { schoolId: string; from: string; to: string }[] = [];
    let collected = 0, outstanding = 0;
    for (const s of schools) {
      const r = await this.rateFor(s.currency, base, day);
      if (!r) {
        bySchool[s.schoolId] = { rate: null, rateAsOf: null, collectedBase: null, outstandingBase: null };
        missing.push({ schoolId: s.schoolId, from: s.currency, to: base });
        continue;
      }
      bySchool[s.schoolId] = { rate: r.rate, rateAsOf: r.asOf, collectedBase: round(s.collected * r.rate), outstandingBase: round(s.outstanding * r.rate) };
      if (s.currency !== base && !used.some(u => u.from === r.from && u.to === r.to && u.asOf === r.asOf)) used.push(r);
      collected += s.collected * r.rate;
      outstanding += s.outstanding * r.rate;
    }
    const total = missing.length
      ? { base, collected: null, outstanding: null, rates: used, missingRates: missing, error: `no exchange rate ${missing.map(m => `${m.from}→${m.to}`).join(', ')} on or before ${day}; record one before a consolidated total can be shown` }
      : { base, collected: round(collected), outstanding: round(outstanding), rates: used, missingRates: [] as typeof missing, error: null };
    return { bySchool, total };
  }

  /**
   * Who works for the group, across its schools. A trust hires once and lends: the point of the pool
   * is that the head office can see the maths teacher in the other branch has four free periods
   * before it advertises a post.
   */
  async staffPool(groupId: string, callerSchoolId: string, f: { q?: string; category?: string; limit?: number; offset?: number } = {}) {
    await this.requireHead(groupId, callerSchoolId);
    const members = await this.memberSchools(groupId);
    const ids = members.map(m => String(m.school_id));
    if (!ids.length) return { staff: [], schools: 0, total: 0, limit: 0, offset: 0 };
    const marks = ids.map(() => '?').join(', ');
    const where = [`st.school_id IN (${marks})`, `st.status IN ('active','probation','on_leave')`, 'st.deleted_at IS NULL'];
    const params: unknown[] = [...ids];
    if (f.category) { where.push('st.staff_category = ?'); params.push(f.category); }
    if (f.q) { where.push('(st.first_name LIKE ? OR st.last_name LIKE ? OR st.employee_no LIKE ?)'); const like = `%${f.q}%`; params.push(like, like, like); }
    // a trust of twenty schools has thousands of staff, and one page is what a request may carry:
    // the total comes back with the page so the console can say what it is showing out of what
    const limit = Math.min(500, Math.max(1, Math.round(Number(f.limit) || 200)));
    const offset = Math.max(0, Math.round(Number(f.offset) || 0));
    const counted = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM staff st WHERE ${where.join(' AND ')}`, params);
    const staff = await this.db.query<Row>(`SELECT st.id, st.school_id, st.employee_no, st.first_name, st.last_name, st.phone, st.staff_category, st.employment_type, st.status, st.join_date,
      sc.name AS school_name, sc.code AS school_code, d.name AS designation, dep.name AS department
      FROM staff st JOIN schools sc ON sc.id = st.school_id LEFT JOIN designations d ON d.id = st.designation_id LEFT JOIN departments dep ON dep.id = st.department_id
      WHERE ${where.join(' AND ')} ORDER BY sc.name, st.first_name, st.id LIMIT ${limit} OFFSET ${offset}`, params);
    // teaching load from the published timetable only: a draft's periods are nobody's workload yet
    const load = await this.db.query<{ teacher_id: string; n: number }>(`SELECT ts.teacher_id, COUNT(*) AS n FROM timetable_slots ts JOIN timetable_versions v ON v.id = ts.version_id AND v.status = 'published' WHERE ts.school_id IN (${marks}) AND ts.teacher_id IS NOT NULL GROUP BY ts.teacher_id`, ids);
    const periods = new Map(load.map(r => [String(r.teacher_id), Number(r.n)]));
    return { schools: ids.length, total: Number(counted[0]?.n ?? 0), limit, offset, staff: staff.map(s => ({ ...s, periods: periods.get(String(s.id)) ?? 0 })) };
  }

  // ---------- moving a child between two schools of the group ----------
  /**
   * A transfer creates the child in the receiving school and closes the row in the school they left,
   * in that order. The other order can lose a child: a failure halfway through would leave somebody
   * marked "transferred" and enrolled nowhere, which is how a nine-year-old drops out of a database.
   *
   * The receiving school issues its own admission number (document numbers are prefixed by the school
   * code, so carrying the old one across would produce a number that claims the wrong school), and the
   * guardians are carried over by phone — the same match the parent super-app runs on, so the family's
   * login reaches the child in the new school the moment the transfer lands.
   *
   * Outstanding fees do not block it. A child is not collateral for an adult's unpaid bill; the amount
   * is recorded on the transfer so the receiving school and the trust can both see it.
   */
  async transferStudent(fromSchoolId: string, input: TransferInput) {
    if (input.toSchoolId === fromSchoolId) throw badRequest('a transfer needs two schools; moving a child inside one school is a section change');
    const group = await this.sharedGroup(fromSchoolId, input.toSchoolId);
    const student = await this.db.findOne<Row>('students', { id: input.studentId, school_id: fromSchoolId });
    if (!student) throw notFound('student');
    // the relay delivers at least once and administrators double-click: a repeat must return the first
    // transfer, never create a second child in the receiving school
    const already = await this.db.findOne<Row>('student_transfers', { school_id: fromSchoolId, student_id: input.studentId, to_school_id: input.toSchoolId, status: 'completed' });
    const elsewhere = already ? null : await this.db.findOne<Row>('student_transfers', { school_id: fromSchoolId, student_id: input.studentId, status: 'completed' });
    if (elsewhere) {
      const to = await this.db.findOne<Row>('schools', { id: String(elsewhere.to_school_id) });
      throw new HttpError(409, `this child was already transferred to ${to ? String(to.name) : String(elsewhere.to_school_id)}; the move from here has happened`, 'conflict');
    }
    if (already) {
      // the same move asked for twice: return the first one, and make sure the row this school kept
      // was actually closed — the status change happens after the transaction commits, so a process
      // that died in between would leave the child active in two schools and billed by both
      await this.db.update('students', { status: 'transferred', updated_at: nowSql() }, { id: input.studentId, school_id: fromSchoolId, status: 'active' });
      const arrived = already.to_student_id ? await this.db.findOne<Row>('students', { id: String(already.to_student_id) }) : null;
      return { id: String(already.id), studentId: input.studentId, toStudentId: arrived ? String(arrived.id) : null, admissionNo: arrived ? String(arrived.admission_no) : null, dues: round(Number(already.dues_at_transfer ?? 0)), alreadyTransferred: true };
    }
    if (String(student.status) !== 'active') throw new HttpError(409, `only an active student transfers; this one is ${String(student.status)}`, 'conflict');
    const toClass = await this.targetClass(input.toSchoolId, student, input.toClassId ?? null);
    const dues = round(Number((await this.db.query<{ due: number }>(`SELECT COALESCE(SUM(balance), 0) AS due FROM invoices WHERE school_id = ? AND student_id = ? AND balance > 0 AND status <> 'cancelled'`, [fromSchoolId, input.studentId]))[0]?.due ?? 0));
    const guardians = await this.db.query<Row>(`SELECT g.full_name, g.phone, g.email, g.occupation, sg.relation, sg.is_primary, sg.pays_fees FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? ORDER BY sg.is_primary DESC, g.id`, [input.studentId]);
    const fromSchool = await this.db.findOne<Row>('schools', { id: fromSchoolId });
    const today = nowSql().slice(0, 10);
    const id = ulid();

    const created = await this.db.transaction(async tx => {
      // people owns students: the child is created through the service, which also emits student.created
      // and student.enrolled, so fees, library and the rest of the receiving school react as they would
      // to any new admission
      const c = await this.people.createStudent(input.toSchoolId, {
        firstName: String(student.first_name), lastName: (student.last_name as string) ?? null, nameBn: (student.name_bn as string) ?? null,
        gender: String(student.gender) as 'male', dateOfBirth: String(student.date_of_birth).slice(0, 10),
        bloodGroup: (student.blood_group as string) ?? null, religion: (student.religion as string) ?? null, birthCertificateNo: (student.birth_certificate_no as string) ?? null,
        classId: String(toClass.id), admissionDate: today,
        presentAddress: json(student.present_address), permanentAddress: json(student.permanent_address),
        previousSchool: { schoolId: fromSchoolId, name: fromSchool ? String(fromSchool.name) : null, admissionNo: String(student.admission_no), transferredOn: today },
        guardians: guardians.map(g => ({ fullName: String(g.full_name), phone: String(g.phone), relation: String(g.relation) as 'father', email: (g.email as string) ?? null, occupation: (g.occupation as string) ?? null, isPrimary: !!Number(g.is_primary), paysFees: !!Number(g.pays_fees) })),
      }, tx);
      await tx.insert('student_transfers', {
        id, school_id: fromSchoolId, group_id: String(group.id), student_id: input.studentId, to_school_id: input.toSchoolId, to_student_id: c.id, to_class_id: String(toClass.id),
        reason: input.reason ?? null, dues_at_transfer: dues, status: 'completed', transferred_by: input.byUserId ?? null, transferred_at: nowSql(),
      });
      await this.outbox.emit(tx, { type: 'student.transferred', schoolId: fromSchoolId, aggregateType: 'people.transfer', aggregateId: id, payload: { transferId: id, studentId: input.studentId, fromSchoolId, toSchoolId: input.toSchoolId, toStudentId: c.id, admissionNo: c.admissionNo, dues } });
      return c;
    });

    // closed only once the child exists on the other side; updateStudent writes the status history row
    await this.people.updateStudent(fromSchoolId, input.studentId, { status: 'transferred', statusReason: `transferred to ${input.toSchoolId}${input.reason ? `: ${input.reason}` : ''}`.slice(0, 255) });
    await this.notifications.notifyRole(input.toSchoolId, 'admin', {
      channels: ['in_app'], eventKey: 'groups.student_transferred', title: 'A student transferred in',
      body: `${String(student.first_name)} ${String(student.last_name ?? '')}`.trim() + ` joins as ${created.admissionNo}${dues > 0 ? `, with ${dues} outstanding at the school they left` : ''}.`,
      entityType: 'people.student', entityId: created.id,
      // the child has already moved; a courtesy notice that cannot be sent must not undo that
    }).catch(() => undefined);
    return { id, studentId: input.studentId, toStudentId: created.id, admissionNo: created.admissionNo, dues, alreadyTransferred: false };
  }
  /** Transfers this school sent or received, each row saying plainly which school it came from. */
  async transfers(schoolId: string, f: { limit?: number; offset?: number } = {}) {
    const limit = Math.min(500, Math.max(1, Math.round(Number(f.limit) || 100)));
    const offset = Math.max(0, Math.round(Number(f.offset) || 0));
    return this.db.query<Row>(`SELECT t.id, t.school_id AS from_school_id, t.to_school_id, t.student_id, t.to_student_id, t.reason, t.dues_at_transfer, t.status, t.transferred_at,
      s.first_name, s.last_name, s.admission_no, fs.name AS from_school, ts.name AS to_school
      FROM student_transfers t JOIN students s ON s.id = t.student_id JOIN schools fs ON fs.id = t.school_id JOIN schools ts ON ts.id = t.to_school_id
      WHERE t.school_id = ? OR t.to_school_id = ? ORDER BY t.transferred_at DESC, t.id DESC LIMIT ${limit} OFFSET ${offset}`, [schoolId, schoolId]);
  }
  /** Two schools may only exchange a child if one group holds both of them. */
  private async sharedGroup(a: string, b: string) {
    const rows = await this.db.query<Row>(`SELECT g.id, g.name FROM school_groups g
      JOIN school_group_members ma ON ma.group_id = g.id AND ma.school_id = ?
      JOIN school_group_members mb ON mb.group_id = g.id AND mb.school_id = ?
      WHERE g.status = 'active' ORDER BY g.created_at, g.id LIMIT 1`, [a, b]);
    if (!rows[0]) throw new HttpError(409, 'those two schools are not in the same group', 'not_grouped');
    return rows[0];
  }
  /** The class the child lands in: the one named, or the same rung of the ladder in the new school. */
  private async targetClass(toSchoolId: string, student: Row, toClassId: string | null) {
    if (toClassId) {
      const c = await this.db.findOne<Row>('classes', { id: toClassId, school_id: toSchoolId });
      if (!c) throw notFound('class in the receiving school');
      return c;
    }
    const current = student.current_class_id ? await this.db.findOne<Row>('classes', { id: String(student.current_class_id) }) : null;
    const level = current?.numeric_level == null ? null : Number(current.numeric_level);
    const match = level == null ? null : await this.db.findOne<Row>('classes', { school_id: toSchoolId, numeric_level: level });
    // guessing wrong here puts a Class 8 child in Class 1, so an unmatched level asks rather than guesses
    if (!match) throw new HttpError(409, `the receiving school has no class at level ${level ?? 'unknown'} — name the class to transfer into`, 'no_class');
    return match;
  }

  // ---------- the parent super-app ----------
  /**
   * One guardian login, every child of theirs in this installation.
   *
   * The match is the guardian's own phone number, normalised to +880… when the row was written and
   * proved by the OTP they signed in with — never their name, and never a school's say-so. A guardian
   * therefore reaches exactly the children some school recorded against that number and nobody else's,
   * and a staff account reaches nothing at all: this is refused outright for anyone who is not a
   * guardian, so a school's console cannot borrow it to see across the group.
   *
   * Each child carries the school they attend and what is owed there, in that school's own currency.
   * The amounts are deliberately not added up: two schools may bill in different currencies, and a
   * family's total is not a number this can invent.
   */
  /**
   * Every child of this guardian, in their own school and in any school that shares a group with it.
   * The group is the boundary: a phone number is not a credential, and matching on it across the
   * whole installation would let any school put a row into a stranger's family app — a typo, or a
   * name and a balance placed in front of somebody deliberately — from inside an app they trust.
   */
  async familyChildren(user: { id: string; school_id: string; user_type: string }) {
    if (user.user_type !== 'guardian') throw forbidden('the family view belongs to a guardian account');
    const me = await this.db.findOne<Row>('guardians', { user_id: user.id });
    if (!me) throw notFound('guardian');
    const phone = String(me.phone);
    const rows = await this.db.query<Row>(`SELECT s.id AS student_id, s.first_name, s.last_name, s.name_bn, s.admission_no, s.current_roll_no, s.date_of_birth, s.status,
      sc.id AS school_id, sc.name AS school_name, sc.code AS school_code, sc.currency, c.name AS class_name, sec.name AS section_name, sg.relation, sg.is_primary
      FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id JOIN students s ON s.id = sg.student_id JOIN schools sc ON sc.id = s.school_id
      LEFT JOIN classes c ON c.id = s.current_class_id LEFT JOIN sections sec ON sec.id = s.current_section_id
      WHERE g.phone = ? AND s.status = 'active'
        AND (s.school_id = ? OR EXISTS (SELECT 1 FROM school_group_members a JOIN school_group_members b ON b.group_id = a.group_id WHERE a.school_id = ? AND b.school_id = s.school_id))
      ORDER BY sc.name, s.date_of_birth, s.id`, [phone, user.school_id, user.school_id]);
    const children = [];
    for (const r of rows) {
      const dues = await this.db.query<{ due: number }>(`SELECT COALESCE(SUM(balance), 0) AS due FROM invoices WHERE student_id = ? AND balance > 0 AND status <> 'cancelled'`, [String(r.student_id)]);
      children.push({
        studentId: String(r.student_id), name: `${String(r.first_name)} ${String(r.last_name ?? '')}`.trim(), nameBn: (r.name_bn as string) ?? null,
        admissionNo: String(r.admission_no), rollNo: (r.current_roll_no as string) ?? null, className: (r.class_name as string) ?? null, sectionName: (r.section_name as string) ?? null,
        relation: String(r.relation), isPrimary: !!Number(r.is_primary),
        school: { id: String(r.school_id), name: String(r.school_name), code: String(r.school_code), currency: String(r.currency ?? 'BDT') },
        // the guardian's home school is the one their session belongs to; the deeper portal pages for a
        // child elsewhere open after signing in to that school with the same phone
        isHomeSchool: String(r.school_id) === user.school_id,
        dues: round(Number(dues[0]?.due ?? 0)), duesCurrency: String(r.currency ?? 'BDT'),
      });
    }
    const schools = [...new Set(children.map(c => c.school.id))];
    return { phone, children, schools: schools.length, currencies: [...new Set(children.map(c => c.duesCurrency))] };
  }

  // ---------- currency ----------
  /**
   * Records a rate. One row per pair per day, so a corrected rate replaces the day's own figure.
   *
   * `currency_rates` is installation-wide, so the write belongs to the founder school and nobody
   * else: an accountant in any tenant could otherwise rewrite the rate a trust's consolidated total
   * is built from, and turn another school's sixty thousand into five hundred.
   */
  async setRate(callerSchoolId: string, r: RateInput) {
    await this.requireFounder(callerSchoolId);
    const base = r.baseCcy.trim().toUpperCase(), quote = r.quoteCcy.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote)) throw badRequest('currencies are three-letter codes such as BDT or USD');
    if (base === quote) throw badRequest('a currency needs no rate against itself');
    if (!(Number(r.rate) > 0)) throw badRequest('a rate must be greater than zero');
    const asOf = (r.asOf ?? nowSql().slice(0, 10)).slice(0, 10);
    const ex = await this.db.findOne<Row>('currency_rates', { base_ccy: base, quote_ccy: quote, as_of: asOf });
    if (ex) { await this.db.update('currency_rates', { rate: Number(r.rate), source: r.source ?? null, updated_at: nowSql() }, { id: String(ex.id) }); return { id: String(ex.id), updated: true }; }
    const id = ulid();
    await this.db.insert('currency_rates', { id, base_ccy: base, quote_ccy: quote, rate: Number(r.rate), as_of: asOf, source: r.source ?? null });
    return { id, updated: false };
  }
  async rates(f: { baseCcy?: string; quoteCcy?: string; limit?: number } = {}) {
    const where: string[] = []; const params: unknown[] = [];
    if (f.baseCcy) { where.push('base_ccy = ?'); params.push(f.baseCcy.toUpperCase()); }
    if (f.quoteCcy) { where.push('quote_ccy = ?'); params.push(f.quoteCcy.toUpperCase()); }
    const limit = Math.min(500, Math.max(1, Math.round(Number(f.limit) || 100)));
    return this.db.query<Row>(`SELECT * FROM currency_rates${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY as_of DESC, base_ccy, quote_ccy LIMIT ${limit}`, params);
  }
  /**
   * The rate that applied on a day: the newest one recorded on or before it, or the inverse of the
   * opposite pair when only that was recorded (a group that keeps USD→BDT should not also have to keep
   * BDT→USD by hand). A rate recorded after the day being reported is not used — restating last
   * month's collection at today's rate is how two reports of the same month stop matching.
   */
  async rateFor(from: string, to: string, onOrBefore = nowSql().slice(0, 10)): Promise<UsedRate | null> {
    const a = from.toUpperCase(), b = to.toUpperCase();
    if (a === b) return { from: a, to: b, rate: 1, asOf: null, source: 'same currency' };
    const day = onOrBefore.slice(0, 10);
    const direct = await this.db.query<Row>(`SELECT rate, as_of, source FROM currency_rates WHERE base_ccy = ? AND quote_ccy = ? AND as_of <= ? ORDER BY as_of DESC, id DESC LIMIT 1`, [a, b, day]);
    if (direct[0]) return { from: a, to: b, rate: Number(direct[0].rate), asOf: String(direct[0].as_of).slice(0, 10), source: String(direct[0].source ?? 'recorded') };
    const inverse = await this.db.query<Row>(`SELECT rate, as_of, source FROM currency_rates WHERE base_ccy = ? AND quote_ccy = ? AND as_of <= ? ORDER BY as_of DESC, id DESC LIMIT 1`, [b, a, day]);
    if (inverse[0] && Number(inverse[0].rate) > 0) return { from: a, to: b, rate: 1 / Number(inverse[0].rate), asOf: String(inverse[0].as_of).slice(0, 10), source: String(inverse[0].source ?? 'recorded'), inverted: true };
    return null;
  }
  /** Converts, or refuses. Nothing in this module silently treats one currency as another. */
  async convert(amount: number, from: string, to: string, onOrBefore?: string) {
    const rate = await this.rateFor(from, to, onOrBefore);
    if (!rate) throw new HttpError(409, `no exchange rate ${from.toUpperCase()}→${to.toUpperCase()} on or before ${(onOrBefore ?? nowSql()).slice(0, 10)}`, 'no_rate');
    return { amount: round(amount * rate.rate), rate: rate.rate, asOf: rate.asOf, inverted: !!rate.inverted, from: rate.from, to: rate.to };
  }
}
