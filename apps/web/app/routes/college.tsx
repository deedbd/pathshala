import { useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/college';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Kpi, Select, Tabs, api, formatDate, formatMoney, formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id; const url = new URL(request.url);
  const [year, term, classes] = await Promise.all([context.app.academic.currentYear(sid), context.app.academic.currentTerm(sid), context.app.academic.classes(sid)]);
  const yearId = year ? String(year.id) : null;
  const termId = url.searchParams.get('termId') ?? (term ? String(term.id) : null);
  const classId = url.searchParams.get('classId') ?? (classes[0] ? String(classes[0].id) : null);
  const studentId = url.searchParams.get('studentId');
  const [programs, departments, registrations, sales, terms, students, staff, courses, subjects] = await Promise.all([
    context.app.college.programs(sid),
    context.app.college.departments(sid),
    termId ? context.app.college.registrations(sid, { termId }) : [],
    context.app.college.sales(sid),
    yearId ? context.app.db.findMany('terms', { school_id: sid, academic_year_id: yearId }, { orderBy: 'sequence ASC' }) : [],
    context.app.people.students(sid, { limit: 200 }),
    context.app.people.staff(sid, { teachingOnly: true }),
    context.app.lms.courses(sid, { status: 'published' }),
    yearId && classId ? context.app.academic.classSubjects(sid, yearId, classId) : [],
  ]);
  const transcript = studentId ? await context.app.college.transcript(sid, studentId).catch(() => null) : null;
  const load = studentId && termId ? await context.app.college.load(sid, studentId, termId).catch(() => null) : null;
  return { locale: (user.locale as Locale) || context.locale, yearId, termId, classId, studentId, programs, departments, registrations, sales, terms, classes, students: students.rows, staff, courses, subjects, transcript, load };
}
export function meta() { return [{ title: 'Pathshala — College & coaching' }]; }

export default function College() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator(); const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<'programs' | 'registrations' | 'transcript' | 'sales'>('programs');
  const [drawer, setDrawer] = useState<null | 'program' | 'credit' | 'register' | 'result' | 'sale' | 'department' | 'head'>(null);
  const [resultFor, setResultFor] = useState<{ id: string; name: string } | null>(null);
  const [headFor, setHeadFor] = useState<{ id: string; name: string } | null>(null);
  const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); setMsg(null); try { await fn(); setDrawer(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const form = (e: React.FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n); };
  const money = (n: unknown) => formatMoney(Number(n ?? 0), d.locale);
  const num = (n: unknown) => formatNumber(Number(n ?? 0), d.locale);
  const name = (r: { first_name?: unknown; last_name?: unknown }) => `${String(r.first_name ?? '')} ${String(r.last_name ?? '')}`.trim();
  const studentOptions = d.students.map(s => ({ value: String(s.id), label: `${s.admission_no} · ${name(s)}` }));
  const classStudents = d.students.filter(s => !d.classId || String(s.current_class_id) === d.classId);
  const registered = d.registrations.filter(r => String(r.status) === 'registered').length;
  const inProgress = d.transcript ? d.transcript.terms.reduce((a, x) => a + Number(x.inProgress ?? 0), 0) : 0;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('col.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('col.purpose')}</p></div>
        <div className="flex flex-wrap gap-2">
          {d.terms.length > 0 && <Select value={d.termId ?? ''} onChange={e => setParam('termId', e.target.value)} options={d.terms.map(x => ({ value: String(x.id), label: String(x.name) }))} className="max-w-[200px]" />}
          {d.classes.length > 0 && <Select value={d.classId ?? ''} onChange={e => setParam('classId', e.target.value)} options={d.classes.map(c => ({ value: String(c.id), label: String(c.name) }))} className="max-w-[180px]" />}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={tr('col.programs')} value={d.programs.length} locale={d.locale} />
        <Kpi label={tr('col.registered')} value={registered} locale={d.locale} />
        <Kpi label={tr('col.departments')} value={d.departments.length} locale={d.locale} />
        <Kpi label={tr('col.sales')} value={d.sales.length} locale={d.locale} />
      </div>
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      {msg && <div className="mt-4"><Banner kind="ok">{msg}</Banner></div>}

      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[
        { key: 'programs', label: tr('col.programs'), count: d.programs.length },
        { key: 'registrations', label: tr('col.registrations'), count: d.registrations.length },
        { key: 'transcript', label: tr('col.transcript') },
        { key: 'sales', label: tr('col.sales'), count: d.sales.length },
      ]} /></div>

      {tab === 'programs' && <div className="mt-4">
        <div className="mb-3 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setDrawer('department')}>{tr('col.newDepartment')}</Button>
          <Button size="sm" variant="secondary" onClick={() => setDrawer('credit')}>{tr('col.setCredit')}</Button>
          <Button size="sm" onClick={() => setDrawer('program')}>{tr('col.newProgram')}</Button>
        </div>
        <DataTable locale={d.locale} rows={d.programs} columns={[
          { key: 'name', label: tr('common.name') },
          { key: 'code', label: tr('col.code'), className: 'num' },
          { key: 'level', label: tr('col.level'), render: r => <Chip status="active">{String(r.level ?? '').replace(/_/g, ' ')}</Chip> },
          { key: 'duration_terms', label: tr('col.terms'), className: 'num', render: r => r.duration_terms == null ? '—' : num(r.duration_terms) },
          { key: 'total_credits', label: tr('col.credits'), className: 'num', render: r => r.total_credits == null ? '—' : num(r.total_credits) },
          { key: 'department_name', label: tr('col.department'), render: r => String(r.department_name ?? '—') },
          { key: 'classes', label: tr('col.classes'), className: 'num', render: r => num(r.classes) },
          { key: 'students', label: tr('nav.students'), className: 'num', render: r => num(r.students) },
        ]} />
        <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('col.ceilingNote')}</p>

        <h2 className="mt-6 text-base">{tr('col.departments')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} searchable={false} rows={d.departments} columns={[
          { key: 'name', label: tr('common.name') },
          { key: 'kind', label: tr('common.type'), render: r => <Chip status={String(r.kind) === 'academic' ? 'active' : 'pending'}>{String(r.kind)}</Chip> },
          { key: 'head_first_name', label: tr('col.head'), render: r => r.head_first_name ? `${r.head_first_name} ${r.head_last_name ?? ''}` : tr('inst.nobody') },
          { key: 'staff', label: tr('nav.staff'), className: 'num', render: r => num(r.staff) },
          { key: 'subjects', label: tr('col.subjects'), className: 'num', render: r => num(r.subjects) },
          { key: 'programs', label: tr('col.programs'), className: 'num', render: r => num(r.programs) },
          { key: 'id', label: '', render: r => <Button size="sm" variant="secondary" onClick={() => { setHeadFor({ id: String(r.id), name: String(r.name) }); setDrawer('head'); }}>{tr('col.setHead')}</Button> },
        ]} /></div>
      </div>}

      {tab === 'registrations' && <div className="mt-4">
        <div className="mb-3 flex justify-end"><Button size="sm" onClick={() => setDrawer('register')} disabled={!d.termId}>{tr('col.register')}</Button></div>
        {!d.termId ? <Banner kind="warn">{tr('col.noTerm')}</Banner> : <DataTable locale={d.locale} rows={d.registrations} columns={[
          { key: 'admission_no', label: tr('stu.admissionNo'), className: 'num' },
          { key: 'first_name', label: tr('common.name'), render: r => name(r) },
          { key: 'subject_name', label: tr('common.subject'), render: r => `${r.subject_name} · ${r.class_name}` },
          { key: 'credit', label: tr('col.credit'), className: 'num', render: r => num(r.credit) },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'completed' ? 'active' : String(r.status) === 'failed' ? 'bad' : String(r.status) === 'dropped' ? 'done' : 'pending'}>{String(r.status)}</Chip> },
          { key: 'grade', label: tr('ex.grade'), render: r => r.grade ? `${r.grade} · ${num(r.grade_point)}` : '—' },
          { key: 'id', label: '', render: r => String(r.status) === 'registered' ? <div className="flex gap-1">
            <Button size="sm" onClick={() => { setResultFor({ id: String(r.id), name: `${name(r)} · ${r.subject_name}` }); setDrawer('result'); }}>{tr('col.enterResult')}</Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => api(`/api/college/registrations/${r.id}/drop`, { method: 'POST', json: {} }))}>{tr('col.drop')}</Button>
          </div> : null },
        ]} />}
      </div>}

      {tab === 'transcript' && <div className="mt-4">
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Select value={d.studentId ?? ''} onChange={e => setParam('studentId', e.target.value)} placeholder={tr('col.pickStudent')} options={studentOptions} className="max-w-[320px]" />
          {d.transcript && d.programs.length > 0 && <Select className="max-w-[240px]" value="" onChange={e => { const programId = e.target.value; if (!programId) return; run(async () => { const r = await api<{ certificateId: string }>('/api/college/certificates/program', { method: 'POST', json: { studentId: d.studentId, programId } }); setMsg(`${tr('col.certified')} · ${r.certificateId}`); }); }} placeholder={tr('col.certify')} options={d.programs.map(p => ({ value: String(p.id), label: String(p.name) }))} />}
        </div>
        {!d.transcript ? <Banner kind="info">{tr('col.pickStudent')}</Banner> : <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label={tr('col.creditsEarned')} value={num(d.transcript.creditsEarned)} locale={d.locale} />
            <Kpi label={tr('col.creditsAttempted')} value={num(d.transcript.creditsAttempted)} locale={d.locale} />
            <Kpi label={tr('col.cgpa')} value={d.transcript.cgpa == null ? '—' : num(d.transcript.cgpa)} locale={d.locale} />
            <Kpi label={tr('col.inProgress')} value={num(inProgress)} locale={d.locale} />
          </div>
          {d.load && <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('col.thisTerm')}: {num(d.load.courses)} · {num(d.load.credits)} {tr('col.credits').toLowerCase()}{d.load.ceiling == null ? '' : ` / ${num(d.load.ceiling)} · ${num(d.load.room)} ${tr('col.roomLeft')}`}</p>}
          {d.transcript.terms.length === 0 && <div className="mt-4"><Banner kind="info">{tr('col.noRegistrations')}</Banner></div>}
          {d.transcript.terms.map(term => <div key={term.termId} className="card mt-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">{term.name}</span>
              <span className="text-xs" style={{ color: 'var(--muted)' }}>{tr('col.gpa')} {term.gpa == null ? '—' : num(term.gpa)} · {num(term.creditsEarned)}/{num(term.creditsAttempted)} {tr('col.credits').toLowerCase()}{term.inProgress ? ` · ${num(term.inProgress)} ${tr('col.inProgress').toLowerCase()}` : ''}</span>
            </div>
            <div className="mt-2 overflow-x-auto"><table className="table"><thead><tr><th>{tr('common.subject')}</th><th className="num">{tr('col.credit')}</th><th className="num">%</th><th>{tr('ex.grade')}</th><th>{tr('common.status')}</th></tr></thead><tbody>
              {term.courses.map(c => <tr key={String(c.id)}>
                <td>{String(c.subject_name)}</td>
                <td className="num">{num(c.credit)}</td>
                <td className="num">{c.percent == null ? '—' : num(c.percent)}</td>
                <td>{String(c.grade ?? '—')}</td>
                <td><Chip status={String(c.status) === 'completed' ? 'active' : String(c.status) === 'failed' ? 'bad' : 'pending'}>{String(c.status)}</Chip></td>
              </tr>)}
            </tbody></table></div>
          </div>)}
          <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('col.transcriptNote')}</p>
        </>}
      </div>}

      {tab === 'sales' && <div className="mt-4">
        <div className="mb-3 flex justify-end"><Button size="sm" onClick={() => setDrawer('sale')}>{tr('col.sell')}</Button></div>
        <DataTable locale={d.locale} rows={d.sales} columns={[
          { key: 'course_title', label: tr('lrn.course') },
          { key: 'first_name', label: tr('common.name'), render: r => `${r.admission_no} · ${name(r)}` },
          { key: 'total_amount', label: tr('fee.amount'), className: 'num money', render: r => money(r.total_amount) },
          { key: 'enrolled', label: tr('col.seat'), render: r => Number(r.enrolled) ? <Chip status="active">{tr('col.handedOver')}</Chip> : <Chip status="pending">{tr('col.waitingPayment')}</Chip> },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'completed' ? 'active' : 'pending'}>{String(r.status)}</Chip> },
          { key: 'created_at', label: tr('common.date'), render: r => formatDate(String(r.created_at), d.locale) },
          { key: 'course_id', label: '', render: r => <div className="flex gap-1">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => { const x = await api<{ outstanding: number; billed: number; unbilled: number }>(`/api/college/sales/outstanding?courseId=${r.course_id}&studentId=${r.student_id}`); setMsg(`${tr('col.stillOwed')}: ${money(x.outstanding)} (${tr('fee.invoices')} ${money(x.billed)} + ${tr('fee.instalments')} ${money(x.unbilled)})`); })}>{tr('col.checkDues')}</Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => { await api('/api/college/certificates/course', { method: 'POST', json: { courseId: r.course_id, studentId: r.student_id } }); setMsg(tr('col.certified')); })}>{tr('col.certify')}</Button>
          </div> },
        ]} />
        <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('col.saleNote')}</p>
      </div>}

      <Drawer open={drawer === 'program'} onClose={() => setDrawer(null)} title={tr('col.newProgram')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(async () => { const r = await api<{ ceiling: number | null }>('/api/college/programs', { method: 'POST', json: { name: f.name, code: f.code, level: f.level, durationTerms: Number(f.durationTerms) || undefined, totalCredits: Number(f.totalCredits) || undefined, departmentId: f.departmentId || undefined } }); setMsg(r.ceiling == null ? tr('common.saved') : `${tr('col.ceiling')}: ${num(r.ceiling)}`); }); }}>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('common.name')}><Input name="name" required /></Field><Field label={tr('col.code')}><Input name="code" required /></Field></div>
          <Field label={tr('col.level')}><Select name="level" options={['higher_secondary', 'bachelor', 'master', 'diploma', 'coaching'].map(k => ({ value: k, label: k.replace(/_/g, ' ') }))} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('col.terms')}><Input name="durationTerms" type="number" min="1" max="24" className="num" /></Field><Field label={tr('col.credits')}><Input name="totalCredits" type="number" step="0.5" min="0" className="num" /></Field></div>
          <Field label={tr('col.department')}><Select name="departmentId" placeholder="—" options={d.departments.map(x => ({ value: String(x.id), label: String(x.name) }))} /></Field>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('col.ceilingNote')}</p>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'credit'} onClose={() => setDrawer(null)} title={tr('col.setCredit')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api('/api/college/credits', { method: 'POST', json: { academicYearId: d.yearId, classId: d.classId, subjectId: f.subjectId, credit: Number(f.credit) } })); }}>
          <Field label={tr('common.class')}><Input value={String(d.classes.find(c => String(c.id) === d.classId)?.name ?? '')} readOnly /></Field>
          <Field label={tr('common.subject')}><Select name="subjectId" required placeholder="—" options={d.subjects.map(s => ({ value: String(s.subject_id), label: `${s.subject_name} · ${num(s.credit)}` }))} /></Field>
          <Field label={tr('col.credit')} hint={tr('col.creditHint')}><Input name="credit" type="number" step="0.5" min="0.5" max="20" required className="num" /></Field>
          <Button disabled={busy || !d.classId}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'register'} onClose={() => setDrawer(null)} title={tr('col.register')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); const ids = Object.keys(f).filter(k => k.startsWith('cs_')).map(k => k.slice(3)); run(async () => { const r = await api<{ credits: number; ceiling: number | null; registered: { subject: string }[]; alreadyRegistered: string[] }>('/api/college/registrations', { method: 'POST', json: { studentId: f.studentId, termId: d.termId, classSubjectIds: ids } }); setMsg(`${num(r.registered.length)} ${tr('col.added')} · ${num(r.credits)} ${tr('col.credits').toLowerCase()}${r.ceiling == null ? '' : ` / ${num(r.ceiling)}`}${r.alreadyRegistered.length ? ` · ${tr('col.alreadyOn')}: ${r.alreadyRegistered.join(', ')}` : ''}`); }); }}>
          <Field label={tr('nav.students')} hint={String(d.classes.find(c => String(c.id) === d.classId)?.name ?? '')}><Select name="studentId" required placeholder="—" options={classStudents.map(s => ({ value: String(s.id), label: `${s.admission_no} · ${name(s)}` }))} /></Field>
          <div className="grid gap-1 text-sm">
            {d.subjects.map(s => <label key={String(s.id)} className="flex items-center gap-2"><input type="checkbox" name={`cs_${s.id}`} /> {String(s.subject_name)} · {num(s.credit)}</label>)}
            {d.subjects.length === 0 && <span className="text-xs" style={{ color: 'var(--muted)' }}>{tr('col.noSubjects')}</span>}
          </div>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('col.registerNote')}</p>
          <Button disabled={busy || !d.termId}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'result'} onClose={() => setDrawer(null)} title={resultFor?.name ?? tr('col.enterResult')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(async () => { const r = await api<{ grade: string; gradePoint: number; creditEarned: number }>(`/api/college/registrations/${resultFor?.id}/result`, { method: 'POST', json: { percent: Number(f.percent) } }); setMsg(`${r.grade} · ${num(r.gradePoint)} · ${num(r.creditEarned)} ${tr('col.credits').toLowerCase()}`); }); }}>
          <Field label="%"><Input name="percent" type="number" step="0.01" min="0" max="100" required className="num" /></Field>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('col.resultNote')}</p>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'sale'} onClose={() => setDrawer(null)} title={tr('col.sell')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api('/api/college/sales', { method: 'POST', json: { courseId: f.courseId, studentId: f.studentId, price: Number(f.price) || undefined, count: Number(f.count) || undefined, firstDue: f.firstDue || undefined } })); }}>
          <Field label={tr('lrn.course')}><Select name="courseId" required placeholder="—" options={d.courses.filter(c => Number(c.is_paid)).map(c => ({ value: String(c.id), label: `${c.title}${c.price ? ` · ${money(c.price)}` : ''}` }))} /></Field>
          <Field label={tr('nav.students')}><Select name="studentId" required placeholder="—" options={studentOptions} /></Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label={tr('fee.amount')} hint={tr('col.priceHint')}><Input name="price" type="number" step="0.01" min="1" className="num" /></Field>
            <Field label={tr('fee.instalmentCount')}><Input name="count" type="number" min="2" max="24" defaultValue={3} className="num" /></Field>
            <Field label={tr('fee.firstDue')}><Input name="firstDue" type="date" /></Field>
          </div>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('col.saleNote')}</p>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'department'} onClose={() => setDrawer(null)} title={tr('col.newDepartment')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api('/api/college/departments', { method: 'POST', json: { name: f.name, kind: f.kind } })); }}>
          <Field label={tr('common.name')}><Input name="name" required /></Field>
          <Field label={tr('common.type')}><Select name="kind" options={['academic', 'admin', 'support'].map(k => ({ value: k, label: k }))} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'head'} onClose={() => setDrawer(null)} title={headFor?.name ?? tr('col.setHead')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api(`/api/college/departments/${headFor?.id}/head`, { method: 'POST', json: { staffId: f.staffId || null } })); }}>
          <Field label={tr('col.head')} hint={tr('col.headHint')}><Select name="staffId" placeholder={tr('inst.nobody')} options={d.staff.map(s => ({ value: String(s.id), label: `${s.employee_no ?? ''} · ${name(s)}` }))} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
    </div>
  );
}
