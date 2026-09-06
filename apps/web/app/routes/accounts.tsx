import { useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/accounts';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Kpi, Select, Tabs, Textarea, api, formatDate, formatMoney, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id; const url = new URL(request.url);
  const to = url.searchParams.get('to') ?? new Date().toISOString().slice(0, 10);
  const from = url.searchParams.get('from') ?? to.slice(0, 8) + '01';
  const fy = await context.app.accounting.fiscalYear(sid, to);
  const [statements, entries, expenses, categories, banks, budgets, accounts] = await Promise.all([
    context.app.accounting.statements(sid, from, to), context.app.accounting.entries(sid, { from, to, limit: 60 }), context.app.accounting.expenses(sid, {}),
    context.app.db.findMany('expense_categories', { school_id: sid }, { orderBy: 'name ASC' }), context.app.accounting.bankAccounts(sid), context.app.accounting.budgetStatus(sid, String(fy.id)), context.app.accounting.accounts(sid),
  ]);
  return { locale: (user.locale as Locale) || context.locale, from, to, statements, entries, expenses, categories, banks, budgets, accounts, fiscalYear: fy };
}
export function meta() { return [{ title: 'Pathshala — Accounts' }]; }

export default function Accounts() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator(); const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<'trial' | 'entries' | 'expenses' | 'budgets'>('trial');
  const [drawer, setDrawer] = useState<'expense' | 'journal' | null>(null);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setDrawer(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const form = (e: React.FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
  const money = (n: unknown) => formatMoney(Number(n ?? 0), d.locale);
  const setRange = (k: 'from' | 'to', v: string) => { const n = new URLSearchParams(sp); n.set(k, v); setSp(n); };

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('acc.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('acc.purpose')}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" value={d.from} onChange={e => setRange('from', e.target.value)} className="max-w-[160px]" />
          <Input type="date" value={d.to} onChange={e => setRange('to', e.target.value)} className="max-w-[160px]" />
          <Button size="sm" variant="secondary" onClick={() => setDrawer('journal')}>{tr('acc.entries')} +</Button>
          <Button size="sm" onClick={() => setDrawer('expense')}>{tr('acc.newExpense')}</Button>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={tr('acc.income')} value={money(d.statements.income)} locale={d.locale} />
        <Kpi label={tr('acc.expense')} value={money(d.statements.expense)} locale={d.locale} />
        <Kpi label={tr('acc.surplus')} value={money(d.statements.surplus)} locale={d.locale} />
        <div className="kpi"><div className="kpi-label">{tr('acc.trialBalance')}</div><div className="mt-1"><Chip status={d.statements.balanced ? 'active' : 'failed'}>{d.statements.balanced ? tr('acc.balanced') : tr('acc.unbalanced')}</Chip></div><div className="mt-1 num text-xs" style={{ color: 'var(--muted)' }}>{money(d.statements.totalDebit)} / {money(d.statements.totalCredit)}</div></div>
      </div>
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      {!d.statements.balanced && <div className="mt-4"><Banner kind="bad">{tr('acc.unbalanced')}: {money(d.statements.totalDebit)} vs {money(d.statements.totalCredit)}</Banner></div>}
      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[{ key: 'trial', label: tr('acc.trialBalance'), count: d.statements.accounts.length }, { key: 'entries', label: tr('acc.entries'), count: d.entries.length }, { key: 'expenses', label: tr('acc.expenses'), count: d.expenses.length }, { key: 'budgets', label: tr('acc.budgets'), count: d.budgets.length }]} /></div>

      {tab === 'trial' && <div className="mt-4"><DataTable locale={d.locale} rows={d.statements.accounts} columns={[{ key: 'code', label: 'Code', className: 'num' }, { key: 'name', label: tr('acc.account') }, { key: 'account_type', label: 'Type' }, { key: 'debit', label: tr('acc.debit'), className: 'num money', render: r => money(r.debit) }, { key: 'credit', label: tr('acc.credit'), className: 'num money', render: r => money(r.credit) }, { key: 'balance', label: tr('fee.balance'), className: 'num money', render: r => money(r.balance) }]} /></div>}

      {tab === 'entries' && <div className="mt-4"><DataTable locale={d.locale} rows={d.entries} onRowClick={async r => setDetail(await api(`/api/accounting/entries/${r.id}`))}
        columns={[{ key: 'entry_no', label: tr('acc.entryNo'), className: 'num' }, { key: 'entry_date', label: tr('common.date'), render: r => formatDate(String(r.entry_date), d.locale) }, { key: 'memo', label: 'Memo' }, { key: 'source_type', label: 'Source', render: r => <Chip status="active">{String(r.source_type ?? 'manual')}</Chip> }, { key: 'amount', label: tr('fee.amount'), className: 'num money', render: r => money(r.amount) }, { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'posted' ? 'active' : String(r.status)}>{String(r.status)}</Chip> }]} /></div>}

      {tab === 'expenses' && <div className="mt-4"><DataTable locale={d.locale} rows={d.expenses} columns={[{ key: 'expense_no', label: 'No', className: 'num' }, { key: 'expense_date', label: tr('common.date'), render: r => formatDate(String(r.expense_date), d.locale) }, { key: 'category', label: tr('acc.category') }, { key: 'description', label: 'Description' }, { key: 'amount', label: tr('fee.amount'), className: 'num money', render: r => money(r.amount) }, { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status)} /> }]} /></div>}

      {tab === 'budgets' && <div className="mt-4"><DataTable locale={d.locale} searchable={false} rows={d.budgets} columns={[{ key: 'code', label: 'Code', className: 'num' }, { key: 'name', label: tr('acc.account') }, { key: 'amount', label: 'Budget', className: 'num money', render: r => money(r.amount) }, { key: 'spent', label: 'Spent', className: 'num money', render: r => money(r.spent) }, { key: 'pct', label: '%', className: 'num', render: r => { const pct = Number(r.amount) ? Math.round(Number(r.spent) / Number(r.amount) * 100) : 0; return <Chip status={pct >= Number(r.alert_at_pct) ? 'failed' : 'active'}>{pct}%</Chip>; } }]}
        toolbar={<Button size="sm" variant="secondary" onClick={() => { const acc = d.accounts.find(a => a.code === '5100'); const amt = prompt('Yearly budget for salaries'); if (acc && amt) run(() => api('/api/accounting/budgets', { method: 'POST', json: { glAccountId: String(acc.id), amount: Number(amt) } })); }}>{tr('common.new')}</Button>} /></div>}

      <Drawer open={drawer === 'expense'} onClose={() => setDrawer(null)} title={tr('acc.newExpense')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api('/api/accounting/expenses', { method: 'POST', json: { categoryId: f.categoryId, amount: Number(f.amount), expenseDate: f.expenseDate, description: f.description, paidFromId: f.paidFromId || null, paymentMethod: f.paymentMethod } })); }}>
          <Field label={tr('acc.category')}><Select name="categoryId" required placeholder="—" options={d.categories.map(c => ({ value: String(c.id), label: String(c.name) }))} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('fee.amount')}><Input name="amount" type="number" step="0.01" required className="num" /></Field><Field label={tr('common.date')}><Input name="expenseDate" type="date" defaultValue={d.to} /></Field></div>
          <Field label="Description"><Input name="description" /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('acc.banks')}><Select name="paidFromId" placeholder="Cash" options={d.banks.map(b => ({ value: String(b.id), label: `${b.bank_name} · ${b.account_name}` }))} /></Field><Field label={tr('fee.method')}><Select name="paymentMethod" options={[{ value: 'cash', label: 'Cash' }, { value: 'bank_transfer', label: 'Bank transfer' }, { value: 'bkash', label: 'bKash' }]} /></Field></div>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'journal'} onClose={() => setDrawer(null)} title={tr('acc.entries')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api('/api/accounting/entries', { method: 'POST', json: { entryDate: f.entryDate, memo: f.memo, lines: [{ accountId: f.debitAccount, debit: Number(f.amount) }, { accountId: f.creditAccount, credit: Number(f.amount) }] } })); }}>
          <Field label="Memo"><Textarea name="memo" rows={2} required /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('common.date')}><Input name="entryDate" type="date" defaultValue={d.to} /></Field><Field label={tr('fee.amount')}><Input name="amount" type="number" step="0.01" required className="num" /></Field></div>
          <Field label={tr('acc.debit')}><Select name="debitAccount" required placeholder="—" options={d.accounts.filter(a => !Number(a.is_group)).map(a => ({ value: String(a.id), label: `${a.code} · ${a.name}` }))} /></Field>
          <Field label={tr('acc.credit')}><Select name="creditAccount" required placeholder="—" options={d.accounts.filter(a => !Number(a.is_group)).map(a => ({ value: String(a.id), label: `${a.code} · ${a.name}` }))} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <Drawer open={!!detail} onClose={() => setDetail(null)} title={String((detail as { entry_no?: string })?.entry_no ?? tr('acc.entries'))}>
        {detail && <div className="text-sm">
          <p style={{ color: 'var(--muted)' }}>{String((detail as { memo?: string }).memo ?? '')} · {formatDate(String((detail as { entry_date?: string }).entry_date), d.locale)}</p>
          <table className="table mt-3"><thead><tr><th>{tr('acc.account')}</th><th className="num">{tr('acc.debit')}</th><th className="num">{tr('acc.credit')}</th></tr></thead>
            <tbody>{((detail as { lines?: Record<string, unknown>[] }).lines ?? []).map((l, i) => <tr key={i}><td>{String(l.code)} · {String(l.name)}</td><td className="num money">{Number(l.debit) ? money(l.debit) : ''}</td><td className="num money">{Number(l.credit) ? money(l.credit) : ''}</td></tr>)}</tbody></table>
          <Button className="mt-4" variant="danger" size="sm" onClick={() => run(() => api(`/api/accounting/entries/${(detail as { id: string }).id}/reverse`, { method: 'POST', json: {} }).then(() => setDetail(null)))}>Reverse</Button>
        </div>}
      </Drawer>
    </div>
  );
}
