import { useState } from 'react';
import { useLoaderData, useRevalidator } from 'react-router';
import type { Route } from './+types/learning';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Kpi, Select, Tabs, api, formatDate, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id;
  const year = await context.app.academic.currentYear(sid);
  const yearId = year ? String(year.id) : null;
  const [courses, assignments, classes, incidents, categories, actions, surveys, newsletters, events, clubs, sections] = await Promise.all([
    context.app.lms.courses(sid), context.app.lms.assignments(sid), context.app.lms.onlineClasses(sid),
    context.app.welfare.incidents(sid), context.app.welfare.categories(sid), context.app.welfare.actions(sid),
    context.app.engagement.surveys(sid), context.app.engagement.newsletters(sid), context.app.engagement.events(sid),
    context.app.engagement.clubs(sid),
    yearId ? context.app.db.query(`SELECT s.id, s.name, c.name AS class_name FROM sections s JOIN classes c ON c.id = s.class_id WHERE s.school_id = ? AND s.academic_year_id = ? ORDER BY c.numeric_level, s.name LIMIT 200`, [sid, yearId]) : [],
  ]);
  const houses = await context.app.engagement.houseTable(sid);
  return { locale: (user.locale as Locale) || context.locale, courses, assignments, classes, incidents, categories, actions, surveys, newsletters, events, clubs, houses, sections };
}
export function meta() { return [{ title: 'Pathshala — Learning & welfare' }]; }

export default function Learning() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<'courses' | 'assignments' | 'welfare' | 'engagement'>('courses');
  const [drawer, setDrawer] = useState<null | 'course' | 'assignment' | 'class' | 'incident' | 'survey' | 'event'>(null);
  const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setDrawer(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const openTickets = d.actions.filter(a => String(a.status) === 'pending').length;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('lrn.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('lrn.purpose')}</p></div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label={tr('lrn.courses')} value={d.courses.length} locale={d.locale} />
        <Kpi label={tr('lrn.assignments')} value={d.assignments.length} locale={d.locale} />
        <Kpi label={tr('lrn.liveClasses')} value={d.classes.length} locale={d.locale} />
        <Kpi label={tr('lrn.incidents')} value={d.incidents.length} locale={d.locale} />
        <Kpi label={tr('lrn.pendingActions')} value={openTickets} locale={d.locale} />
      </div>
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      {msg && <div className="mt-4"><Banner kind="ok">{msg}</Banner></div>}

      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[
        { key: 'courses', label: tr('lrn.courses'), count: d.courses.length },
        { key: 'assignments', label: tr('lrn.assignments'), count: d.assignments.length },
        { key: 'welfare', label: tr('lrn.welfare'), count: d.incidents.length },
        { key: 'engagement', label: tr('lrn.engagement'), count: d.surveys.length + d.events.length },
      ]} /></div>

      {tab === 'courses' && <div className="mt-4">
        <div className="mb-3 flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setDrawer('class')}>{tr('lrn.newClass')}</Button>
          <Button size="sm" onClick={() => setDrawer('course')}>{tr('lrn.newCourse')}</Button>
        </div>
        <DataTable locale={d.locale} rows={d.courses} columns={[
          { key: 'title', label: tr('lrn.course') },
          { key: 'lessons', label: tr('lrn.lessons'), className: 'num' },
          { key: 'students', label: tr('lrn.students'), className: 'num' },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'published' ? 'active' : 'pending'}>{String(r.status)}</Chip> },
          { key: 'id', label: '', render: r => String(r.status) === 'published' ? null : <Button size="sm" onClick={() => run(async () => { const x = await api<{ enrolled: number }>(`/api/lms/courses/${r.id}/publish`, { method: 'POST', json: {} }); setMsg(`${x.enrolled} ${tr('lrn.enrolled')}`); })}>{tr('lrn.publish')}</Button> },
        ]} />
        <h2 className="mt-6 text-lg">{tr('lrn.liveClasses')}</h2>
        <DataTable locale={d.locale} rows={d.classes} columns={[
          { key: 'title', label: tr('common.name') },
          { key: 'section_name', label: tr('common.section') },
          { key: 'starts_at', label: tr('lrn.starts'), render: r => String(r.starts_at).slice(0, 16) },
          { key: 'join_url', label: tr('lrn.join'), render: r => r.join_url ? <a href={String(r.join_url)} target="_blank" rel="noreferrer" className="underline">{tr('lrn.join')}</a> : '—' },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'ended' ? 'active' : 'pending'}>{String(r.status)}</Chip> },
        ]} />
      </div>}

      {tab === 'assignments' && <div className="mt-4">
        <div className="mb-3 flex justify-end"><Button size="sm" onClick={() => setDrawer('assignment')}>{tr('lrn.newAssignment')}</Button></div>
        <DataTable locale={d.locale} rows={d.assignments} columns={[
          { key: 'title', label: tr('common.name') },
          { key: 'section_name', label: tr('common.section') },
          { key: 'subject_name', label: tr('common.subject') },
          { key: 'due_at', label: tr('lrn.due'), render: r => String(r.due_at).slice(0, 16) },
          { key: 'submissions', label: tr('lrn.handedIn'), className: 'num' },
          { key: 'max_marks', label: tr('ex.fullMarks'), className: 'num' },
        ]} />
      </div>}

      {tab === 'welfare' && <div className="mt-4">
        <div className="mb-3 flex justify-end"><Button size="sm" onClick={() => setDrawer('incident')}>{tr('lrn.newIncident')}</Button></div>
        <DataTable locale={d.locale} rows={d.incidents} columns={[
          { key: 'incident_date', label: tr('common.date'), render: r => formatDate(String(r.incident_date).slice(0, 10), d.locale) },
          { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` },
          { key: 'category_name', label: tr('lrn.category') },
          { key: 'points', label: tr('lrn.points'), className: 'num', render: r => <Chip status={Number(r.points) >= 0 ? 'active' : 'failed'}>{String(r.points)}</Chip> },
          { key: 'severity', label: tr('lrn.severity') },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'closed' ? 'active' : 'pending'}>{String(r.status)}</Chip> },
        ]} />
        <h2 className="mt-6 text-lg">{tr('lrn.actions')}</h2>
        <DataTable locale={d.locale} rows={d.actions} columns={[
          { key: 'action_type', label: tr('lrn.action'), render: r => String(r.action_type).replace(/_/g, ' ') },
          { key: 'is_auto_proposed', label: tr('lrn.proposedBy'), render: r => Number(r.is_auto_proposed) ? <Chip status="active">{tr('ops.automatic')}</Chip> : tr('ops.byHand') },
          { key: 'from_date', label: tr('common.date'), render: r => r.from_date ? formatDate(String(r.from_date).slice(0, 10), d.locale) : '—' },
          { key: 'guardian_acknowledged_at', label: tr('lrn.acknowledged'), render: r => <Chip status={r.guardian_acknowledged_at ? 'active' : 'pending'}>{r.guardian_acknowledged_at ? tr('ops.given') : tr('ops.waiting')}</Chip> },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'approved' ? 'active' : 'pending'}>{String(r.status)}</Chip> },
          { key: 'id', label: '', render: r => String(r.status) === 'pending' ? <Button size="sm" onClick={() => run(() => api(`/api/welfare/actions/${r.id}/approve`, { method: 'POST', json: {} }))}>{tr('ops.approve')}</Button> : null },
        ]} />
      </div>}

      {tab === 'engagement' && <div className="mt-4">
        <div className="mb-3 flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setDrawer('event')}>{tr('lrn.newEvent')}</Button>
          <Button size="sm" onClick={() => setDrawer('survey')}>{tr('lrn.newSurvey')}</Button>
        </div>
        <DataTable locale={d.locale} rows={d.surveys} columns={[
          { key: 'title', label: tr('lrn.survey') },
          { key: 'is_anonymous', label: tr('lrn.anonymous'), render: r => Number(r.is_anonymous) ? tr('common.yes') : tr('common.no') },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'open' ? 'active' : 'pending'}>{String(r.status)}</Chip> },
          { key: 'id', label: '', render: r => String(r.status) === 'draft'
            ? <Button size="sm" onClick={() => run(async () => { const x = await api<{ asked: number }>(`/api/engagement/surveys/${r.id}/open`, { method: 'POST', json: {} }); setMsg(`${x.asked} ${tr('lrn.asked')}`); })}>{tr('lrn.ask')}</Button>
            : <Button size="sm" variant="secondary" onClick={() => run(async () => { const x = await api<{ responses: number }>(`/api/engagement/surveys/${r.id}/results`); setMsg(`${x.responses} ${tr('lrn.responses')}`); })}>{tr('lrn.results')}</Button> },
        ]} />
        <h2 className="mt-6 text-lg">{tr('lrn.events')}</h2>
        <DataTable locale={d.locale} rows={d.events} columns={[
          { key: 'title', label: tr('common.name') },
          { key: 'event_type', label: tr('common.type') },
          { key: 'starts_at', label: tr('lrn.starts'), render: r => String(r.starts_at).slice(0, 16) },
          { key: 'coming', label: tr('lrn.coming'), className: 'num' },
          { key: 'tickets', label: tr('lrn.tickets'), className: 'num' },
          { key: 'id', label: '', render: r => <Button size="sm" variant="secondary" onClick={() => run(async () => { const x = await api<{ told: number }>(`/api/engagement/events/${r.id}/announce`, { method: 'POST', json: {} }); setMsg(`${x.told} ${tr('lrn.told')}`); })}>{tr('lrn.announce')}</Button> },
        ]} />
        <h2 className="mt-6 text-lg">{tr('lrn.houses')}</h2>
        <DataTable locale={d.locale} rows={d.houses} columns={[{ key: 'name', label: tr('common.name') }, { key: 'points', label: tr('lrn.points'), className: 'num' }]} />
      </div>}

      <Drawer open={drawer === 'course'} onClose={() => setDrawer(null)} title={tr('lrn.newCourse')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/lms/courses', { method: 'POST', json: { title: f.title, description: f.description } })); }}>
          <Field label={tr('lrn.course')}><Input name="title" required /></Field>
          <Field label={tr('common.description')}><textarea name="description" className="input" rows={4} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'assignment'} onClose={() => setDrawer(null)} title={tr('lrn.newAssignment')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/lms/assignments', { method: 'POST', json: { sectionId: f.sectionId, classSubjectId: f.classSubjectId, title: f.title, description: f.description, dueAt: `${f.dueAt} 23:59:00`, maxMarks: Number(f.maxMarks || 20), latePenaltyPct: Number(f.latePenaltyPct || 10) } })); }}>
          <Field label={tr('common.name')}><Input name="title" required /></Field>
          <Field label={tr('common.section')}><Select name="sectionId" required options={d.sections.map(s => ({ value: String(s.id), label: `${s.class_name} ${s.name}` }))} /></Field>
          <Field label={tr('lrn.classSubjectId')} hint={tr('lrn.classSubjectHint')}><Input name="classSubjectId" required /></Field>
          <div className="grid grid-cols-3 gap-3"><Field label={tr('lrn.due')}><Input name="dueAt" type="date" required /></Field><Field label={tr('ex.fullMarks')}><Input name="maxMarks" type="number" className="num" defaultValue="20" /></Field><Field label={tr('lrn.latePenalty')}><Input name="latePenaltyPct" type="number" className="num" defaultValue="10" /></Field></div>
          <Field label={tr('common.description')}><textarea name="description" className="input" rows={3} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'class'} onClose={() => setDrawer(null)} title={tr('lrn.newClass')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(async () => { const x = await api<{ joinUrl: string }>('/api/lms/classes', { method: 'POST', json: { sectionId: f.sectionId, title: f.title, startsAt: `${f.date} ${f.time}:00`, durationMin: Number(f.durationMin || 40) } }); setMsg(x.joinUrl ?? tr('common.saved')); }); }}>
          <Field label={tr('common.name')}><Input name="title" required placeholder="Algebra revision" /></Field>
          <Field label={tr('common.section')}><Select name="sectionId" required options={d.sections.map(s => ({ value: String(s.id), label: `${s.class_name} ${s.name}` }))} /></Field>
          <div className="grid grid-cols-3 gap-3"><Field label={tr('common.date')}><Input name="date" type="date" required /></Field><Field label={tr('lrn.starts')}><Input name="time" type="time" required /></Field><Field label={tr('lrn.minutes')}><Input name="durationMin" type="number" className="num" defaultValue="40" /></Field></div>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('lrn.jitsiHint')}</p>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'incident'} onClose={() => setDrawer(null)} title={tr('lrn.newIncident')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/welfare/incidents', { method: 'POST', json: { studentId: f.studentId, categoryId: f.categoryId, description: f.description } })); }}>
          <Field label={tr('doc.studentId')} hint={tr('doc.studentIdHint')}><Input name="studentId" required /></Field>
          <Field label={tr('lrn.category')}><Select name="categoryId" required options={d.categories.map(c => ({ value: String(c.id), label: `${c.name} (${Number(c.default_points) > 0 ? '+' : ''}${c.default_points})` }))} /></Field>
          <Field label={tr('common.description')}><textarea name="description" className="input" rows={3} required /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'survey'} onClose={() => setDrawer(null)} title={tr('lrn.newSurvey')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/engagement/surveys', { method: 'POST', json: { title: f.title, isAnonymous: f.isAnonymous === 'on', questions: f.questions.split('\n').filter(Boolean).map((q, i) => ({ key: `q${i + 1}`, label: q.trim(), type: 'rating' })) } })); }}>
          <Field label={tr('lrn.survey')}><Input name="title" required /></Field>
          <Field label={tr('lrn.questions')} hint={tr('lrn.questionsHint')}><textarea name="questions" className="input" rows={5} required /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isAnonymous" /> {tr('lrn.anonymous')}</label>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'event'} onClose={() => setDrawer(null)} title={tr('lrn.newEvent')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/engagement/events', { method: 'POST', json: { title: f.title, eventType: f.eventType, startsAt: `${f.date} ${f.time}:00`, venue: f.venue, rsvpRequired: f.rsvpRequired === 'on', ticketLimit: f.ticketLimit ? Number(f.ticketLimit) : null } })); }}>
          <Field label={tr('common.name')}><Input name="title" required /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('common.type')}><Select name="eventType" options={['sports', 'cultural', 'ptm', 'seminar', 'trip', 'ceremony', 'competition', 'workshop', 'other'].map(v => ({ value: v, label: v }))} /></Field><Field label={tr('ops.badge')}><Input name="ticketLimit" type="number" className="num" placeholder={tr('lrn.ticketLimit')} /></Field></div>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('common.date')}><Input name="date" type="date" required /></Field><Field label={tr('lrn.starts')}><Input name="time" type="time" required /></Field></div>
          <Field label={tr('adm.venue')}><Input name="venue" /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="rsvpRequired" /> {tr('lrn.rsvp')}</label>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
    </div>
  );
}
