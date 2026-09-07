import { useState } from 'react';
import { useLoaderData, useRevalidator } from 'react-router';
import type { Route } from './+types/platform';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Kpi, Select, Tabs, api, formatDate, formatMoney, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id;
  const [billing, plugins, packs, clients, skills, generations] = await Promise.all([
    (async () => ({ subscription: await context.app.saas.subscription(sid), usage: (await context.app.saas.meter(sid)).usage, invoices: await context.app.saas.invoices({ schoolId: sid }) }))(),
    (async () => ({ available: await context.app.marketplace.plugins(), installed: await context.app.marketplace.installs(sid) }))(),
    context.app.marketplace.packs(),
    context.app.marketplace.clients(sid),
    (async () => ({ skills: context.app.ai.skills(), budget: await context.app.ai.budgetLeft(sid), provider: context.app.adapters.ai.kind }))(),
    context.app.ai.generations(sid),
  ]);
  return { locale: (user.locale as Locale) || context.locale, billing, plugins, packs, clients, skills, generations };
}
export function meta() { return [{ title: 'Pathshala — Platform' }]; }

export default function Platform() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<'billing' | 'apps' | 'assistant'>('billing');
  const [drawer, setDrawer] = useState<null | 'support' | 'client' | 'install'>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState<{ q: string; a: string }[]>([]);
  const [secret, setSecret] = useState<{ what: string; value: string } | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setDrawer(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const form = (e: React.FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
  const money = (n: unknown) => formatMoney(Number(n ?? 0), d.locale);
  const sub = d.billing.subscription;

  return (
    <div>
      <div><h1 className="text-2xl">{tr('plat.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('plat.purpose')}</p></div>
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="kpi"><div className="kpi-label">{tr('plat.plan')}</div><div className="kpi-value">{String(sub?.plan_name ?? '—')}</div>{sub && <div className="mt-1"><Chip status={String(sub.status) === 'active' ? 'active' : String(sub.status) === 'past_due' ? 'failed' : 'pending'}>{String(sub.status)}</Chip></div>}</div>
        <Kpi label={tr('plat.students')} value={Number(d.billing.usage.students ?? 0)} locale={d.locale} />
        <Kpi label={tr('plat.messages')} value={Number(d.billing.usage.sms ?? 0)} locale={d.locale} />
        <Kpi label={tr('plat.storage')} value={`${Number(d.billing.usage.storage_mb ?? 0)} MB`} locale={d.locale} />
      </div>
      {sub && String(sub.status) === 'past_due' && <div className="mt-4"><Banner kind="warn">{tr('plat.pastDue')}</Banner></div>}
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      {msg && <div className="mt-4"><Banner kind="ok">{msg}</Banner></div>}
      {secret && <div className="mt-4"><Banner kind="info"><strong>{secret.what}</strong>: <code>{secret.value}</code> — {tr('plat.copyNow')}</Banner></div>}

      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[
        { key: 'billing', label: tr('plat.billing'), count: d.billing.invoices.length },
        { key: 'apps', label: tr('plat.apps'), count: d.plugins.installed.length + d.clients.length },
        { key: 'assistant', label: tr('plat.assistant') },
      ]} /></div>

      {tab === 'billing' && <div className="mt-4">
        <div className="mb-3 flex justify-end"><Button size="sm" variant="secondary" onClick={() => setDrawer('support')}>{tr('plat.askForHelp')}</Button></div>
        <DataTable locale={d.locale} searchable={false} rows={d.billing.invoices} columns={[
          { key: 'invoice_no', label: tr('fee.invoiceNo'), className: 'num' },
          { key: 'period_start', label: tr('plat.period'), render: r => `${formatDate(String(r.period_start), d.locale)} — ${formatDate(String(r.period_end), d.locale)}` },
          { key: 'total', label: tr('fee.amount'), className: 'num money', render: r => money(r.total) },
          { key: 'due_date', label: tr('fee.due'), render: r => formatDate(String(r.due_date), d.locale) },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'paid' ? 'active' : String(r.status) === 'overdue' ? 'failed' : 'pending'}>{String(r.status)}</Chip> },
        ]} />
        <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>{tr('plat.billingNote')}</p>
      </div>}

      {tab === 'apps' && <div className="mt-4">
        <h2 className="text-base">{tr('plat.plugins')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} searchable={false} rows={d.plugins.available} columns={[
          { key: 'name', label: tr('common.name') },
          { key: 'vendor', label: tr('plat.vendor'), render: r => String(r.vendor ?? '—') },
          { key: 'version', label: tr('plat.version') },
          { key: 'price_monthly', label: tr('plat.perMonth'), className: 'num money', render: r => Number(r.price_monthly) ? money(r.price_monthly) : tr('plat.free') },
          { key: 'id', label: '', render: r => d.plugins.installed.some(i => String(i.plugin_id) === String(r.id))
            ? <Chip status="active">{tr('plat.installed')}</Chip>
            : <Button size="sm" onClick={() => { setInstalling(String(r.id)); setDrawer('install'); }}>{tr('plat.install')}</Button> },
        ]} /></div>
        {d.plugins.installed.length > 0 && <>
          <h2 className="mt-6 text-base">{tr('plat.installedHere')}</h2>
          <div className="mt-2"><DataTable locale={d.locale} searchable={false} rows={d.plugins.installed} columns={[
            { key: 'name', label: tr('common.name') },
            { key: 'is_enabled', label: tr('common.status'), render: r => <Chip status={Number(r.is_enabled) ? 'active' : 'pending'}>{Number(r.is_enabled) ? tr('plat.on') : tr('plat.off')}</Chip> },
            { key: 'hooks', label: tr('plat.listensTo'), render: r => ((r.hooks as unknown as string[]) ?? []).join(', ') },
            { key: 'id', label: '', render: r => <div className="flex gap-1">
              <Button size="sm" variant="secondary" onClick={() => run(() => api(`/api/marketplace/installs/${r.id}/enabled`, { method: 'POST', json: { enabled: !Number(r.is_enabled) } }))}>{Number(r.is_enabled) ? tr('plat.turnOff') : tr('plat.turnOn')}</Button>
              <Button size="sm" variant="danger" onClick={() => run(() => api(`/api/marketplace/installs/${r.id}/uninstall`, { method: 'POST', json: {} }))}>{tr('plat.uninstall')}</Button>
            </div> },
          ]} /></div>
        </>}
        <h2 className="mt-6 text-base">{tr('plat.packs')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} searchable={false} rows={d.packs} columns={[
          { key: 'name', label: tr('common.name') },
          { key: 'kind', label: tr('common.type'), render: r => <Chip status="active">{String(r.kind)}</Chip> },
          { key: 'version', label: tr('plat.version') },
          { key: 'id', label: '', render: r => <Button size="sm" variant="secondary" onClick={() => run(async () => { const x = await api<{ written: number; kept: number }>(`/api/marketplace/packs/${r.id}/apply`, { method: 'POST', json: {} }); setMsg(`${x.written} ${tr('plat.added')}, ${x.kept} ${tr('plat.leftAlone')}`); })}>{tr('plat.apply')}</Button> },
        ]} /></div>
        <h2 className="mt-6 text-base">{tr('plat.apiClients')}</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('plat.apiNote')}</p>
        <div className="mb-2 mt-2 flex justify-end"><Button size="sm" onClick={() => setDrawer('client')}>{tr('plat.newClient')}</Button></div>
        <DataTable locale={d.locale} searchable={false} rows={d.clients} columns={[
          { key: 'name', label: tr('common.name') },
          { key: 'client_id', label: 'client_id', className: 'num' },
          { key: 'scopes', label: tr('plat.scopes'), render: r => ((r.scopes as unknown as string[]) ?? []).join(' ') },
          { key: 'revoked_at', label: tr('common.status'), render: r => r.revoked_at ? <Chip status="failed">{tr('plat.revoked')}</Chip> : <Chip status="active">{tr('plat.live')}</Chip> },
          { key: 'id', label: '', render: r => r.revoked_at ? null : <Button size="sm" variant="danger" onClick={() => run(() => api(`/api/oauth/clients/${r.id}/revoke`, { method: 'POST', json: {} }))}>{tr('plat.revoke')}</Button> },
        ]} />
      </div>}

      {tab === 'assistant' && <div className="mt-4">
        <div className="card p-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="chip">{tr('plat.provider')}: {d.skills.provider}</span>
            <span className="chip">{tr('plat.budgetLeft')}: {money(d.skills.budget.left)} / {money(d.skills.budget.budget)}</span>
          </div>
          <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('plat.assistantNote')}</p>
          <form className="mt-3 flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); const f = form(e); (e.currentTarget as HTMLFormElement).reset(); run(async () => { const r = await api<{ answer: string }>('/api/ai/ask', { method: 'POST', json: { question: f.question } }); setAsked(a => [{ q: f.question, a: r.answer }, ...a].slice(0, 10)); }); }}>
            <Input name="question" required placeholder={d.skills.skills[0]} className="max-w-[420px]" />
            <Button disabled={busy}>{tr('plat.ask')}</Button>
          </form>
          <div className="mt-2 flex flex-wrap gap-2">{d.skills.skills.map(s => <span key={s} className="chip" style={{ color: 'var(--muted)' }}>{s}</span>)}</div>
          {asked.length > 0 && <div className="mt-4 grid gap-2">{asked.map((x, i) => <div key={i} className="rounded-[var(--radius-ctl)] p-3" style={{ background: 'var(--surface-2)' }}><div className="text-xs" style={{ color: 'var(--muted)' }}>{x.q}</div><div className="mt-1 text-sm">{x.a}</div></div>)}</div>}
        </div>
        {d.generations.length > 0 && <>
          <h2 className="mt-6 text-base">{tr('plat.drafts')}</h2>
          <div className="mt-2"><DataTable locale={d.locale} searchable={false} rows={d.generations} columns={[
            { key: 'kind', label: tr('common.type'), render: r => <Chip status="active">{String(r.kind)}</Chip> },
            { key: 'output', label: tr('plat.draft'), render: r => String((r.output as { text?: string } | null)?.text ?? '').slice(0, 120) },
            { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'applied' ? 'active' : 'pending'}>{String(r.status)}</Chip> },
            { key: 'created_at', label: tr('common.date'), render: r => formatDate(String(r.created_at), d.locale) },
            { key: 'id', label: '', render: r => String(r.status) === 'generated' ? <Button size="sm" variant="secondary" onClick={() => run(() => api(`/api/ai/generations/${r.id}/discard`, { method: 'POST', json: {} }))}>{tr('plat.discard')}</Button> : null },
          ]} /></div>
        </>}
      </div>}

      <Drawer open={drawer === 'support'} onClose={() => setDrawer(null)} title={tr('plat.askForHelp')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(async () => { await api('/api/billing/support', { method: 'POST', json: { subject: f.subject, body: f.body, priority: f.priority } }); setMsg(tr('plat.helpSent')); }); }}>
          <Field label={tr('plat.subject')}><Input name="subject" required /></Field>
          <Field label={tr('plat.whatHappened')}><textarea name="body" className="input" rows={5} required /></Field>
          <Field label={tr('inst.priority')}><Select name="priority" options={['low', 'normal', 'high', 'urgent'].map(k => ({ value: k, label: k }))} /></Field>
          <Button disabled={busy}>{tr('plat.send')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'install'} onClose={() => setDrawer(null)} title={tr('plat.install')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(async () => { const r = await api<{ secret: string }>(`/api/marketplace/plugins/${installing}/install`, { method: 'POST', json: { webhookUrl: f.webhookUrl || null } }); setSecret({ what: tr('plat.webhookSecret'), value: r.secret }); }); }}>
          <Field label={tr('plat.webhookUrl')}><Input name="webhookUrl" placeholder="https://…" /></Field>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('plat.installNote')}</p>
          <Button disabled={busy}>{tr('plat.install')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'client'} onClose={() => setDrawer(null)} title={tr('plat.newClient')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); const scopes = ['profile.read', 'students.read', 'students.write', 'attendance.read', 'attendance.write', 'fees.read', 'results.read', 'notices.write'].filter(s => f[`sc_${s}`] === 'on'); run(async () => { const r = await api<{ clientId: string; clientSecret: string }>('/api/oauth/clients', { method: 'POST', json: { name: f.name, scopes: scopes.length ? scopes : ['profile.read'] } }); setSecret({ what: `${tr('plat.clientSecret')} (${r.clientId})`, value: r.clientSecret }); }); }}>
          <Field label={tr('common.name')}><Input name="name" required /></Field>
          <div className="grid grid-cols-2 gap-2 text-sm">
            {['profile.read', 'students.read', 'students.write', 'attendance.read', 'attendance.write', 'fees.read', 'results.read', 'notices.write'].map(s =>
              <label key={s} className="flex items-center gap-1"><input type="checkbox" name={`sc_${s}`} defaultChecked={s === 'profile.read'} /> {s}</label>)}
          </div>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('plat.scopeNote')}</p>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
    </div>
  );
}
