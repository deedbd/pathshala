import { useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/fees';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Kpi, Select, Tabs, api, formatDate, formatMoney, formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id; const url = new URL(request.url);
  const year = await context.app.academic.currentYear(sid);
  const yearId = year ? String(year.id) : null;
  const period = url.searchParams.get('period') ?? new Date().toISOString().slice(0, 10);
  const monthStart = period.slice(0, 8) + '01';
  const [heads, structures, batches, dues, collection, invoices, payments, discounts, classes, students, cash] = await Promise.all([
    context.app.fees.heads(sid), yearId ? context.app.fees.structures(sid, yearId) : [], context.app.fees.batches(sid), context.app.fees.dues(sid),
    context.app.fees.collectionSummary(sid, monthStart, period), context.app.fees.invoices(sid, { period: monthStart, limit: 100 }),
    context.app.db.query(`SELECT p.*, s.first_name, s.last_name, s.admission_no FROM payments p LEFT JOIN students s ON s.id = p.student_id WHERE p.school_id = ? ORDER BY p.paid_at DESC LIMIT 50`, [sid]),
    context.app.db.query(`SELECT sd.id, sd.status, ds.name, ds.discount_kind, ds.value_type, ds.value, s.first_name, s.last_name FROM student_discounts sd JOIN discount_schemes ds ON ds.id = sd.discount_scheme_id JOIN students s ON s.id = sd.student_id WHERE sd.school_id = ? ORDER BY sd.created_at DESC LIMIT 100`, [sid]),
    context.app.academic.classes(sid), context.app.people.students(sid, { limit: 200 }), context.app.fees.openSessionFor(sid, user.id),
  ]);
  const outstanding = dues.reduce((a, d) => a + Number(d.due), 0);
  const collected = collection.reduce((a, c) => a + Number(c.amount), 0);
  return { locale: (user.locale as Locale) || context.locale, period, yearId, heads, structures, batches, dues, collection, invoices, payments, discounts, classes, students: students.rows, outstanding, collected, cash };
}
export function meta() { return [{ title: 'Pathshala — Fees' }]; }

export default function Fees() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator(); const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<'dues' | 'invoices' | 'payments' | 'structures' | 'discounts'>('dues');
  const [drawer, setDrawer] = useState<'collect' | 'structure' | null>(null);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setDrawer(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const form = (e: React.FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
  const money = (n: unknown) => formatMoney(Number(n ?? 0), d.locale);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('fee.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('fee.purpose')}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <Input type="month" value={d.period.slice(0, 7)} onChange={e => { const n = new URLSearchParams(sp); n.set('period', e.target.value + '-01'); setSp(n); }} className="max-w-[150px]" />
          <Button size="sm" variant="secondary" onClick={() => run(async () => { const r = await api<{ invoices?: number; queued?: boolean }>('/api/fees/batches', { method: 'POST', json: { billingPeriod: d.period } }); setMsg(r.queued ? 'Invoice batch queued' : `${r.invoices ?? 0} invoices`); })} disabled={busy}>{tr('fee.generate')}</Button>
          <Button size="sm" variant="secondary" onClick={() => run(async () => { const r = await api<{ sent: number }>('/api/fees/reminders/run', { method: 'POST', json: {} }); setMsg(`${r.sent} reminders sent`); })} disabled={busy}>{tr('fee.remind')}</Button>
          <Button size="sm" onClick={() => setDrawer('collect')}>{tr('fee.collect')}</Button>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={tr('fee.outstanding')} value={money(d.outstanding)} locale={d.locale} />
        <Kpi label={tr('fee.collected')} value={money(d.collected)} locale={d.locale} />
        <Kpi label={tr('fee.invoices')} value={d.invoices.length} locale={d.locale} />
        <Kpi label={tr('fee.dues')} value={d.dues.length} locale={d.locale} />
      </div>
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      {msg && <div className="mt-4"><Banner kind="ok">{msg}</Banner></div>}
      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[{ key: 'dues', label: tr('fee.dues'), count: d.dues.length }, { key: 'invoices', label: tr('fee.invoices'), count: d.invoices.length }, { key: 'payments', label: tr('fee.payments'), count: d.payments.length }, { key: 'structures', label: tr('fee.structures'), count: d.structures.length }, { key: 'discounts', label: tr('fee.discounts'), count: d.discounts.length }]} /></div>

      {tab === 'dues' && <div className="mt-4"><DataTable locale={d.locale} rows={d.dues} columns={[{ key: 'admission_no', label: tr('stu.admissionNo'), className: 'num' }, { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` }, { key: 'class_name', label: tr('common.class') }, { key: 'invoices', label: tr('fee.invoices'), className: 'num' }, { key: 'oldest_due', label: tr('fee.due'), render: r => formatDate(String(r.oldest_due), d.locale) }, { key: 'due', label: tr('fee.balance'), className: 'num money', render: r => money(r.due) }]} /></div>}

      {tab === 'invoices' && <div className="mt-4"><DataTable locale={d.locale} rows={d.invoices} columns={[{ key: 'invoice_no', label: tr('fee.invoiceNo'), className: 'num' }, { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name ?? ''} ${r.last_name ?? ''}` }, { key: 'class_name', label: tr('common.class') }, { key: 'billing_period', label: 'Period', render: r => String(r.billing_period ?? '').slice(0, 7) }, { key: 'total', label: tr('fee.amount'), className: 'num money', render: r => money(r.total) }, { key: 'paid_total', label: tr('fee.paid'), className: 'num money', render: r => money(r.paid_total) }, { key: 'balance', label: tr('fee.balance'), className: 'num money', render: r => money(r.balance) }, { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status)} /> }]} /></div>}

      {tab === 'payments' && <div className="mt-4"><DataTable locale={d.locale} rows={d.payments} columns={[{ key: 'payment_no', label: tr('fee.receipt'), className: 'num' }, { key: 'paid_at', label: tr('common.date'), render: r => formatDate(String(r.paid_at), d.locale) }, { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name ?? ''} ${r.last_name ?? ''}` }, { key: 'method', label: tr('fee.method'), render: r => <Chip status="active">{String(r.method)}</Chip> }, { key: 'amount', label: tr('fee.amount'), className: 'num money', render: r => money(r.amount) }, { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status)} /> }]}
        toolbar={d.cash ? <Button size="sm" variant="secondary" onClick={() => { const counted = prompt('Counted cash'); if (counted != null) run(async () => { const r = await api<{ variance: number }>('/api/fees/cash/close', { method: 'POST', json: { sessionId: String(d.cash!.id), countedCash: Number(counted) } }); setMsg(`Variance ${r.variance}`); }); }}>{tr('fee.cashClose')}</Button> : <Button size="sm" variant="secondary" onClick={() => run(() => api('/api/fees/cash/open', { method: 'POST', json: { openingCash: 0 } }))}>{tr('fee.cashOpen')}</Button>} /></div>}

      {tab === 'structures' && <div className="mt-4"><DataTable locale={d.locale} rows={d.structures} toolbar={<Button size="sm" onClick={() => setDrawer('structure')}>{tr('common.new')}</Button>}
        columns={[{ key: 'class_name', label: tr('common.class') }, { key: 'name', label: tr('common.name') }, { key: 'items', label: tr('fee.head'), className: 'num' }, { key: 'monthly_total', label: tr('fee.monthly'), className: 'num money', render: r => money(r.monthly_total) }]} /></div>}

      {tab === 'discounts' && <div className="mt-4"><DataTable locale={d.locale} rows={d.discounts} columns={[{ key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` }, { key: 'name', label: tr('fee.discounts') }, { key: 'discount_kind', label: 'Kind' }, { key: 'value', label: tr('fee.amount'), className: 'num', render: r => String(r.value_type) === 'percent' ? `${formatNumber(Number(r.value), d.locale)}%` : money(r.value) }, { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status)} /> },
        { key: 'id', label: '', render: r => String(r.status) === 'pending' ? <div className="flex gap-1"><Button size="sm" onClick={() => run(() => api(`/api/fees/discounts/${r.id}/decide`, { method: 'POST', json: { decision: 'approved' } }))}>{tr('lv.approve')}</Button><Button size="sm" variant="secondary" onClick={() => run(() => api(`/api/fees/discounts/${r.id}/decide`, { method: 'POST', json: { decision: 'rejected' } }))}>{tr('lv.reject')}</Button></div> : null }]} /></div>}

      <Drawer open={drawer === 'collect'} onClose={() => setDrawer(null)} title={tr('fee.collect')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(async () => { const r = await api<{ paymentNo: string; unallocated: number }>('/api/fees/payments', { method: 'POST', json: { studentId: f.studentId, amount: Number(f.amount), method: f.method, reference: f.reference || null } }); setMsg(`${tr('fee.receipt')} ${r.paymentNo}${r.unallocated ? ` · advance ${r.unallocated}` : ''}`); }); }}>
          <Field label={tr('nav.students')}><Select name="studentId" required placeholder="—" options={d.students.map(s => ({ value: String(s.id), label: `${s.admission_no} · ${s.first_name} ${s.last_name ?? ''}` }))} /></Field>
          <Field label={tr('fee.amount')}><Input name="amount" type="number" step="0.01" min="1" required className="num" /></Field>
          <Field label={tr('fee.method')}><Select name="method" options={[{ value: 'cash', label: 'Cash' }, { value: 'bkash', label: 'bKash' }, { value: 'nagad', label: 'Nagad' }, { value: 'bank_transfer', label: 'Bank transfer' }, { value: 'cheque', label: 'Cheque' }]} /></Field>
          <Field label="Reference"><Input name="reference" /></Field>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>Allocation is oldest invoice first; anything left over stays as an advance.</p>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'structure'} onClose={() => setDrawer(null)} title={tr('fee.structures')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api('/api/fees/structures', { method: 'POST', json: { classId: f.classId, name: f.name, items: [{ feeHeadId: f.feeHeadId, amount: Number(f.amount), frequency: f.frequency, dueDay: Number(f.dueDay) || 10 }] } })); }}>
          <Field label={tr('common.class')}><Select name="classId" required placeholder="—" options={d.classes.map(c => ({ value: String(c.id), label: String(c.name) }))} /></Field>
          <Field label={tr('common.name')}><Input name="name" required defaultValue="Fees" /></Field>
          <Field label={tr('fee.head')}><Select name="feeHeadId" required placeholder="—" options={d.heads.map(h => ({ value: String(h.id), label: String(h.name) }))} /></Field>
          <div className="grid grid-cols-3 gap-3"><Field label={tr('fee.amount')}><Input name="amount" type="number" step="0.01" required className="num" /></Field><Field label="Frequency"><Select name="frequency" options={[{ value: 'monthly', label: 'Monthly' }, { value: 'yearly', label: 'Yearly' }, { value: 'half_yearly', label: 'Half-yearly' }, { value: 'quarterly', label: 'Quarterly' }, { value: 'one_time', label: 'One time' }]} /></Field><Field label="Due day"><Input name="dueDay" type="number" defaultValue={10} className="num" /></Field></div>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
    </div>
  );
}
