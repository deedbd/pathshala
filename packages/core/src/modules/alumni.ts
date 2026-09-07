import type { Db, Row } from '@pathshala/db';
import { nowSql, ulid } from '@pathshala/db';
import type { ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { AcademicService } from './academic.js';
import { HttpError, badRequest, notFound } from '../context.js';

/**
 * Alumni. The directory is not something anybody sits down to type: it is written the day a class
 * graduates, from the records the school already has. After that it is theirs — a former student
 * decides whether their entry is public, whether they will mentor, and what they want it to say.
 *
 * Nothing here is visible outside the school unless the person marked it public, and a phone number
 * never is: the school passes messages on, it does not hand out contact details.
 */
export class AlumniService {
  constructor(private db: Db, private outbox: OutboxService, private notifications: NotificationService, private academic: AcademicService) {}

  /**
   * Graduates a class: the students' records close, and each one becomes an alumni entry with the
   * batch they left in. Running it twice changes nothing, because a school will run it twice.
   */
  async graduateClass(schoolId: string, p: { classId: string; academicYearId?: string; graduationYear?: number; leftOn?: string }) {
    const year = p.academicYearId ? await this.db.findOne<Row>('academic_years', { id: p.academicYearId, school_id: schoolId }) : await this.academic.requireYear(schoolId, null);
    if (!year) throw notFound('academic year');
    const cls = await this.db.findOne<Row>('classes', { id: p.classId, school_id: schoolId });
    if (!cls) throw notFound('class');
    const graduationYear = p.graduationYear ?? Number(String(year.name).match(/\d{4}/)?.[0] ?? new Date().getUTCFullYear());
    const leftOn = p.leftOn ?? nowSql().slice(0, 10);
    const students = await this.db.query<Row>(`SELECT s.* FROM students s JOIN student_enrollments e ON e.student_id = s.id AND e.academic_year_id = ? WHERE s.school_id = ? AND e.class_id = ? AND s.status IN ('active','graduated','alumni') ORDER BY s.admission_no`, [String(year.id), schoolId, p.classId]);
    const batchId = await this.batch(schoolId, graduationYear);
    let made = 0, already = 0;
    for (const s of students) {
      if (await this.db.findOne('alumni', { school_id: schoolId, student_id: String(s.id) })) { already++; continue; }
      const guardianEmail = (await this.db.query<{ email: string | null }>(`SELECT g.email FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND sg.is_primary = TRUE LIMIT 1`, [String(s.id)]))[0]?.email ?? null;
      await this.db.insert('alumni', {
        id: ulid(), school_id: schoolId, student_id: String(s.id), user_id: (s.user_id as string) ?? null,
        full_name: `${s.first_name} ${s.last_name ?? ''}`.trim(), graduation_year: graduationYear, last_class_id: p.classId,
        phone: (s.phone as string) ?? null, email: guardianEmail, current_organisation: null, current_position: null,
        city: null, country: 'Bangladesh', linkedin_url: null, bio: null, photo_file_id: (s.photo_file_id as string) ?? null,
        is_public: false, is_mentor: false, status: 'active',
      });
      await this.db.update('students', { status: 'alumni', status_changed_at: `${leftOn} 00:00:00`, status_reason: `graduated ${graduationYear}`, updated_at: nowSql() }, { id: String(s.id) });
      made++;
    }
    await this.outbox.emitNow({ type: 'alumni.graduated', schoolId, aggregateType: 'alumni.batch', aggregateId: batchId, payload: { batchId, graduationYear, classId: p.classId, alumni: made } });
    return { graduationYear, batchId, added: made, alreadyThere: already, students: students.length };
  }
  async batch(schoolId: string, graduationYear: number, name?: string) {
    const ex = await this.db.findOne<{ id: string }>('alumni_batches', { school_id: schoolId, graduation_year: graduationYear });
    if (ex) return ex.id;
    const id = ulid();
    await this.db.insert('alumni_batches', { id, school_id: schoolId, graduation_year: graduationYear, name: name ?? `Batch of ${graduationYear}`, rep_alumni_id: null });
    return id;
  }
  async batches(schoolId: string) {
    return this.db.query<Row>(`SELECT b.*, (SELECT COUNT(*) FROM alumni a WHERE a.school_id = b.school_id AND a.graduation_year = b.graduation_year) AS members FROM alumni_batches b WHERE b.school_id = ? ORDER BY b.graduation_year DESC`, [schoolId]);
  }
  async setBatchRep(schoolId: string, graduationYear: number, alumniId: string) {
    const batchId = await this.batch(schoolId, graduationYear);
    if (!(await this.db.findOne('alumni', { id: alumniId, school_id: schoolId }))) throw notFound('alumni');
    await this.db.update('alumni_batches', { rep_alumni_id: alumniId, updated_at: nowSql() }, { id: batchId });
    return { batchId, repAlumniId: alumniId };
  }

  /** The office's view: everyone, with the contact details the school holds. */
  async directory(schoolId: string, f: { year?: number; q?: string; mentorsOnly?: boolean } = {}) {
    const where: string[] = ['a.school_id = ?', `a.status = 'active'`]; const params: unknown[] = [schoolId];
    if (f.year) { where.push('a.graduation_year = ?'); params.push(f.year); }
    if (f.mentorsOnly) where.push('a.is_mentor = TRUE');
    if (f.q) { where.push('(a.full_name LIKE ? OR a.current_organisation LIKE ?)'); params.push(`%${f.q}%`, `%${f.q}%`); }
    return this.db.query<Row>(`SELECT a.*, c.name AS class_name FROM alumni a LEFT JOIN classes c ON c.id = a.last_class_id WHERE ${where.join(' AND ')} ORDER BY a.graduation_year DESC, a.full_name LIMIT 500`, params);
  }
  /** The public directory: only those who asked to appear, and never a phone number. */
  async publicDirectory(schoolId: string, f: { year?: number; q?: string } = {}) {
    const rows = await this.directory(schoolId, f);
    return rows.filter(r => Number(r.is_public)).map(r => ({
      id: String(r.id), name: String(r.full_name), graduationYear: Number(r.graduation_year),
      organisation: (r.current_organisation as string) ?? null, position: (r.current_position as string) ?? null,
      city: (r.city as string) ?? null, country: (r.country as string) ?? null, linkedin: (r.linkedin_url as string) ?? null,
      bio: (r.bio as string) ?? null, isMentor: !!Number(r.is_mentor),
    }));
  }
  /** A former student updating their own entry. Only they can, and only these fields. */
  async updateProfile(schoolId: string, alumniId: string, p: { currentOrganisation?: string | null; currentPosition?: string | null; city?: string | null; country?: string | null; linkedinUrl?: string | null; bio?: string | null; isPublic?: boolean; isMentor?: boolean; phone?: string | null; email?: string | null }, byUserId?: string | null) {
    const a = await this.db.findOne<Row>('alumni', { id: alumniId, school_id: schoolId });
    if (!a) throw notFound('alumni');
    if (byUserId && a.user_id && String(a.user_id) !== byUserId) throw new HttpError(403, 'that is somebody else’s entry', 'forbidden');
    const row: Row = { updated_at: nowSql() };
    for (const [k, col] of [['currentOrganisation', 'current_organisation'], ['currentPosition', 'current_position'], ['city', 'city'], ['country', 'country'], ['linkedinUrl', 'linkedin_url'], ['bio', 'bio'], ['phone', 'phone'], ['email', 'email']] as const) {
      if (p[k] !== undefined) row[col] = p[k];
    }
    if (p.isPublic !== undefined) row.is_public = p.isPublic;
    if (p.isMentor !== undefined) row.is_mentor = p.isMentor;
    await this.db.update('alumni', row, { id: alumniId });
    return { id: alumniId };
  }
  async me(schoolId: string, userId: string) {
    const a = await this.db.findOne<Row>('alumni', { school_id: schoolId, user_id: userId });
    if (!a) throw notFound('alumni');
    const [mentees, posts] = await Promise.all([
      this.db.query<Row>(`SELECT m.*, s.first_name, s.last_name FROM mentorship_pairs m JOIN students s ON s.id = m.student_id WHERE m.mentor_id = ? ORDER BY m.started_on DESC`, [String(a.id)]),
      this.db.findMany<Row>('job_board_posts', { school_id: schoolId, posted_by_alumni_id: String(a.id) }, { orderBy: 'created_at DESC', limit: 50 }),
    ]);
    return { profile: a, mentees, posts };
  }

  // ---------- mentorship ----------
  /**
   * Pairing a former student with a current one. Both sides are told; a mentor already carrying three
   * mentees is not given a fourth, because a mentorship nobody has time for helps nobody.
   */
  async pair(schoolId: string, p: { mentorId: string; studentId: string; topic?: string | null; startedOn?: string }) {
    const mentor = await this.db.findOne<Row>('alumni', { id: p.mentorId, school_id: schoolId });
    if (!mentor) throw notFound('mentor');
    if (!Number(mentor.is_mentor)) throw badRequest(`${mentor.full_name} has not offered to mentor`);
    if (!(await this.db.findOne('students', { id: p.studentId, school_id: schoolId, status: 'active' }))) throw notFound('student');
    if (await this.db.findOne('mentorship_pairs', { mentor_id: p.mentorId, student_id: p.studentId, status: 'active' })) throw new HttpError(409, 'these two are already paired', 'duplicate');
    const load = await this.db.count('mentorship_pairs', { mentor_id: p.mentorId, status: 'active' });
    if (load >= 3) throw new HttpError(409, `${mentor.full_name} already mentors ${load} students`, 'mentor_full');
    const id = ulid();
    await this.db.insert('mentorship_pairs', { id, school_id: schoolId, mentor_id: p.mentorId, student_id: p.studentId, topic: p.topic ?? null, started_on: p.startedOn ?? nowSql().slice(0, 10), ended_on: null, status: 'active' });
    if (mentor.user_id) await this.notifications.notify({ schoolId, userId: String(mentor.user_id), channels: ['in_app', 'push'], eventKey: 'alumni.mentorship_started', title: 'A student to mentor', body: `You have been paired with a student${p.topic ? ` on ${p.topic}` : ''}. The school will introduce you.`, entityType: 'alumni.mentorship', entityId: id });
    const guardians = await this.db.query<{ user_id: string | null; phone: string }>(`SELECT g.user_id, g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND sg.receives_notifications = TRUE`, [p.studentId]);
    for (const g of guardians) await this.notifications.notify({ schoolId, userId: g.user_id, address: g.phone, channels: ['push', 'in_app'], eventKey: 'alumni.mentorship_started', title: 'A mentor from the school’s alumni', body: `${mentor.full_name} (batch of ${mentor.graduation_year}) will mentor your child${p.topic ? ` on ${p.topic}` : ''}.`, entityType: 'alumni.mentorship', entityId: id });
    return { id };
  }
  async endPair(schoolId: string, pairId: string, endedOn?: string) {
    if (!(await this.db.update('mentorship_pairs', { status: 'ended', ended_on: endedOn ?? nowSql().slice(0, 10), updated_at: nowSql() }, { id: pairId, school_id: schoolId }))) throw notFound('mentorship');
    return { id: pairId, status: 'ended' as const };
  }
  async pairs(schoolId: string, f: { mentorId?: string; studentId?: string; activeOnly?: boolean } = {}) {
    const where: string[] = ['m.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.mentorId) { where.push('m.mentor_id = ?'); params.push(f.mentorId); }
    if (f.studentId) { where.push('m.student_id = ?'); params.push(f.studentId); }
    if (f.activeOnly) where.push(`m.status = 'active'`);
    return this.db.query<Row>(`SELECT m.*, a.full_name AS mentor_name, a.graduation_year, s.first_name, s.last_name, s.admission_no FROM mentorship_pairs m JOIN alumni a ON a.id = m.mentor_id JOIN students s ON s.id = m.student_id WHERE ${where.join(' AND ')} ORDER BY m.started_on DESC LIMIT 200`, params);
  }

  // ---------- job board ----------
  async postJob(schoolId: string, j: { title: string; company?: string | null; location?: string | null; description?: string | null; applyUrl?: string | null; expiresAt?: string | null; postedByAlumniId?: string | null }) {
    const id = ulid();
    await this.db.insert('job_board_posts', { id, school_id: schoolId, posted_by_alumni_id: j.postedByAlumniId ?? null, title: j.title, company: j.company ?? null, location: j.location ?? null, description: j.description ?? null, apply_url: j.applyUrl ?? null, expires_at: j.expiresAt ?? null, status: 'open' });
    return id;
  }
  async closeJob(schoolId: string, postId: string) {
    if (!(await this.db.update('job_board_posts', { status: 'closed', updated_at: nowSql() }, { id: postId, school_id: schoolId }))) throw notFound('post');
    return { id: postId, status: 'closed' as const };
  }
  /** Open posts only, and an expired post is closed rather than left to mislead somebody. */
  async jobBoard(schoolId: string) {
    const today = nowSql().slice(0, 10);
    await this.db.execute(`UPDATE job_board_posts SET status = 'closed', updated_at = ? WHERE school_id = ? AND status = 'open' AND expires_at IS NOT NULL AND expires_at < ?`, [nowSql(), schoolId, today]);
    return this.db.query<Row>(`SELECT p.*, a.full_name AS posted_by FROM job_board_posts p LEFT JOIN alumni a ON a.id = p.posted_by_alumni_id WHERE p.school_id = ? AND p.status = 'open' ORDER BY p.created_at DESC LIMIT 100`, [schoolId]);
  }

  // ---------- scheduled ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      /**
       * Daily: the job board tidies itself.
       *
       * A post was only ever closed when somebody happened to load the page — so a vacancy that
       * closed in March was still being applied for in June by whoever had the link, and the alumnus
       * who posted it never learned that it had lapsed. Closing an expired post is arithmetic on a
       * date the poster set themselves; telling them a few days beforehand is the courtesy that
       * makes them extend it if the job is still open.
       */
      'alumni.job_board': async ({ schoolId }) => {
        const today = nowSql().slice(0, 10);
        const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
        let closed = 0, warned = 0;
        const expiring = await this.db.query<Row>(`SELECT p.*, a.user_id, a.full_name FROM job_board_posts p LEFT JOIN alumni a ON a.id = p.posted_by_alumni_id
          WHERE p.school_id = ? AND p.status = 'open' AND p.expires_at IS NOT NULL AND p.expires_at BETWEEN ? AND ? LIMIT 100`, [schoolId, today, soon]);
        for (const p of expiring) {
          if (!p.user_id) continue;
          const sent = await this.notifications.notifyOnce(96, { schoolId, userId: String(p.user_id), channels: ['in_app', 'email'], eventKey: 'alumni.job_expiring', title: 'Your job post is about to close', body: `${String(p.title)}${p.company ? ` at ${String(p.company)}` : ''} closes on ${String(p.expires_at).slice(0, 10)}. Tell the school if it should stay up.`, entityType: 'alumni.job_post', entityId: String(p.id) });
          if (sent.length) warned++;
        }
        const gone = await this.db.query<Row>(`SELECT p.*, a.user_id FROM job_board_posts p LEFT JOIN alumni a ON a.id = p.posted_by_alumni_id
          WHERE p.school_id = ? AND p.status = 'open' AND p.expires_at IS NOT NULL AND p.expires_at < ? LIMIT 200`, [schoolId, today]);
        for (const p of gone) {
          await this.db.update('job_board_posts', { status: 'closed', updated_at: nowSql() }, { id: String(p.id) });
          closed++;
          if (p.user_id) await this.notifications.notifyOnce(720, { schoolId, userId: String(p.user_id), channels: ['in_app'], eventKey: 'alumni.job_closed', title: 'Your job post has closed', body: `${String(p.title)} reached the date you set and is no longer on the board. Post it again if the job is still open.`, entityType: 'alumni.job_post', entityId: String(p.id) });
        }
        return { closed, warned };
      },
    };
  }
}
