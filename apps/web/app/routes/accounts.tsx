import { useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/accounts';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Kpi, Select, Tabs, Textarea, api, formatDate, formatMoney, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id; const url = new URL(request.url);
  const to = url.searchParams.get('to') ?? new Date().toISOString().slice(0, 10);
  const from = url.searchParams.get('from') ?? to.slice(0, 8) + '01';
  const source = url.searchParams.get('source') ?? undefined;
  const expenseStatus = url.searchParams.get('expense') ?? undefined;
  const fy = await context.app.accounting.fiscalYear(sid, to);
  const [statements, entries, expenses, categories, banks, budgets, accounts, chart, lines] = await Promise.all([
    context.app.accounting.statements(sid, from, to), context.app.accounting.entries(sid, { from, to, sourceType: source, limit: 100 }), context.app.accounting.expenses(sid, { status: expenseStatus }),
    context.app.db.findMany('expense_categories', { school_id: sid }, { orderBy: 'name ASC' }), context.app.accounting.bankAccounts(sid), context.app.accounting.budgetStatus(sid, String(fy.id)), context.app.accounting.accounts(sid),
    context.app.accounting.chartOfAccounts(sid, to), context.app.accounting.statementLines(sid, { limit: 200 }),
  ]);
  return { locale: (user.locale as Locale) || context.locale, from, to, source: source ?? '', expenseStatus: expenseStatus ?? '', statements, entries, expenses, categories, banks, budgets, accounts, chart, lines, fiscalYear: fy };
}
export function meta() { return [{ title: 'Pathshala — Accounts' }]; }

export default function Accounts() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator(); const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<'coa' | 'trial' | 'entries' | 'expenses' | 'bank' | 'budgets'>('coa');
  const [drawer, setDrawer] = useState<'expense' | 'journal' | 'import' | null>(null);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setDrawer(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const form = (e: React.FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
  const money = (n: unknown) => formatMoney(Number(n ?? 0), d.locale);
  const setRange = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n); };

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
      {msg && <div className="mt-4"><Banner kind="ok">{msg}</Banner></div>}
      {!d.statements.balanced && <div className="mt-4"><Banner kind="bad">{tr('acc.unbalanced')}: {money(d.statements.totalDebit)} vs {money(d.statements.totalCredit)}</Banner></div>}
      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[{ key: 'coa', label: tr('acc.coa'), count: d.chart.accounts.length }, { key: 'trial', label: tr('acc.trialBalance'), count: d.statements.accounts.length }, { key: 'entries', label: tr('acc.entries'), count: d.entries.length }, { key: 'expenses', label: tr('acc.expenses'), count: d.expenses.length }, { key: 'bank', label: tr('acc.bank'), count: d.lines.filter(l => !l.matched_id).length }, { key: 'budgets', label: tr('acc.budgets'), count: d.budgets.length }]} /></div>

      {tab === 'coa' && <div className="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <section className="card overflow-hidden">
          <div className="border-b p-3" style={{ borderColor: 'var(--line)' }}><h2 className="text-base">{tr('acc.coa')}</h2><p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('acc.coaNote')}</p></div>
          <ul className="divide-y text-sm" style={{ borderColor: 'var(--line)' }}>
            {d.chart.accounts.map(a => (
              <li key={a.id} className="flex items-center gap-2 px-3 py-2" style={{ paddingLeft: `${12 + a.depth * 18}px`, background: a.is_group ? 'var(--surface-2)' : undefined }}>
                <span className="num text-xs" style={{ color: 'var(--muted)' }}>{a.code}</span>
                <span className={a.is_group ? 'font-medium' : ''}>{a.name}</span>
                {!a.is_group && <Chip>{a.account_type}</Chip>}
                <span className="num money ml-auto">{money(a.balance)}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card p-4">
          <h2 className="text-base">{tr('acc.autoPosting')}</h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('acc.autoPostingNote')}</p>
          <ul className="mt-3 divide-y text-sm" style={{ borderColor: 'var(--line)' }}>
            {d.accounts.filter(a => !Number(a.is_group) && ['4100', '4110', '4120', '4130', '4140', '4150', '1100', '1220', '5100', '5990'].includes(String(a.code))).map(a => (
              <li key={String(a.id)} className="flex items-center gap-2 py-2"><span className="num text-xs" style={{ color: 'var(--muted)' }}>{String(a.code)}</span><span>{String(a.name)}</span><span className="ml-auto"><Chip status="active">{tr('acc.postedBySystem')}</Chip></span></li>
            ))}
          </ul>
        </section>
      </div>}

      {tab === 'trial' && <div className="mt-4"><DataTable locale={d.locale} rows={d.statements.accounts} columns={[{ key: 'code', label: 'Code', className: 'num' }, { key: 'name', label: tr('acc.account') }, { key: 'account_type', label: 'Type' }, { key: 'debit', label: tr('acc.debit'), className: 'num money', render: r => money(r.debit) }, { key: 'credit', label: tr('acc.credit'), className: 'num money', render: r => money(r.credit) }, { key: 'balance', label: tr('fee.balance'), className: 'num money', render: r => money(r.balance) }]} /></div>}

      {tab === 'entries' && <div className="mt-4"><DataTable locale={d.locale} rows={d.entries} onRowClick={async r => setDetail(await api(`/api/accounting/entries/${r.id}`))}
        toolbar={<div className="flex flex-wrap gap-2"><Select value={d.source} onChange={e => setRange('source', e.target.value)} placeholder={tr('acc.everySource')} options={['invoice', 'payment', 'refund', 'expense', 'payroll', 'inventory'].map(s => ({ value: s, label: s }))} className="max-w-[160px]" /><Button size="sm" variant="secondary" onClick={() => setDrawer('journal')}>{tr('acc.manualEntry')}</Button></div>}
        columns={[{ key: 'entry_no', label: tr('acc.entryNo'), className: 'num' }, { key: 'entry_date', label: tr('common.date'), render: r => formatDate(String(r.entry_date), d.locale) }, { key: 'memo', label: 'Memo' }, { key: 'source_type', label: 'Source', render: r => <Chip>{String(r.source_type ?? 'manual')}</Chip> }, { key: 'is_auto', label: tr('acc.postedBy'), render: r => Number(r.is_auto) ? <Chip status="active">{tr('acc.postedBySystem')}</Chip> : <Chip status="draft">{tr('acc.byHand')}</Chip> }, { key: 'amount', label: tr('fee.amount'), className: 'num money', render: r => money(r.amount) }, { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'posted' ? 'active' : String(r.status)}>{String(r.status)}</Chip> }]} />
        <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('acc.journalNote')}</p></div>}

      {tab === 'expenses' && <div className="mt-4">
        <DataTable locale={d.locale} rows={d.expenses} toolbar={<div className="flex flex-wrap gap-2"><Select value={d.expenseStatus} onChange={e => setRange('expense', e.target.value)} placeholder={tr('acc.everyStatus')} options={['pending', 'approved', 'paid', 'rejected'].map(s => ({ value: s, label: s }))} className="max-w-[150px]" /><Button size="sm" onClick={() => setDrawer('expense')}>{tr('acc.newExpense')}</Button></div>}
          columns={[{ key: 'expense_no', label: 'No', className: 'num' }, { key: 'expense_date', label: tr('common.date'), render: r => formatDate(String(r.expense_date), d.locale) }, { key: 'category', label: tr('acc.category') }, { key: 'vendor', label: tr('acc.vendor'), render: r => String(r.vendor ?? '—') }, { key: 'description', label: 'Description' }, { key: 'amount', label: tr('fee.amount'), className: 'num money', render: r => money(r.amount) }, { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status)} /> },
            { key: 'id', label: '', render: r => String(r.status) === 'approved' ? <Button size="sm" onClick={() => run(async () => { const p = await api<{ entryNo?: string; alreadyPosted?: boolean }>(`/api/accounting/expenses/${r.id}/pay`, { method: 'POST', json: {} }); setMsg(p.alreadyPosted ? tr('acc.alreadyPosted') : `${tr('acc.paidAndPosted')} · ${p.entryNo ?? ''}`); })} disabled={busy}>{tr('acc.payExpense')}</Button> : String(r.status) === 'paid' && r.journal_entry_id ? <Chip status="active">{tr('acc.posted')}</Chip> : null }]} />
        <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('acc.payNote')}</p>
      </div>}

      {tab === 'bank' && <div className="mt-4">
        {/* the balance is the ledger's, not a figure typed in beside the account: the same journal lines the modules wrote */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{d.banks.map(b => { const gl = d.chart.accounts.find(a => a.id === String(b.gl_account_id)); return <Kpi key={String(b.id)} label={`${b.bank_name} · ${b.account_name}`} value={gl ? money(gl.balance) : String(b.account_no)} locale={d.locale} />; })}</div>
        <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('acc.bankNote')}</p>
        <div className="mt-4"><DataTable locale={d.locale} rows={d.lines}
          toolbar={<div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setDrawer('import')}>{tr('acc.import')}</Button>
            <Button size="sm" variant="secondary" disabled={busy || !d.banks.length} onClick={() => run(async () => { const r = await api<{ lines: number; matched: number; unmatched: number }>('/api/accounting/bank/reconcile', { method: 'POST', json: { bankAccountId: String(d.banks[0].id) } }); setMsg(`${r.matched} ${tr('acc.matchedCount')} · ${r.unmatched} ${tr('acc.leftOver')}`); })}>{tr('acc.reconcile')}</Button>
          </div>}
          columns={[{ key: 'txn_date', label: tr('common.date'), render: r => formatDate(String(r.txn_date), d.locale) }, { key: 'bank_name', label: tr('acc.banks'), render: r => `${r.bank_name} · ${r.account_name}` }, { key: 'description', label: 'Description', render: r => String(r.description ?? '—') }, { key: 'reference', label: 'Reference', className: 'num', render: r => String(r.reference ?? '—') }, { key: 'credit', label: tr('acc.credit'), className: 'num money', render: r => Number(r.credit) ? money(r.credit) : '' }, { key: 'debit', label: tr('acc.debit'), className: 'num money', render: r => Number(r.debit) ? money(r.debit) : '' },
            { key: 'matched_type', label: tr('acc.matched'), render: r => r.matched_id ? <Chip status="active">{String(r.matched_type)}</Chip> : <Chip status="pending">{tr('acc.unmatched')}</Chip> }]}
          empty={<p className="p-4 text-sm" style={{ color: 'var(--muted)' }}>{tr('acc.noStatement')}</p>} /></div>
      </div>}

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
      <Drawer open={drawer === 'import'} onClose={() => setDrawer(null)} title={tr('acc.import')}>
        <form className="grid gap-3" onSubmit={e => {
          e.preventDefault(); const f = form(e);
          // one line per row: date,description,reference,debit,credit — the same shape every BD bank exports
          const lines = f.csv.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split(',').map(c => c.trim()))
            .filter(c => /^\d{4}-\d{2}-\d{2}$/.test(c[0] ?? ''))
            .map(c => ({ txnDate: c[0], description: (c[1] || '').slice(0, 255), reference: (c[2] || '').slice(0, 120), debit: Number(c[3] || 0), credit: Number(c[4] || 0) }));
          if (!lines.length) { setErr(tr('acc.noLines')); return; }
          run(async () => { const r = await api<{ imported: number; matched: number; unmatched: number }>('/api/accounting/bank/import', { method: 'POST', json: { bankAccountId: f.bankAccountId, lines } }); setMsg(`${r.imported} ${tr('acc.linesImported')} · ${r.matched} ${tr('acc.matchedCount')} · ${r.unmatched} ${tr('acc.leftOver')}`); });
        }}>
          <Field label={tr('acc.banks')}><Select name="bankAccountId" required placeholder="—" options={d.banks.map(b => ({ value: String(b.id), label: `${b.bank_name} · ${b.account_name}` }))} /></Field>
          <Field label={tr('acc.csv')} hint={tr('acc.csvHint')}><Textarea name="csv" rows={8} required placeholder={'2026-09-01,BKASH SETTLEMENT,TRX448210,0,45200'} /></Field>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('acc.importNote')}</p>
          <Button disabled={busy}>{tr('acc.import')}</Button>
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
