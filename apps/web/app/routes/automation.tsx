import { useState } from 'react';
import { useLoaderData, useNavigation, useRevalidator, useSearchParams, Form } from 'react-router';
import type { Route } from './+types/automation';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Kpi, Select, Tabs, Textarea, api, chipClass, formatDateTime, formatMoney, formatNumber, t, type Locale } from '@pathshala/ui';
import { assertSameOrigin, requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const access = await context.app.rbac.accessFor(user.id);
  context.app.rbac.require('platform.view', access);
  const sid = user.school_id; const url = new URL(request.url);
  const ruleId = url.searchParams.get('ruleId') || undefined;
  const day = url.searchParams.get('day') || undefined;
  const a = context.app.automation;
  const [approvals, tasks, rules, preview, runs, summary, jobs, background, webhooks, deliveries] = await Promise.all([
    a.pendingApprovals(sid), a.openTasks(sid), a.rules(sid), a.previewRuns(sid),
    a.runs(sid, { ruleId, day, limit: 100 }), a.activitySummary(sid, day),
    a.scheduledJobs(sid), a.backgroundJobs(sid, 30), a.webhooks(sid), a.deliveries(sid, { limit: 40 }),
  ]);
  return {
    locale: (user.locale as Locale) || context.locale, mode: context.app.adapters.mode, ruleId: ruleId ?? '', day: day ?? '',
    approvals, tasks, rules, preview, runs, summary, jobs, background, webhooks, deliveries,
    canEdit: context.app.rbac.can('platform.automation', access),
    canApprove: context.app.rbac.can('platform.approve', access),
    canTask: context.app.rbac.can('platform.edit', access),
  };
}

/** The one thing the page still does with a plain form: a scheduler tick needs no JSON. */
export async function action({ context, request }: Route.ActionArgs) {
  const user = requireUser(context, request);
  assertSameOrigin(request, context.app.config.appUrl);
  context.app.rbac.require('platform.automation', await context.app.rbac.accessFor(user.id));
  await request.formData();
  return { tick: await context.app.tick() };
}

export function meta() { return [{ title: 'Pathshala — Automation' }]; }

type Tab = 'approvals' | 'tasks' | 'rules' | 'jobs' | 'activity' | 'integrations';

export default function Automation() {
  const d = useLoaderData<typeof loader>();
  const rv = useRevalidator(); const nav = useNavigation(); const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<Tab>(d.approvals.length ? 'approvals' : 'rules');
  const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [refuse, setRefuse] = useState<{ id: string; what: string } | null>(null);
  const [newTask, setNewTask] = useState(false);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); setMsg(null); try { await fn(); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n); };
  const num = (n: unknown) => formatNumber(Number(n ?? 0), d.locale);
  const when = (v: unknown) => v ? formatDateTime(String(v), d.locale) : '—';
  const st = (s: unknown) => <span className={chipClass(s == null ? null : String(s))}>{s ? t(`status.${String(s)}` as never, d.locale) : '—'}</span>;
  const inPreview = d.rules.filter(r => r.inPreview);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('auto.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('auto.purpose')}</p></div>
        <div className="flex items-center gap-2">
          <span className="chip chip-cron">{tr('auto.mode')}: {d.mode}</span>
          {d.canEdit && <Form method="post"><Button size="sm" variant="secondary" disabled={nav.state !== 'idle'}>{tr('auto.tick')}</Button></Form>}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={tr('dash.pendingApprovals')} value={d.approvals.length} locale={d.locale} />
        <Kpi label={tr('dash.openTasks')} value={d.tasks.length} locale={d.locale} />
        <Kpi label={tr('auto.ranToday')} value={d.summary.ran} locale={d.locale} />
        <Kpi label={tr('auto.failedToday')} value={d.summary.failed} locale={d.locale} />
      </div>

      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      {msg && <div className="mt-4"><Banner kind="ok">{msg}</Banner></div>}
      {inPreview.length > 0 && <div className="mt-4"><Banner kind="warn">{inPreview.length === 1 ? `${inPreview[0].code} ${inPreview[0].name}` : `${num(inPreview.length)} ${tr('auto.rules').toLowerCase()}`} · {tr('auto.previewNote')}</Banner></div>}

      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[
        { key: 'approvals', label: tr('auto.approvals'), count: d.approvals.length },
        { key: 'tasks', label: tr('auto.tasks'), count: d.tasks.length },
        { key: 'rules', label: tr('auto.rules'), count: d.rules.length },
        { key: 'jobs', label: tr('auto.scheduled'), count: d.jobs.length },
        { key: 'activity', label: tr('auto.activity'), count: d.runs.length },
        { key: 'integrations', label: tr('auto.integrations'), count: d.webhooks.length },
      ]} /></div>

      {/* ---------- approvals inbox ---------- */}
      {tab === 'approvals' && <div className="mt-4">
        {d.approvals.length === 0 ? <Banner kind="ok">{tr('auto.noApprovals')}</Banner> : <DataTable locale={d.locale} rows={d.approvals} columns={[
          { key: 'entityType', label: tr('common.type'), render: r => <Chip status="pending">{String(r.entityType).replace(/[._]/g, ' ')}</Chip> },
          { key: 'what', label: tr('common.description'), render: r => <span className="block max-w-[420px] whitespace-normal">{r.what}</span> },
          { key: 'requester', label: tr('auto.requester'), render: r => String(r.requester ?? '—') },
          { key: 'worth', label: tr('auto.worth'), className: 'num', render: r => r.worth == null ? '—' : formatMoney(r.worth, d.locale) },
          { key: 'currentStep', label: tr('auto.step'), className: 'num', render: r => num(r.currentStep) },
          { key: 'dueAt', label: tr('auto.due'), render: r => <span style={{ color: r.overdue ? 'var(--bad)' : undefined }}>{when(r.dueAt)}</span> },
          { key: 'id', label: '', render: r => d.canApprove ? <div className="flex gap-1">
            <Button size="sm" disabled={busy} onClick={() => run(async () => { await api(`/api/automation/approvals/${r.id}/decide`, { method: 'POST', json: { decision: 'approved' } }); setMsg(`${r.what} · ${tr('auto.approve')}`); })}>{tr('auto.approve')}</Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setRefuse({ id: String(r.id), what: String(r.what) }); }}>{tr('auto.refuse')}</Button>
          </div> : null },
        ]} />}
      </div>}

      {/* ---------- tasks ---------- */}
      {tab === 'tasks' && <div className="mt-4">
        {d.canTask && <div className="mb-3 flex justify-end"><Button size="sm" onClick={() => setNewTask(true)}>{tr('auto.newTask')}</Button></div>}
        {d.tasks.length === 0 ? <Banner kind="ok">{tr('auto.noTasks')}</Banner> : <DataTable locale={d.locale} rows={d.tasks} columns={[
          { key: 'title', label: tr('common.name'), render: r => <span className="block max-w-[440px] whitespace-normal">{String(r.title)}{r.description ? <span className="block text-xs" style={{ color: 'var(--muted)' }}>{String(r.description).slice(0, 160)}</span> : null}</span> },
          { key: 'assignee', label: tr('auto.owner'), render: r => String(r.assignee ?? r.assignedRole ?? tr('common.none')) },
          { key: 'dueAt', label: tr('auto.due'), render: r => <span style={{ color: r.overdue ? 'var(--bad)' : undefined }}>{when(r.dueAt)}</span> },
          { key: 'priority', label: tr('auto.priority'), render: r => <Chip status={String(r.priority) === 'urgent' || String(r.priority) === 'high' ? 'overdue' : 'pending'}>{String(r.priority)}</Chip> },
          { key: 'raisedBy', label: tr('auto.raisedBy'), render: r => <span className="num text-xs">{String(r.raisedBy)}</span> },
          { key: 'status', label: tr('common.status'), render: r => st(r.status) },
          { key: 'id', label: '', render: r => d.canTask ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => api(`/api/automation/tasks/${r.id}/complete`, { method: 'POST', json: {} }))}>{tr('auto.close')}</Button> : null },
        ]} />}
      </div>}

      {/* ---------- rules and their preview ---------- */}
      {tab === 'rules' && <div className="mt-4">
        <DataTable locale={d.locale} rows={d.rules} pageSize={50} columns={[
          { key: 'code', label: '#', className: 'num', render: r => String(r.code) },
          { key: 'name', label: tr('auto.rules'), render: r => <span className="block max-w-[320px] whitespace-normal">{String(r.name)}<span className="block text-xs" style={{ color: 'var(--muted)' }}>{String(r.module)}</span></span> },
          { key: 'eventType', label: tr('auto.trigger'), render: r => <span className="num text-xs">{String(r.eventType ?? r.triggerKind)}</span> },
          { key: 'actions', label: tr('auto.does'), render: r => <span className="block max-w-[420px] whitespace-normal text-xs">{r.actions.map(a => a.note ?? a.type).join(' · ') || '—'}</span> },
          { key: 'lastRunAt', label: tr('auto.lastRun'), render: r => when(r.lastRunAt) },
          { key: 'runCount', label: tr('auto.runsCount'), className: 'num', render: r => num(r.runCount) },
          { key: 'previewUntil', label: tr('auto.preview'), render: r => r.inPreview ? <Chip status="preview">{tr('auto.previewOn')} · {when(r.previewUntil)}</Chip> : '—' },
          { key: 'isActive', label: '', render: r => <div className="flex gap-1">
            {d.canEdit ? <Button size="sm" variant={r.isActive ? 'secondary' : 'primary'} disabled={busy} onClick={() => run(async () => { const on = !r.isActive; const res = await api<{ previewUntil: string | null }>(`/api/automation/rules/${r.id}/active`, { method: 'POST', json: { active: on } }); setMsg(on && res.previewUntil ? `${r.code} · ${tr('auto.previewNote')}` : `${r.code} · ${on ? tr('auto.on') : tr('auto.off')}`); })}>{r.isActive ? tr('auto.on') : tr('auto.off')}</Button> : st(r.isActive ? 'active' : 'inactive')}
            {d.canEdit && r.inPreview && <Button size="sm" disabled={busy} onClick={() => run(() => api(`/api/automation/rules/${r.id}/go-live`, { method: 'POST', json: {} }))}>{tr('auto.goLive')}</Button>}
          </div> },
        ]} />

        <h2 className="mt-6 text-base" style={{ color: 'var(--auto)' }}>{tr('auto.preview')}</h2>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('auto.previewNote')}</p>
        <div className="mt-2">{d.preview.length === 0 ? <Banner kind="info">{tr('auto.noPreview')}</Banner> : <DataTable locale={d.locale} searchable={false} rows={d.preview} columns={[
          { key: 'code', label: '#', className: 'num', render: r => String(r.code) },
          { key: 'name', label: tr('auto.rules'), render: r => String(r.name) },
          { key: 'startedAt', label: tr('auto.lastRun'), render: r => when(r.startedAt) },
          { key: 'aggregateType', label: tr('common.type'), render: r => <span className="num text-xs">{String(r.aggregateType ?? '—')}</span> },
          { key: 'would', label: tr('auto.wouldHave'), render: r => <ul className="block max-w-[560px] whitespace-normal text-xs">{r.would.map((w, i) => <li key={i}>{w.would}</li>)}{r.would.length === 0 && <li>—</li>}</ul> },
        ]} />}</div>
      </div>}

      {/* ---------- scheduled jobs ---------- */}
      {tab === 'jobs' && <div className="mt-4">
        <DataTable locale={d.locale} rows={d.jobs} pageSize={50} columns={[
          { key: 'jobKey', label: tr('auto.scheduled'), render: r => <span className="num text-xs">{String(r.jobKey)}</span> },
          { key: 'cronExpr', label: tr('auto.cron'), className: 'num', render: r => <span className="whitespace-nowrap text-xs">{String(r.cronExpr)}</span> },
          { key: 'lastRunAt', label: tr('auto.lastRun'), render: r => when(r.lastRunAt) },
          { key: 'lastStatus', label: tr('auto.status'), render: r => st(r.lastStatus) },
          { key: 'lastDurationMs', label: tr('auto.took'), className: 'num', render: r => r.lastDurationMs == null ? '—' : `${num(r.lastDurationMs)} ms` },
          { key: 'nextRunAt', label: tr('auto.nextRun'), render: r => <span style={{ color: r.overdue ? 'var(--bad)' : undefined }}>{when(r.nextRunAt)}</span> },
          { key: 'id', label: '', render: r => d.canEdit ? <div className="flex gap-1">
            <Button size="sm" disabled={busy || !r.isActive} onClick={() => run(async () => { const res = await api<{ lastStatus: string | null }>(`/api/automation/jobs/${encodeURIComponent(String(r.jobKey))}/run`, { method: 'POST', json: {} }); setMsg(`${r.jobKey} · ${res.lastStatus ?? '—'}`); })}>{tr('auto.runNow')}</Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => api(`/api/automation/jobs/${encodeURIComponent(String(r.jobKey))}/active`, { method: 'POST', json: { active: !r.isActive } }))}>{r.isActive ? tr('auto.on') : tr('auto.off')}</Button>
          </div> : st(r.isActive ? 'active' : 'inactive') },
        ]} />

        <h2 className="mt-6 text-base">{tr('auto.jobs')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} searchable={false} rows={d.background} columns={[
          { key: 'jobName', label: tr('auto.jobs'), render: r => String(r.jobName) },
          { key: 'queue', label: 'queue', render: r => <span className="num text-xs">{String(r.queue)}</span> },
          { key: 'progressPct', label: '%', className: 'num', render: r => num(r.progressPct) },
          { key: 'attempts', label: '×', className: 'num', render: r => num(r.attempts) },
          { key: 'scheduledFor', label: tr('auto.nextRun'), render: r => when(r.scheduledFor) },
          { key: 'status', label: tr('auto.status'), render: r => <>{st(r.status)}{r.error ? <span className="block text-xs" style={{ color: 'var(--bad)' }}>{String(r.error).slice(0, 120)}</span> : null}</> },
        ]} /></div>
      </div>}

      {/* ---------- activity ---------- */}
      {tab === 'activity' && <div className="mt-4">
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Select className="max-w-[280px]" value={d.ruleId} onChange={e => setParam('ruleId', e.target.value)} placeholder={tr('auto.allRules')} options={d.rules.map(r => ({ value: String(r.id), label: `${r.code} · ${r.name}` }))} />
          <Input type="date" value={d.day} onChange={e => setParam('day', e.target.value)} className="max-w-[180px]" aria-label={tr('auto.day')} />
          {(d.ruleId || d.day) && <Button size="sm" variant="ghost" onClick={() => setSp(new URLSearchParams())}>{tr('common.cancel')}</Button>}
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label={tr('auto.ranToday')} value={d.summary.ran} locale={d.locale} />
          <Kpi label={tr('auto.failedToday')} value={d.summary.failed} locale={d.locale} />
          <Kpi label={tr('auto.preview')} value={d.summary.preview} locale={d.locale} />
          <Kpi label={tr('auto.inQueue')} value={d.summary.queued} locale={d.locale} />
        </div>
        <div className="mt-4"><DataTable locale={d.locale} rows={d.runs} pageSize={50} columns={[
          { key: 'startedAt', label: tr('auto.lastRun'), render: r => when(r.startedAt) },
          { key: 'code', label: '#', className: 'num', render: r => String(r.code) },
          { key: 'name', label: tr('auto.rules'), render: r => <span className="block max-w-[300px] whitespace-normal">{String(r.name)}</span> },
          { key: 'aggregateType', label: tr('common.type'), render: r => <span className="num text-xs">{String(r.aggregateType ?? '—')}</span> },
          { key: 'status', label: tr('auto.status'), render: r => st(r.status) },
          { key: 'error', label: tr('auto.error'), render: r => r.error ? <span className="block max-w-[320px] whitespace-normal text-xs" style={{ color: 'var(--bad)' }}>{String(r.error).slice(0, 200)}</span> : '—' },
        ]} empty={tr('dash.empty')} /></div>
      </div>}

      {/* ---------- integrations ---------- */}
      {tab === 'integrations' && <div className="mt-4">
        {d.webhooks.length === 0 ? <Banner kind="info">{tr('auto.noWebhooks')}</Banner> : <DataTable locale={d.locale} searchable={false} rows={d.webhooks} columns={[
          { key: 'url', label: tr('auto.webhook'), render: r => <span className="num block max-w-[360px] whitespace-normal text-xs">{String(r.url)}</span> },
          { key: 'eventTypes', label: tr('auto.events'), render: r => <span className="num block max-w-[280px] whitespace-normal text-xs">{r.eventTypes.length ? r.eventTypes.join(', ') : '*'}</span> },
          { key: 'delivered', label: tr('auto.delivered'), className: 'num', render: r => r.successPct == null ? '—' : `${num(r.delivered)}/${num(r.attempts)} · ${r.successPct}%` },
          { key: 'failureCount', label: tr('auto.failures'), className: 'num', render: r => <span style={{ color: Number(r.failureCount) > 0 ? 'var(--bad)' : undefined }}>{num(r.failureCount)}</span> },
          { key: 'lastAttemptAt', label: tr('auto.lastRun'), render: r => when(r.lastAttemptAt) },
          { key: 'isActive', label: '', render: r => d.canEdit ? <Button size="sm" variant={r.isActive ? 'secondary' : 'primary'} disabled={busy} onClick={() => run(() => api(`/api/automation/webhooks/${r.id}/active`, { method: 'POST', json: { active: !r.isActive } }))}>{r.isActive ? tr('auto.on') : tr('auto.off')}</Button> : st(r.isActive ? 'active' : 'inactive') },
        ]} />}

        <h2 className="mt-6 text-base">{tr('auto.deliveries')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} searchable={false} rows={d.deliveries} columns={[
          { key: 'createdAt', label: tr('common.date'), render: r => when(r.createdAt) },
          { key: 'eventType', label: tr('auto.events'), render: r => <span className="num text-xs">{String(r.eventType ?? r.eventUid)}</span> },
          { key: 'url', label: tr('auto.webhook'), render: r => <span className="num block max-w-[280px] whitespace-normal text-xs">{String(r.url)}</span> },
          { key: 'responseCode', label: tr('auto.status'), render: r => <Chip status={r.deliveredAt ? 'success' : 'failed'}>{String(r.responseCode ?? '—')}</Chip> },
          { key: 'responseExcerpt', label: tr('auto.error'), render: r => r.deliveredAt ? '—' : <span className="block max-w-[300px] whitespace-normal text-xs" style={{ color: 'var(--bad)' }}>{String(r.responseExcerpt ?? '')}</span> },
        ]} empty={tr('dash.empty')} /></div>
      </div>}

      {/* a refusal always carries its reason: the person who asked has to be told why */}
      <Drawer open={!!refuse} onClose={() => setRefuse(null)} title={`${tr('auto.refuse')} — ${refuse?.what ?? ''}`}>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('auto.reasonNeeded')}</p>
        <form className="mt-3" onSubmit={e => { e.preventDefault(); const fd = new FormData(e.currentTarget); const comment = String(fd.get('comment') ?? ''); const id = refuse?.id; setRefuse(null); void run(() => api(`/api/automation/approvals/${id}/decide`, { method: 'POST', json: { decision: 'rejected', comment } })); }}>
          <Field label={tr('auto.reason')}><Textarea name="comment" required minLength={3} maxLength={500} /></Field>
          <div className="mt-3 flex gap-2"><Button type="submit" variant="danger" disabled={busy}>{tr('auto.refuse')}</Button><Button type="button" variant="secondary" onClick={() => setRefuse(null)}>{tr('common.cancel')}</Button></div>
        </form>
      </Drawer>

      <Drawer open={newTask} onClose={() => setNewTask(false)} title={tr('auto.newTask')}>
        <form onSubmit={e => { e.preventDefault(); const json = Object.fromEntries(new FormData(e.currentTarget).entries()); setNewTask(false); void run(() => api('/api/automation/tasks', { method: 'POST', json })); }}>
          <Field label={tr('common.name')}><Input name="title" required minLength={2} maxLength={200} /></Field>
          <Field label={tr('common.description')}><Textarea name="description" maxLength={2000} /></Field>
          <Field label={tr('auto.owner')}><Select name="assignedRole" options={['admin', 'principal', 'accountant', 'teacher', 'librarian', 'staff'].map(r => ({ value: r, label: r }))} /></Field>
          <Field label={tr('auto.priority')}><Select name="priority" options={['low', 'normal', 'high', 'urgent'].map(p => ({ value: p, label: p }))} /></Field>
          <div className="mt-3 flex gap-2"><Button type="submit" disabled={busy}>{tr('common.save')}</Button><Button type="button" variant="secondary" onClick={() => setNewTask(false)}>{tr('common.cancel')}</Button></div>
        </form>
      </Drawer>
    </div>
  );
}
