import { useState } from 'react';
import { useLoaderData, useRevalidator } from 'react-router';
import type { Route } from './+types/insights';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Kpi, Select, Tabs, api, formatDate, formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id;
  const url = new URL(request.url);
  const role = url.searchParams.get('role') ?? 'admin';
  const [dashboard, risks, classes, benchmark] = await Promise.all([
    context.app.analytics.dashboard(sid, role),
    context.app.analytics.risks(sid, { minScore: 40 }),
    context.app.academic.classes(sid),
    context.app.analytics.benchmark(sid).catch(() => ({ period: '', cohort: '', metrics: [] })),
  ]);
  return { locale: (user.locale as Locale) || context.locale, role, dashboard, risks, classes, benchmark };
}
export function meta() { return [{ title: 'Pathshala — Insights' }]; }

export default function Insights() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<'dashboard' | 'watch' | 'broadcast'>('dashboard');
  const [drawer, setDrawer] = useState(false);
  const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ recipients: number; withPhone: number; withAccount: number } | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const audienceOf = (f: Record<string, string>) => ({ guardians: f.who === 'guardians' || f.who === 'both', staff: f.who === 'staff' || f.who === 'both', classIds: f.classId ? [f.classId] : undefined, withDues: f.withDues === 'on' });
  const num = (n: unknown) => formatNumber(Number(n ?? 0), d.locale);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('ins.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('ins.purpose')}</p></div>
        <a className="btn btn-secondary btn-sm" href={`/insights?role=${d.role === 'admin' ? 'accountant' : d.role === 'accountant' ? 'teacher' : 'admin'}`}>{tr('ins.asRole')}: {d.role}</a>
      </div>
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      {msg && <div className="mt-4"><Banner kind="ok">{msg}</Banner></div>}

      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[
        { key: 'dashboard', label: tr('ins.dashboard'), count: d.dashboard.cards.length },
        { key: 'watch', label: tr('ins.watch'), count: d.dashboard.alerts.length + d.risks.length },
        { key: 'broadcast', label: tr('ins.broadcast') },
      ]} /></div>

      {tab === 'dashboard' && <div className="mt-4">
        <div className="mb-3 flex justify-end"><Button size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => { const r = await api<{ anomalies: unknown[] }>('/api/analytics/compute', { method: 'POST', json: {} }); setMsg(`${r.anomalies.length} ${tr('ins.anomaliesFound')}`); })}>{tr('ins.recompute')}</Button></div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {d.dashboard.cards.map(c => <div key={c.key} className="card p-4">
            <div className="kpi-label">{c.name}</div>
            <div className="kpi-value num" style={{ color: c.warn ? 'var(--bad)' : undefined }}>{c.value == null ? '—' : `${num(c.value)}${c.unit === '%' ? '%' : ''}`}</div>
            <div className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
              {c.change == null ? tr('ins.noComparison') : `${c.change >= 0 ? '▲' : '▼'} ${num(Math.abs(c.change))} ${tr('ins.sinceLast')}`}
              {c.baseline != null && <> · {tr('ins.usually')} {num(c.baseline)}</>}
            </div>
            {c.history.length > 1 && <div className="mt-2 flex items-end gap-[2px]" style={{ height: 32 }}>
              {c.history.slice(-24).map((h, i) => { const max = Math.max(...c.history.map(x => x.value), 1); return <span key={i} title={`${h.period}: ${h.value}`} style={{ width: 6, height: `${Math.max(2, (h.value / max) * 32)}px`, background: 'var(--accent-soft)', display: 'inline-block' }} />; })}
            </div>}
          </div>)}
        </div>
        {d.benchmark.metrics.length > 0 && <>
          <h2 className="mt-6 text-base">{tr('ins.benchmark')}</h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('ins.benchmarkNote')}</p>
          <div className="mt-2"><DataTable locale={d.locale} searchable={false} rows={d.benchmark.metrics.map((m, i) => ({ id: String(i), ...m }))} columns={[
            { key: 'metricKey', label: tr('ins.metric') },
            { key: 'mine', label: tr('ins.ours'), className: 'num', render: r => r.mine == null ? '—' : num(r.mine) },
            { key: 'p25', label: '25%', className: 'num', render: r => num(r.p25) },
            { key: 'p50', label: '50%', className: 'num', render: r => num(r.p50) },
            { key: 'p75', label: '75%', className: 'num', render: r => num(r.p75) },
            { key: 'standing', label: tr('ins.standing'), render: r => <Chip status={String(r.standing).includes('top') ? 'active' : String(r.standing).includes('bottom') ? 'failed' : 'pending'}>{String(r.standing ?? '—')}</Chip> },
          ]} /></div>
        </>}
      </div>}

      {tab === 'watch' && <div className="mt-4">
        <h2 className="text-base">{tr('ins.alerts')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} searchable={false} rows={d.dashboard.alerts} columns={[
          { key: 'metric_key', label: tr('ins.metric'), render: r => String((r.details as { name?: string } | null)?.name ?? r.metric_key) },
          { key: 'actual', label: tr('ins.actual'), className: 'num', render: r => num(r.actual) },
          { key: 'expected', label: tr('ins.usually'), className: 'num', render: r => num(r.expected) },
          { key: 'severity', label: tr('ins.severity'), render: r => <Chip status={String(r.severity) === 'critical' ? 'failed' : 'pending'}>{String(r.severity)}</Chip> },
          { key: 'detected_at', label: tr('common.date'), render: r => formatDate(String(r.detected_at), d.locale) },
          { key: 'id', label: '', render: r => <Button size="sm" variant="secondary" onClick={() => run(() => api(`/api/analytics/alerts/${r.id}/status`, { method: 'POST', json: { status: 'resolved' } }))}>{tr('ins.resolve')}</Button> },
        ]} /></div>
        <h2 className="mt-6 text-base">{tr('ins.risks')}</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('ins.risksNote')}</p>
        <div className="mb-2 mt-2 flex justify-end"><Button size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => { const r = await api<{ flagged: number; students: number }>('/api/analytics/risks/compute', { method: 'POST', json: {} }); setMsg(`${r.students} ${tr('ins.checked')}, ${r.flagged} ${tr('ins.newlyFlagged')}`); })}>{tr('ins.recomputeRisks')}</Button></div>
        <DataTable locale={d.locale} rows={d.risks} columns={[
          { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` },
          { key: 'class_name', label: tr('common.class'), render: r => String(r.class_name ?? '—') },
          { key: 'risk_type', label: tr('ins.risk'), render: r => <Chip status={String(r.risk_type) === 'dropout' ? 'failed' : 'pending'}>{String(r.risk_type).replace('_', ' ')}</Chip> },
          { key: 'score', label: tr('ins.score'), className: 'num', render: r => num(r.score) },
          { key: 'factors', label: tr('ins.why'), render: r => ((r.factors as { why?: string[] } | null)?.why ?? []).join('; ') },
          { key: 'id', label: '', render: r => r.acknowledged_by ? <Chip status="done">{tr('ins.seen')}</Chip> : <Button size="sm" onClick={() => run(() => api(`/api/analytics/risks/${r.id}/acknowledge`, { method: 'POST', json: {} }))}>{tr('ins.acknowledge')}</Button> },
        ]} />
      </div>}

      {tab === 'broadcast' && <div className="mt-4">
        <div className="card p-4">
          <p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('ins.broadcastNote')}</p>
          <div className="mt-3"><Button onClick={() => { setPreview(null); setDrawer(true); }}>{tr('ins.compose')}</Button></div>
        </div>
      </div>}

      <Drawer open={drawer} onClose={() => setDrawer(false)} title={tr('ins.compose')}>
        <form className="grid gap-3" onSubmit={e => {
          e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
          const channels = ['sms', 'push', 'in_app', 'whatsapp', 'voice', 'email'].filter(c => f[`ch_${c}`] === 'on');
          run(async () => {
            const r = await api<{ recipients: number }>('/api/comms/broadcast', { method: 'POST', json: { title: f.title, body: f.body, channels: channels.length ? channels : ['push', 'in_app'], audience: audienceOf(f), urgent: f.urgent === 'on' } });
            setMsg(`${r.recipients} ${tr('ins.recipients')}`); setDrawer(false);
          });
        }}>
          <Field label={tr('common.name')}><Input name="title" required maxLength={200} /></Field>
          <Field label={tr('ins.message')}><textarea name="body" className="input" rows={4} required maxLength={4000} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('ins.who')}><Select name="who" options={[{ value: 'guardians', label: tr('ins.guardians') }, { value: 'staff', label: tr('ins.staff') }, { value: 'both', label: tr('ins.both') }]} /></Field>
            <Field label={tr('common.class')}><Select name="classId" placeholder={tr('ins.allClasses')} options={d.classes.map(c => ({ value: String(c.id), label: String(c.name) }))} /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="withDues" /> {tr('ins.onlyDues')}</label>
          <div className="flex flex-wrap gap-3 text-sm">
            {[['push', 'Push'], ['in_app', 'In app'], ['sms', 'SMS'], ['whatsapp', 'WhatsApp'], ['voice', tr('ins.voice')], ['email', 'Email']].map(([c, label]) =>
              <label key={c} className="flex items-center gap-1"><input type="checkbox" name={`ch_${c}`} defaultChecked={c === 'push' || c === 'in_app'} /> {label}</label>)}
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="urgent" /> {tr('ins.urgent')}</label>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('ins.voiceNote')}</p>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" disabled={busy} onClick={async e => {
              const f = Object.fromEntries(new FormData((e.currentTarget.closest('form') as HTMLFormElement)).entries()) as Record<string, string>;
              try { setPreview(await api('/api/comms/broadcast/preview', { method: 'POST', json: { audience: audienceOf(f) } })); } catch (ex) { setErr((ex as Error).message); }
            }}>{tr('ins.checkAudience')}</Button>
            <Button disabled={busy}>{tr('ins.send')}</Button>
          </div>
          {preview && <Banner kind="info">{preview.recipients} {tr('ins.recipients')} · {preview.withPhone} {tr('ins.withPhone')} · {preview.withAccount} {tr('ins.withAccount')}</Banner>}
        </form>
      </Drawer>
    </div>
  );
}
