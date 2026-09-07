import { useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/operations';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Kpi, Select, Tabs, api, formatDate, formatMoney, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id; const url = new URL(request.url);
  const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
  const [books, issues, routes, trips, hostels, residents, outpasses, stock, purchaseOrders, visitors, complaints, stores] = await Promise.all([
    context.app.library.books(sid), context.app.library.issues(sid, { overdueOnly: false }),
    context.app.transport.routes(sid), context.app.transport.trips(sid, date),
    context.app.hostel.hostels(sid), context.app.hostel.residents(sid), context.app.hostel.outpasses(sid),
    context.app.inventory.stock(sid), context.app.inventory.purchaseOrders(sid),
    context.app.frontOffice.visitors(sid, date), context.app.frontOffice.complaints(sid),
    context.app.inventory.stores(sid),
  ]);
  // the voice line: the register it wrote, the menu a guardian hears, and whether the gateway has a
  // secret to send. The secret itself is never read back out of the settings row.
  const [ivrCalls, ivrSchool, ivrSecret] = await Promise.all([
    context.app.ivr.calls(sid, 100),
    context.app.db.findOne('schools', { id: sid }),
    context.app.settings.get<{ enc?: string }>(sid, 'ivr.webhook_secret'),
  ]);
  const ivrMenu = ivrSchool ? context.app.ivr.menu(ivrSchool) : null;
  const ivrPhone = ivrSchool && ivrSchool.phone ? String(ivrSchool.phone) : null;
  return { locale: (user.locale as Locale) || context.locale, date, books, issues, routes, trips, hostels, residents, outpasses, stock, purchaseOrders, visitors, complaints, stores, ivrCalls, ivrMenu, ivrPhone, ivrSecretSet: !!ivrSecret?.enc };
}
export function meta() { return [{ title: 'Pathshala — Operations' }]; }

export default function Operations() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator(); const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<'library' | 'transport' | 'hostel' | 'inventory' | 'frontoffice' | 'ivr'>('library');
  const [drawer, setDrawer] = useState<null | 'book' | 'issue' | 'route' | 'hostel' | 'item' | 'visitor' | 'complaint'>(null);
  const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  // only ever what the rotate call handed back, and only until the page is left: the secret the
  // office typed is never held here, and the server never returns it
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setDrawer(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const money = (n: unknown) => formatMoney(Number(n ?? 0), d.locale);
  const overdue = d.issues.filter(i => String(i.status) === 'overdue').length;
  const openTickets = d.complaints.filter(c => ['open', 'in_progress'].includes(String(c.status))).length;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('ops.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('ops.purpose')}</p></div>
        <Input type="date" value={d.date} onChange={e => { const n = new URLSearchParams(sp); n.set('date', e.target.value); setSp(n); }} className="max-w-[180px]" />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label={tr('ops.booksOut')} value={d.issues.filter(i => ['issued', 'overdue'].includes(String(i.status))).length} locale={d.locale} />
        <Kpi label={tr('ops.overdue')} value={overdue} locale={d.locale} />
        <Kpi label={tr('ops.tripsToday')} value={d.trips.length} locale={d.locale} />
        <Kpi label={tr('ops.residents')} value={d.residents.length} locale={d.locale} />
        <Kpi label={tr('ops.openTickets')} value={openTickets} locale={d.locale} />
      </div>
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      {msg && <div className="mt-4"><Banner kind="ok">{msg}</Banner></div>}

      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[
        { key: 'library', label: tr('ops.library'), count: d.books.length },
        { key: 'transport', label: tr('ops.transport'), count: d.routes.length },
        { key: 'hostel', label: tr('ops.hostel'), count: d.hostels.length },
        { key: 'inventory', label: tr('ops.inventory'), count: d.stock.length },
        { key: 'frontoffice', label: tr('ops.frontOffice'), count: d.visitors.length },
        { key: 'ivr', label: tr('ivr.tab'), count: d.ivrCalls.length },
      ]} /></div>

      {tab === 'library' && <div className="mt-4">
        <div className="mb-3 flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setDrawer('issue')}>{tr('ops.issueBook')}</Button>
          <Button size="sm" onClick={() => setDrawer('book')}>{tr('ops.newBook')}</Button>
        </div>
        <DataTable locale={d.locale} rows={d.issues} columns={[
          { key: 'accession_no', label: tr('ops.accession'), className: 'num' },
          { key: 'title', label: tr('ops.book') },
          { key: 'first_name', label: tr('ops.borrower'), render: r => `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || String(r.card_no) },
          { key: 'due_at', label: tr('ops.due'), render: r => formatDate(String(r.due_at).slice(0, 10), d.locale) },
          { key: 'fine_amount', label: tr('ops.fine'), className: 'num', render: r => money(r.fine_amount) },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'overdue' ? 'failed' : String(r.status) === 'returned' ? 'active' : 'pending'}>{String(r.status)}</Chip> },
          { key: 'id', label: '', render: r => ['issued', 'overdue'].includes(String(r.status)) ? <Button size="sm" onClick={() => run(async () => { const x = await api<{ fine: number }>('/api/library/return', { method: 'POST', json: { issueId: String(r.id) } }); setMsg(x.fine > 0 ? `${tr('ops.returned')} · ${tr('ops.fine')} ${money(x.fine)}` : tr('ops.returned')); })}>{tr('ops.return')}</Button> : null },
        ]} />
        <h2 className="mt-6 text-lg">{tr('ops.catalogue')}</h2>
        <DataTable locale={d.locale} rows={d.books} columns={[
          { key: 'title', label: tr('ops.book') },
          { key: 'category_name', label: tr('common.type') },
          { key: 'total_copies', label: tr('ops.copies'), className: 'num' },
          { key: 'available_copies', label: tr('ops.available'), className: 'num' },
        ]} />
      </div>}

      {tab === 'transport' && <div className="mt-4">
        <div className="mb-3 flex justify-end gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => { const r = await api<{ trips: number }>('/api/transport/trips', { method: 'POST', json: { date: d.date } }); setMsg(`${r.trips} ${tr('ops.tripsToday').toLowerCase()}`); })}>{tr('ops.makeTrips')}</Button>
          <Button size="sm" onClick={() => setDrawer('route')}>{tr('ops.newRoute')}</Button>
        </div>
        <DataTable locale={d.locale} rows={d.trips} columns={[
          { key: 'route_name', label: tr('ops.route') },
          { key: 'registration_no', label: tr('ops.vehicle') },
          { key: 'trip_type', label: tr('common.type') },
          { key: 'scheduled_start', label: tr('ops.start'), render: r => String(r.scheduled_start ?? '—').slice(0, 5) },
          { key: 'boarded', label: tr('ops.onBoard'), className: 'num' },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'completed' ? 'active' : String(r.status) === 'delayed' ? 'failed' : 'pending'}>{String(r.status)}</Chip> },
          { key: 'id', label: '', render: r => String(r.status) === 'scheduled' || String(r.status) === 'delayed' ? <Button size="sm" variant="secondary" onClick={() => run(() => api(`/api/transport/trips/${r.id}/start`, { method: 'POST', json: {} }))}>{tr('ops.startTrip')}</Button> : String(r.status) === 'running' ? <Button size="sm" onClick={() => run(async () => { const x = await api<{ stillOnBoard: number }>(`/api/transport/trips/${r.id}/end`, { method: 'POST', json: {} }); setMsg(x.stillOnBoard ? `${x.stillOnBoard} ${tr('ops.stillOnBoard')}` : tr('ops.tripEnded')); })}>{tr('ops.endTrip')}</Button> : null },
        ]} />
        <h2 className="mt-6 text-lg">{tr('ops.routes')}</h2>
        <DataTable locale={d.locale} rows={d.routes} columns={[
          { key: 'name', label: tr('ops.route') },
          { key: 'registration_no', label: tr('ops.vehicle') },
          { key: 'stops', label: tr('ops.stops'), className: 'num' },
          { key: 'riders', label: tr('ops.riders'), className: 'num' },
          { key: 'monthly_fee', label: tr('ops.monthlyFee'), className: 'num', render: r => money(r.monthly_fee) },
        ]} />
      </div>}

      {tab === 'hostel' && <div className="mt-4">
        <div className="mb-3 flex justify-end gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => { const month = prompt('Which month? (YYYY-MM)', new Date(Date.now() - 15 * 86_400_000).toISOString().slice(0, 7)); if (month) run(async () => { const r = await api<{ billed: number; skipped: number; total: number }>('/api/hostel/mess/bill', { method: 'POST', json: { month } }); setMsg(`${r.billed} invoiced, ${r.skipped} already billed · ${money(r.total)}`); }); }}>{tr('ops.messBill')}</Button>
          <Button size="sm" onClick={() => setDrawer('hostel')}>{tr('ops.newHostel')}</Button>
        </div>
        <DataTable locale={d.locale} rows={d.hostels} columns={[
          { key: 'name', label: tr('common.name') },
          { key: 'hostel_type', label: tr('common.type') },
          { key: 'rooms', label: tr('ops.rooms'), className: 'num' },
          { key: 'beds', label: tr('ops.beds'), className: 'num' },
          { key: 'occupied', label: tr('ops.occupied'), className: 'num' },
          { key: 'curfew_time', label: tr('ops.curfew'), render: r => String(r.curfew_time ?? '—').slice(0, 5) },
        ]} />
        <h2 className="mt-6 text-lg">{tr('ops.outpasses')}</h2>
        <DataTable locale={d.locale} rows={d.outpasses} columns={[
          { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` },
          { key: 'leave_from', label: tr('ops.leaves'), render: r => String(r.leave_from).slice(0, 16) },
          { key: 'expected_return', label: tr('ops.returns'), render: r => String(r.expected_return).slice(0, 16) },
          { key: 'guardian_consent_at', label: tr('ops.consent'), render: r => <Chip status={r.guardian_consent_at ? 'active' : 'pending'}>{r.guardian_consent_at ? tr('ops.given') : tr('ops.waiting')}</Chip> },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={['returned', 'approved'].includes(String(r.status)) ? 'active' : String(r.status) === 'late' ? 'failed' : 'pending'}>{String(r.status)}</Chip> },
          { key: 'id', label: '', render: r => String(r.status) === 'pending' && r.guardian_consent_at ? <Button size="sm" onClick={() => run(() => api(`/api/hostel/outpasses/${r.id}/approve`, { method: 'POST', json: {} }))}>{tr('ops.approve')}</Button> : null },
        ]} />
      </div>}

      {tab === 'inventory' && <div className="mt-4">
        <div className="mb-3 flex justify-end"><Button size="sm" onClick={() => setDrawer('item')}>{tr('ops.newItem')}</Button></div>
        <DataTable locale={d.locale} rows={d.stock} columns={[
          { key: 'sku', label: 'SKU', className: 'num' },
          { key: 'name', label: tr('common.name') },
          { key: 'store_name', label: tr('ops.store') },
          { key: 'quantity', label: tr('ops.quantity'), className: 'num', render: r => `${Number(r.quantity)} ${r.unit}` },
          { key: 'reorder_level', label: tr('ops.reorderAt'), className: 'num', render: r => Number(r.quantity) <= Number(r.reorder_level) ? <Chip status="failed">{String(Number(r.reorder_level))}</Chip> : String(Number(r.reorder_level)) },
        ]} />
        <h2 className="mt-6 text-lg">{tr('ops.purchaseOrders')}</h2>
        <DataTable locale={d.locale} rows={d.purchaseOrders} columns={[
          { key: 'po_no', label: tr('ops.poNo'), className: 'num' },
          { key: 'vendor_name', label: tr('ops.vendor') },
          { key: 'total', label: tr('ops.value'), className: 'num', render: r => money(r.total) },
          { key: 'is_auto', label: tr('ops.raisedBy'), render: r => Number(r.is_auto) ? <Chip status="active">{tr('ops.automatic')}</Chip> : tr('ops.byHand') },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'received' ? 'active' : 'pending'}>{String(r.status)}</Chip> },
        ]} />
      </div>}

      {tab === 'frontoffice' && <div className="mt-4">
        <div className="mb-3 flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setDrawer('complaint')}>{tr('ops.newTicket')}</Button>
          <Button size="sm" onClick={() => setDrawer('visitor')}>{tr('ops.checkIn')}</Button>
        </div>
        <DataTable locale={d.locale} rows={d.visitors} columns={[
          { key: 'badge_no', label: tr('ops.badge'), className: 'num' },
          { key: 'visitor_name', label: tr('common.name') },
          { key: 'purpose', label: tr('ops.purposeCol') },
          { key: 'host_first', label: tr('ops.toMeet'), render: r => `${r.host_first ?? ''} ${r.host_last ?? ''}`.trim() || '—' },
          { key: 'in_at', label: tr('ops.in'), render: r => String(r.in_at).slice(11, 16) },
          { key: 'out_at', label: tr('ops.out'), render: r => r.out_at ? String(r.out_at).slice(11, 16) : <Button size="sm" variant="secondary" onClick={() => run(() => api(`/api/frontoffice/visitors/${r.id}/out`, { method: 'POST', json: {} }))}>{tr('ops.checkOut')}</Button> },
        ]} />
        <h2 className="mt-6 text-lg">{tr('ops.tickets')}</h2>
        <DataTable locale={d.locale} rows={d.complaints} columns={[
          { key: 'ticket_no', label: tr('ops.ticket'), className: 'num' },
          { key: 'category', label: tr('common.type') },
          { key: 'subject', label: tr('ops.subject') },
          { key: 'priority', label: tr('ops.priority'), render: r => <Chip status={String(r.priority) === 'urgent' ? 'failed' : 'pending'}>{String(r.priority)}</Chip> },
          { key: 'sla_due_at', label: tr('ops.dueBy'), render: r => String(r.sla_due_at ?? '').slice(0, 16) },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={['resolved', 'closed'].includes(String(r.status)) ? 'active' : r.escalated_at ? 'failed' : 'pending'}>{String(r.status)}</Chip> },
          { key: 'id', label: '', render: r => ['open', 'in_progress'].includes(String(r.status)) ? <Button size="sm" onClick={() => run(() => api(`/api/frontoffice/complaints/${r.id}`, { method: 'POST', json: { status: 'resolved', resolution: 'Handled at the front desk.', note: 'Resolved.' } }))}>{tr('ops.resolve')}</Button> : null },
        ]} />
      </div>}

      {tab === 'ivr' && <div className="mt-4">
        <Banner kind="info">{tr('ivr.note')}</Banner>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <div className="card p-4">
            <div className="kpi-label">{tr('ivr.line')}</div>
            <p className="mt-2 text-sm">{tr('ivr.ringNumber')}: <span className="num">{d.ivrPhone ?? tr('ivr.noPhone')}</span></p>
            <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('ivr.gatewayNote')}</p>
            <p className="mt-3 flex items-center gap-2 text-sm">{tr('ivr.secret')}: <Chip status={d.ivrSecretSet ? 'active' : 'failed'}>{d.ivrSecretSet ? tr('ivr.secretSet') : tr('ivr.secretMissing')}</Chip></p>
            <form className="mt-3 grid gap-3" onSubmit={e => {
              e.preventDefault(); const form = e.currentTarget; const secret = String(new FormData(form).get('secret') ?? '');
              run(async () => { const x = await api<{ configured: boolean; webhookUrl: string }>('/api/ivr/secret', { method: 'POST', json: { secret } }); form.reset(); setWebhookUrl(x.webhookUrl); setMsg(tr('ivr.webhookShown')); });
            }}>
              <Field label={tr('ivr.secret')} hint={tr('ivr.secretHint')}><Input name="secret" type="password" minLength={12} maxLength={200} required autoComplete="off" /></Field>
              <div><Button size="sm" disabled={busy}>{tr('ivr.saveSecret')}</Button></div>
            </form>
            {webhookUrl && <div className="mt-3"><Banner kind="ok"><span className="block text-xs">{tr('ivr.webhook')}</span><code className="break-all text-xs">{webhookUrl}</code></Banner></div>}
          </div>
          <div className="card p-4">
            <div className="kpi-label">{tr('ivr.menu')}</div>
            <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('ivr.menuNote')}</p>
            {d.ivrMenu && <>
              <p className="mt-3 text-sm">{tr('ivr.welcomeLine')}: “{d.ivrMenu.welcome}”</p>
              <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('ivr.language')}: {d.ivrMenu.locale}</p>
              <ul className="mt-3 grid gap-2 text-sm">{d.ivrMenu.choices.map(c => <li key={c.key} className="flex items-start gap-2"><span className="chip num">{c.key}</span><span>{c.says} <span className="text-xs" style={{ color: 'var(--muted)' }}>({c.topic})</span></span></li>)}</ul>
            </>}
          </div>
        </div>
        <h2 className="mt-6 text-lg">{tr('ivr.calls')}</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('ivr.callsNote')}</p>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.ivrCalls} columns={[
          { key: 'called_at', label: tr('ivr.when'), render: r => String(r.called_at ?? '').slice(0, 16) },
          { key: 'caller_name', label: tr('ivr.caller'), render: r => r.caller_name ? String(r.caller_name) : <span style={{ color: 'var(--muted)' }}>{tr('ivr.unknownCaller')}</span> },
          { key: 'phone', label: tr('common.phone'), className: 'num', render: r => String(r.phone ?? '') },
          { key: 'purpose', label: tr('ivr.asked'), render: r => String(r.purpose ?? '—') },
          { key: 'notes', label: tr('ivr.said'), render: r => { const said = String(r.notes ?? '').split('\n').filter(Boolean); return said.length ? said[said.length - 1] : '—'; } },
          { key: 'follow_up_at', label: tr('ivr.ended'), render: r => r.follow_up_at ? <Chip status="pending">{tr('ivr.callbackWanted')}</Chip> : String(r.notes ?? '').includes('[-]') ? <Chip status="failed">{tr('ivr.turnedAway')}</Chip> : <Chip status="active">{tr('ivr.answered')}</Chip> },
        ]} /></div>
      </div>}

      <Drawer open={drawer === 'book'} onClose={() => setDrawer(null)} title={tr('ops.newBook')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/library/books', { method: 'POST', json: { title: f.title, isbn: f.isbn || null, authors: f.authors ? f.authors.split(',').map(x => x.trim()) : [], price: Number(f.price || 0), copies: Number(f.copies || 1) } })); }}>
          <Field label={tr('ops.book')}><Input name="title" required /></Field>
          <Field label={tr('ops.authors')} hint={tr('ops.authorsHint')}><Input name="authors" /></Field>
          <div className="grid grid-cols-3 gap-3"><Field label="ISBN"><Input name="isbn" className="num" /></Field><Field label={tr('ops.price')}><Input name="price" type="number" className="num" /></Field><Field label={tr('ops.copies')}><Input name="copies" type="number" className="num" defaultValue="1" /></Field></div>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'issue'} onClose={() => setDrawer(null)} title={tr('ops.issueBook')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(async () => { const x = await api<{ dueAt: string }>('/api/library/issues', { method: 'POST', json: { accessionNo: f.accessionNo, memberId: f.memberId } }); setMsg(`${tr('ops.due')} ${x.dueAt}`); }); }}>
          <Field label={tr('ops.accession')} hint={tr('ops.accessionHint')}><Input name="accessionNo" required className="num" /></Field>
          <Field label={tr('ops.memberId')}><Input name="memberId" required /></Field>
          <Button disabled={busy}>{tr('ops.issueBook')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'route'} onClose={() => setDrawer(null)} title={tr('ops.newRoute')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/transport/routes', { method: 'POST', json: { name: f.name, monthlyFee: Number(f.monthlyFee || 0), stops: f.stops ? f.stops.split(',').map((s, i) => ({ name: s.trim(), sequence: i + 1, pickupTime: f.pickupTime || null })) : [] } })); }}>
          <Field label={tr('ops.route')}><Input name="name" required /></Field>
          <Field label={tr('ops.stops')} hint={tr('ops.stopsHint')}><Input name="stops" /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('ops.monthlyFee')}><Input name="monthlyFee" type="number" className="num" /></Field><Field label={tr('ops.pickupTime')}><Input name="pickupTime" type="time" /></Field></div>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'hostel'} onClose={() => setDrawer(null)} title={tr('ops.newHostel')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/hostel', { method: 'POST', json: { name: f.name, hostelType: f.hostelType, curfewTime: f.curfewTime ? `${f.curfewTime}:00` : null, rooms: Array.from({ length: Number(f.roomCount || 0) }, (_, i) => ({ roomNo: String(101 + i), capacity: Number(f.capacity || 4), monthlyFee: Number(f.monthlyFee || 0) })) } })); }}>
          <Field label={tr('common.name')}><Input name="name" required /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('common.type')}><Select name="hostelType" options={[{ value: 'boys', label: 'Boys' }, { value: 'girls', label: 'Girls' }, { value: 'staff', label: 'Staff' }]} /></Field><Field label={tr('ops.curfew')}><Input name="curfewTime" type="time" defaultValue="21:00" /></Field></div>
          <div className="grid grid-cols-3 gap-3"><Field label={tr('ops.rooms')}><Input name="roomCount" type="number" className="num" defaultValue="10" /></Field><Field label={tr('ops.beds')}><Input name="capacity" type="number" className="num" defaultValue="4" /></Field><Field label={tr('ops.monthlyFee')}><Input name="monthlyFee" type="number" className="num" /></Field></div>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'item'} onClose={() => setDrawer(null)} title={tr('ops.newItem')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/inventory/items', { method: 'POST', json: { categoryId: f.categoryId, name: f.name, unit: f.unit, reorderLevel: Number(f.reorderLevel || 0), reorderQty: Number(f.reorderQty || 0) } })); }}>
          <Field label={tr('common.name')}><Input name="name" required /></Field>
          <Field label={tr('ops.category')} hint={tr('ops.categoryHint')}><Input name="categoryId" required /></Field>
          <div className="grid grid-cols-3 gap-3"><Field label={tr('ops.unit')}><Input name="unit" defaultValue="pcs" /></Field><Field label={tr('ops.reorderAt')}><Input name="reorderLevel" type="number" className="num" /></Field><Field label={tr('ops.reorderQty')}><Input name="reorderQty" type="number" className="num" /></Field></div>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'visitor'} onClose={() => setDrawer(null)} title={tr('ops.checkIn')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(async () => { const x = await api<{ badgeNo: string }>('/api/frontoffice/visitors', { method: 'POST', json: { visitorName: f.visitorName, phone: f.phone, purpose: f.purpose } }); setMsg(`${tr('ops.badge')} ${x.badgeNo}`); }); }}>
          <Field label={tr('common.name')}><Input name="visitorName" required /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('common.phone')}><Input name="phone" className="num" /></Field><Field label={tr('ops.purposeCol')}><Select name="purpose" options={[{ value: 'meeting', label: 'Meeting' }, { value: 'admission', label: 'Admission' }, { value: 'delivery', label: 'Delivery' }, { value: 'pickup', label: 'Pickup' }, { value: 'vendor', label: 'Vendor' }, { value: 'other', label: 'Other' }]} /></Field></div>
          <Button disabled={busy}>{tr('ops.checkIn')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'complaint'} onClose={() => setDrawer(null)} title={tr('ops.newTicket')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(async () => { const x = await api<{ ticketNo: string }>('/api/frontoffice/complaints', { method: 'POST', json: { category: f.category, subject: f.subject, description: f.description, priority: f.priority } }); setMsg(`${tr('ops.ticket')} ${x.ticketNo}`); }); }}>
          <Field label={tr('ops.subject')}><Input name="subject" required /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('common.type')}><Select name="category" options={['academic', 'fees', 'transport', 'hostel', 'staff_behaviour', 'facility', 'safety', 'it', 'other'].map(v => ({ value: v, label: v.replace('_', ' ') }))} /></Field>
            <Field label={tr('ops.priority')}><Select name="priority" options={[{ value: 'normal', label: 'Normal' }, { value: 'high', label: 'High' }, { value: 'urgent', label: 'Urgent' }, { value: 'low', label: 'Low' }]} /></Field>
          </div>
          <Field label={tr('common.description')}><textarea name="description" className="input" rows={4} required /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
    </div>
  );
}
