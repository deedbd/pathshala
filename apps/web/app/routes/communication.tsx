import { useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/communication';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Kpi, Select, Tabs, Textarea, api, formatDate, formatDateTime, formatMoney, formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id; const url = new URL(request.url);
  const to = url.searchParams.get('to') ?? new Date().toISOString().slice(0, 10);
  const from = url.searchParams.get('from') ?? to;
  const channel = url.searchParams.get('channel') ?? undefined;
  const status = url.searchParams.get('status') ?? undefined;
  const page = Math.max(Number(url.searchParams.get('page') ?? 0), 0);
  const year = await context.app.academic.currentYear(sid);
  const [notices, log, stats, templates, providers, slots, bookings, sections, teachers] = await Promise.all([
    context.app.communication.noticeBoard(sid, { limit: 100 }),
    context.app.communication.notificationLog(sid, { channel, status, from, to, limit: 50, offset: page * 50 }),
    context.app.communication.notificationStats(sid, from, to),
    context.app.communication.templates(sid),
    context.app.communication.providers(sid),
    context.app.communication.ptmSlots(sid, { from: `${to} 00:00:00` }),
    context.app.communication.ptmBookings(sid, {}),
    year ? context.app.academic.sections(sid, String(year.id)) : [],
    context.app.people.staff(sid, { teachingOnly: true }),
  ]);
  return { locale: (user.locale as Locale) || context.locale, from, to, page, channel: channel ?? '', status: status ?? '', notices, log, stats, templates, providers, slots, bookings, sections, teachers };
}
export function meta() { return [{ title: 'Pathshala — Communication' }]; }

const CHANNELS = ['sms', 'email', 'push', 'whatsapp', 'in_app', 'voice'] as const;

export default function Communication() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator(); const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<'notices' | 'log' | 'templates' | 'providers' | 'ptm'>('notices');
  const [drawer, setDrawer] = useState<'notice' | 'template' | 'provider' | 'slots' | null>(null);
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [preview, setPreview] = useState<{ subject: string | null; body: string; missing: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [audience, setAudience] = useState('public');
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setDrawer(null); setEditing(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const form = (e: React.FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
  const money = (n: unknown) => formatMoney(Number(n ?? 0), d.locale);
  const setParams = (patch: Record<string, string>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); } setSp(n); };
  const setParam = (k: string, v: string) => setParams({ [k]: v });

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('comm.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('comm.purpose')}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" value={d.from} onChange={e => setParam('from', e.target.value)} className="max-w-[160px]" />
          <Input type="date" value={d.to} onChange={e => setParam('to', e.target.value)} className="max-w-[160px]" />
          <Button size="sm" onClick={() => setDrawer('notice')}>{tr('comm.newNotice')}</Button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={tr('comm.sent')} value={formatNumber(d.stats.sent, d.locale)} locale={d.locale} />
        <Kpi label={tr('comm.queued')} value={formatNumber(d.stats.queued, d.locale)} locale={d.locale} />
        <Kpi label={tr('comm.failed')} value={formatNumber(d.stats.failed, d.locale)} locale={d.locale} />
        <Kpi label={tr('comm.cost')} value={money(d.stats.cost)} locale={d.locale} />
      </div>
      <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('comm.deliveredMeans')}{d.stats.deliveredPct == null ? '' : ` · ${d.stats.deliveredPct}%`}</p>
      {d.providers.some(p => p.low) && <div className="mt-4"><Banner kind="warn">{tr('comm.lowBalance')}</Banner></div>}
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      {msg && <div className="mt-4"><Banner kind="ok">{msg}</Banner></div>}

      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[{ key: 'notices', label: tr('comm.notices'), count: d.notices.length }, { key: 'log', label: tr('comm.log'), count: d.log.total }, { key: 'templates', label: tr('comm.templates'), count: d.templates.length }, { key: 'providers', label: tr('comm.providers'), count: d.providers.length }, { key: 'ptm', label: tr('comm.ptm'), count: d.slots.length }]} /></div>

      {tab === 'notices' && <div className="mt-4">
        <p className="mb-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('comm.noticeNote')}</p>
        <DataTable locale={d.locale} rows={d.notices as unknown as Record<string, unknown>[]}
          columns={[{ key: 'title', label: tr('common.name'), render: r => <span className="font-medium">{String(r.title)}</span> }, { key: 'notice_type', label: tr('common.type'), render: r => <Chip>{String(r.notice_type)}</Chip> },
            { key: 'publish_at', label: tr('comm.publishes'), render: r => formatDateTime(String(r.publish_at), d.locale) },
            { key: 'audience', label: tr('comm.audience'), render: r => { const a = (r.audience ?? {}) as Record<string, unknown>; const bits: string[] = []; if (a.public) bits.push(tr('comm.everyone')); if (a.guardians) bits.push(tr('ins.guardians')); if (a.staff) bits.push(tr('ins.staff')); if (Array.isArray(a.classIds) && a.classIds.length) bits.push(`${a.classIds.length} ${tr('acad.classes')}`); if (Array.isArray(a.sectionIds) && a.sectionIds.length) bits.push(`${a.sectionIds.length} ${tr('acad.sections')}`); if (a.withDues) bits.push(tr('ins.onlyDues')); return bits.length ? bits.join(' · ') : tr('comm.everyone'); } },
            { key: 'channels', label: tr('comm.channels'), render: r => { const chs = (r.channels ?? []) as string[]; return chs.length ? <span className="flex flex-wrap gap-1">{chs.map(c => <Chip key={c}>{c}</Chip>)}</span> : <span style={{ color: 'var(--muted)' }}>—</span>; } },
            { key: 'told', label: tr('comm.told'), className: 'num' },
            { key: 'read', label: tr('comm.read'), className: 'num' },
            { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'published' ? 'active' : String(r.status)}>{String(r.status)}</Chip> },
            { key: 'failed', label: '', render: r => Number(r.failed) ? <Chip status="failed">{`${r.failed} ${tr('comm.failed')}`}</Chip> : Number(r.queued) ? <Chip status="pending">{`${r.queued} ${tr('comm.queued')}`}</Chip> : null }]}
          empty={<p className="p-4 text-sm" style={{ color: 'var(--muted)' }}>{tr('comm.noNotices')}</p>} />
      </div>}

      {tab === 'log' && <div className="mt-4">
        <div className="flex flex-wrap gap-2">
          {d.stats.byChannel.map(c => <span key={c.channel} className="chip">{c.channel}: <strong className="num">{formatNumber(c.count, d.locale)}</strong>{c.cost ? <> · {money(c.cost)}</> : null}{c.failed ? <> · {c.failed} {tr('comm.failed')}</> : null}</span>)}
        </div>
        <div className="mt-4"><DataTable locale={d.locale} rows={d.log.rows} total={d.log.total} pageSize={50} page={d.page} onPage={p => setParam('page', String(p))}
          toolbar={<div className="flex flex-wrap gap-2">
            <Select value={d.channel} onChange={e => setParams({ page: '', channel: e.target.value })} placeholder={tr('comm.allChannels')} options={CHANNELS.map(c => ({ value: c, label: c }))} className="max-w-[150px]" />
            <Select value={d.status} onChange={e => setParams({ page: '', status: e.target.value })} placeholder={tr('comm.allStatuses')} options={['queued', 'sent', 'delivered', 'failed', 'read'].map(s => ({ value: s, label: s }))} className="max-w-[150px]" />
          </div>}
          columns={[{ key: 'created_at', label: tr('common.date'), render: r => formatDateTime(String(r.created_at), d.locale) },
            { key: 'recipient_name', label: tr('comm.recipient'), render: r => String(r.recipient_name ?? r.recipient_address ?? '—') },
            { key: 'channel', label: tr('comm.channel'), render: r => <Chip>{String(r.channel)}</Chip> },
            { key: 'event_key', label: tr('comm.event'), className: 'num' },
            { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'failed' ? 'failed' : ['sent', 'delivered', 'read'].includes(String(r.status)) ? 'active' : 'pending'}>{String(r.status)}</Chip> },
            { key: 'attempts', label: tr('comm.attempts'), className: 'num' },
            { key: 'cost', label: tr('comm.cost'), className: 'num money', render: r => r.cost == null || !Number(r.cost) ? '—' : money(r.cost) },
            { key: 'error', label: '', render: r => String(r.status) === 'failed' ? <div className="flex items-center gap-2"><span className="text-xs" style={{ color: 'var(--bad)' }}>{String(r.error ?? '')}</span><Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => api(`/api/comms/notifications/${r.id}/retry`, { method: 'POST', json: {} }))}>{tr('comm.retry')}</Button></div> : null }]}
          empty={<p className="p-4 text-sm" style={{ color: 'var(--muted)' }}>{tr('comm.noMessages')}</p>} /></div>
      </div>}

      {tab === 'templates' && <div className="mt-4">
        <p className="mb-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('comm.templateNote')}</p>
        <DataTable locale={d.locale} rows={d.templates as unknown as Record<string, unknown>[]}
          toolbar={<Button size="sm" onClick={() => { setEditing(null); setPreview(null); setDrawer('template'); }}>{tr('comm.newTemplate')}</Button>}
          onRowClick={r => { setEditing(r); setPreview(null); setDrawer('template'); }}
          columns={[{ key: 'event_key', label: tr('comm.event'), className: 'num' }, { key: 'channel', label: tr('comm.channel'), render: r => <Chip>{String(r.channel)}</Chip> }, { key: 'locale', label: tr('comm.language') }, { key: 'subject', label: tr('comm.subject'), render: r => String(r.subject ?? '—') },
            { key: 'body', label: tr('comm.body'), render: r => <span className="block max-w-[420px] whitespace-normal text-xs">{String(r.body).slice(0, 200)}</span> },
            { key: 'placeholders', label: tr('comm.placeholders'), render: r => <span className="flex flex-wrap gap-1">{((r.placeholders ?? []) as string[]).map(p => <Chip key={p}>{p}</Chip>)}</span> },
            { key: 'is_active', label: tr('common.status'), render: r => <Chip status={r.is_active ? 'active' : 'pending'}>{r.is_active ? tr('comm.on') : tr('comm.off')}</Chip> },
            { key: 'id', label: '', render: r => <Button size="sm" variant="secondary" disabled={busy} onClick={ev => { ev.stopPropagation(); run(() => api(`/api/comms/templates/${r.id}`, { method: 'PATCH', json: { isActive: !r.is_active } })); }}>{r.is_active ? tr('comm.turnOff') : tr('comm.turnOn')}</Button> }]} />
      </div>}

      {tab === 'providers' && <div className="mt-4">
        <p className="mb-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('comm.providerNote')}</p>
        <DataTable locale={d.locale} searchable={false} rows={d.providers as unknown as Record<string, unknown>[]}
          toolbar={<Button size="sm" onClick={() => { setEditing(null); setDrawer('provider'); }}>{tr('comm.newProvider')}</Button>}
          onRowClick={r => { setEditing(r); setDrawer('provider'); }}
          columns={[{ key: 'channel', label: tr('comm.channel'), render: r => <Chip>{String(r.channel)}</Chip> }, { key: 'provider', label: tr('comm.provider') }, { key: 'sender_id', label: tr('comm.senderId'), className: 'num', render: r => String(r.sender_id ?? '—') },
            { key: 'balance', label: tr('comm.balance'), className: 'num', render: r => r.balance == null ? '—' : <span style={r.low ? { color: 'var(--bad)' } : undefined}>{formatNumber(Number(r.balance), d.locale)}</span> },
            { key: 'low_balance_threshold', label: tr('comm.threshold'), className: 'num', render: r => r.low_balance_threshold == null ? '—' : formatNumber(Number(r.low_balance_threshold), d.locale) },
            { key: 'cost_per_unit', label: tr('comm.perMessage'), className: 'num money', render: r => r.cost_per_unit == null ? '—' : money(r.cost_per_unit) },
            { key: 'hasCredentials', label: tr('comm.credentials'), render: r => <Chip status={r.hasCredentials ? 'active' : 'pending'}>{r.hasCredentials ? tr('comm.credentialsSet') : tr('comm.credentialsMissing')}</Chip> },
            { key: 'is_default', label: '', render: r => <Chip status={r.is_default ? 'active' : ''}>{r.is_default ? tr('comm.default') : tr('comm.fallback')}</Chip> },
            { key: 'is_active', label: '', render: r => <Chip status={r.is_active ? 'active' : 'pending'}>{r.is_active ? tr('comm.on') : tr('comm.off')}</Chip> }]}
          empty={<p className="p-4 text-sm" style={{ color: 'var(--muted)' }}>{tr('comm.noProviders')}</p>} />
        <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('comm.secretNote')}</p>
      </div>}

      {tab === 'ptm' && <div className="mt-4">
        <p className="mb-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('comm.ptmNote')}</p>
        <DataTable locale={d.locale} rows={d.slots}
          toolbar={<Button size="sm" onClick={() => setDrawer('slots')}>{tr('ptm.create')}</Button>}
          columns={[{ key: 'starts_at', label: tr('comm.slot'), render: r => `${formatDateTime(String(r.starts_at), d.locale)} – ${String(r.ends_at).slice(11, 16)}` },
            { key: 'first_name', label: tr('comm.teacher'), render: r => `${r.first_name} ${r.last_name ?? ''}` },
            { key: 'room_name', label: tr('inst.room'), render: r => String(r.room_name ?? String(r.mode)) },
            { key: 'capacity', label: tr('acad.capacity'), className: 'num' },
            { key: 'booked', label: tr('ptm.booked'), className: 'num' },
            { key: 'x', label: '', render: r => Number(r.booked) >= Number(r.capacity) ? <Chip status="active">{tr('comm.full')}</Chip> : Number(r.booked) ? <Chip status="pending">{tr('comm.partlyBooked')}</Chip> : <Chip>{tr('comm.open')}</Chip> }]}
          empty={<p className="p-4 text-sm" style={{ color: 'var(--muted)' }}>{tr('comm.noSlots')}</p>} />
        <h2 className="mb-2 mt-6 text-base">{tr('comm.whoBooked')}</h2>
        <DataTable locale={d.locale} rows={d.bookings}
          columns={[{ key: 'starts_at', label: tr('comm.slot'), render: r => formatDateTime(String(r.starts_at), d.locale) },
            { key: 'student_first', label: tr('nav.students'), render: r => `${r.student_first} ${r.student_last ?? ''}` },
            { key: 'teacher_first', label: tr('comm.teacher'), render: r => `${r.teacher_first} ${r.teacher_last ?? ''}` },
            { key: 'mode', label: tr('common.type'), render: r => <Chip>{String(r.mode)}</Chip> },
            { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'booked' ? 'active' : String(r.status)}>{String(r.status)}</Chip> }]}
          empty={<p className="p-4 text-sm" style={{ color: 'var(--muted)' }}>{tr('comm.noBookings')}</p>} />
      </div>}

      <Drawer open={drawer === 'notice'} onClose={() => setDrawer(null)} title={tr('comm.newNotice')}>
        <form className="grid gap-3" onSubmit={e => {
          e.preventDefault(); const f = form(e);
          const channels = CHANNELS.filter(c => f[`ch_${c}`] === 'on');
          run(async () => {
            if (audience === 'public') {
              await api('/api/cms/notices', { method: 'POST', json: { title: f.title, body: f.body, noticeType: f.noticeType, isPinned: f.isPinned === 'on', publishAt: f.publishAt ? `${f.publishAt.replace('T', ' ')}:00` : null } });
              setMsg(f.publishAt ? tr('comm.scheduled') : tr('comm.published'));
            } else {
              const a: Record<string, unknown> = audience === 'staff' ? { staff: true } : audience === 'dues' ? { guardians: true, withDues: true } : audience === 'section' ? { sectionIds: [f.sectionId] } : { guardians: true };
              const r = await api<{ recipients: number }>('/api/comms/broadcast', { method: 'POST', json: { title: f.title, body: f.body, noticeType: f.noticeType, channels: channels.length ? channels : ['push', 'in_app'], audience: a } });
              setMsg(`${formatNumber(r.recipients, d.locale)} ${tr('ins.recipients')}`);
            }
          });
        }}>
          <Field label={tr('common.name')}><Input name="title" required maxLength={200} /></Field>
          <Field label={tr('site.message')}><Textarea name="body" required rows={5} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('common.type')}><Select name="noticeType" options={['general', 'academic', 'exam', 'fee', 'holiday', 'urgent', 'event'].map(v => ({ value: v, label: v }))} /></Field>
            <Field label={tr('comm.audience')}><Select value={audience} onChange={e => setAudience(e.target.value)} options={[{ value: 'public', label: tr('comm.everyone') }, { value: 'guardians', label: tr('ins.guardians') }, { value: 'section', label: tr('common.section') }, { value: 'staff', label: tr('ins.staff') }, { value: 'dues', label: tr('ins.onlyDues') }]} /></Field>
          </div>
          {audience === 'section' && <Field label={tr('common.section')}><Select name="sectionId" required placeholder="—" options={d.sections.map(s => ({ value: String(s.id), label: `${s.class_name} ${s.name}` }))} /></Field>}
          {audience === 'public' && <div className="grid grid-cols-2 gap-3">
            <Field label={tr('comm.schedule')} hint={tr('comm.scheduleHint')}><Input name="publishAt" type="datetime-local" /></Field>
            <Field label={tr('comm.pin')}><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isPinned" /> {tr('comm.pinHint')}</label></Field>
          </div>}
          {audience !== 'public' && <Field label={tr('comm.channels')} hint={tr('comm.channelHint')}>
            <div className="flex flex-wrap gap-3 text-sm">{(['push', 'in_app', 'sms', 'email', 'whatsapp', 'voice'] as const).map(c => <label key={c} className="flex items-center gap-1"><input type="checkbox" name={`ch_${c}`} defaultChecked={c === 'push' || c === 'in_app'} /> {c}</label>)}</div>
          </Field>}
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{audience === 'public' ? tr('comm.publicNote') : tr('comm.targetedNote')}</p>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'template'} onClose={() => { setDrawer(null); setEditing(null); setPreview(null); }} title={tr('comm.templates')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api('/api/comms/templates', { method: 'POST', json: { eventKey: f.eventKey, channel: f.channel, locale: f.locale, subject: f.subject || null, body: f.body, isActive: f.isActive === 'on' } })); }}>
          <div className="grid grid-cols-3 gap-3">
            <Field label={tr('comm.event')}><Input name="eventKey" required defaultValue={String(editing?.event_key ?? '')} readOnly={!!editing} className="num" /></Field>
            <Field label={tr('comm.channel')}><Select name="channel" defaultValue={String(editing?.channel ?? 'sms')} options={CHANNELS.map(c => ({ value: c, label: c }))} /></Field>
            <Field label={tr('comm.language')}><Select name="locale" defaultValue={String(editing?.locale ?? 'bn')} options={[{ value: 'bn', label: 'বাংলা' }, { value: 'en', label: 'English' }]} /></Field>
          </div>
          <Field label={tr('comm.subject')}><Input name="subject" defaultValue={String(editing?.subject ?? '')} maxLength={200} /></Field>
          <Field label={tr('comm.body')} hint={tr('comm.bodyHint')}><Textarea name="body" required rows={6} defaultValue={String(editing?.body ?? '')} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isActive" defaultChecked={editing ? !!editing.is_active : true} /> {tr('comm.activeHint')}</label>
          <div className="flex gap-2">
            <Button disabled={busy}>{tr('common.save')}</Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={async () => {
              const el = document.querySelector<HTMLTextAreaElement>('textarea[name="body"]'); if (!el) return;
              setErr(null);
              try { setPreview(await api('/api/comms/templates/preview', { method: 'POST', json: { body: el.value, sample: { student: 'Rahim', amount: 1200, due: d.to, month: d.to.slice(0, 7), name: 'Rahim', date: d.to } } })); } catch (e2) { setErr((e2 as Error).message); }
            }}>{tr('comm.preview')}</Button>
          </div>
          {preview && <div className="card p-3 text-sm">
            {preview.subject && <div className="font-medium">{preview.subject}</div>}
            <p className="whitespace-pre-wrap">{preview.body}</p>
            {preview.missing.length > 0 && <p className="mt-2 text-xs" style={{ color: 'var(--warn)' }}>{tr('comm.missingVars')}: {preview.missing.join(', ')}</p>}
          </div>}
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('comm.templateSaveNote')}</p>
        </form>
      </Drawer>

      <Drawer open={drawer === 'provider'} onClose={() => { setDrawer(null); setEditing(null); }} title={tr('comm.providers')}>
        <form className="grid gap-3" onSubmit={e => {
          e.preventDefault(); const f = form(e);
          const credentials: Record<string, string> = {};
          for (const [k, v] of Object.entries(f)) if (k.startsWith('cred_') && v) credentials[k.slice(5)] = v;
          run(() => api('/api/comms/providers', { method: 'POST', json: { id: editing ? String(editing.id) : undefined, channel: f.channel, provider: f.provider, senderId: f.senderId || null, credentials: Object.keys(credentials).length ? credentials : null, isDefault: f.isDefault === 'on', isActive: f.isActive === 'on', lowBalanceThreshold: f.lowBalanceThreshold ? Number(f.lowBalanceThreshold) : null, costPerUnit: f.costPerUnit ? Number(f.costPerUnit) : null } }));
        }}>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('comm.channel')}><Select name="channel" defaultValue={String(editing?.channel ?? 'sms')} options={['sms', 'email', 'push', 'whatsapp', 'voice'].map(c => ({ value: c, label: c }))} /></Field>
            <Field label={tr('comm.provider')}><Input name="provider" required defaultValue={String(editing?.provider ?? '')} maxLength={60} /></Field>
          </div>
          <Field label={tr('comm.senderId')}><Input name="senderId" defaultValue={String(editing?.sender_id ?? '')} maxLength={80} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('comm.threshold')} hint={tr('comm.thresholdHint')}><Input name="lowBalanceThreshold" type="number" step="1" min="0" className="num" defaultValue={editing?.low_balance_threshold == null ? '' : String(editing.low_balance_threshold)} /></Field>
            <Field label={tr('comm.perMessage')}><Input name="costPerUnit" type="number" step="0.0001" min="0" className="num" defaultValue={editing?.cost_per_unit == null ? '' : String(editing.cost_per_unit)} /></Field>
          </div>
          <Field label={tr('comm.apiKey')} hint={tr('comm.apiKeyHint')}><Input name="cred_apiKey" type="password" autoComplete="off" /></Field>
          <Field label={tr('comm.apiSecret')}><Input name="cred_apiSecret" type="password" autoComplete="off" /></Field>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" name="isDefault" defaultChecked={!!editing?.is_default} /> {tr('comm.defaultHint')}</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="isActive" defaultChecked={editing ? !!editing.is_active : true} /> {tr('comm.on')}</label>
          </div>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('comm.secretNote')}</p>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'slots'} onClose={() => setDrawer(null)} title={tr('ptm.create')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(async () => { const r = await api<{ created: number }>('/api/ptm/slots', { method: 'POST', json: { teacherId: f.teacherId, date: f.date, startTime: f.startTime, endTime: f.endTime, minutes: Number(f.minutes), capacity: Number(f.capacity) || 1, mode: f.mode } }); setMsg(`${formatNumber(r.created, d.locale)} ${tr('ptm.slots')}`); }); }}>
          <Field label={tr('comm.teacher')}><Select name="teacherId" required placeholder="—" options={d.teachers.map(s => ({ value: String(s.id), label: `${s.first_name} ${s.last_name ?? ''}` }))} /></Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label={tr('common.date')}><Input name="date" type="date" required defaultValue={d.to} /></Field>
            <Field label={tr('inst.from')}><Input name="startTime" type="time" required defaultValue="09:00" /></Field>
            <Field label={tr('inst.to')}><Input name="endTime" type="time" required defaultValue="12:00" /></Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label={tr('lrn.minutes')}><Input name="minutes" type="number" min="5" max="120" defaultValue={15} className="num" /></Field>
            <Field label={tr('acad.capacity')}><Input name="capacity" type="number" min="1" max="20" defaultValue={1} className="num" /></Field>
            <Field label={tr('common.type')}><Select name="mode" options={[{ value: 'in_person', label: tr('comm.inPerson') }, { value: 'online', label: tr('comm.online') }]} /></Field>
          </div>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('comm.slotNote')}</p>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <p className="mt-6 text-xs" style={{ color: 'var(--muted)' }}>{formatDate(d.from, d.locale)} – {formatDate(d.to, d.locale)}</p>
    </div>
  );
}
