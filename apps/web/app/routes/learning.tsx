import { useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/learning';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Kpi, Select, Tabs, api, formatDate, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

/** A pick that needs server data is a search param, so a reload — or a shared link — lands on the same view. */
const soft = <T,>(p: Promise<T>) => p.catch(() => null);
/**
 * A JSON column comes back parsed on MySQL and Postgres and as text on SQLite. The page must not
 * care which engine the school is on, so every JSON value is read through here.
 */
function parsed<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return fallback; } }
  return v as T;
}

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
  // the welfare half: the clinic's day book, the counselling register (never its notes), the
  // thresholds the nightly pass measures against, and one child's health record when one is picked
  const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
  const healthStudentId = url.searchParams.get('healthStudentId') || null;
  const [materials, clinic, counselling, behaviourRules, health] = await Promise.all([
    context.app.lms.materials(sid, {}),
    context.app.welfare.clinicVisits(sid, { onDate: date }),
    context.app.welfare.counsellingSessions(sid),
    context.app.welfare.behaviourRules(sid),
    healthStudentId ? soft(context.app.welfare.health(sid, healthStudentId)) : null,
  ]);
  return {
    locale: (user.locale as Locale) || context.locale, courses, assignments, classes, incidents, categories, actions, surveys, newsletters, events, clubs, houses, sections,
    courseId, studentId, classSubjectId, threads, watch, classSubjects, students: roll.rows, gaps, plan,
    date, healthStudentId, materials, clinic, counselling, behaviourRules, health,
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
  const [tab, setTab] = useState<'courses' | 'assignments' | 'materials' | 'discussions' | 'adaptive' | 'welfare' | 'engagement'>('courses');
  const [drawer, setDrawer] = useState<null | 'course' | 'assignment' | 'class' | 'incident' | 'survey' | 'event' | 'thread' | 'similarity' | 'material' | 'submissions' | 'clinic' | 'counselling' | 'health' | 'vaccination' | 'notes'>(null);
  const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [watchOpen, setWatchOpen] = useState(false);
  const [sim, setSim] = useState<Similarity | null>(null);
  const [subs, setSubs] = useState<{ title: string; rows: Record<string, unknown>[] } | null>(null);
  // the decrypted words live only in this drawer, for the counsellor who owns the session, and are
  // dropped the moment it is closed. The list they came from never carried them.
  const [notes, setNotes] = useState<{ id: string; name: string; notes: string | null } | null>(null);
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
        { key: 'materials', label: tr('lrn.materials'), count: d.materials.length },
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
          { key: 'submissions_btn', label: '', render: r => <Button size="sm" variant="secondary" disabled={busy} onClick={async () => {
            setBusy(true); setErr(null);
            try { setSubs({ title: String(r.title), rows: await api<Record<string, unknown>[]>(`/api/lms/assignments/${r.id}/submissions`) }); setDrawer('submissions'); }
            catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
          }}>{tr('lrn.submissions')}</Button> },
          { key: 'similarity', label: '', render: r => <Button size="sm" variant="secondary" disabled={busy} onClick={async () => {
            setBusy(true); setErr(null);
            try { setSim(await api<Similarity>(`/api/lms/assignments/${r.id}/similarity`, { method: 'POST', json: {} })); setDrawer('similarity'); }
            catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
          }}>{tr('lrn.checkSimilarity')}</Button> },
        ]} />
      </div>}

      {tab === 'materials' && <div className="mt-4">
        <div className="mb-3 flex justify-end"><Button size="sm" onClick={() => setDrawer('material')}>{tr('lrn.newMaterial')}</Button></div>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('lrn.materialsNote')}</p>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.materials} columns={[
          { key: 'title', label: tr('common.name') },
          { key: 'material_type', label: tr('common.type'), render: r => <Chip>{String(r.material_type)}</Chip> },
          { key: 'section_id', label: tr('common.section'), render: r => { const s = d.sections.find(x => String(x.id) === String(r.section_id)); return s ? `${s.class_name} ${s.name}` : tr('lrn.everySection'); } },
          { key: 'published_at', label: tr('lrn.published'), render: r => formatDate(String(r.published_at).slice(0, 10), d.locale) },
          { key: 'view_count', label: tr('lrn.views'), className: 'num' },
          { key: 'external_url', label: '', render: r => r.external_url
            ? <a className="btn btn-secondary btn-sm" href={String(r.external_url)} target="_blank" rel="noreferrer">{tr('lrn.open')}</a>
            : r.file_id ? <Button size="sm" variant="secondary" onClick={async () => { const u = await api<{ url: string }>(`/api/files/${r.file_id}/url`); window.open(u.url, '_blank'); }}>{tr('common.download')}</Button> : null },
        ]} /></div>
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
        <div className="mb-3 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setDrawer('counselling')}>{tr('lrn.newCounselling')}</Button>
          <Button size="sm" variant="secondary" onClick={() => setDrawer('clinic')}>{tr('lrn.newVisit')}</Button>
          <Button size="sm" onClick={() => setDrawer('incident')}>{tr('lrn.newIncident')}</Button>
        </div>
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

        <h2 className="mt-6 text-lg">{tr('lrn.behaviourRules')}</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('lrn.rulesNote')}</p>
        <div className="mt-2"><DataTable locale={d.locale} searchable={false} rows={d.behaviourRules} columns={[
          { key: 'name', label: tr('lrn.condition') },
          { key: 'threshold_points', label: tr('lrn.threshold'), className: 'num', render: r => `${Number(r.threshold_points)} ${tr('lrn.points').toLowerCase()}` },
          { key: 'window_days', label: tr('lrn.window'), className: 'num', render: r => `${Number(r.window_days)} ${tr('lrn.days')}` },
          { key: 'action_type', label: tr('lrn.action'), render: r => String(r.action_type).replace(/_/g, ' ') },
          { key: 'notify_roles', label: tr('lrn.tells'), render: r => parsed<string[]>(r.notify_roles, []).join(', ') || '—' },
          { key: 'is_active', label: tr('common.status'), render: r => <Chip status={Number(r.is_active) ? 'active' : 'pending'}>{Number(r.is_active) ? tr('lrn.ruleOn') : tr('lrn.ruleOff')}</Chip> },
        ]} /></div>

        <h2 className="mt-6 text-lg">{tr('lrn.clinicVisits')} · {formatDate(d.date, d.locale)}</h2>
        <div className="mt-1 flex flex-wrap items-end gap-3">
          <Input type="date" value={d.date} onChange={e => setParam('date', e.target.value)} className="max-w-[180px]" />
        </div>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.clinic} columns={[
          { key: 'visited_at', label: tr('lrn.time'), render: r => <span className="num">{String(r.visited_at).slice(11, 16)}</span> },
          { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name ?? r.staff_first ?? ''} ${r.last_name ?? r.staff_last ?? ''}`.trim() || String(r.person_type) },
          { key: 'class_name', label: tr('common.class'), render: r => String(r.class_name ?? '—') },
          { key: 'complaint', label: tr('lrn.complaint') },
          { key: 'treatment', label: tr('lrn.treatment'), render: r => String(r.treatment ?? '—') },
          { key: 'medicines_given', label: tr('lrn.medicines'), render: r => parsed<{ name?: string; quantity?: number }[]>(r.medicines_given, []).map(m => `${m.name ?? ''} ×${m.quantity ?? 0}`).join(', ') || '—' },
          { key: 'sent_home', label: tr('lrn.sentHome'), render: r => Number(r.sent_home) ? <Chip status="failed">{tr('lrn.sentHomeYes')}</Chip> : '—' },
          { key: 'guardian_notified_at', label: tr('ops.guardian'), render: r => r.guardian_notified_at ? <Chip status="active">{tr('ops.told')}</Chip> : '—' },
        ]} /></div>

        <h2 className="mt-6 text-lg">{tr('lrn.counselling')}</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('lrn.counsellingNote')}</p>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.counselling} columns={[
          { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}`.trim() },
          { key: 'class_name', label: tr('common.class'), render: r => String(r.class_name ?? '—') },
          { key: 'referral_source', label: tr('lrn.referral'), render: r => String(r.referral_source).replace(/_/g, ' ') },
          { key: 'session_at', label: tr('lrn.session'), render: r => String(r.session_at).slice(0, 16) },
          { key: 'counsellor_first', label: tr('lrn.counsellor'), render: r => `${r.counsellor_first ?? ''} ${r.counsellor_last ?? ''}`.trim() || '—' },
          { key: 'follow_up_at', label: tr('lrn.followUp'), render: r => r.follow_up_at ? String(r.follow_up_at).slice(0, 16) : '—' },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'done' ? 'active' : String(r.status) === 'no_show' ? 'failed' : 'pending'}>{String(r.status).replace(/_/g, ' ')}</Chip> },
          { key: 'has_notes', label: tr('lrn.notes'), render: r => r.has_notes
            ? <Button size="sm" variant="secondary" disabled={busy} onClick={async () => {
              setBusy(true); setErr(null);
              try { const x = await api<{ id: string; notes: string | null }>(`/api/welfare/counselling/${r.id}/notes`); setNotes({ ...x, name: `${r.first_name} ${r.last_name ?? ''}`.trim() }); setDrawer('notes'); }
              catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
            }}>{tr('lrn.readNotes')}</Button>
            : <span style={{ color: 'var(--muted)' }}>{tr('lrn.noNotes')}</span> },
        ]} /></div>

        <h2 className="mt-6 text-lg">{tr('lrn.health')}</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('lrn.healthNote')}</p>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <div className="min-w-[260px]"><Field label={tr('lrn.pickStudent')}><Select value={d.healthStudentId ?? ''} placeholder={tr('lrn.pickStudent')} onChange={e => setParam('healthStudentId', e.target.value)} options={d.students.map(s => ({ value: String(s.id), label: `${s.first_name} ${s.last_name ?? ''} — ${s.class_name ?? ''} ${s.section_name ?? ''}`.trim() }))} /></Field></div>
          <Button size="sm" variant="secondary" disabled={!d.healthStudentId} onClick={() => setDrawer('health')}>{tr('lrn.newHealth')}</Button>
          <Button size="sm" variant="secondary" disabled={!d.healthStudentId} onClick={() => setDrawer('vaccination')}>{tr('lrn.newVaccination')}</Button>
        </div>
        {d.health ? <div className="mt-3 grid gap-4">
          <div>
            <h3 className="text-sm">{tr('lrn.growth')}</h3>
            <div className="mt-1"><DataTable locale={d.locale} searchable={false} rows={d.health.records} columns={[
              { key: 'recorded_on', label: tr('common.date'), render: r => formatDate(String(r.recorded_on).slice(0, 10), d.locale) },
              { key: 'height_cm', label: tr('lrn.height'), className: 'num', render: r => r.height_cm == null ? '—' : String(Number(r.height_cm)) },
              { key: 'weight_kg', label: tr('lrn.weight'), className: 'num', render: r => r.weight_kg == null ? '—' : String(Number(r.weight_kg)) },
              { key: 'bmi', label: 'BMI', className: 'num', render: r => r.bmi == null ? '—' : String(Number(r.bmi)) },
              { key: 'vision_left', label: tr('lrn.vision'), render: r => `${r.vision_left ?? '—'} · ${r.vision_right ?? '—'}` },
              { key: 'dental', label: tr('lrn.dental'), render: r => String(r.dental ?? '—') },
              { key: 'doctor_notes', label: tr('lrn.notes'), render: r => String(r.doctor_notes ?? '—') },
            ]} /></div>
          </div>
          <div>
            <h3 className="text-sm">{tr('lrn.vaccinations')}</h3>
            <div className="mt-1"><DataTable locale={d.locale} searchable={false} rows={d.health.vaccinations} columns={[
              { key: 'vaccine', label: tr('lrn.vaccine') },
              { key: 'dose_no', label: tr('lrn.dose'), className: 'num' },
              { key: 'given_on', label: tr('lrn.givenOn'), render: r => r.given_on ? formatDate(String(r.given_on).slice(0, 10), d.locale) : '—' },
              { key: 'next_due_on', label: tr('lrn.nextDue'), render: r => r.next_due_on ? <Chip status={String(r.next_due_on).slice(0, 10) <= new Date().toISOString().slice(0, 10) ? 'failed' : 'pending'}>{formatDate(String(r.next_due_on).slice(0, 10), d.locale)}</Chip> : <Chip status="active">{tr('lrn.complete')}</Chip> },
            ]} /></div>
          </div>
          <div>
            <h3 className="text-sm">{tr('lrn.clinicVisits')}</h3>
            <div className="mt-1"><DataTable locale={d.locale} searchable={false} rows={d.health.visits} columns={[
              { key: 'visited_at', label: tr('common.date'), render: r => String(r.visited_at).slice(0, 16) },
              { key: 'complaint', label: tr('lrn.complaint') },
              { key: 'treatment', label: tr('lrn.treatment'), render: r => String(r.treatment ?? '—') },
              { key: 'sent_home', label: tr('lrn.sentHome'), render: r => Number(r.sent_home) ? <Chip status="failed">{tr('lrn.sentHomeYes')}</Chip> : '—' },
            ]} /></div>
          </div>
        </div> : <div className="mt-3 card p-6 text-center text-sm" style={{ color: 'var(--muted)' }}>{tr('lrn.pickStudentHint')}</div>}
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

      <Drawer open={drawer === 'material'} onClose={() => setDrawer(null)} title={tr('lrn.newMaterial')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/lms/materials', { method: 'POST', json: { title: f.title, materialType: f.materialType, sectionId: f.sectionId || null, classSubjectId: f.classSubjectId || null, externalUrl: f.externalUrl || null } })); }}>
          <Field label={tr('common.name')}><Input name="title" required /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('common.type')}><Select name="materialType" options={['note', 'slide', 'video', 'link', 'book', 'audio'].map(v => ({ value: v, label: v }))} /></Field>
            <Field label={tr('common.section')} hint={tr('lrn.everySectionHint')}><Select name="sectionId" placeholder={tr('lrn.everySection')} options={d.sections.map(s => ({ value: String(s.id), label: `${s.class_name} ${s.name}` }))} /></Field>
          </div>
          <Field label={tr('common.subject')}><Select name="classSubjectId" placeholder="—" options={d.classSubjects.map(cs => ({ value: String(cs.id), label: `${cs.class_name} — ${cs.subject_name}` }))} /></Field>
          <Field label={tr('lrn.externalUrl')} hint={tr('lrn.externalUrlHint')}><Input name="externalUrl" type="url" maxLength={500} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'submissions'} onClose={() => { setDrawer(null); setSubs(null); }} title={tr('lrn.submissions')}>
        {subs && <div className="grid gap-3">
          <p className="text-sm"><strong>{subs.title}</strong></p>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{subs.rows.length} {tr('lrn.handedIn').toLowerCase()}</p>
          {subs.rows.length === 0 && <Banner kind="info">{tr('lrn.noSubmissions')}</Banner>}
          {subs.rows.map(s => <div key={String(s.id)} className="card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-sm">{`${s.first_name ?? ''} ${s.last_name ?? ''}`.trim()}</strong>
              {s.current_roll_no ? <span className="num text-xs" style={{ color: 'var(--muted)' }}>{String(s.current_roll_no)}</span> : null}
              {Number(s.is_late) ? <Chip status="failed">{tr('lrn.late')}</Chip> : null}
              <Chip status={s.marks == null ? 'pending' : 'active'}>{s.marks == null ? tr('lrn.ungraded') : `${Number(s.marks)}`}</Chip>
              <span className="ml-auto text-xs" style={{ color: 'var(--muted)' }}>{String(s.submitted_at ?? '').slice(0, 16)}</span>
            </div>
            {s.text_answer ? <p className="mt-2 whitespace-pre-wrap text-sm">{String(s.text_answer)}</p> : null}
            {s.feedback ? <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('lrn.feedback')}: {String(s.feedback)}</p> : null}
            <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={e => {
              e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
              setBusy(true); setErr(null);
              api(`/api/lms/submissions/${s.id}/grade`, { method: 'POST', json: { marks: Number(f.marks), feedback: f.feedback || null } })
                .then(() => { setMsg(tr('lrn.graded')); setDrawer(null); setSubs(null); rv.revalidate(); })
                .catch(e2 => setErr((e2 as Error).message)).finally(() => setBusy(false));
            }}>
              <Field label={tr('lrn.marks')} className="max-w-[100px]"><Input name="marks" type="number" step="0.5" className="num" required defaultValue={s.marks == null ? '' : String(Number(s.marks))} /></Field>
              <Field label={tr('lrn.feedback')} className="flex-1"><Input name="feedback" maxLength={4000} defaultValue={String(s.feedback ?? '')} /></Field>
              <Button size="sm" disabled={busy}>{tr('lrn.grade')}</Button>
            </form>
          </div>)}
        </div>}
      </Drawer>

      <Drawer open={drawer === 'notes'} onClose={() => { setDrawer(null); setNotes(null); }} title={tr('lrn.notes')}>
        {notes && <div className="grid gap-3">
          <Banner kind="warn">{tr('lrn.notesPrivate')}</Banner>
          <p className="text-sm"><strong>{notes.name}</strong></p>
          <p className="whitespace-pre-wrap text-sm">{notes.notes ?? tr('lrn.noNotes')}</p>
        </div>}
      </Drawer>

      <Drawer open={drawer === 'clinic'} onClose={() => setDrawer(null)} title={tr('lrn.newVisit')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/welfare/clinic', { method: 'POST', json: { personType: 'student', studentId: f.studentId, complaint: f.complaint, treatment: f.treatment || null, referredTo: f.referredTo || null, sentHome: f.sentHome === 'on' } })); }}>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('lrn.clinicNote')}</p>
          <Field label={tr('lrn.pickStudent')}><Select name="studentId" required placeholder="—" options={d.students.map(s => ({ value: String(s.id), label: `${s.first_name} ${s.last_name ?? ''} — ${s.class_name ?? ''} ${s.section_name ?? ''}`.trim() }))} /></Field>
          <Field label={tr('lrn.complaint')}><Input name="complaint" required maxLength={255} /></Field>
          <Field label={tr('lrn.treatment')}><textarea name="treatment" className="input" rows={3} /></Field>
          <Field label={tr('lrn.referredTo')}><Input name="referredTo" maxLength={160} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="sentHome" /> {tr('lrn.sentHome')}</label>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'counselling'} onClose={() => setDrawer(null)} title={tr('lrn.newCounselling')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/welfare/counselling', { method: 'POST', json: { studentId: f.studentId, referralSource: f.referralSource, sessionAt: f.date ? `${f.date} ${f.time || '09:00'}:00` : undefined, notes: f.notes || null, followUpAt: f.followUpAt ? `${f.followUpAt} 09:00:00` : null, status: f.status } })); }}>
          <Banner kind="warn">{tr('lrn.notesPrivate')}</Banner>
          <Field label={tr('lrn.pickStudent')}><Select name="studentId" required placeholder="—" options={d.students.map(s => ({ value: String(s.id), label: `${s.first_name} ${s.last_name ?? ''} — ${s.class_name ?? ''} ${s.section_name ?? ''}`.trim() }))} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('lrn.referral')}><Select name="referralSource" options={['self', 'teacher', 'behaviour_rule', 'result_drop', 'guardian', 'clinic'].map(v => ({ value: v, label: v.replace(/_/g, ' ') }))} /></Field>
            <Field label={tr('common.status')}><Select name="status" options={['scheduled', 'done', 'no_show', 'cancelled'].map(v => ({ value: v, label: v.replace(/_/g, ' ') }))} /></Field>
          </div>
          <div className="grid grid-cols-3 gap-3"><Field label={tr('common.date')}><Input name="date" type="date" /></Field><Field label={tr('lrn.starts')}><Input name="time" type="time" /></Field><Field label={tr('lrn.followUp')}><Input name="followUpAt" type="date" /></Field></div>
          <Field label={tr('lrn.notes')}><textarea name="notes" className="input" rows={5} maxLength={20000} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'health'} onClose={() => setDrawer(null)} title={tr('lrn.newHealth')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(async () => { const x = await api<{ bmi: number | null }>('/api/welfare/health', { method: 'POST', json: { studentId: d.healthStudentId, recordedOn: f.recordedOn || undefined, heightCm: f.heightCm ? Number(f.heightCm) : null, weightKg: f.weightKg ? Number(f.weightKg) : null, visionLeft: f.visionLeft || null, visionRight: f.visionRight || null, dental: f.dental || null, doctorNotes: f.doctorNotes || null } }); setMsg(x.bmi == null ? tr('common.saved') : `BMI ${x.bmi}`); }); }}>
          <Field label={tr('common.date')}><Input name="recordedOn" type="date" defaultValue={d.date} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('lrn.height')}><Input name="heightCm" type="number" step="0.1" className="num" /></Field><Field label={tr('lrn.weight')}><Input name="weightKg" type="number" step="0.1" className="num" /></Field></div>
          <div className="grid grid-cols-3 gap-3"><Field label={`${tr('lrn.vision')} L`}><Input name="visionLeft" maxLength={10} placeholder="6/6" /></Field><Field label={`${tr('lrn.vision')} R`}><Input name="visionRight" maxLength={10} placeholder="6/6" /></Field><Field label={tr('lrn.dental')}><Input name="dental" maxLength={40} /></Field></div>
          <Field label={tr('lrn.notes')}><textarea name="doctorNotes" className="input" rows={3} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'vaccination'} onClose={() => setDrawer(null)} title={tr('lrn.newVaccination')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/welfare/vaccinations', { method: 'POST', json: { studentId: d.healthStudentId, vaccine: f.vaccine, doseNo: Number(f.doseNo || 1), givenOn: f.givenOn || null, nextDueOn: f.nextDueOn || null } })); }}>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('lrn.vaccinationNote')}</p>
          <Field label={tr('lrn.vaccine')}><Input name="vaccine" required maxLength={80} /></Field>
          <div className="grid grid-cols-3 gap-3"><Field label={tr('lrn.dose')}><Input name="doseNo" type="number" className="num" defaultValue="1" /></Field><Field label={tr('lrn.givenOn')}><Input name="givenOn" type="date" /></Field><Field label={tr('lrn.nextDue')}><Input name="nextDueOn" type="date" /></Field></div>
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
