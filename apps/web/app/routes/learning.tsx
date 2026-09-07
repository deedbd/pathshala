import { useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/learning';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Kpi, Select, Tabs, api, formatDate, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

/** A pick that needs server data is a search param, so a reload — or a shared link — lands on the same view. */
const soft = <T,>(p: Promise<T>) => p.catch(() => null);

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id;
  const url = new URL(request.url);
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
  // the year-5 half: threads and the watch report follow the chosen course, the revision plan the
  // chosen child, the class gaps the chosen class subject. Each is soft — a school with no term or
  // no competency ratings yet must still get the rest of the page.
  const courseId = url.searchParams.get('courseId') || (courses[0] ? String(courses[0].id) : null);
  const studentId = url.searchParams.get('studentId') || null;
  const classSubjectId = url.searchParams.get('classSubjectId') || null;
  const [threads, watch, classSubjects, roll, gaps, plan] = await Promise.all([
    courseId ? soft(context.app.lms.threads(sid, { courseId }, { userId: user.id, isStaff: true })) : null,
    courseId ? soft(context.app.lms.watchReport(sid, courseId)) : null,
    yearId ? context.app.academic.classSubjects(sid, yearId) : [],
    context.app.people.students(sid, { limit: 200 }),
    classSubjectId ? soft(context.app.adaptive.classGaps(sid, { classSubjectId })) : null,
    studentId ? soft(context.app.adaptive.revisionPlan(sid, studentId)) : null,
  ]);
  return {
    locale: (user.locale as Locale) || context.locale, courses, assignments, classes, incidents, categories, actions, surveys, newsletters, events, clubs, houses, sections,
    courseId, studentId, classSubjectId, threads, watch, classSubjects, students: roll.rows, gaps, plan,
  };
}
export function meta() { return [{ title: 'Pathshala — Learning & welfare' }]; }

type Similarity = {
  assignmentId: string; title: string; checked: number; reportAt: number; minWords: number; highestPct: number; truncated: string | null; note: string;
  pairs: { similarityPct: number; a: { submissionId: string; name: string; roll: string | null }; b: { submissionId: string; name: string; roll: string | null }; sharedPhrases: string[] }[];
  skipped: { submissionId: string; name: string; words: number; reason: string }[];
};

export default function Learning() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator(); const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<'courses' | 'assignments' | 'discussions' | 'adaptive' | 'welfare' | 'engagement'>('courses');
  const [drawer, setDrawer] = useState<null | 'course' | 'assignment' | 'class' | 'incident' | 'survey' | 'event' | 'thread' | 'similarity'>(null);
  const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [watchOpen, setWatchOpen] = useState(false);
  const [sim, setSim] = useState<Similarity | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setDrawer(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); n.set(k, v); setSp(n); };
  const openTickets = d.actions.filter(a => String(a.status) === 'pending').length;
  const threads = d.threads?.threads ?? [];
  // a thread counts as answered when the question itself or any of its replies was marked
  const answered = (post: { isAnswer: boolean; replies: { isAnswer: boolean }[] }) => post.isAnswer || post.replies.some(r => r.isAnswer);

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
        { key: 'discussions', label: tr('lrn.discussions'), count: threads.length },
        { key: 'adaptive', label: tr('lrn.adaptive') },
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
          { key: 'watch', label: '', render: r => <Button size="sm" variant="secondary" onClick={() => { setParam('courseId', String(r.id)); setWatchOpen(true); }}>{tr('lrn.watchReport')}</Button> },
          { key: 'id', label: '', render: r => String(r.status) === 'published' ? null : <Button size="sm" onClick={() => run(async () => { const x = await api<{ enrolled: number }>(`/api/lms/courses/${r.id}/publish`, { method: 'POST', json: {} }); setMsg(`${x.enrolled} ${tr('lrn.enrolled')}`); })}>{tr('lrn.publish')}</Button> },
        ]} />

        {watchOpen && <div className="mt-4 card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg">{tr('lrn.watchReport')}{d.watch ? ` — ${d.watch.title}` : ''}</h2>
            <Button size="sm" variant="ghost" onClick={() => setWatchOpen(false)}>{tr('common.cancel')}</Button>
          </div>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('lrn.watchNote')}{d.watch ? ` · ${tr('lrn.countsAt')} ${d.watch.requiredPct}%` : ''}</p>
          {d.watch && <>
            <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-3">
              <Kpi label={tr('lrn.enrolled')} value={d.watch.enrolled} locale={d.locale} />
              <Kpi label={tr('lrn.lessons')} value={d.watch.lessons.length} locale={d.locale} />
              <Kpi label={tr('lrn.watched')} value={d.watch.lessons.reduce((a, l) => a + l.completed, 0)} locale={d.locale} />
            </div>
            <div className="mt-3"><DataTable locale={d.locale} searchable={false} rows={d.watch.lessons.map(l => ({ id: l.lessonId, ...l }))} columns={[
              { key: 'title', label: tr('lrn.lesson') },
              { key: 'lessonType', label: tr('common.type') },
              { key: 'durationMin', label: tr('lrn.runTime'), className: 'num', render: r => r.durationMin == null ? '—' : `${r.durationMin} ${tr('lrn.minutes')}` },
              { key: 'started', label: tr('lrn.started'), className: 'num' },
              { key: 'completed', label: tr('lrn.watched'), className: 'num' },
              { key: 'notStarted', label: tr('lrn.notStarted'), className: 'num' },
              { key: 'avgWatchedPct', label: tr('lrn.avgWatched'), className: 'num', render: r => r.avgWatchedPct == null ? '—' : <Chip status={r.avgWatchedPct >= 85 ? 'active' : r.avgWatchedPct >= 40 ? 'pending' : 'failed'}>{`${r.avgWatchedPct}%`}</Chip> },
            ]} /></div>
          </>}
        </div>}

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
          { key: 'similarity', label: '', render: r => <Button size="sm" variant="secondary" disabled={busy} onClick={async () => {
            setBusy(true); setErr(null);
            try { setSim(await api<Similarity>(`/api/lms/assignments/${r.id}/similarity`, { method: 'POST', json: {} })); setDrawer('similarity'); }
            catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
          }}>{tr('lrn.checkSimilarity')}</Button> },
        ]} />
      </div>}

      {tab === 'discussions' && <div className="mt-4">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-[240px]"><Field label={tr('lrn.pickCourse')}><Select value={d.courseId ?? ''} onChange={e => setParam('courseId', e.target.value)} options={d.courses.map(c => ({ value: String(c.id), label: String(c.title) }))} /></Field></div>
          <Button size="sm" disabled={!d.courseId} onClick={() => { setReplyTo(null); setDrawer('thread'); }}>{tr('lrn.newThread')}</Button>
        </div>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('lrn.discussionsNote')}</p>
        <div className="mt-3 grid gap-3">
          {threads.map(th => <div key={th.id} className="card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <strong>{th.author}</strong>
              <span className="text-xs" style={{ color: 'var(--muted)' }}>{formatDate(th.createdAt, d.locale)}</span>
              <Chip status={answered(th) ? 'active' : 'pending'}>{answered(th) ? tr('lrn.answered') : tr('lrn.unanswered')}</Chip>
              <span className="ml-auto text-xs" style={{ color: 'var(--muted)' }}>▲ {th.upvotes}</span>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm">{th.body}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => api(`/api/lms/discussions/${th.id}/upvote`, { method: 'POST', json: {} }))}>{tr('lrn.upvote')}</Button>
              <Button size="sm" variant="secondary" onClick={() => { setReplyTo(th.id); setDrawer('thread'); }}>{tr('lrn.reply')}</Button>
            </div>
            {th.replies.length > 0 && <ul className="mt-3 grid gap-3 border-l pl-3" style={{ borderColor: 'var(--line)' }}>
              {th.replies.map(rp => <li key={rp.id}>
                <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
                  <strong style={{ color: 'var(--ink)' }}>{rp.author}</strong>
                  <span>{formatDate(rp.createdAt, d.locale)}</span>
                  <span>▲ {rp.upvotes}</span>
                  {rp.isAnswer && <Chip status="active">{tr('lrn.answered')}</Chip>}
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm">{rp.body}</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => api(`/api/lms/discussions/${rp.id}/upvote`, { method: 'POST', json: {} }))}>{tr('lrn.upvote')}</Button>
                  {!rp.isAnswer && <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => api(`/api/lms/discussions/${rp.id}/answer`, { method: 'POST', json: {} }))}>{tr('lrn.markAnswer')}</Button>}
                </div>
              </li>)}
            </ul>}
          </div>)}
          {threads.length === 0 && <div className="card p-6 text-center text-sm" style={{ color: 'var(--muted)' }}>{tr('lrn.noThreads')}</div>}
        </div>
      </div>}

      {tab === 'adaptive' && <div className="mt-4">
        <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('lrn.adaptiveNote')}</p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="min-w-[240px]"><Field label={tr('lrn.pickClassSubject')}><Select value={d.classSubjectId ?? ''} placeholder={tr('lrn.pickClassSubject')} onChange={e => setParam('classSubjectId', e.target.value)} options={d.classSubjects.map(cs => ({ value: String(cs.id), label: `${cs.class_name} — ${cs.subject_name}` }))} /></Field></div>
          <div className="min-w-[240px]"><Field label={tr('lrn.pickStudent')}><Select value={d.studentId ?? ''} placeholder={tr('lrn.pickStudent')} onChange={e => setParam('studentId', e.target.value)} options={d.students.map(s => ({ value: String(s.id), label: `${s.first_name} ${s.last_name ?? ''} — ${s.class_name ?? ''} ${s.section_name ?? ''}`.trim() }))} /></Field></div>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => {
            const x = await api<{ planned: number; sent: number; skipped: number; reason?: string }>('/api/adaptive/run', { method: 'POST', json: {} });
            setMsg(x.reason ?? `${x.planned} ${tr('lrn.plansBuilt')} · ${x.sent} ${tr('lrn.planSent')}`);
          })}>{tr('lrn.runAdaptive')}</Button>
        </div>

        <h2 className="mt-6 text-lg">{tr('lrn.classGaps')}</h2>
        {d.gaps && <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('lrn.term')}: {d.gaps.term} · {d.gaps.students} {tr('lrn.students')}</p>}
        <div className="mt-2"><DataTable locale={d.locale} searchable={false} rows={(d.gaps?.outcomes ?? []).map(o => ({ id: o.outcomeId, ...o }))} columns={[
          { key: 'code', label: tr('lrn.indicator'), render: r => <span title={r.statement}>{r.code} — {r.statement}</span> },
          { key: 'unitTitle', label: tr('lrn.unit'), render: r => r.unitTitle ?? '—' },
          { key: 'assessed', label: tr('lrn.rated'), className: 'num' },
          { key: 'notMet', label: tr('lrn.notMet'), className: 'num', render: r => <Chip status={r.notMetPct >= 50 ? 'failed' : 'pending'}>{`${r.notMet} (${r.notMetPct}%)`}</Chip> },
          { key: 'teaches', label: tr('lrn.teaches'), render: r => r.covered ? r.teaches.map(x => x.title).join(', ') : <Chip status="failed">{tr('lrn.nothingCovers')}</Chip> },
          { key: 'gap', label: tr('lrn.gaps'), render: r => r.gap ?? '—' },
        ]} /></div>

        <h2 className="mt-6 text-lg">{tr('lrn.revisionPlan')}</h2>
        {d.plan ? <div className="mt-2 card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <strong>{d.plan.name}</strong>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>{tr('lrn.term')}: {d.plan.term} · {tr('lrn.rated')} {d.plan.assessed} · {tr('lrn.met')} {d.plan.met} · {tr('lrn.covered')} {d.plan.covered} · {tr('lrn.nothingCovers')} {d.plan.uncovered}</div>
            </div>
            <Button size="sm" disabled={busy || !d.plan.indicators.length} onClick={() => run(async () => {
              const x = await api<{ sent: number; reason?: string }>(`/api/adaptive/plan/${d.studentId}/push`, { method: 'POST', json: {} });
              setMsg(x.reason ?? `${x.sent} ${tr('lrn.planSent')}`);
            })}>{tr('lrn.pushPlan')}</Button>
          </div>
          {d.plan.note && <div className="mt-3"><Banner kind="info">{d.plan.note}</Banner></div>}
          <ul className="mt-3 grid gap-3">
            {d.plan.indicators.map(i => <li key={i.outcomeId} className="border-t pt-3" style={{ borderColor: 'var(--line)' }}>
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-sm">{i.code}</strong>
                <span className="text-sm">{i.statement}</span>
                <Chip status={i.covered ? 'active' : 'failed'}>{i.covered ? tr('lrn.covered') : tr('lrn.nothingCovers')}</Chip>
              </div>
              <div className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{i.subject} · {i.label} · {i.unitTitle ?? '—'}</div>
              {i.covered
                ? <div className="mt-1 text-sm">{tr('lrn.teaches')}: {[...i.lessons, ...i.quizzes, ...i.materials].map(x => x.title).join(', ')}</div>
                : <div className="mt-1 text-sm" style={{ color: 'var(--bad)' }}>{i.gap}</div>}
            </li>)}
          </ul>
        </div> : <div className="mt-2 card p-6 text-center text-sm" style={{ color: 'var(--muted)' }}>{tr('lrn.pickStudentHint')}</div>}
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

      <Drawer open={drawer === 'thread'} onClose={() => setDrawer(null)} title={replyTo ? tr('lrn.reply') : tr('lrn.newThread')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/lms/discussions', { method: 'POST', json: replyTo ? { parentId: replyTo, body: f.body } : { courseId: d.courseId, body: f.body } })); }}>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{d.threads?.courseTitle ?? ''}</p>
          <Field label={tr('lrn.threadBody')}><textarea name="body" className="input" rows={5} required maxLength={20000} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'similarity'} onClose={() => setDrawer(null)} title={tr('lrn.similarity')}>
        {sim && <div className="grid gap-3">
          <Banner kind="warn">{tr('lrn.similarityNote')}</Banner>
          <p className="text-sm"><strong>{sim.title}</strong></p>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{sim.checked} {tr('lrn.compared')} · {tr('lrn.similarityPct')} ≥ {sim.reportAt}%</p>
          {sim.truncated && <Banner kind="info">{sim.truncated}</Banner>}
          {sim.pairs.length === 0 && <Banner kind="ok">{tr('lrn.noPairs')}</Banner>}
          {sim.pairs.map(p => <div key={`${p.a.submissionId}-${p.b.submissionId}`} className="card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Chip status={p.similarityPct >= 60 ? 'failed' : 'pending'}>{`${p.similarityPct}%`}</Chip>
              <span className="text-sm">{p.a.name}{p.a.roll ? ` (${p.a.roll})` : ''} · {p.b.name}{p.b.roll ? ` (${p.b.roll})` : ''}</span>
            </div>
            {p.sharedPhrases.length > 0 && <div className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('lrn.sharedPhrases')}: {p.sharedPhrases.map(s => `“${s}”`).join(' · ')}</div>}
          </div>)}
          {sim.skipped.length > 0 && <div className="text-xs" style={{ color: 'var(--muted)' }}>{tr('lrn.tooShort')}: {sim.skipped.map(s => s.name).join(', ')}</div>}
        </div>}
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
