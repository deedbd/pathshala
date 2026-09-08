import { useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/fees';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Kpi, Select, Tabs, api, formatDate, formatDateTime, formatMoney, formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id; const url = new URL(request.url);
  const year = await context.app.academic.currentYear(sid);
  const yearId = year ? String(year.id) : null;
  const period = url.searchParams.get('period') ?? new Date().toISOString().slice(0, 10);
  const monthStart = period.slice(0, 8) + '01';
  const invoiceStatus = url.searchParams.get('status') ?? undefined;
  const payMethod = url.searchParams.get('method') ?? undefined;
  const [heads, structures, batches, dues, collection, invoices, payments, discounts, classes, students, cash] = await Promise.all([
    context.app.fees.heads(sid), yearId ? context.app.fees.structures(sid, yearId) : [], context.app.fees.batches(sid), context.app.fees.dues(sid),
    context.app.fees.collectionSummary(sid, monthStart, period), context.app.fees.invoices(sid, { period: monthStart, status: invoiceStatus, limit: 100 }),
    context.app.fees.payments(sid, { method: payMethod, limit: 100 }),
    context.app.fees.studentDiscounts(sid, { limit: 100 }),
    context.app.academic.classes(sid), context.app.people.students(sid, { limit: 200 }), context.app.fees.openSessionFor(sid, user.id),
  ]);
  const [cheques, plans, ageing, reminderStages, reminders, cashSessions] = await Promise.all([
    context.app.fees.pendingCheques(sid), context.app.fees.instalmentPlans(sid), context.app.fees.ageing(sid),
    context.app.fees.reminderStages(sid), context.app.fees.reminders(sid, { limit: 200 }), context.app.fees.cashSessions(sid, 10),
  ]);
  const schemes = await context.app.fees.discountSchemes(sid);
  const till = cash ? await context.app.fees.cashSession(sid, String(cash.id)) : null;
  const outstanding = dues.reduce((a, d) => a + Number(d.due), 0);
  const collected = collection.reduce((a, c) => a + Number(c.amount), 0);
  const overdue = Number(ageing.days1to30) + Number(ageing.days31to60) + Number(ageing.days61to90) + Number(ageing.over90);
  return { locale: (user.locale as Locale) || context.locale, period, yearId, invoiceStatus: invoiceStatus ?? '', payMethod: payMethod ?? '', heads, structures, batches, dues, collection, invoices, payments, discounts, schemes, classes, students: students.rows, outstanding, collected, overdue, cash, cheques, plans, ageing, ladder: context.app.fees.ladderStages(), reminderStages, reminders, cashSessions, till };
}
export function meta() { return [{ title: 'Pathshala — Fees' }]; }

export default function Fees() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator(); const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<'dues' | 'invoices' | 'payments' | 'reminders' | 'cash' | 'cheques' | 'instalments' | 'structures' | 'discounts'>('dues');
  const [drawer, setDrawer] = useState<'collect' | 'structure' | 'plan' | 'count' | null>(null);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setDrawer(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const form = (e: React.FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
  const money = (n: unknown) => formatMoney(Number(n ?? 0), d.locale);
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n); };

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
      {/* invoiced comes off the batch row that raised the bills, not from re-adding a page of invoices */}
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={tr('fee.invoiced')} value={money(d.batches.filter(b => String(b.billing_period).slice(0, 7) === d.period.slice(0, 7)).reduce((a, b) => a + Number(b.total_amount), 0))} locale={d.locale} />
        <Kpi label={tr('fee.collected')} value={money(d.collected)} locale={d.locale} />
        <Kpi label={tr('fee.outstanding')} value={money(d.outstanding)} locale={d.locale} />
        <Kpi label={tr('fee.overdue')} value={money(d.overdue)} locale={d.locale} />
      </div>
      <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{formatNumber(d.dues.length, d.locale)} {tr('fee.familiesOwing')} · {formatNumber(Number(d.ageing.invoices), d.locale)} {tr('fee.openInvoices')}</p>
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      {msg && <div className="mt-4"><Banner kind="ok">{msg}</Banner></div>}
      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[{ key: 'dues', label: tr('fee.dues'), count: d.dues.length }, { key: 'invoices', label: tr('fee.invoices'), count: d.invoices.length }, { key: 'payments', label: tr('fee.payments'), count: d.payments.length }, { key: 'reminders', label: tr('fee.reminders'), count: d.reminders.length }, { key: 'cash', label: tr('fee.cash'), count: d.till ? d.till.receipts.length : 0 }, { key: 'cheques', label: tr('fee.cheques'), count: d.cheques.length }, { key: 'instalments', label: tr('fee.instalments'), count: d.plans.length }, { key: 'structures', label: tr('fee.structures'), count: d.structures.length }, { key: 'discounts', label: tr('fee.discounts'), count: d.discounts.length }]} /></div>

      {/* the same buckets the monthly job messages accounts about — read here, not rebuilt by hand */}
      {tab === 'dues' && <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="text-base">{tr('fee.ageing')}</h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('fee.overdueMeans')}</p>
          <ul className="mt-3 grid gap-2">
            {([[tr('fee.notDue'), Number(d.ageing.notDue), 'var(--accent)'], ['1–30', Number(d.ageing.days1to30), 'var(--warn)'], ['31–60', Number(d.ageing.days31to60), 'var(--warn)'], ['61–90', Number(d.ageing.days61to90), 'var(--bad)'], ['90+', Number(d.ageing.over90), 'var(--bad)']] as [string, number, string][]).map(([label, value, colour]) => (
              <li key={label} className="grid grid-cols-[70px_1fr_auto] items-center gap-2 text-xs">
                <span style={{ color: 'var(--muted)' }}>{label}</span>
                <span className="h-2 rounded-[999px]" style={{ background: 'var(--surface-2)' }}><span className="block h-2 rounded-[999px]" style={{ width: `${Number(d.ageing.total) ? Math.max(value / Number(d.ageing.total) * 100, value > 0 ? 2 : 0) : 0}%`, background: colour }} /></span>
                <strong className="num money">{money(value)}</strong>
              </li>
            ))}
          </ul>
          <p className="mt-3 num text-xs" style={{ color: 'var(--muted)' }}>{tr('fee.asOf')} {formatDate(String(d.ageing.asOf), d.locale)} · {formatNumber(Number(d.ageing.invoices), d.locale)} {tr('fee.openInvoices')} · {money(d.ageing.total)}</p>
        </section>
        <section className="card p-4">
          <h2 className="text-base">{tr('fee.byMethod')}</h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('fee.byMethodNote')}</p>
          {(() => {
            const totals = new Map<string, number>();
            for (const c of d.collection) totals.set(String(c.method), (totals.get(String(c.method)) ?? 0) + Number(c.amount));
            const rows = [...totals.entries()].sort((a, b) => b[1] - a[1]);
            const max = rows.reduce((a, r) => Math.max(a, r[1]), 0);
            if (!rows.length) return <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>—</p>;
            return <ul className="mt-3 grid gap-2">{rows.map(([method, amount]) => (
              <li key={method} className="grid grid-cols-[100px_1fr_auto] items-center gap-2 text-xs">
                <span style={{ color: 'var(--muted)' }}>{method.replace('_', ' ')}</span>
                <span className="h-2 rounded-[999px]" style={{ background: 'var(--surface-2)' }}><span className="block h-2 rounded-[999px]" style={{ width: `${max ? Math.max(amount / max * 100, 2) : 0}%`, background: 'var(--accent)' }} /></span>
                <strong className="num money">{money(amount)}</strong>
              </li>))}</ul>;
          })()}
        </section>
      </div>}
      {tab === 'dues' && <div className="mt-4">
        <h2 className="mb-2 text-base">{tr('fee.defaulters')}</h2>
        <DataTable locale={d.locale} rows={d.dues} columns={[{ key: 'admission_no', label: tr('stu.admissionNo'), className: 'num' }, { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` }, { key: 'class_name', label: tr('common.class') }, { key: 'guardian_name', label: tr('stu.guardian'), render: r => String(r.guardian_name ?? '—') }, { key: 'guardian_phone', label: tr('common.phone'), className: 'num', render: r => r.guardian_phone ? <a href={`tel:${String(r.guardian_phone)}`}>{String(r.guardian_phone)}</a> : '—' }, { key: 'invoices', label: tr('fee.openInvoices'), className: 'num' }, { key: 'oldest_due', label: tr('fee.oldestDue'), render: r => formatDate(String(r.oldest_due), d.locale) }, { key: 'due', label: tr('fee.balance'), className: 'num money', render: r => money(r.due) },
          { key: 'student_id', label: '', render: r => <div className="flex gap-1"><Button size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => { const x = await api<{ told: number; owed: number }>(`/api/fees/students/${r.student_id}/remind`, { method: 'POST', json: {} }); setMsg(`${tr('fee.chased')} · ${formatNumber(x.told, d.locale)} ${tr('fee.told')}`); })}>{tr('fee.chase')}</Button><Button size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => { const x = await api<{ already: boolean }>(`/api/fees/students/${r.student_id}/call-task`, { method: 'POST', json: {} }); setMsg(x.already ? tr('fee.callTaskAlready') : tr('fee.callTaskMade')); })}>{tr('fee.callTask')}</Button></div> }]} />
        <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('fee.chaseNote')}</p></div>}

      {tab === 'reminders' && <div className="mt-4">
        <Banner kind="info">{tr('fee.reminderNote')}</Banner>
        <div className="mt-4"><DataTable locale={d.locale} searchable={false} rows={d.reminderStages.map(s => ({ id: s.stage, ...s }))}
          columns={[{ key: 'stage', label: tr('fee.stage'), render: r => <span className="num">{String(r.stage)}</span> }, { key: 'offsetDays', label: tr('fee.whenItFires'), render: r => Number(r.offsetDays) < 0 ? `${Math.abs(Number(r.offsetDays))} ${tr('fee.daysBeforeDue')}` : Number(r.offsetDays) === 0 ? tr('fee.onTheDueDate') : `${r.offsetDays} ${tr('fee.daysAfterDue')}` }, { key: 'reminders', label: tr('fee.told'), className: 'num' }, { key: 'lastSent', label: tr('fee.lastSent'), render: r => r.lastSent ? formatDate(String(r.lastSent), d.locale) : '—' }, { key: 'x', label: '', render: r => <Chip status={Number(r.reminders) ? 'active' : 'pending'}>{Number(r.reminders) ? tr('fee.hasRun') : tr('fee.notYet')}</Chip> }]} /></div>
        <div className="mt-4"><DataTable locale={d.locale} rows={d.reminders as unknown as Record<string, unknown>[]}
          columns={[{ key: 'sent_at', label: tr('fee.sent'), render: r => formatDate(String(r.sent_at), d.locale) }, { key: 'invoice_no', label: tr('fee.invoiceNo'), className: 'num' }, { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` }, { key: 'class_name', label: tr('common.class') }, { key: 'stage', label: tr('fee.stage'), render: r => <Chip status="active">{String(r.stage)}</Chip> },
            { key: 'messages', label: tr('fee.channel'), render: r => { const ms = (r.messages ?? []) as { channel: string; to: string | null }[]; return ms.length ? <span className="flex flex-wrap gap-1">{[...new Set(ms.map(m => m.channel))].map(c => <Chip key={c}>{c}</Chip>)}</span> : <span style={{ color: 'var(--muted)' }}>{String(r.channel)}</span>; } },
            { key: 'told', label: tr('fee.told'), className: 'num' },
            { key: 'delivered', label: tr('fee.cameBack'), render: r => Number(r.failed) ? <Chip status="failed">{`${r.failed} ${tr('fee.failedCount')}`}</Chip> : Number(r.delivered) ? <Chip status="active">{`${r.delivered} ${tr('fee.delivered')}`}</Chip> : <Chip status="pending">{tr('fee.stillQueued')}</Chip> },
            { key: 'balance', label: tr('fee.balance'), className: 'num money', render: r => money(r.balance) }]}
          empty={<p className="p-4 text-sm" style={{ color: 'var(--muted)' }}>{tr('fee.noReminders')}</p>} /></div>
      </div>}

      {tab === 'cash' && <div className="mt-4">
        {!d.till && <Banner kind="info">{tr('fee.noSession')}</Banner>}
        {d.till && <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label={tr('fee.cashTaken')} value={money(d.till.cashTaken)} locale={d.locale} />
            <Kpi label={tr('fee.openingFloat')} value={money(d.till.openingCash)} locale={d.locale} />
            <Kpi label={tr('fee.expected')} value={money(d.till.expected)} locale={d.locale} />
            <Kpi label={tr('fee.takings')} value={money(d.till.takings)} locale={d.locale} />
          </div>
          <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('fee.cashNote')} · {tr('fee.cashier')}: {String(d.till.session.cashier_name ?? '—')} · {tr('fee.openedAt')} {formatDateTime(String(d.till.session.opened_at), d.locale)}</p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => setDrawer('count')}>{tr('fee.countCash')}</Button>
            {d.till.byMethod.map(m => <span key={m.method} className="chip">{m.method.replace('_', ' ')}: <strong className="num money">{money(m.total)}</strong> · {formatNumber(m.count, d.locale)}</span>)}
          </div>
          <div className="mt-4"><DataTable locale={d.locale} rows={d.till.receipts} columns={[{ key: 'payment_no', label: tr('fee.receipt'), className: 'num' }, { key: 'paid_at', label: tr('common.date'), render: r => formatDateTime(String(r.paid_at), d.locale) }, { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name ?? ''} ${r.last_name ?? ''}` }, { key: 'method', label: tr('fee.method'), render: r => <Chip status="active">{String(r.method)}</Chip> }, { key: 'reference', label: 'Reference', render: r => String(r.reference ?? '—') }, { key: 'amount', label: tr('fee.amount'), className: 'num money', render: r => money(r.amount) }]} /></div>
        </>}
        <div className="mt-6">
          <h2 className="mb-2 text-base">{tr('fee.sessions')}</h2>
          <DataTable locale={d.locale} searchable={false} rows={d.cashSessions}
            toolbar={!d.till ? <Button size="sm" onClick={() => run(() => api('/api/fees/cash/open', { method: 'POST', json: { openingCash: 0 } }))} disabled={busy}>{tr('fee.cashOpen')}</Button> : undefined}
            columns={[{ key: 'opened_at', label: tr('fee.openedAt'), render: r => formatDateTime(String(r.opened_at), d.locale) }, { key: 'cashier_name', label: tr('fee.cashier'), render: r => String(r.cashier_name ?? '—') }, { key: 'opening_cash', label: tr('fee.openingFloat'), className: 'num money', render: r => money(r.opening_cash) }, { key: 'cash_taken', label: tr('fee.cashTaken'), className: 'num money', render: r => money(r.cash_taken) }, { key: 'counted_cash', label: tr('fee.counted'), className: 'num money', render: r => r.counted_cash == null ? '—' : money(r.counted_cash) },
              { key: 'variance', label: tr('fee.variance'), render: r => r.variance == null ? <Chip status="pending">{tr('fee.stillOpen')}</Chip> : Number(r.variance) === 0 ? <Chip status="active">{money(0)}</Chip> : <Chip status="failed">{money(r.variance)}</Chip> },
              { key: 'closed_at', label: tr('fee.closedAt'), render: r => r.closed_at ? formatDateTime(String(r.closed_at), d.locale) : '—' }]} />
        </div>
      </div>}

      {tab === 'invoices' && <div className="mt-4"><DataTable locale={d.locale} rows={d.invoices}
        toolbar={<Select value={d.invoiceStatus} onChange={e => setParam('status', e.target.value)} placeholder={tr('fee.everyStatus')} options={['issued', 'partially_paid', 'paid', 'overdue', 'cancelled'].map(s => ({ value: s, label: s }))} className="max-w-[170px]" />}
        columns={[{ key: 'invoice_no', label: tr('fee.invoiceNo'), className: 'num' }, { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name ?? ''} ${r.last_name ?? ''}` }, { key: 'class_name', label: tr('common.class') }, { key: 'billing_period', label: 'Period', render: r => String(r.billing_period ?? '').slice(0, 7) }, { key: 'total', label: tr('fee.amount'), className: 'num money', render: r => money(r.total) }, { key: 'paid_total', label: tr('fee.paid'), className: 'num money', render: r => money(r.paid_total) }, { key: 'balance', label: tr('fee.balance'), className: 'num money', render: r => money(r.balance) }, { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status)} /> }]} /></div>}

      {tab === 'payments' && <div className="mt-4"><DataTable locale={d.locale} rows={d.payments} columns={[{ key: 'payment_no', label: tr('fee.receipt'), className: 'num' }, { key: 'paid_at', label: tr('common.date'), render: r => formatDate(String(r.paid_at), d.locale) }, { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name ?? ''} ${r.last_name ?? ''}` }, { key: 'method', label: tr('fee.method'), render: r => <Chip status="active">{String(r.method)}</Chip> }, { key: 'amount', label: tr('fee.amount'), className: 'num money', render: r => money(r.amount) }, { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status)} /> }, { key: 'id', label: '', render: r => String(r.status) === 'success' ? <Button size="sm" variant="secondary" onClick={() => run(async () => { const rec = await api<{ fileId: string }>(`/api/fees/payments/${r.id}/receipt`, { method: 'POST', json: {} }); const u = await api<{ url: string }>(`/api/files/${rec.fileId}/url`); window.open(u.url, '_blank'); })}>{tr('fee.printReceipt')}</Button> : null }]}
        toolbar={<div className="flex flex-wrap gap-2">
          <Select value={d.payMethod} onChange={e => setParam('method', e.target.value)} placeholder={tr('fee.everyMethod')} options={['cash', 'bkash', 'nagad', 'rocket', 'sslcommerz', 'bank_transfer', 'cheque', 'card', 'wallet'].map(m => ({ value: m, label: m.replace('_', ' ') }))} className="max-w-[170px]" />
          {d.cash ? <Button size="sm" variant="secondary" onClick={() => { setTab('cash'); setDrawer('count'); }}>{tr('fee.cashClose')}</Button> : <Button size="sm" variant="secondary" onClick={() => run(() => api('/api/fees/cash/open', { method: 'POST', json: { openingCash: 0 } }))}>{tr('fee.cashOpen')}</Button>}
        </div>} /></div>}

      {tab === 'cheques' && <div className="mt-4"><DataTable locale={d.locale} rows={d.cheques} columns={[{ key: 'payment_no', label: tr('fee.receipt'), className: 'num' }, { key: 'paid_at', label: tr('common.date'), render: r => formatDate(String(r.paid_at), d.locale) }, { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name ?? ''} ${r.last_name ?? ''}` }, { key: 'reference', label: 'Cheque no' }, { key: 'amount', label: tr('fee.amount'), className: 'num money', render: r => money(r.amount) },
        { key: 'id', label: '', render: r => <div className="flex gap-1"><Button size="sm" onClick={() => run(() => api(`/api/fees/cheques/${r.id}/clear`, { method: 'POST', json: {} }))}>{tr('fee.chequeClear')}</Button><Button size="sm" variant="secondary" onClick={() => { const why = prompt('Why did the bank return it?'); if (why) run(() => api(`/api/fees/cheques/${r.id}/bounce`, { method: 'POST', json: { reason: why } })); }}>{tr('fee.chequeBounce')}</Button></div> }]} />
        <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>A cheque allocates nothing and posts nothing until it clears, so the fee stays outstanding until the bank pays.</p></div>}

      {tab === 'instalments' && <div className="mt-4"><DataTable locale={d.locale} rows={d.plans} toolbar={<div className="flex gap-2"><Button size="sm" onClick={() => setDrawer('plan')}>{tr('fee.newPlan')}</Button><Button size="sm" variant="secondary" onClick={() => run(async () => { const r = await api<{ billed: number }>('/api/fees/instalments/run', { method: 'POST', json: {} }); setMsg(`${r.billed} instalments invoiced`); })} disabled={busy}>{tr('fee.billDue')}</Button></div>}
        columns={[{ key: 'student_id', label: tr('common.name'), render: r => { const st = d.students.find(x => String(x.id) === String(r.student_id)); return st ? `${st.first_name} ${st.last_name ?? ''}` : String(r.student_id); } }, { key: 'total_amount', label: tr('fee.amount'), className: 'num money', render: r => money(r.total_amount) },
          { key: 'instalments', label: tr('fee.instalmentCount'), className: 'num', render: r => { const rows = (typeof r.instalments === 'string' ? JSON.parse(r.instalments) : r.instalments) as { invoiceId: string | null }[]; return `${rows.filter(i => i.invoiceId).length}/${rows.length}`; } },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status)} /> },
          { key: 'id', label: '', render: r => String(r.status) === 'active' ? <Button size="sm" variant="secondary" onClick={() => run(() => api(`/api/fees/instalments/${r.id}/cancel`, { method: 'POST', json: {} }))}>{tr('common.cancel')}</Button> : null }]} /></div>}

      {tab === 'structures' && <div className="mt-4"><DataTable locale={d.locale} rows={d.structures} toolbar={<Button size="sm" onClick={() => setDrawer('structure')}>{tr('common.new')}</Button>}
        columns={[{ key: 'class_name', label: tr('common.class') }, { key: 'name', label: tr('common.name') }, { key: 'items', label: tr('fee.head'), className: 'num' }, { key: 'monthly_total', label: tr('fee.monthly'), className: 'num money', render: r => money(r.monthly_total) }]} /></div>}

      {tab === 'discounts' && <div className="mt-4">
        <h2 className="mb-2 text-base">{tr('fee.schemes')}</h2>
        <DataTable locale={d.locale} searchable={false} rows={d.schemes}
          columns={[{ key: 'name', label: tr('common.name') }, { key: 'discount_kind', label: tr('common.type'), render: r => <Chip>{String(r.discount_kind)}</Chip> }, { key: 'value', label: tr('fee.value'), className: 'num', render: r => String(r.value_type) === 'percent' ? `${formatNumber(Number(r.value), d.locale)}%` : money(r.value) }, { key: 'requires_approval', label: tr('fee.mode'), render: r => <Chip status={Number(r.requires_approval) ? 'pending' : 'active'}>{Number(r.requires_approval) ? tr('fee.needsApproval') : tr('fee.appliesItself')}</Chip> }, { key: 'students', label: tr('fee.holdingIt'), className: 'num' }, { key: 'pending', label: tr('fee.awaiting'), className: 'num' }, { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status)} /> }]}
          empty={<p className="p-4 text-sm" style={{ color: 'var(--muted)' }}>{tr('fee.noSchemes')}</p>} />
        <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('fee.discountNote')}</p>
        <h2 className="mb-2 mt-6 text-base">{tr('fee.whoHasOne')}</h2>
        <DataTable locale={d.locale} rows={d.discounts} columns={[{ key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` }, { key: 'name', label: tr('fee.discounts') }, { key: 'discount_kind', label: 'Kind' }, { key: 'value', label: tr('fee.amount'), className: 'num', render: r => String(r.value_type) === 'percent' ? `${formatNumber(Number(r.value), d.locale)}%` : money(r.value) }, { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status)} /> },
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
      <Drawer open={drawer === 'count'} onClose={() => setDrawer(null)} title={tr('fee.countCash')}>
        {d.till && <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(async () => { const r = await api<{ expected: number; counted: number; variance: number }>('/api/fees/cash/close', { method: 'POST', json: { sessionId: String(d.till!.session.id), countedCash: Number(f.countedCash) } }); setMsg(r.variance === 0 ? `${tr('fee.varianceNone')} · ${money(r.counted)}` : `${tr('fee.variance')} ${money(r.variance)} — ${tr('fee.expected')} ${money(r.expected)}, ${tr('fee.counted')} ${money(r.counted)}`); }); }}>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('fee.openingFloat')}><Input value={money(d.till.openingCash)} readOnly className="num" /></Field>
            <Field label={tr('fee.cashTaken')}><Input value={money(d.till.cashTaken)} readOnly className="num" /></Field>
          </div>
          <Field label={tr('fee.expected')}><Input value={money(d.till.expected)} readOnly className="num" /></Field>
          <Field label={tr('fee.counted')} hint={tr('fee.countHint')}><Input name="countedCash" type="number" step="0.01" min="0" required autoFocus className="num" /></Field>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('fee.varianceNote')}</p>
          <Button disabled={busy}>{tr('fee.cashClose')}</Button>
        </form>}
      </Drawer>
      <Drawer open={drawer === 'plan'} onClose={() => setDrawer(null)} title={tr('fee.instalments')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api('/api/fees/instalments', { method: 'POST', json: { studentId: f.studentId, feeHeadId: f.feeHeadId, totalAmount: Number(f.totalAmount), count: Number(f.count), firstDue: f.firstDue } })); }}>
          <Field label={tr('nav.students')}><Select name="studentId" required placeholder="—" options={d.students.map(s => ({ value: String(s.id), label: `${s.admission_no} · ${s.first_name} ${s.last_name ?? ''}` }))} /></Field>
          <Field label={tr('fee.head')}><Select name="feeHeadId" required placeholder="—" options={d.heads.map(h => ({ value: String(h.id), label: String(h.name) }))} /></Field>
          <div className="grid grid-cols-3 gap-3"><Field label={tr('fee.amount')}><Input name="totalAmount" type="number" step="0.01" min="1" required className="num" /></Field><Field label={tr('fee.instalmentCount')}><Input name="count" type="number" min="2" max="24" defaultValue={3} className="num" /></Field><Field label={tr('fee.firstDue')}><Input name="firstDue" type="date" required /></Field></div>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>Each instalment is invoiced on the day it falls due, so the guardian never sees the whole amount as overdue.</p>
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
