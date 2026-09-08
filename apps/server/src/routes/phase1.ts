import type { Request, Response, Router } from 'express';
import { HttpError, type App } from '@pathshala/core';
import { nowSql } from '@pathshala/db';
import { calendarEventSchema, classSchema, classSubjectSchema, contactSchema, enquirySchema, generateSchema, guardianSchema, lessonPlanSchema, noticeSchema, pageSchema, periodSchema, sectionSchema, slotSchema, staffSchema, studentSchema, subjectSchema, syllabusSchema, yearSchema, z } from '@pathshala/schemas';

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (e?: unknown) => void) => void;

/** Phase 1 API: academic structure, people, import, timetable, curriculum, website, guardian portal. */
export function mountPhase1(api: Router, app: App, wrap: Wrap, requirePerm: (req: Request, perm: string) => { id: string; school_id: string }, requireUser: (req: Request) => { id: string; school_id: string; user_type: string }) {

  /**
   * The language a person reads the software in, kept on their own row so the choice follows them
   * from the office computer to the phone they mark attendance on. The cookie the console also sets
   * covers the pages seen before signing in; this is the half that lasts.
   */
  /**
   * The one box at the top of the console. Behind the same permissions as the pages it finds things
   * on, so it can never be a way around them.
   */
  api.get('/search', wrap(async req => {
    const u = requireUser(req);
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    return app.search.find(u.school_id, u.id, q);
  }));

  api.post('/auth/locale', wrap(async req => {
    const u = requireUser(req);
    const { locale } = z.object({ locale: z.enum(['bn', 'en']) }).parse(req.body ?? {});
    await app.db.update('users', { locale, updated_at: nowSql() }, { id: u.id });
    return { locale };
  }));
  const q = (req: Request, k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : undefined);
  const yearOf = async (req: Request, schoolId: string) => String((await app.academic.requireYear(schoolId, q(req, 'yearId') ?? (req.body?.academicYearId as string | undefined))).id);

  // ---------- academic ----------
  api.get('/academic/overview', wrap(async req => { const u = requirePerm(req, 'academic.view'); const years = await app.academic.years(u.school_id); const year = years.find(y => Number(y.is_current)) ?? years[0]; return { years, year, structure: year ? await app.academic.structure(u.school_id, String(year.id)) : null, shifts: await app.academic.shifts(u.school_id), rooms: await app.academic.rooms(u.school_id), weeklyOffs: await app.academic.weeklyOffs(u.school_id) }; }));
  api.post('/academic/years', wrap(async req => { const u = requirePerm(req, 'academic.create'); const id = await app.academic.createYear(u.school_id, yearSchema.parse(req.body)); await app.audit.log({ action: 'create', entityType: 'academic_year', entityId: id, after: req.body }); return { id }; }));
  api.post('/academic/years/:id/current', wrap(async req => { const u = requirePerm(req, 'academic.edit'); await app.academic.setCurrentYear(u.school_id, req.params.id as string); return { ok: true }; }));
  api.post('/academic/years/:id/preset', wrap(async req => { const u = requirePerm(req, 'academic.create'); const school = await app.db.findOne<{ institution_type: string }>('schools', { id: u.school_id }); return app.academic.applyPreset(u.school_id, z.object({ institutionType: z.string().optional() }).parse(req.body ?? {}).institutionType ?? school?.institution_type ?? 'school', req.params.id as string); }));
  api.get('/academic/classes', wrap(async req => { const u = requirePerm(req, 'academic.view'); return app.academic.classes(u.school_id); }));
  api.post('/academic/classes', wrap(async req => { const u = requirePerm(req, 'academic.create'); return { id: await app.academic.createClass(u.school_id, classSchema.parse(req.body)) }; }));
  api.get('/academic/subjects', wrap(async req => { const u = requirePerm(req, 'academic.view'); return app.academic.subjects(u.school_id); }));
  api.post('/academic/subjects', wrap(async req => { const u = requirePerm(req, 'academic.create'); return { id: await app.academic.createSubject(u.school_id, subjectSchema.parse(req.body)) }; }));
  api.get('/academic/class-subjects', wrap(async req => { const u = requirePerm(req, 'academic.view'); return app.academic.classSubjects(u.school_id, await yearOf(req, u.school_id), q(req, 'classId')); }));
  api.post('/academic/class-subjects', wrap(async req => { const u = requirePerm(req, 'academic.edit'); return { id: await app.academic.setClassSubject(u.school_id, classSubjectSchema.parse(req.body)) }; }));
  api.get('/academic/sections', wrap(async req => { const u = requirePerm(req, 'academic.view'); return app.academic.sections(u.school_id, await yearOf(req, u.school_id), q(req, 'classId')); }));
  api.post('/academic/sections', wrap(async req => { const u = requirePerm(req, 'academic.create'); return { id: await app.academic.createSection(u.school_id, sectionSchema.parse(req.body)) }; }));
  api.patch('/academic/sections/:id', wrap(async req => { const u = requirePerm(req, 'academic.edit'); return { updated: await app.academic.updateSection(u.school_id, req.params.id as string, sectionSchema.partial().extend({ status: z.enum(['active', 'inactive']).optional() }).parse(req.body)) }; }));
  api.get('/academic/periods', wrap(async req => { const u = requirePerm(req, 'academic.view'); return app.academic.periods(u.school_id, q(req, 'shiftId') ?? undefined); }));
  api.put('/academic/periods', wrap(async req => { const u = requirePerm(req, 'academic.edit'); const b = z.object({ shiftId: z.string().optional().nullable(), periods: z.array(periodSchema).min(1) }).parse(req.body); await app.academic.setPeriods(u.school_id, b.shiftId ?? null, b.periods); return { ok: true }; }));
  api.post('/academic/rooms', wrap(async req => { const u = requirePerm(req, 'academic.create'); const campus = await app.academic.mainCampus(u.school_id); const b = z.object({ name: z.string().min(1).max(60), capacity: z.coerce.number().optional(), building: z.string().optional(), roomType: z.string().optional() }).parse(req.body); return { id: await app.academic.createRoom(u.school_id, { campusId: String(campus?.id), ...b }) }; }));
  api.get('/academic/calendar', wrap(async req => { const u = requirePerm(req, 'academic.view'); const from = q(req, 'from') ?? new Date().toISOString().slice(0, 10); const to = q(req, 'to') ?? new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10); return { events: await app.academic.calendar(u.school_id, from, to), weeklyOffs: await app.academic.weeklyOffs(u.school_id) }; }));
  api.post('/academic/calendar', wrap(async req => { const u = requirePerm(req, 'academic.create'); return { id: await app.academic.addCalendarEvent(u.school_id, calendarEventSchema.parse(req.body)) }; }));
  api.put('/academic/weekly-offs', wrap(async req => { const u = requirePerm(req, 'academic.edit'); await app.academic.setWeeklyOffs(u.school_id, z.object({ days: z.array(z.number().int().min(0).max(6)) }).parse(req.body).days); return { ok: true }; }));

  // ---------- people ----------
  api.get('/people/students', wrap(async req => { const u = requirePerm(req, 'people.view'); return app.people.students(u.school_id, { yearId: q(req, 'yearId'), classId: q(req, 'classId'), sectionId: q(req, 'sectionId'), q: q(req, 'q'), status: q(req, 'status'), limit: Number(q(req, 'limit')) || 50, offset: Number(q(req, 'offset')) || 0 }); }));
  api.post('/people/students', wrap(async req => { const u = requirePerm(req, 'people.create'); const r = await app.people.createStudent(u.school_id, studentSchema.parse(req.body)); await app.audit.log({ action: 'create', entityType: 'student', entityId: r.id, after: { admissionNo: r.admissionNo } }); return r; }));
  api.get('/people/students/:id', wrap(async req => { const u = requirePerm(req, 'people.view'); return app.people.student(u.school_id, req.params.id as string); }));
  api.patch('/people/students/:id', wrap(async req => { const u = requirePerm(req, 'people.edit'); const patch = studentSchema.partial().extend({ status: z.enum(['active', 'suspended', 'graduated', 'transferred', 'dropped', 'alumni']).optional(), statusReason: z.string().max(255).optional() }).parse(req.body); const n = await app.people.updateStudent(u.school_id, req.params.id as string, patch as never); if (!n) throw new HttpError(404, 'student not found'); await app.audit.log({ action: 'update', entityType: 'student', entityId: req.params.id as string, after: patch }); return { updated: n }; }));
  api.post('/people/students/:id/guardians', wrap(async req => { const u = requirePerm(req, 'people.edit'); return { guardianId: await app.people.linkGuardian(u.school_id, req.params.id as string, guardianSchema.parse(req.body)) }; }));
  api.post('/people/students/:id/section', wrap(async req => { const u = requirePerm(req, 'people.edit'); const b = z.object({ sectionId: z.string(), rollNo: z.string().optional().nullable() }).parse(req.body); await app.people.moveSection(u.school_id, req.params.id as string, b.sectionId, b.rollNo); return { ok: true }; }));
  // the literal path is registered before `/people/guardians/:id/...` so "guardians" is never an id
  api.get('/people/guardians', wrap(async req => { const u = requirePerm(req, 'people.view'); const has = q(req, 'hasAccount'); return app.people.guardians(u.school_id, { q: q(req, 'q'), hasAccount: has === '1' ? true : has === '0' ? false : undefined, limit: Number(q(req, 'limit')) || 50, offset: Number(q(req, 'offset')) || 0 }); }));
  api.post('/people/guardians/:id/account', wrap(async req => { const u = requirePerm(req, 'people.edit'); return { userId: await app.people.ensureGuardianAccount(u.school_id, req.params.id as string) }; }));
  api.get('/people/staff', wrap(async req => { const u = requirePerm(req, 'people.view'); return app.people.staff(u.school_id, { category: q(req, 'category'), q: q(req, 'q'), teachingOnly: q(req, 'teaching') === '1' }); }));
  api.post('/people/staff', wrap(async req => { const u = requirePerm(req, 'people.create'); const r = await app.people.createStaff(u.school_id, staffSchema.parse(req.body)); await app.audit.log({ action: 'create', entityType: 'staff', entityId: r.id, after: { employeeNo: r.employeeNo } }); return r; }));
  api.put('/people/staff/:id/subjects', wrap(async req => { const u = requirePerm(req, 'people.edit'); await app.people.setStaffSubjects(u.school_id, req.params.id as string, z.object({ subjectIds: z.array(z.string()) }).parse(req.body).subjectIds); return { ok: true }; }));
  api.get('/people/departments', wrap(async req => { const u = requirePerm(req, 'people.view'); return app.people.departmentSummary(u.school_id, q(req, 'date')); }));
  api.post('/people/departments', wrap(async req => { const u = requirePerm(req, 'people.create'); const b = z.object({ name: z.string().min(1).max(80), kind: z.enum(['academic', 'admin', 'support']).optional() }).parse(req.body); return { id: await app.people.createDepartment(u.school_id, b.name, b.kind) }; }));
  api.post('/people/departments/:id/head', wrap(async req => { const u = requirePerm(req, 'people.edit'); const b = z.object({ staffId: z.string().nullable() }).parse(req.body); return app.people.setDepartmentHead(u.school_id, req.params.id as string, b.staffId); }));
  api.post('/people/designations', wrap(async req => { const u = requirePerm(req, 'people.create'); const b = z.object({ name: z.string().min(1).max(80), category: z.enum(['teaching', 'non_teaching', 'admin', 'support']).optional(), level: z.coerce.number().int().optional() }).parse(req.body); return { id: await app.people.createDesignation(u.school_id, b.name, b.category, b.level) }; }));

  // ---------- import (raw xlsx body or base64 JSON) ----------
  api.get('/import/template', (req, res) => {
    try { requirePerm(req, 'people.create'); } catch (e) { return res.status((e as HttpError).status ?? 401).json({ error: (e as Error).message }); }
    const entity = (q(req, 'entity') ?? 'student') as 'student' | 'staff' | 'attendance';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${entity}-template.xlsx"`);
    res.send(app.importer.template(entity));
  });
  api.post('/import/students', wrap(async req => {
    const u = requirePerm(req, 'people.create');
    let buffer: Buffer; let fileName = 'students.xlsx';
    if (Buffer.isBuffer(req.body)) buffer = req.body;
    else { const b = z.object({ fileName: z.string().max(200).optional(), base64: z.string().min(10) }).parse(req.body); buffer = Buffer.from(b.base64.replace(/^data:[^;]+;base64,/, ''), 'base64'); fileName = b.fileName ?? fileName; }
    if (buffer.length > 15 * 1024 * 1024) throw new HttpError(413, 'file too large (15 MB max)');
    return app.importer.start(u.school_id, buffer, fileName, { academicYearId: q(req, 'yearId') ?? null, createdBy: u.id });
  }));
  // staff and a term's attendance arrive as spreadsheets too: same body, same job, different sheet
  for (const [path, entity, perm] of [['staff', 'staff', 'people.create'], ['attendance', 'attendance', 'attendance.edit']] as const) {
    api.post(`/import/${path}`, wrap(async req => {
      const u = requirePerm(req, perm);
      let buffer: Buffer; let fileName = `${path}.xlsx`;
      if (Buffer.isBuffer(req.body)) buffer = req.body;
      else { const b = z.object({ fileName: z.string().max(200).optional(), base64: z.string().min(10) }).parse(req.body); buffer = Buffer.from(b.base64.replace(/^data:[^;]+;base64,/, ''), 'base64'); fileName = b.fileName ?? fileName; }
      if (buffer.length > 15 * 1024 * 1024) throw new HttpError(413, 'file too large (15 MB max)');
      return app.importer.start(u.school_id, buffer, fileName, { entity, academicYearId: q(req, 'yearId') ?? null, createdBy: u.id });
    }));
  }
  api.get('/files/:id/url', wrap(async req => { const u = requireUser(req); return { url: await app.files.url(req.params.id as string, u.school_id, 900) }; }));
  api.get('/import/jobs', wrap(async req => { const u = requirePerm(req, 'people.view'); return app.importer.list(u.school_id); }));
  api.get('/import/jobs/:id', wrap(async req => { const u = requirePerm(req, 'people.view'); return app.importer.status(u.school_id, req.params.id as string); }));

  // ---------- timetable ----------
  api.get('/timetable/versions', wrap(async req => { const u = requirePerm(req, 'curriculum.view'); return app.timetable.versions(u.school_id, await yearOf(req, u.school_id)); }));
  api.post('/timetable/versions', wrap(async req => { const u = requirePerm(req, 'curriculum.create'); const b = z.object({ academicYearId: z.string().optional(), name: z.string().min(1).max(80), effectiveFrom: z.string() }).parse(req.body); return { id: await app.timetable.createVersion(u.school_id, await yearOf(req, u.school_id), b.name, b.effectiveFrom) }; }));
  api.post('/timetable/generate', wrap(async req => { const u = requirePerm(req, 'curriculum.create'); const b = generateSchema.parse(req.body ?? {}); const yearId = await yearOf(req, u.school_id); await app.timetable.autoAssignTeachers(u.school_id, yearId); const r = await app.timetable.generate(u.school_id, yearId, b); await app.audit.log({ action: 'generate', entityType: 'timetable_version', entityId: r.versionId, after: r }); return r; }));
  api.post('/timetable/versions/:id/publish', wrap(async req => { const u = requirePerm(req, 'curriculum.approve'); await app.timetable.publish(u.school_id, req.params.id as string); return { ok: true }; }));
  api.get('/timetable/versions/:id/grid', wrap(async req => { const u = requirePerm(req, 'curriculum.view'); return { slots: await app.timetable.grid(u.school_id, req.params.id as string, q(req, 'sectionId')), clashes: await app.timetable.validate(u.school_id, req.params.id as string), periods: await app.academic.periods(u.school_id) }; }));
  api.put('/timetable/versions/:id/slots', wrap(async req => { const u = requirePerm(req, 'curriculum.edit'); return { id: await app.timetable.setSlot(u.school_id, req.params.id as string, slotSchema.parse(req.body)) }; }));
  api.delete('/timetable/versions/:id/slots', wrap(async req => { const u = requirePerm(req, 'curriculum.edit'); const b = slotSchema.pick({ sectionId: true, dayOfWeek: true, periodId: true }).parse(req.body); return { deleted: await app.timetable.clearSlot(req.params.id as string, b.sectionId, b.dayOfWeek, b.periodId) }; }));
  api.post('/timetable/assign', wrap(async req => { const u = requirePerm(req, 'curriculum.edit'); const b = z.object({ sectionId: z.string(), classSubjectId: z.string(), teacherId: z.string() }).parse(req.body); return { id: await app.timetable.assignTeacher(u.school_id, b.sectionId, b.classSubjectId, b.teacherId) }; }));
  api.post('/timetable/auto-assign', wrap(async req => { const u = requirePerm(req, 'curriculum.edit'); return app.timetable.autoAssignTeachers(u.school_id, await yearOf(req, u.school_id)); }));
  api.post('/timetable/substitutions/suggest', wrap(async req => { const u = requirePerm(req, 'curriculum.edit'); const b = z.object({ teacherId: z.string(), onDate: z.string(), versionId: z.string().optional() }).parse(req.body); const v = b.versionId ? { id: b.versionId } : await app.timetable.publishedVersion(u.school_id, await yearOf(req, u.school_id)); if (!v) throw new HttpError(409, 'no published timetable'); return app.timetable.suggestSubstitutes(u.school_id, String(v.id), b.teacherId, b.onDate); }));
  api.get('/timetable/substitutions', wrap(async req => { const u = requirePerm(req, 'curriculum.view'); return app.timetable.substitutions(u.school_id, q(req, 'date') ?? new Date().toISOString().slice(0, 10)); }));
  api.post('/timetable/substitutions/:id', wrap(async req => { const u = requirePerm(req, 'curriculum.approve'); const b = z.object({ status: z.enum(['approved', 'rejected', 'cancelled']), substituteTeacherId: z.string().optional().nullable() }).parse(req.body); await app.timetable.decideSubstitution(u.school_id, req.params.id as string, b.status, b.substituteTeacherId); return { ok: true }; }));

  // ---------- curriculum ----------
  api.get('/curriculum/syllabi', wrap(async req => { const u = requirePerm(req, 'curriculum.view'); return app.curriculum.syllabi(u.school_id, await yearOf(req, u.school_id)); }));
  api.post('/curriculum/syllabi', wrap(async req => { const u = requirePerm(req, 'curriculum.create'); return { id: await app.curriculum.createSyllabus(u.school_id, syllabusSchema.parse(req.body)) }; }));
  api.get('/curriculum/syllabi/:id/units', wrap(async req => { const u = requirePerm(req, 'curriculum.view'); return app.curriculum.units(u.school_id, req.params.id as string); }));
  api.get('/curriculum/lessons', wrap(async req => { const u = requirePerm(req, 'curriculum.view'); return app.curriculum.lessons(u.school_id, { sectionId: q(req, 'sectionId'), teacherId: q(req, 'teacherId'), from: q(req, 'from'), to: q(req, 'to') }); }));
  api.post('/curriculum/lessons', wrap(async req => { const u = requirePerm(req, 'curriculum.create'); return { id: await app.curriculum.planLesson(u.school_id, lessonPlanSchema.parse(req.body)) }; }));
  api.post('/curriculum/lessons/:id/taught', wrap(async req => { const u = requirePerm(req, 'curriculum.edit'); await app.curriculum.markTaught(u.school_id, req.params.id as string, z.object({ status: z.enum(['taught', 'skipped']).optional() }).parse(req.body ?? {}).status); return { ok: true }; }));
  api.get('/curriculum/progress', wrap(async req => { const u = requirePerm(req, 'curriculum.view'); return app.curriculum.progress(u.school_id, await yearOf(req, u.school_id)); }));

  // ---------- website (cms) ----------
  api.get('/cms/pages', wrap(async req => { const u = requirePerm(req, 'cms.view'); return { pages: await app.cms.pages(u.school_id), menu: await app.cms.menu(u.school_id), notices: await app.cms.notices(u.school_id), enquiries: await app.cms.enquiries(u.school_id) }; }));
  api.post('/cms/pages', wrap(async req => { const u = requirePerm(req, 'cms.create'); return { id: await app.cms.savePage(u.school_id, pageSchema.parse(req.body)) }; }));
  api.put('/cms/pages/:id', wrap(async req => { const u = requirePerm(req, 'cms.edit'); return { id: await app.cms.savePage(u.school_id, pageSchema.parse(req.body), req.params.id as string) }; }));
  api.put('/cms/menu', wrap(async req => { const u = requirePerm(req, 'cms.edit'); await app.cms.setMenu(u.school_id, 'main', z.array(z.object({ label: z.string().max(60), labelBn: z.string().max(60).optional(), href: z.string().max(300) })).parse(req.body)); return { ok: true }; }));
  api.post('/cms/notices', wrap(async req => { const u = requirePerm(req, 'communication.create'); return { id: await app.cms.publishNotice(u.school_id, noticeSchema.parse(req.body)) }; }));

  // ---------- guardian / student portal ----------
  api.get('/portal/me', wrap(async req => { const u = requireUser(req); const school = await app.db.findOne<{ name: string; name_bn: string | null; locale: string; theme: unknown }>('schools', { id: u.school_id }); return { school, children: await app.portal.children(u.school_id, u.id), notices: await app.cms.publicNotices(u.school_id, 10) }; }));
  api.get('/portal/children/:id', wrap(async req => { const u = requireUser(req); return app.portal.child(u.school_id, u.id, req.params.id as string); }));
}

/** Public routes (no session): website content, enquiry and contact forms. Mounted at /api/public. */
export function mountPublic(pub: Router, app: App, wrap: Wrap, verifyTurnstile: (token: string | undefined, ip?: string) => Promise<void>) {
  const schoolOf = async (req: Request) => { const s = await app.cms.resolveSchool(req.headers.host ?? null); if (!s) throw new HttpError(404, 'no school configured yet'); return s; };
  pub.get('/site', wrap(async req => { const s = await schoolOf(req); const locale = (String(req.query.locale ?? s.locale ?? 'bn') as 'bn' | 'en'); return { school: { id: s.id, name: s.name, nameBn: s.name_bn, locale: s.locale, phone: s.phone, email: s.email, address: s.address, theme: s.theme }, page: await app.cms.home(String(s.id), locale), menu: await app.cms.menu(String(s.id)), notices: await app.cms.publicNotices(String(s.id)), classes: await app.academic.classes(String(s.id)) }; }));
  pub.get('/site/pages/:slug', wrap(async req => { const s = await schoolOf(req); const p = await app.cms.page(String(s.id), req.params.slug as string, (String(req.query.locale ?? s.locale ?? 'bn') as 'bn' | 'en')); if (!p) throw new HttpError(404, 'page not found'); return p; }));
  pub.post('/site/enquiry', wrap(async req => { const s = await schoolOf(req); const b = enquirySchema.parse(req.body); await verifyTurnstile(b.turnstile, req.ip); return { id: await app.cms.submitEnquiry(String(s.id), { studentName: b.studentName, guardianName: b.guardianName, phone: b.phone, email: b.email, classId: b.classId, notes: b.notes, source: 'website' }) }; }));
  pub.post('/site/contact', wrap(async req => { const s = await schoolOf(req); const b = contactSchema.parse(req.body); await verifyTurnstile(b.turnstile, req.ip); return { id: await app.cms.submitContact(String(s.id), b) }; }));
}
