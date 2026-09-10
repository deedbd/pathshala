import { useEffect, useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/operations';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Kpi, Select, Tabs, api, formatDate, formatMoney, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

/** A school with no hostel, no bus and no store must still get the page, so every extra read is soft. */
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
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MEALS = ['breakfast', 'lunch', 'snack', 'dinner'] as const;

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id; const url = new URL(request.url);
  const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
  const [books, issues, members, reservations, routes, trips, vehicles, boardings, live, hostels, residents, outpasses, stock, purchaseOrders, movements, assets, requisitions, issueRequests, visitors, complaints, stores, gatePasses, calls, postal, docRequests, issuedDocs, templates, idCards, printJobs] = await Promise.all([
    context.app.library.books(sid), context.app.library.issues(sid, { overdueOnly: false }),
    context.app.library.members(sid), context.app.library.reservations(sid),
    context.app.transport.routes(sid), context.app.transport.trips(sid, date),
    context.app.transport.vehicles(sid), context.app.transport.boardings(sid, date), context.app.transport.live(sid, date),
    context.app.hostel.hostels(sid), context.app.hostel.residents(sid), context.app.hostel.outpasses(sid),
    context.app.inventory.stock(sid), context.app.inventory.purchaseOrders(sid),
    context.app.inventory.movements(sid, { limit: 200 }), context.app.inventory.assets(sid),
    context.app.inventory.requisitions(sid), context.app.inventory.issueRequests(sid),
    context.app.frontOffice.visitors(sid, date), context.app.frontOffice.complaints(sid),
    context.app.inventory.stores(sid),
    context.app.frontOffice.gatePasses(sid, date), context.app.frontOffice.calls(sid, 200), context.app.frontOffice.post(sid, 200),
    context.app.documents.requests(sid), context.app.documents.issued(sid), context.app.documents.templates(sid),
    context.app.documents.idCards(sid), context.app.documents.printJobs(sid),
  ]);
  // the hostel screens all hang off one building, so the pick is a search param and a reload lands back on it
  const hostelId = url.searchParams.get('hostelId') || (hostels[0] ? String(hostels[0].id) : null);
  const [hostelRooms, rollCall, menu] = await Promise.all([
    hostelId ? soft(context.app.hostel.rooms(sid, hostelId)) : null,
    hostelId ? soft(context.app.hostel.rollCallSheet(sid, hostelId, date, 'night')) : null,
    hostelId ? soft(context.app.hostel.menu(sid, hostelId)) : null,
  ]);
  const vacantBeds = hostelId ? await soft(context.app.hostel.vacantBeds(sid, hostelId)) : null;
  // the voice line: the register it wrote, the menu a guardian hears, and whether the gateway has a
  // secret to send. The secret itself is never read back out of the settings row.
  const [ivrCalls, ivrSchool, ivrSecret] = await Promise.all([
    context.app.ivr.calls(sid, 100),
    context.app.db.findOne('schools', { id: sid }),
    context.app.settings.get<{ enc?: string }>(sid, 'ivr.webhook_secret'),
  ]);
  const ivrMenu = ivrSchool ? context.app.ivr.menu(ivrSchool) : null;
  const ivrPhone = ivrSchool && ivrSchool.phone ? String(ivrSchool.phone) : null;
  return {
    locale: (user.locale as Locale) || context.locale, date, books, issues, members, reservations, routes, trips, vehicles, boardings, live,
    hostels, residents, outpasses, hostelId, hostelRooms, vacantBeds, rollCall, menu,
    stock, purchaseOrders, movements, assets, requisitions, issueRequests, stores,
    visitors, complaints, gatePasses, calls, postal,
    docRequests, issuedDocs, templates, idCards, printJobs,
    ivrCalls, ivrMenu, ivrPhone, ivrSecretSet: !!ivrSecret?.enc,
  };
}
export function meta() { return [{ title: 'Pathshala — Operations' }]; }

type RollRow = { studentId: string; name: string; admissionNo: string; roomNo: string; bedNo: string; status: string; onOutpass: boolean };
type Mark = 'present' | 'absent' | 'on_outpass' | 'sick';

export default function Operations() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator(); const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<'library' | 'transport' | 'hostel' | 'inventory' | 'documents' | 'frontoffice' | 'ivr'>('library');
  const [shelve, setShelve] = useState<null | { id: string; title: string; rack: string; shelf: string }>(null);
  const [drawer, setDrawer] = useState<null | 'book' | 'issue' | 'reserve' | 'member' | 'route' | 'vehicle' | 'hostel' | 'allocate' | 'menu' | 'item' | 'movement' | 'receive' | 'visitor' | 'complaint' | 'gatePass' | 'call' | 'post' | 'docRequest' | 'idCards' | 'template'>(null);
  const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [receivePo, setReceivePo] = useState<{ po: { id: string; po_no: string }; lines: { id: string; item_id: string; name: string; unit: string; quantity: number; received_qty: number }[] } | null>(null);
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  // a template is edited as the text it is; saving bumps its version rather than overwriting the run of it
  const [template, setTemplate] = useState<{ id: string; doc_type: string; name: string; html_template: string; page_size: string; orientation: string; version: number } | null>(null);
  // only ever what the rotate call handed back, and only until the page is left: the secret the
  // office typed is never held here, and the server never returns it
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  useEffect(() => { const rows = (d.rollCall?.rows ?? []) as RollRow[]; setMarks(Object.fromEntries(rows.map(r => [r.studentId, r.status as Mark]))); }, [d.rollCall]);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setDrawer(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const money = (n: unknown) => formatMoney(Number(n ?? 0), d.locale);
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); n.set(k, v); setSp(n); };
  const openFile = async (fileId: unknown) => { if (!fileId) return; const u = await api<{ url: string }>(`/api/files/${String(fileId)}/url`); window.open(u.url, '_blank'); };
  const overdue = d.issues.filter(i => String(i.status) === 'overdue').length;
  const openTickets = d.complaints.filter(c => ['open', 'in_progress'].includes(String(c.status))).length;
  const memberName = (r: Record<string, unknown>) => `${r.s_first ?? r.first_name ?? r.t_first ?? r.staff_first ?? ''} ${r.s_last ?? r.last_name ?? r.staff_last ?? ''}`.trim();
  const menuOf = (day: number, meal: string) => (d.menu ?? []).find(m => Number(m.day_of_week) === day && String(m.meal) === meal);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('ops.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('ops.purpose')}</p></div>
        <Input type="date" value={d.date} onChange={e => setParam('date', e.target.value)} className="max-w-[180px]" />
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
        { key: 'documents', label: tr('ops.documents'), count: d.docRequests.length },
        { key: 'frontoffice', label: tr('ops.frontOffice'), count: d.visitors.length },
        { key: 'ivr', label: tr('ivr.tab'), count: d.ivrCalls.length },
      ]} /></div>

      {tab === 'library' && <div className="mt-4">
        <div className="mb-3 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setDrawer('member')}>{tr('ops.newMember')}</Button>
          <Button size="sm" variant="secondary" onClick={() => setDrawer('reserve')}>{tr('ops.reserve')}</Button>
          <Button size="sm" variant="secondary" onClick={() => setDrawer('issue')}>{tr('ops.issueBook')}</Button>
          <Button size="sm" onClick={() => setDrawer('book')}>{tr('ops.newBook')}</Button>
        </div>
        <DataTable locale={d.locale} rows={d.issues} columns={[
          { key: 'accession_no', label: tr('ops.accession'), className: 'num' },
          { key: 'title', label: tr('ops.book') },
          { key: 'first_name', label: tr('ops.borrower'), render: r => `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || String(r.card_no) },
          { key: 'due_at', label: tr('ops.due'), render: r => formatDate(String(r.due_at).slice(0, 10), d.locale) },
          { key: 'renew_count', label: tr('ops.renewals'), className: 'num', render: r => String(Number(r.renew_count ?? 0)) },
          { key: 'fine_amount', label: tr('ops.fine'), className: 'num', render: r => money(r.fine_amount) },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'overdue' ? 'failed' : String(r.status) === 'returned' ? 'active' : 'pending'}>{String(r.status)}</Chip> },
          { key: 'id', label: '', render: r => ['issued', 'overdue'].includes(String(r.status)) ? <div className="flex gap-1">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => { const x = await api<{ dueAt: string }>(`/api/library/issues/${r.id}/renew`, { method: 'POST', json: {} }); setMsg(`${tr('ops.renewed')} · ${tr('ops.due')} ${x.dueAt}`); })}>{tr('ops.renew')}</Button>
            <Button size="sm" onClick={() => run(async () => { const x = await api<{ fine: number }>('/api/library/return', { method: 'POST', json: { issueId: String(r.id) } }); setMsg(x.fine > 0 ? `${tr('ops.returned')} · ${tr('ops.fine')} ${money(x.fine)}` : tr('ops.returned')); })}>{tr('ops.return')}</Button>
          </div> : null },
        ]} />

        <h2 className="mt-6 text-lg">{tr('ops.catalogue')}</h2>
        <DataTable locale={d.locale} rows={d.books} columns={[
          { key: 'title', label: tr('ops.book') },
          { key: 'authors', label: tr('ops.authors'), render: r => parsed<string[]>(r.authors, []).join(', ') || '—' },
          { key: 'category_name', label: tr('common.type') },
          { key: 'language', label: tr('ops.language'), render: r => <Chip>{String(r.language ?? 'bn')}</Chip> },
          { key: 'total_copies', label: tr('ops.copies'), className: 'num' },
          { key: 'available_copies', label: tr('ops.available'), className: 'num', render: r => Number(r.available_copies) ? String(Number(r.available_copies)) : <Chip status="failed">0</Chip> },
          // a catalogue that cannot say which rack the book is on sends somebody walking the room
          { key: 'rack', label: tr('ops.shelfmark'), render: r => (r.rack || r.shelf)
            ? <span className="num">{[r.rack, r.shelf].filter(Boolean).join(' · ')}</span>
            : <span style={{ color: 'var(--muted)' }}>{tr('ops.notShelved')}</span> },
          { key: 'id', label: '', render: r => <Button size="sm" variant="secondary" onClick={() => { setShelve({ id: String(r.id), title: String(r.title), rack: (r.rack as string) ?? '', shelf: (r.shelf as string) ?? '' }); }}>{tr('ops.shelve')}</Button> },
        ]} />

        <h2 className="mt-6 text-lg">{tr('ops.members')}</h2>
        <DataTable locale={d.locale} rows={d.members} columns={[
          { key: 'card_no', label: tr('ops.card'), className: 'num' },
          { key: 's_first', label: tr('common.name'), render: r => memberName(r) || '—' },
          { key: 'member_type', label: tr('common.type') },
          { key: 'max_books', label: tr('ops.maxBooks'), className: 'num' },
          { key: 'loan_days', label: tr('ops.loanDays'), className: 'num' },
          { key: 'fine_per_day', label: tr('ops.finePerDay'), className: 'num', render: r => money(r.fine_per_day) },
          { key: 'out', label: tr('ops.outNow'), className: 'num', render: r => String(d.issues.filter(i => String(i.member_id) === String(r.id) && ['issued', 'overdue'].includes(String(i.status))).length) },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'active' ? 'active' : 'failed'}>{String(r.status)}</Chip> },
        ]} />

        <h2 className="mt-6 text-lg">{tr('ops.reservations')}</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('ops.reservationsNote')}</p>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.reservations} columns={[
          { key: 'title', label: tr('ops.book') },
          { key: 'card_no', label: tr('ops.member'), render: r => `${memberName(r) || String(r.card_no)}` },
          { key: 'reserved_at', label: tr('ops.reservedOn'), render: r => formatDate(String(r.reserved_at).slice(0, 10), d.locale) },
          { key: 'ahead', label: tr('ops.ahead'), className: 'num' },
          { key: 'expires_at', label: tr('ops.holdUntil'), render: r => r.expires_at ? String(r.expires_at).slice(0, 16) : '—' },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'ready' ? 'active' : String(r.status) === 'expired' ? 'failed' : 'pending'}>{String(r.status)}</Chip> },
        ]} /></div>
      </div>}

      {tab === 'transport' && <div className="mt-4">
        <div className="mb-3 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setDrawer('vehicle')}>{tr('ops.newVehicle')}</Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => { const r = await api<{ trips: number }>('/api/transport/trips', { method: 'POST', json: { date: d.date } }); setMsg(`${r.trips} ${tr('ops.tripsToday').toLowerCase()}`); })}>{tr('ops.makeTrips')}</Button>
          <Button size="sm" onClick={() => setDrawer('route')}>{tr('ops.newRoute')}</Button>
        </div>

        <h2 className="text-lg">{tr('ops.live')}</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('ops.liveNote')}</p>
        <div className="mt-2"><DataTable locale={d.locale} searchable={false} rows={d.live.trips.map(t2 => ({ id: t2.tripId, ...t2 }))} columns={[
          { key: 'route', label: tr('ops.route') },
          { key: 'vehicle', label: tr('ops.vehicle'), className: 'num' },
          { key: 'tripType', label: tr('common.type') },
          { key: 'scheduledStart', label: tr('ops.start'), render: r => r.scheduledStart ?? '—' },
          { key: 'delayMin', label: tr('ops.delay'), render: r => r.delayMin == null ? '—' : r.delayMin > 0 ? <Chip status={r.delayMin >= 10 ? 'failed' : 'pending'}>{`${r.delayMin} ${tr('ops.minutesLate')}`}</Chip> : <Chip status="active">{tr('ops.onTime')}</Chip> },
          { key: 'lastFix', label: tr('ops.lastFix'), render: r => r.lastFix ? <span className="num">{`${r.lastFix.latitude.toFixed(5)}, ${r.lastFix.longitude.toFixed(5)}`}</span> : <span style={{ color: 'var(--muted)' }}>{tr('ops.noFix')}</span> },
          { key: 'fixAge', label: tr('ops.fixAge'), render: r => r.lastFix ? <Chip status={r.lastFix.ageMin <= 5 ? 'active' : r.lastFix.ageMin <= 20 ? 'pending' : 'failed'}>{`${r.lastFix.ageMin} ${tr('ops.minutesAgo')}`}</Chip> : '—' },
          { key: 'speed', label: tr('ops.speed'), className: 'num', render: r => r.lastFix?.speedKmh == null ? '—' : `${r.lastFix.speedKmh} km/h` },
          { key: 'onBoard', label: tr('ops.onBus'), className: 'num' },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={r.status === 'completed' ? 'active' : r.status === 'delayed' ? 'failed' : 'pending'}>{r.status}</Chip> },
        ]} /></div>

        <h2 className="mt-6 text-lg">{tr('ops.tripsToday')}</h2>
        <DataTable locale={d.locale} rows={d.trips} columns={[
          { key: 'route_name', label: tr('ops.route') },
          { key: 'registration_no', label: tr('ops.vehicle') },
          { key: 'trip_type', label: tr('common.type') },
          { key: 'scheduled_start', label: tr('ops.start'), render: r => String(r.scheduled_start ?? '—').slice(0, 5) },
          { key: 'boarded', label: tr('ops.onBoard'), className: 'num' },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'completed' ? 'active' : String(r.status) === 'delayed' ? 'failed' : 'pending'}>{String(r.status)}</Chip> },
          { key: 'id', label: '', render: r => String(r.status) === 'scheduled' || String(r.status) === 'delayed' ? <Button size="sm" variant="secondary" onClick={() => run(() => api(`/api/transport/trips/${r.id}/start`, { method: 'POST', json: {} }))}>{tr('ops.startTrip')}</Button> : String(r.status) === 'running' ? <Button size="sm" onClick={() => run(async () => { const x = await api<{ stillOnBoard: number }>(`/api/transport/trips/${r.id}/end`, { method: 'POST', json: {} }); setMsg(x.stillOnBoard ? `${x.stillOnBoard} ${tr('ops.stillOnBoard')}` : tr('ops.tripEnded')); })}>{tr('ops.endTrip')}</Button> : null },
        ]} />

        <h2 className="mt-6 text-lg">{tr('ops.boardings')}</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('ops.boardingsNote')}</p>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.boardings} columns={[
          { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}`.trim() },
          { key: 'class_name', label: tr('common.class'), render: r => String(r.class_name ?? '—') },
          { key: 'route_name', label: tr('ops.route') },
          { key: 'stop_name', label: tr('ops.stop'), render: r => String(r.stop_name ?? '—') },
          { key: 'boarded_at', label: tr('ops.boardedAt'), render: r => r.boarded_at ? <span className="num">{String(r.boarded_at).slice(11, 16)}</span> : '—' },
          { key: 'alighted_at', label: tr('ops.alightedAt'), render: r => r.alighted_at ? <span className="num">{String(r.alighted_at).slice(11, 16)}</span> : <Chip status="pending">{tr('ops.onBus')}</Chip> },
          { key: 'guardian_notified_at', label: tr('ops.guardian'), render: r => r.guardian_notified_at ? <Chip status="active">{tr('ops.told')}</Chip> : '—' },
        ]} /></div>

        <h2 className="mt-6 text-lg">{tr('ops.routes')}</h2>
        <DataTable locale={d.locale} rows={d.routes} columns={[
          { key: 'name', label: tr('ops.route') },
          { key: 'registration_no', label: tr('ops.vehicle') },
          { key: 'start_point', label: tr('ops.from'), render: r => String(r.start_point ?? '—') },
          { key: 'stops', label: tr('ops.stops'), className: 'num' },
          { key: 'riders', label: tr('ops.riders'), className: 'num' },
          { key: 'monthly_fee', label: tr('ops.monthlyFee'), className: 'num', render: r => money(r.monthly_fee) },
        ]} />

        <h2 className="mt-6 text-lg">{tr('ops.vehicles')}</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('ops.vehiclesNote')}</p>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.vehicles} columns={[
          { key: 'registration_no', label: tr('ops.registration'), className: 'num' },
          { key: 'vehicle_type', label: tr('common.type') },
          { key: 'driver_first', label: tr('ops.driver'), render: r => `${r.driver_first ?? ''} ${r.driver_last ?? ''}`.trim() || '—' },
          { key: 'route_name', label: tr('ops.route'), render: r => String(r.route_name ?? '—') },
          { key: 'capacity', label: tr('ops.seats'), className: 'num' },
          { key: 'fitness_expiry', label: tr('ops.fitness'), render: r => paper(r.fitness_expiry, d.locale, tr) },
          { key: 'insurance_expiry', label: tr('ops.insurance'), render: r => paper(r.insurance_expiry, d.locale, tr) },
          { key: 'tax_token_expiry', label: tr('ops.taxToken'), render: r => paper(r.tax_token_expiry, d.locale, tr) },
          { key: 'route_permit_expiry', label: tr('ops.permit'), render: r => paper(r.route_permit_expiry, d.locale, tr) },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'active' ? 'active' : 'failed'}>{String(r.status)}</Chip> },
        ]} /></div>
      </div>}

      {tab === 'hostel' && <div className="mt-4">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-[220px]"><Field label={tr('ops.pickHostel')}><Select value={d.hostelId ?? ''} placeholder={tr('ops.pickHostel')} onChange={e => setParam('hostelId', e.target.value)} options={d.hostels.map(h => ({ value: String(h.id), label: String(h.name) }))} /></Field></div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={!d.hostelId} onClick={() => setDrawer('menu')}>{tr('ops.editMenu')}</Button>
            <Button size="sm" variant="secondary" disabled={!d.hostelId} onClick={() => setDrawer('allocate')}>{tr('ops.allocate')}</Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => { const month = prompt('Which month? (YYYY-MM)', new Date(Date.now() - 15 * 86_400_000).toISOString().slice(0, 7)); if (month) run(async () => { const r = await api<{ billed: number; skipped: number; total: number }>('/api/hostel/mess/bill', { method: 'POST', json: { month } }); setMsg(`${r.billed} invoiced, ${r.skipped} already billed · ${money(r.total)}`); }); }}>{tr('ops.messBill')}</Button>
            <Button size="sm" onClick={() => setDrawer('hostel')}>{tr('ops.newHostel')}</Button>
          </div>
        </div>

        <DataTable locale={d.locale} rows={d.hostels} columns={[
          { key: 'name', label: tr('common.name') },
          { key: 'hostel_type', label: tr('common.type') },
          { key: 'warden_first', label: tr('ops.warden'), render: r => `${r.warden_first ?? ''} ${r.warden_last ?? ''}`.trim() || '—' },
          { key: 'rooms', label: tr('ops.rooms'), className: 'num' },
          { key: 'beds', label: tr('ops.beds'), className: 'num' },
          { key: 'occupied', label: tr('ops.occupied'), className: 'num', render: r => `${Number(r.occupied)} / ${Number(r.beds)}` },
          { key: 'curfew_time', label: tr('ops.curfew'), render: r => String(r.curfew_time ?? '—').slice(0, 5) },
        ]} />

        <h2 className="mt-6 text-lg">{tr('ops.roomsBeds')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.hostelRooms ?? []} columns={[
          { key: 'room_no', label: tr('ops.room'), className: 'num' },
          { key: 'floor', label: tr('ops.floor'), render: r => String(r.floor ?? '—') },
          { key: 'room_type', label: tr('common.type') },
          { key: 'capacity', label: tr('ops.beds'), className: 'num' },
          { key: 'vacant', label: tr('ops.vacant'), className: 'num', render: r => Number(r.vacant) ? <Chip status="active">{String(Number(r.vacant))}</Chip> : <Chip status="pending">0</Chip> },
          { key: 'monthly_fee', label: tr('ops.monthlyFee'), className: 'num', render: r => money(r.monthly_fee) },
        ]} /></div>

        <h2 className="mt-6 text-lg">{tr('ops.residents')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.residents} columns={[
          { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}`.trim() },
          { key: 'admission_no', label: tr('stu.admissionNo'), className: 'num' },
          { key: 'hostel_name', label: tr('ops.hostel') },
          { key: 'room_no', label: tr('ops.room'), className: 'num', render: r => `${r.room_no}-${r.bed_no}` },
          { key: 'monthly_fee', label: tr('ops.monthlyFee'), className: 'num', render: r => money(r.monthly_fee) },
          { key: 'id', label: '', render: r => <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => api(`/api/hostel/allocations/${r.id}/vacate`, { method: 'POST', json: {} }))}>{tr('ops.vacate')}</Button> },
        ]} /></div>

        <h2 className="mt-6 text-lg">{tr('ops.rollCall')} · {formatDate(d.date, d.locale)}</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('ops.rollCallNote')}</p>
        {d.rollCall && d.rollCall.rows.length > 0 ? <div className="mt-2 card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">{d.rollCall.rows.length} {tr('ops.residents').toLowerCase()} · {d.rollCall.taken ? <Chip status="active">{tr('ops.rollCallTaken')}</Chip> : <Chip status="pending">{tr('ops.rollCallNotTaken')}</Chip>}</span>
            <Button size="sm" disabled={busy} onClick={() => run(async () => {
              const rows = (d.rollCall!.rows as RollRow[]).map(r => ({ studentId: r.studentId, status: marks[r.studentId] ?? 'present' }));
              const x = await api<{ saved: number }>('/api/hostel/roll-call', { method: 'POST', json: { hostelId: d.hostelId, onDate: d.date, call: 'night', marks: rows } });
              setMsg(`${x.saved} ${tr('ops.rollCallSaved')}`);
            })}>{tr('ops.saveRollCall')}</Button>
          </div>
          <ul className="mt-3 grid gap-1">
            {(d.rollCall.rows as RollRow[]).map(r => <li key={r.studentId} className="flex flex-wrap items-center gap-2 border-t py-2 text-sm" style={{ borderColor: 'var(--line)' }}>
              <span className="num" style={{ color: 'var(--muted)' }}>{r.roomNo}-{r.bedNo}</span>
              <span>{r.name}</span>
              {r.onOutpass && <Chip status="pending">{tr('ops.onOutpass')}</Chip>}
              <span className="ml-auto flex gap-1">
                {(['present', 'absent', 'on_outpass', 'sick'] as Mark[]).map(s => <Button key={s} size="sm" variant={(marks[r.studentId] ?? 'present') === s ? 'primary' : 'ghost'} onClick={() => setMarks(m => ({ ...m, [r.studentId]: s }))}>{tr(`ops.${s === 'on_outpass' ? 'onOutpass' : s}` as Parameters<typeof t>[0])}</Button>)}
              </span>
            </li>)}
          </ul>
        </div> : <div className="mt-2 card p-6 text-center text-sm" style={{ color: 'var(--muted)' }}>{tr('ops.noResidents')}</div>}

        <h2 className="mt-6 text-lg">{tr('ops.messMenu')}</h2>
        <div className="mt-2 overflow-x-auto card">
          <table className="w-full text-sm">
            <thead><tr>{[tr('ops.day'), tr('ops.breakfast'), tr('ops.lunch'), tr('ops.snack'), tr('ops.dinner')].map(h => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr></thead>
            <tbody>{DAYS.map((day, i) => <tr key={day} className="border-t" style={{ borderColor: 'var(--line)' }}>
              <td className="px-3 py-2"><strong>{day}</strong></td>
              {MEALS.map(meal => <td key={meal} className="px-3 py-2" style={{ whiteSpace: 'normal' }}>{String(menuOf(i, meal)?.items ?? '—')}</td>)}
            </tr>)}</tbody>
          </table>
        </div>

        <h2 className="mt-6 text-lg">{tr('ops.outpasses')}</h2>
        <DataTable locale={d.locale} rows={d.outpasses} columns={[
          { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` },
          { key: 'reason', label: tr('ops.reason'), render: r => String(r.reason ?? '—') },
          { key: 'leave_from', label: tr('ops.leaves'), render: r => String(r.leave_from).slice(0, 16) },
          { key: 'expected_return', label: tr('ops.returns'), render: r => String(r.expected_return).slice(0, 16) },
          { key: 'guardian_consent_at', label: tr('ops.consent'), render: r => <Chip status={r.guardian_consent_at ? 'active' : 'pending'}>{r.guardian_consent_at ? tr('ops.given') : tr('ops.waiting')}</Chip> },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={['returned', 'approved'].includes(String(r.status)) ? 'active' : String(r.status) === 'late' ? 'failed' : 'pending'}>{String(r.status)}</Chip> },
          { key: 'id', label: '', render: r => String(r.status) === 'pending' && r.guardian_consent_at ? <Button size="sm" onClick={() => run(() => api(`/api/hostel/outpasses/${r.id}/approve`, { method: 'POST', json: {} }))}>{tr('ops.approve')}</Button> : null },
        ]} />
      </div>}

      {tab === 'inventory' && <div className="mt-4">
        <div className="mb-3 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setDrawer('movement')}>{tr('ops.stockInOut')}</Button>
          <Button size="sm" onClick={() => setDrawer('item')}>{tr('ops.newItem')}</Button>
        </div>
        <DataTable locale={d.locale} rows={d.stock} columns={[
          { key: 'sku', label: 'SKU', className: 'num' },
          { key: 'name', label: tr('common.name') },
          { key: 'category_name', label: tr('ops.category'), render: r => String(r.category_name ?? '—') },
          { key: 'store_name', label: tr('ops.store') },
          { key: 'quantity', label: tr('ops.quantity'), className: 'num', render: r => `${Number(r.quantity)} ${r.unit}` },
          { key: 'reorder_level', label: tr('ops.reorderAt'), className: 'num', render: r => Number(r.quantity) <= Number(r.reorder_level) ? <Chip status="failed">{String(Number(r.reorder_level))}</Chip> : String(Number(r.reorder_level)) },
          { key: 'last_cost', label: tr('ops.lastCost'), className: 'num', render: r => r.last_cost == null ? '—' : money(r.last_cost) },
        ]} />

        <h2 className="mt-6 text-lg">{tr('ops.movements')}</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('ops.movementsNote')}</p>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.movements} columns={[
          { key: 'created_at', label: tr('common.date'), render: r => String(r.created_at).slice(0, 16) },
          { key: 'item_name', label: tr('ops.item') },
          { key: 'move_type', label: tr('common.type'), render: r => <Chip status={['in', 'return'].includes(String(r.move_type)) ? 'active' : String(r.move_type) === 'adjust' ? 'pending' : 'failed'}>{String(r.move_type)}</Chip> },
          { key: 'quantity', label: tr('ops.qty'), className: 'num', render: r => `${Number(r.quantity) > 0 ? '+' : ''}${Number(r.quantity)} ${r.unit ?? ''}` },
          { key: 'store_name', label: tr('ops.store') },
          { key: 'ref_type', label: tr('ops.reference'), render: r => String(r.ref_type ?? '—').replace(/_/g, ' ') },
          { key: 'to_first', label: tr('ops.toWhom'), render: r => `${r.to_first ?? ''} ${r.to_last ?? ''}`.trim() || '—' },
        ]} /></div>

        <h2 className="mt-6 text-lg">{tr('ops.purchaseOrders')}</h2>
        <DataTable locale={d.locale} rows={d.purchaseOrders} columns={[
          { key: 'po_no', label: tr('ops.poNo'), className: 'num' },
          { key: 'vendor_name', label: tr('ops.vendor') },
          { key: 'total', label: tr('ops.value'), className: 'num', render: r => money(r.total) },
          { key: 'is_auto', label: tr('ops.raisedBy'), render: r => Number(r.is_auto) ? <Chip status="active">{tr('ops.automatic')}</Chip> : tr('ops.byHand') },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'received' ? 'active' : 'pending'}>{String(r.status)}</Chip> },
          { key: 'id', label: '', render: r => ['ordered', 'approved', 'partially_received'].includes(String(r.status))
            ? <Button size="sm" disabled={busy} onClick={async () => { setErr(null); try { setReceivePo(await api<NonNullable<typeof receivePo>>(`/api/inventory/purchase-orders/${r.id}`)); setDrawer('receive'); } catch (e) { setErr((e as Error).message); } }}>{tr('ops.receive')}</Button>
            : null },
        ]} />

        <h2 className="mt-6 text-lg">{tr('ops.requisitions')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.requisitions} columns={[
          { key: 'created_at', label: tr('common.date'), render: r => formatDate(String(r.created_at).slice(0, 10), d.locale) },
          { key: 'first_name', label: tr('ops.requestedBy'), render: r => `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || '—' },
          { key: 'department_name', label: tr('ops.forWhom'), render: r => String(r.department_name ?? '—') },
          { key: 'items', label: tr('ops.lines'), className: 'num', render: r => String(parsed<unknown[]>(r.items, []).length) },
          { key: 'justification', label: tr('ops.reason'), render: r => String(r.justification ?? '—') },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'approved' ? 'active' : String(r.status) === 'rejected' ? 'failed' : 'pending'}>{String(r.status)}</Chip> },
        ]} /></div>

        <h2 className="mt-6 text-lg">{tr('ops.issueRequests')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.issueRequests} columns={[
          { key: 'created_at', label: tr('common.date'), render: r => formatDate(String(r.created_at).slice(0, 10), d.locale) },
          { key: 'first_name', label: tr('ops.requestedBy'), render: r => `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || '—' },
          { key: 'store_name', label: tr('ops.store') },
          { key: 'items', label: tr('ops.lines'), className: 'num', render: r => String(parsed<unknown[]>(r.items, []).length) },
          { key: 'purpose', label: tr('ops.purposeCol'), render: r => String(r.purpose ?? '—') },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'issued' ? 'active' : 'pending'}>{String(r.status)}</Chip> },
          { key: 'id', label: '', render: r => String(r.status) === 'pending' ? <Button size="sm" disabled={busy} onClick={() => run(async () => { const x = await api<{ status: string; lines?: number }>(`/api/inventory/issues/${r.id}/issue`, { method: 'POST', json: {} }); setMsg(`${tr('ops.issuedFromStore')}${x.lines ? ` · ${x.lines}` : ''}`); })}>{tr('ops.issueNow')}</Button> : null },
        ]} /></div>

        <h2 className="mt-6 text-lg">{tr('ops.assets')}</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('ops.assetsNote')}</p>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.assets} columns={[
          { key: 'asset_tag', label: tr('ops.assetTag'), className: 'num' },
          { key: 'name', label: tr('common.name') },
          { key: 'room_name', label: tr('ops.location'), render: r => String(r.room_name ?? '—') },
          { key: 'custodian_first', label: tr('ops.custodian'), render: r => `${r.custodian_first ?? ''} ${r.custodian_last ?? ''}`.trim() || '—' },
          { key: 'purchase_cost', label: tr('ops.cost'), className: 'num', render: r => money(r.purchase_cost) },
          { key: 'warranty_until', label: tr('ops.warranty'), render: r => paper(r.warranty_until, d.locale, tr) },
          { key: 'next_service_on', label: tr('ops.nextService'), render: r => paper(r.next_service_on, d.locale, tr) },
          { key: 'condition_note', label: tr('ops.condition'), render: r => <Chip status={String(r.condition_note) === 'repair' ? 'failed' : String(r.condition_note) === 'fair' ? 'pending' : 'active'}>{String(r.condition_note ?? '—')}</Chip> },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'in_use' ? 'active' : String(r.status) === 'disposed' ? 'failed' : 'pending'}>{String(r.status).replace(/_/g, ' ')}</Chip> },
        ]} /></div>
      </div>}

      {tab === 'documents' && <div className="mt-4">
        <div className="mb-3 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setDrawer('idCards')}>{tr('ops.batchCards')}</Button>
          <Button size="sm" onClick={() => setDrawer('docRequest')}>{tr('ops.newDocRequest')}</Button>
        </div>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('ops.docRequestsNote')}</p>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.docRequests} columns={[
          { key: 'created_at', label: tr('common.date'), render: r => formatDate(String(r.created_at).slice(0, 10), d.locale) },
          { key: 'doc_type', label: tr('ops.docType'), render: r => String(r.doc_type).replace(/_/g, ' ') },
          { key: 'person_type', label: tr('ops.person') },
          { key: 'reason', label: tr('ops.reason'), render: r => String(r.reason ?? '—') },
          { key: 'eligibility', label: tr('ops.eligibility'), render: r => { const e = parsed<{ eligible?: boolean; blockers?: { kind: string; detail: string }[] } | null>(r.eligibility, null); if (!e) return '—'; return e.eligible ? <Chip status="active">{tr('ops.clear')}</Chip> : <span className="flex flex-wrap gap-1">{(e.blockers ?? []).map(b => <Chip key={b.kind} status="failed">{b.detail || b.kind}</Chip>)}</span>; } },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'issued' ? 'active' : String(r.status) === 'blocked' ? 'failed' : 'pending'}>{String(r.status)}</Chip> },
          { key: 'id', label: '', render: r => ['approved', 'requested'].includes(String(r.status)) ? <Button size="sm" disabled={busy} onClick={() => run(async () => { const x = await api<{ documentNo: string; fileId: string }>(`/api/documents/requests/${r.id}/issue`, { method: 'POST', json: {} }); setMsg(`${tr('ops.documentNo')} ${x.documentNo}`); await openFile(x.fileId); })}>{tr('ops.issueDoc')}</Button> : null },
        ]} /></div>

        <h2 className="mt-6 text-lg">{tr('ops.issuedDocs')}</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('ops.issuedDocsNote')}</p>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.issuedDocs} columns={[
          { key: 'document_no', label: tr('ops.documentNo'), className: 'num' },
          { key: 'doc_type', label: tr('ops.docType'), render: r => String(r.doc_type).replace(/_/g, ' ') },
          { key: 'issued_at', label: tr('common.date'), render: r => formatDate(String(r.issued_at).slice(0, 10), d.locale) },
          { key: 'valid_until', label: tr('ops.validTo'), render: r => r.valid_until ? formatDate(String(r.valid_until).slice(0, 10), d.locale) : '—' },
          { key: 'verification_code', label: tr('ops.verifyCode'), render: r => <span className="num">{String(r.verification_code)}</span> },
          { key: 'revoked_at', label: tr('common.status'), render: r => r.revoked_at ? <Chip status="failed">{tr('ops.revoked')}</Chip> : <Chip status="active">{tr('ops.valid')}</Chip> },
          { key: 'file_id', label: '', render: r => r.file_id ? <Button size="sm" variant="secondary" onClick={() => openFile(r.file_id)}>{tr('common.download')}</Button> : null },
        ]} /></div>

        <h2 className="mt-6 text-lg">{tr('ops.templates')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.templates} columns={[
          { key: 'name', label: tr('ops.template') },
          { key: 'doc_type', label: tr('ops.docType'), render: r => <span className="num">{String(r.doc_type)}</span> },
          { key: 'page_size', label: tr('ops.pageSize'), render: r => `${r.page_size ?? 'A4'} ${r.orientation ?? 'portrait'}` },
          { key: 'version', label: tr('ops.version'), className: 'num' },
          { key: 'is_default', label: '', render: r => Number(r.is_default) ? <Chip status="active">{tr('ops.defaultTemplate')}</Chip> : null },
          { key: 'id', label: '', render: r => <Button size="sm" variant="secondary" onClick={() => { setTemplate({ id: String(r.id), doc_type: String(r.doc_type), name: String(r.name), html_template: String(r.html_template ?? ''), page_size: String(r.page_size ?? 'A4'), orientation: String(r.orientation ?? 'portrait'), version: Number(r.version) }); setDrawer('template'); }}>{tr('ops.editTemplate')}</Button> },
        ]} /></div>

        <h2 className="mt-6 text-lg">{tr('ops.idCards')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.idCards} columns={[
          { key: 'card_no', label: tr('ops.cardNo'), className: 'num' },
          { key: 's_first', label: tr('common.name'), render: r => `${r.s_first ?? r.t_first ?? ''} ${r.s_last ?? r.t_last ?? ''}`.trim() || '—' },
          { key: 'class_name', label: tr('common.class'), render: r => String(r.class_name ?? tr('ops.staffCard')) },
          { key: 'rfid_tag', label: 'RFID', render: r => <span className="num">{String(r.rfid_tag ?? '—')}</span> },
          { key: 'valid_to', label: tr('ops.validTo'), render: r => formatDate(String(r.valid_to).slice(0, 10), d.locale) },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'active' ? 'active' : String(r.status) === 'lost' ? 'failed' : 'pending'}>{String(r.status).replace(/_/g, ' ')}</Chip> },
          { key: 'file_id', label: '', render: r => <div className="flex gap-1">
            {r.file_id ? <Button size="sm" variant="secondary" onClick={() => openFile(r.file_id)}>{tr('common.download')}</Button> : null}
            {/* a card is lost on a Tuesday and the child needs one on the Wednesday: the endpoint has
                always been there, and until now the only way to reach it was to write the request */}
            {['active', 'pending_print'].includes(String(r.status))
              ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => { const x = await api<{ cardNo: string }>(`/api/documents/id-cards/${r.id}/reissue`, { method: 'POST', json: { reason: 'lost' } }); setMsg(`${tr('ops.reissued')} ${x.cardNo}`); })}>{tr('ops.reissue')}</Button>
              : null}
          </div> },
        ]} /></div>

        <h2 className="mt-6 text-lg">{tr('ops.printJobs')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} searchable={false} rows={d.printJobs} columns={[
          { key: 'created_at', label: tr('common.date'), render: r => String(r.created_at).slice(0, 16) },
          { key: 'kind', label: tr('common.type'), render: r => String(r.kind).replace(/_/g, ' ') },
          { key: 'items', label: tr('ops.lines'), className: 'num', render: r => String(parsed<{ ids?: string[] }>(r.items, {}).ids?.length ?? 0) },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'ready' ? 'active' : String(r.status) === 'failed' ? 'failed' : 'pending'}>{String(r.status)}</Chip> },
          { key: 'file_id', label: '', render: r => r.file_id ? <Button size="sm" variant="secondary" onClick={() => openFile(r.file_id)}>{tr('common.download')}</Button> : null },
        ]} /></div>
      </div>}

      {tab === 'frontoffice' && <div className="mt-4">
        <div className="mb-3 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setDrawer('post')}>{tr('ops.logPost')}</Button>
          <Button size="sm" variant="secondary" onClick={() => setDrawer('call')}>{tr('ops.logCall')}</Button>
          <Button size="sm" variant="secondary" onClick={() => setDrawer('gatePass')}>{tr('ops.newGatePass')}</Button>
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

        <h2 className="mt-6 text-lg">{tr('ops.gatePasses')}</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('ops.gatePassesNote')}</p>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.gatePasses} columns={[
          { key: 'qr_code', label: tr('ops.gatePass'), className: 'num' },
          { key: 'person_type', label: tr('ops.person') },
          { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || '—' },
          { key: 'reason', label: tr('ops.reason'), render: r => String(r.reason ?? '—') },
          { key: 'picked_by', label: tr('ops.pickedBy'), render: r => String(r.picked_by ?? '—') },
          { key: 'out_at', label: tr('ops.out'), render: r => String(r.out_at ?? '').slice(11, 16) || '—' },
          { key: 'expected_in', label: tr('ops.expectedIn'), render: r => r.expected_in ? String(r.expected_in).slice(11, 16) : '—' },
          { key: 'actual_in', label: tr('ops.backIn'), render: r => r.actual_in ? String(r.actual_in).slice(11, 16) : <Button size="sm" variant="secondary" onClick={() => run(() => api(`/api/frontoffice/gate-passes/${r.id}/return`, { method: 'POST', json: {} }))}>{tr('ops.markBack')}</Button> },
        ]} /></div>

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

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div>
            <h2 className="text-lg">{tr('ops.calls')}</h2>
            <div className="mt-2"><DataTable locale={d.locale} searchable={false} pageSize={10} rows={d.calls} columns={[
              { key: 'called_at', label: tr('common.date'), render: r => String(r.called_at ?? '').slice(0, 16) },
              { key: 'direction', label: tr('ops.direction'), render: r => <Chip>{String(r.direction)}</Chip> },
              { key: 'phone', label: tr('common.phone'), className: 'num' },
              { key: 'purpose', label: tr('ops.purposeCol'), render: r => String(r.purpose ?? '—') },
            ]} /></div>
          </div>
          <div>
            <h2 className="text-lg">{tr('ops.postal')}</h2>
            <div className="mt-2"><DataTable locale={d.locale} searchable={false} pageSize={10} rows={d.postal} columns={[
              { key: 'record_date', label: tr('common.date'), render: r => formatDate(String(r.record_date).slice(0, 10), d.locale) },
              { key: 'direction', label: tr('ops.direction'), render: r => <Chip>{String(r.direction)}</Chip> },
              { key: 'subject', label: tr('ops.subject'), render: r => String(r.subject ?? '—') },
              { key: 'from_party', label: tr('ops.party'), render: r => String(r.from_party ?? r.to_party ?? '—') },
            ]} /></div>
          </div>
        </div>
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

      <Drawer open={!!shelve} onClose={() => setShelve(null)} title={shelve?.title ?? tr('ops.shelve')}>
        <form className="grid gap-3" onSubmit={e => {
          e.preventDefault();
          const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
          const bookId = shelve?.id;
          setShelve(null);
          run(async () => { await api('/api/library/shelve', { method: 'POST', json: { bookId, rack: f.rack || null, shelf: f.shelf || null } }); setMsg(tr('ops.shelved')); });
        }}>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('ops.shelveHint')}</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('ops.rack')}><Input name="rack" defaultValue={shelve?.rack ?? ''} maxLength={20} className="num" /></Field>
            <Field label={tr('ops.shelf')}><Input name="shelf" defaultValue={shelve?.shelf ?? ''} maxLength={20} className="num" /></Field>
          </div>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'book'} onClose={() => setDrawer(null)} title={tr('ops.newBook')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/library/books', { method: 'POST', json: { title: f.title, isbn: f.isbn || null, authors: f.authors ? f.authors.split(',').map(x => x.trim()) : [], price: Number(f.price || 0), copies: Number(f.copies || 1), rack: f.rack || null, shelf: f.shelf || null } })); }}>
          <Field label={tr('ops.book')}><Input name="title" required /></Field>
          <Field label={tr('ops.authors')} hint={tr('ops.authorsHint')}><Input name="authors" /></Field>
          <div className="grid grid-cols-3 gap-3"><Field label="ISBN"><Input name="isbn" className="num" /></Field><Field label={tr('ops.price')}><Input name="price" type="number" className="num" /></Field><Field label={tr('ops.copies')}><Input name="copies" type="number" className="num" defaultValue="1" /></Field></div>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('ops.rack')}><Input name="rack" maxLength={20} className="num" /></Field><Field label={tr('ops.shelf')}><Input name="shelf" maxLength={20} className="num" /></Field></div>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'issue'} onClose={() => setDrawer(null)} title={tr('ops.issueBook')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(async () => { const x = await api<{ dueAt: string }>('/api/library/issues', { method: 'POST', json: { accessionNo: f.accessionNo, memberId: f.memberId } }); setMsg(`${tr('ops.due')} ${x.dueAt}`); }); }}>
          <Field label={tr('ops.accession')} hint={tr('ops.accessionHint')}><Input name="accessionNo" required className="num" /></Field>
          <Field label={tr('ops.member')}><Select name="memberId" required placeholder="—" options={d.members.map(m => ({ value: String(m.id), label: `${String(m.card_no)} · ${memberName(m) || String(m.member_type)}` }))} /></Field>
          <Button disabled={busy}>{tr('ops.issueBook')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'reserve'} onClose={() => setDrawer(null)} title={tr('ops.reserve')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/library/reservations', { method: 'POST', json: { bookId: f.bookId, memberId: f.memberId } })); }}>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('ops.reservationsNote')}</p>
          <Field label={tr('ops.book')}><Select name="bookId" required placeholder="—" options={d.books.map(b => ({ value: String(b.id), label: String(b.title) }))} /></Field>
          <Field label={tr('ops.member')}><Select name="memberId" required placeholder="—" options={d.members.map(m => ({ value: String(m.id), label: `${String(m.card_no)} · ${memberName(m) || String(m.member_type)}` }))} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'member'} onClose={() => setDrawer(null)} title={tr('ops.newMember')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/library/members', { method: 'POST', json: { memberType: f.memberType, studentId: f.memberType === 'student' ? f.personId : null, staffId: f.memberType === 'staff' ? f.personId : null, maxBooks: Number(f.maxBooks || 2), loanDays: Number(f.loanDays || 14), finePerDay: Number(f.finePerDay || 5) } })); }}>
          <Field label={tr('common.type')}><Select name="memberType" options={[{ value: 'student', label: 'Student' }, { value: 'staff', label: 'Staff' }]} /></Field>
          <Field label={tr('ops.personId')} hint={tr('ops.personIdHint')}><Input name="personId" required /></Field>
          <div className="grid grid-cols-3 gap-3"><Field label={tr('ops.maxBooks')}><Input name="maxBooks" type="number" className="num" defaultValue="2" /></Field><Field label={tr('ops.loanDays')}><Input name="loanDays" type="number" className="num" defaultValue="14" /></Field><Field label={tr('ops.finePerDay')}><Input name="finePerDay" type="number" className="num" defaultValue="5" /></Field></div>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'route'} onClose={() => setDrawer(null)} title={tr('ops.newRoute')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/transport/routes', { method: 'POST', json: { name: f.name, vehicleId: f.vehicleId || null, monthlyFee: Number(f.monthlyFee || 0), stops: f.stops ? f.stops.split(',').map((s, i) => ({ name: s.trim(), sequence: i + 1, pickupTime: f.pickupTime || null })) : [] } })); }}>
          <Field label={tr('ops.route')}><Input name="name" required /></Field>
          <Field label={tr('ops.vehicle')}><Select name="vehicleId" placeholder="—" options={d.vehicles.map(v => ({ value: String(v.id), label: String(v.registration_no) }))} /></Field>
          <Field label={tr('ops.stops')} hint={tr('ops.stopsHint')}><Input name="stops" /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('ops.monthlyFee')}><Input name="monthlyFee" type="number" className="num" /></Field><Field label={tr('ops.pickupTime')}><Input name="pickupTime" type="time" /></Field></div>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'vehicle'} onClose={() => setDrawer(null)} title={tr('ops.newVehicle')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/transport/vehicles', { method: 'POST', json: { registrationNo: f.registrationNo, vehicleType: f.vehicleType, capacity: Number(f.capacity || 40), fitnessExpiry: f.fitnessExpiry || null, insuranceExpiry: f.insuranceExpiry || null, taxTokenExpiry: f.taxTokenExpiry || null, routePermitExpiry: f.routePermitExpiry || null } })); }}>
          <Field label={tr('ops.registration')}><Input name="registrationNo" required className="num" /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('common.type')}><Select name="vehicleType" options={['bus', 'microbus', 'van', 'car'].map(v => ({ value: v, label: v }))} /></Field><Field label={tr('ops.seats')}><Input name="capacity" type="number" className="num" defaultValue="40" /></Field></div>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('ops.vehiclesNote')}</p>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('ops.fitness')}><Input name="fitnessExpiry" type="date" /></Field><Field label={tr('ops.insurance')}><Input name="insuranceExpiry" type="date" /></Field></div>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('ops.taxToken')}><Input name="taxTokenExpiry" type="date" /></Field><Field label={tr('ops.permit')}><Input name="routePermitExpiry" type="date" /></Field></div>
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

      <Drawer open={drawer === 'allocate'} onClose={() => setDrawer(null)} title={tr('ops.allocate')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/hostel/allocations', { method: 'POST', json: { studentId: f.studentId, bedId: f.bedId } })); }}>
          <Field label={tr('doc.studentId')} hint={tr('doc.studentIdHint')}><Input name="studentId" required /></Field>
          <Field label={tr('ops.bed')} hint={tr('ops.bedHint')}><Select name="bedId" required placeholder="—" options={(d.vacantBeds ?? []).map(b => ({ value: String(b.id), label: `${b.room_no}-${b.bed_no} · ${money(b.monthly_fee)}` }))} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'menu'} onClose={() => setDrawer(null)} title={tr('ops.editMenu')}>
        <form className="grid gap-3" onSubmit={e => {
          e.preventDefault(); const f = new FormData(e.currentTarget);
          const rows: { dayOfWeek: number; meal: string; items: string }[] = [];
          for (let day = 0; day < 7; day++) for (const meal of MEALS) { const v = String(f.get(`${day}-${meal}`) ?? '').trim(); if (v) rows.push({ dayOfWeek: day, meal, items: v }); }
          run(async () => { const x = await api<{ rows: number }>(`/api/hostel/${d.hostelId}/menu`, { method: 'POST', json: { rows } }); setMsg(`${x.rows} ${tr('ops.menuRowsSaved')}`); });
        }}>
          {DAYS.map((day, i) => <div key={day}>
            <div className="label">{day}</div>
            <div className="grid grid-cols-2 gap-2">{MEALS.map(meal => <Input key={meal} name={`${i}-${meal}`} placeholder={tr(`ops.${meal}` as Parameters<typeof t>[0])} defaultValue={String(menuOf(i, meal)?.items ?? '')} maxLength={255} />)}</div>
          </div>)}
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

      <Drawer open={drawer === 'movement'} onClose={() => setDrawer(null)} title={tr('ops.stockInOut')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/inventory/movements', { method: 'POST', json: { itemId: f.itemId, storeId: f.storeId, moveType: f.moveType, quantity: Number(f.quantity), unitCost: f.unitCost ? Number(f.unitCost) : null, note: f.note || null } })); }}>
          <Field label={tr('ops.item')}><Select name="itemId" required placeholder="—" options={d.stock.map(s => ({ value: String(s.item_id), label: `${s.name} (${Number(s.quantity)} ${s.unit})` }))} /></Field>
          <Field label={tr('ops.store')}><Select name="storeId" required placeholder="—" options={d.stores.map(s => ({ value: String(s.id), label: String(s.name) }))} /></Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label={tr('common.type')}><Select name="moveType" options={['in', 'out', 'adjust', 'return', 'consume'].map(v => ({ value: v, label: v }))} /></Field>
            <Field label={tr('ops.qty')}><Input name="quantity" type="number" step="0.01" className="num" required /></Field>
            <Field label={tr('ops.unitCost')}><Input name="unitCost" type="number" step="0.01" className="num" /></Field>
          </div>
          <Field label={tr('ops.note')}><Input name="note" maxLength={255} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'receive'} onClose={() => { setDrawer(null); setReceivePo(null); }} title={tr('ops.receive')}>
        {receivePo && <form className="grid gap-3" onSubmit={e => {
          e.preventDefault(); const f = new FormData(e.currentTarget);
          const items = receivePo.lines.map(l => ({ itemId: String(l.item_id), quantity: Number(f.get(`q-${l.item_id}`) ?? 0) })).filter(i => i.quantity > 0);
          run(async () => { const x = await api<{ value: number; assets: number; expenseId: string | null }>(`/api/inventory/purchase-orders/${receivePo.po.id}/receive`, { method: 'POST', json: { items } }); setReceivePo(null); setMsg(`${tr('ops.received')} ${money(x.value)}${x.assets ? ` · ${x.assets} ${tr('ops.assets').toLowerCase()}` : ''}`); });
        }}>
          <p className="text-sm"><strong className="num">{receivePo.po.po_no}</strong></p>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('ops.receiveNote')}</p>
          {receivePo.lines.map(l => <Field key={String(l.item_id)} label={`${l.name} (${l.unit})`} hint={`${tr('ops.ordered')} ${Number(l.quantity)} · ${tr('ops.alreadyIn')} ${Number(l.received_qty ?? 0)}`}>
            <Input name={`q-${l.item_id}`} type="number" step="0.01" min="0" max={String(Math.max(0, Number(l.quantity) - Number(l.received_qty ?? 0)))} className="num" defaultValue={String(Math.max(0, Number(l.quantity) - Number(l.received_qty ?? 0)))} />
          </Field>)}
          <Button disabled={busy}>{tr('ops.receive')}</Button>
        </form>}
      </Drawer>

      <Drawer open={drawer === 'docRequest'} onClose={() => setDrawer(null)} title={tr('ops.newDocRequest')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(async () => { const x = await api<{ status: string; blockers?: { detail: string }[] }>('/api/documents/requests', { method: 'POST', json: { docType: f.docType, personType: f.personType, studentId: f.personType === 'student' ? f.personId : null, staffId: f.personType === 'staff' ? f.personId : null, reason: f.reason || null } }); setMsg(x.status === 'blocked' ? `${tr('ops.blocked')}: ${(x.blockers ?? []).map(b => b.detail).join('; ')}` : tr('common.saved')); }); }}>
          <Field label={tr('ops.docType')}><Select name="docType" options={['tc', 'testimonial', 'character', 'bonafide', 'marksheet', 'certificate', 'experience_letter'].map(v => ({ value: v, label: v.replace(/_/g, ' ') }))} /></Field>
          <Field label={tr('ops.person')}><Select name="personType" options={[{ value: 'student', label: 'Student' }, { value: 'staff', label: 'Staff' }]} /></Field>
          <Field label={tr('ops.personId')} hint={tr('ops.personIdHint')}><Input name="personId" required /></Field>
          <Field label={tr('ops.reason')}><Input name="reason" maxLength={255} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'idCards'} onClose={() => setDrawer(null)} title={tr('ops.batchCards')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(async () => { const x = await api<{ cards: number; printJobId: string | null }>('/api/documents/id-cards', { method: 'POST', json: { personType: f.personType, validFrom: f.validFrom, validTo: f.validTo } }); setMsg(x.cards ? `${x.cards} ${tr('ops.cardsQueued')}` : tr('ops.everyoneHasACard')); }); }}>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('ops.idCardsNote')}</p>
          <Field label={tr('ops.person')}><Select name="personType" options={[{ value: 'student', label: 'Student' }, { value: 'staff', label: 'Staff' }]} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('ops.validFrom')}><Input name="validFrom" type="date" required defaultValue={d.date} /></Field><Field label={tr('ops.validTo')}><Input name="validTo" type="date" required defaultValue={`${new Date().getFullYear()}-12-31`} /></Field></div>
          <Button disabled={busy}>{tr('ops.batchCards')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'template'} onClose={() => { setDrawer(null); setTemplate(null); }} title={tr('ops.editTemplate')}>
        {template && <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/documents/templates', { method: 'POST', json: { docType: template.doc_type, name: template.name, body: f.body, pageSize: f.pageSize, orientation: f.orientation } })); }}>
          <p className="text-sm"><strong>{template.name}</strong> <span className="num text-xs" style={{ color: 'var(--muted)' }}>{template.doc_type} · v{template.version}</span></p>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('ops.templateNote')}</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('ops.pageSize')}><Select name="pageSize" defaultValue={template.page_size} options={['A4', 'A5', 'Letter', 'CR80'].map(v => ({ value: v, label: v }))} /></Field>
            <Field label={tr('ops.orientation')}><Select name="orientation" defaultValue={template.orientation} options={[{ value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }]} /></Field>
          </div>
          <Field label={tr('ops.template')} hint={tr('ops.templateHint')}><textarea name="body" className="input" rows={14} defaultValue={template.html_template} maxLength={50_000} required /></Field>
          <div className="flex gap-2">
            <Button disabled={busy}>{tr('common.save')}</Button>
            {/* the draft in the box, not the version on file: a preview of what was saved last week
                does not tell you whether the line you just typed fits on the page */}
            <Button type="button" variant="secondary" disabled={busy} onClick={e => {
              const form = (e.currentTarget as HTMLButtonElement).form;
              const f = form ? Object.fromEntries(new FormData(form).entries()) as Record<string, string> : {};
              run(async () => {
                const x = await api<{ fileId: string }>('/api/documents/templates/preview', { method: 'POST', json: { docType: template.doc_type, name: template.name, body: f.body, pageSize: f.pageSize, orientation: f.orientation } });
                await openFile(x.fileId);
              });
            }}>{tr('ops.previewTemplate')}</Button>
          </div>
        </form>}
      </Drawer>

      <Drawer open={drawer === 'visitor'} onClose={() => setDrawer(null)} title={tr('ops.checkIn')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(async () => { const x = await api<{ badgeNo: string }>('/api/frontoffice/visitors', { method: 'POST', json: { visitorName: f.visitorName, phone: f.phone, purpose: f.purpose } }); setMsg(`${tr('ops.badge')} ${x.badgeNo}`); }); }}>
          <Field label={tr('common.name')}><Input name="visitorName" required /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('common.phone')}><Input name="phone" className="num" /></Field><Field label={tr('ops.purposeCol')}><Select name="purpose" options={[{ value: 'meeting', label: 'Meeting' }, { value: 'admission', label: 'Admission' }, { value: 'delivery', label: 'Delivery' }, { value: 'pickup', label: 'Pickup' }, { value: 'vendor', label: 'Vendor' }, { value: 'other', label: 'Other' }]} /></Field></div>
          <Button disabled={busy}>{tr('ops.checkIn')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'gatePass'} onClose={() => setDrawer(null)} title={tr('ops.newGatePass')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(async () => { const x = await api<{ qr: string }>('/api/frontoffice/gate-passes', { method: 'POST', json: { personType: f.personType, studentId: f.personType === 'student' ? f.personId : null, staffId: f.personType === 'staff' ? f.personId : null, reason: f.reason, pickedBy: f.pickedBy || null, pickerPhone: f.pickerPhone || null } }); setMsg(`${tr('ops.gatePass')} ${x.qr}`); }); }}>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('ops.gatePassesNote')}</p>
          <Field label={tr('ops.person')}><Select name="personType" options={[{ value: 'student', label: 'Student' }, { value: 'staff', label: 'Staff' }]} /></Field>
          <Field label={tr('ops.personId')} hint={tr('ops.personIdHint')}><Input name="personId" required /></Field>
          <Field label={tr('ops.reason')}><Input name="reason" required maxLength={200} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('ops.pickedBy')}><Input name="pickedBy" /></Field><Field label={tr('common.phone')}><Input name="pickerPhone" className="num" /></Field></div>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'call'} onClose={() => setDrawer(null)} title={tr('ops.logCall')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/frontoffice/calls', { method: 'POST', json: { direction: f.direction, callerName: f.callerName || null, phone: f.phone, purpose: f.purpose || null, notes: f.notes || null, followUpAt: f.followUpAt ? `${f.followUpAt} 09:00:00` : null } })); }}>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('ops.direction')}><Select name="direction" options={[{ value: 'inbound', label: 'Inbound' }, { value: 'outbound', label: 'Outbound' }]} /></Field><Field label={tr('common.phone')}><Input name="phone" required className="num" /></Field></div>
          <Field label={tr('ops.callerName')}><Input name="callerName" /></Field>
          <Field label={tr('ops.purposeCol')}><Input name="purpose" maxLength={200} /></Field>
          <Field label={tr('ops.note')}><textarea name="notes" className="input" rows={3} /></Field>
          <Field label={tr('ops.followUp')}><Input name="followUpAt" type="date" /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'post'} onClose={() => setDrawer(null)} title={tr('ops.logPost')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/frontoffice/post', { method: 'POST', json: { direction: f.direction, referenceNo: f.referenceNo || null, fromParty: f.direction === 'receive' ? f.party : null, toParty: f.direction === 'dispatch' ? f.party : null, subject: f.subject, recordDate: f.recordDate || undefined } })); }}>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('ops.direction')}><Select name="direction" options={[{ value: 'receive', label: 'Receive' }, { value: 'dispatch', label: 'Dispatch' }]} /></Field><Field label={tr('common.date')}><Input name="recordDate" type="date" defaultValue={d.date} /></Field></div>
          <Field label={tr('ops.subject')}><Input name="subject" required maxLength={200} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('ops.party')}><Input name="party" /></Field><Field label={tr('ops.reference')}><Input name="referenceNo" className="num" /></Field></div>
          <Button disabled={busy}>{tr('common.save')}</Button>
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

/** A compliance date reads as three things: gone, close, or fine. */
function paper(value: unknown, locale: Locale, tr: (k: Parameters<typeof t>[0]) => string) {
  if (!value) return '—';
  const on = String(value).slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const days = Math.round((Date.parse(`${on}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days < 0) return <Chip status="failed">{tr('ops.expiredOn')} {formatDate(on, locale)}</Chip>;
  if (days <= 30) return <Chip status="pending">{formatDate(on, locale)}</Chip>;
  return formatDate(on, locale);
}
