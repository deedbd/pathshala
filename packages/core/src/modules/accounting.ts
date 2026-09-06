import type { Db, Row } from '@pathshala/db';
import { nowSql, ulid } from '@pathshala/db';
import type { OutboxService } from '../automation/outbox.js';
import type { NumberingService } from './numbering.js';
import type { ApprovalService } from '../approvals.js';
import { HttpError, badRequest, notFound } from '../context.js';

export interface JournalLine { accountCode?: string; accountId?: string; debit?: number; credit?: number; description?: string; costCenterId?: string | null }
export interface JournalInput { entryDate?: string; memo?: string; sourceType?: string; sourceId?: string | null; lines: JournalLine[]; isAuto?: boolean; postedBy?: string | null }

/**
 * Double-entry general ledger. Every money movement in the platform posts a journal entry through
 * `post()` — fee invoices, payments, refunds, expenses, payroll — so the trial balance is produced
 * from the same rows the modules wrote, and never from a separate "accounting import".
 * Entries are balanced or refused; the chart of accounts is seeded per school (BD school COA).
 */
export class AccountingService {
  constructor(private db: Db, private outbox: OutboxService, private numbering: NumberingService, private approvals: ApprovalService) {}

  async accounts(schoolId: string) { return this.db.findMany<Row>('gl_accounts', { school_id: schoolId, status: 'active' }, { orderBy: 'code ASC' }); }
  async accountByCode(schoolId: string, code: string) {
    const a = await this.db.findOne<Row>('gl_accounts', { school_id: schoolId, code });
    if (!a) throw new HttpError(409, `chart of accounts is missing ${code} — re-run the seeds`, 'no_account');
    return a;
  }
  /** The fiscal year covering `date`, created on demand from the school's academic year dates. */
  async fiscalYear(schoolId: string, date = nowSql().slice(0, 10)) {
    const ex = await this.db.query<Row>(`SELECT * FROM fiscal_years WHERE school_id = ? AND start_date <= ? AND end_date >= ? LIMIT 1`, [schoolId, date, date]);
    if (ex[0]) return ex[0];
    const y = Number(date.slice(0, 4));
    const id = ulid();
    await this.db.insert('fiscal_years', { id, school_id: schoolId, name: String(y), start_date: `${y}-01-01`, end_date: `${y}-12-31`, is_closed: false });
    return (await this.db.findOne<Row>('fiscal_years', { id }))!;
  }

  /** Posts a balanced entry. Lines may name accounts by code (portable across schools) or by id. */
  async post(schoolId: string, input: JournalInput, tx?: Db): Promise<{ id: string; entryNo: string; total: number }> {
    const run = async (t: Db) => {
      const date = input.entryDate ?? nowSql().slice(0, 10);
      const fy = await this.fiscalYear(schoolId, date);
      if (Number(fy.is_closed)) throw new HttpError(409, `fiscal year ${fy.name} is closed`, 'closed');
      const lines: { accountId: string; debit: number; credit: number; description?: string; costCenterId?: string | null }[] = [];
      for (const l of input.lines) {
        const accountId = l.accountId ?? String((await this.accountByCode(schoolId, l.accountCode!)).id);
        const debit = round(l.debit ?? 0), credit = round(l.credit ?? 0);
        if (debit && credit) throw badRequest('a journal line is either a debit or a credit, not both');
        if (!debit && !credit) continue;
        lines.push({ accountId, debit, credit, description: l.description, costCenterId: l.costCenterId ?? null });
      }
      if (lines.length < 2) throw badRequest('a journal entry needs at least two lines');
      const dr = round(lines.reduce((a, l) => a + l.debit, 0)), cr = round(lines.reduce((a, l) => a + l.credit, 0));
      if (dr !== cr) throw new HttpError(409, `entry does not balance: debit ${dr} vs credit ${cr}`, 'unbalanced');
      const id = ulid();
      const entryNo = await this.numbering.next(schoolId, 'journal_no', { prefix: 'JV-', padding: 6, resetYearly: true }, t);
      await t.insert('journal_entries', { id, school_id: schoolId, fiscal_year_id: String(fy.id), entry_no: entryNo, entry_date: date, memo: input.memo ?? null, source_type: input.sourceType ?? null, source_id: input.sourceId ?? null, status: 'posted', posted_by: input.postedBy ?? null, is_auto: input.isAuto ?? true });
      await t.insertMany('journal_lines', lines.map(l => ({ id: ulid(), school_id: schoolId, entry_id: id, account_id: l.accountId, cost_center_id: l.costCenterId, debit: l.debit, credit: l.credit, description: l.description ?? null })));
      return { id, entryNo, total: dr };
    };
    return tx ? run(tx) : this.db.transaction(run);
  }

  /** Reverses an entry with a mirrored one (never deletes: the audit trail must stay). */
  async reverse(schoolId: string, entryId: string, memo?: string) {
    const entry = await this.db.findOne<Row>('journal_entries', { id: entryId, school_id: schoolId });
    if (!entry) throw notFound('journal entry');
    if (entry.status === 'reversed') throw badRequest('already reversed');
    const lines = await this.db.findMany<Row>('journal_lines', { entry_id: entryId });
    const r = await this.post(schoolId, { entryDate: nowSql().slice(0, 10), memo: memo ?? `Reversal of ${entry.entry_no}`, sourceType: 'reversal', sourceId: entryId, lines: lines.map(l => ({ accountId: String(l.account_id), debit: Number(l.credit), credit: Number(l.debit), description: String(l.description ?? '') })) });
    await this.db.update('journal_entries', { status: 'reversed', reversal_of_id: r.id, updated_at: nowSql() }, { id: entryId });
    return r;
  }

  async entries(schoolId: string, f: { from?: string; to?: string; sourceType?: string; limit?: number } = {}) {
    const where = ['e.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.from) { where.push('e.entry_date >= ?'); params.push(f.from); }
    if (f.to) { where.push('e.entry_date <= ?'); params.push(f.to); }
    if (f.sourceType) { where.push('e.source_type = ?'); params.push(f.sourceType); }
    return this.db.query<Row>(`SELECT e.*, (SELECT SUM(l.debit) FROM journal_lines l WHERE l.entry_id = e.id) AS amount FROM journal_entries e WHERE ${where.join(' AND ')} ORDER BY e.entry_date DESC, e.entry_no DESC LIMIT ${Math.min(500, f.limit ?? 100)}`, params);
  }
  async entry(schoolId: string, id: string) {
    const e = await this.db.findOne<Row>('journal_entries', { id, school_id: schoolId }); if (!e) throw notFound('journal entry');
    const lines = await this.db.query<Row>(`SELECT l.*, a.code, a.name FROM journal_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.debit DESC`, [id]);
    return { ...e, lines };
  }

  /** Trial balance: every account with movement in the period, plus the totals that must match. */
  async trialBalance(schoolId: string, from: string, to: string) {
    const rows = await this.db.query<Row>(`SELECT a.id, a.code, a.name, a.account_type, SUM(l.debit) AS debit, SUM(l.credit) AS credit
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN gl_accounts a ON a.id = l.account_id
      WHERE l.school_id = ? AND e.entry_date BETWEEN ? AND ? AND e.status = 'posted'
      GROUP BY a.id, a.code, a.name, a.account_type ORDER BY a.code`, [schoolId, from, to]);
    const accounts = rows.map(r => { const debit = Number(r.debit ?? 0), credit = Number(r.credit ?? 0); return { id: String(r.id), code: String(r.code), name: String(r.name), account_type: String(r.account_type), debit, credit, balance: round(debit - credit) }; });
    const totalDebit = round(accounts.reduce((a, r) => a + r.debit, 0));
    const totalCredit = round(accounts.reduce((a, r) => a + r.credit, 0));
    return { from, to, accounts, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
  }
  /** Income statement and balance sheet from the same lines. */
  async statements(schoolId: string, from: string, to: string) {
    const tb = await this.trialBalance(schoolId, from, to);
    const sum = (type: string) => round(tb.accounts.filter(a => a.account_type === type).reduce((s, a) => s + (type === 'income' || type === 'liability' || type === 'equity' ? -a.balance : a.balance), 0));
    const income = sum('income'), expense = sum('expense');
    return { ...tb, income, expense, surplus: round(income - expense), assets: sum('asset'), liabilities: sum('liability'), equity: sum('equity') };
  }

  // ---------- expenses ----------
  async createExpense(schoolId: string, e: { categoryId: string; vendorId?: string | null; expenseDate?: string; amount: number; description?: string; paidFromId?: string | null; paymentMethod?: string; billFileId?: string | null; requestedBy?: string | null }) {
    const id = ulid();
    const expenseNo = await this.numbering.next(schoolId, 'expense_no', { prefix: 'EXP-', padding: 5, resetYearly: true });
    const cat = await this.db.findOne<Row>('expense_categories', { id: e.categoryId, school_id: schoolId });
    if (!cat) throw notFound('expense category');
    const ap = await this.approvals.request({ schoolId, entityType: 'expense', entityId: id, summary: { amount: e.amount, category: cat.name } });
    await this.db.insert('expenses', { id, school_id: schoolId, expense_no: expenseNo, category_id: e.categoryId, vendor_id: e.vendorId ?? null, expense_date: e.expenseDate ?? nowSql().slice(0, 10), amount: e.amount, tax_amount: 0, paid_from_id: e.paidFromId ?? null, payment_method: e.paymentMethod ?? 'cash', description: e.description ?? null, bill_file_id: e.billFileId ?? null, requested_by: e.requestedBy ?? null, status: ap.status === 'approved' ? 'approved' : 'pending', approval_request_id: ap.id });
    if (ap.status === 'approved') await this.payExpense(schoolId, id);
    return { id, expenseNo, status: ap.status };
  }
  /** L: approved expense → Dr expense account, Cr cash/bank. */
  async payExpense(schoolId: string, expenseId: string) {
    const e = await this.db.findOne<Row>('expenses', { id: expenseId, school_id: schoolId });
    if (!e) throw notFound('expense');
    if (e.journal_entry_id) return { alreadyPosted: true, journalEntryId: String(e.journal_entry_id) };
    const cat = await this.db.findOne<Row>('expense_categories', { id: String(e.category_id) });
    const expenseAccount = cat?.gl_account_id ? String(cat.gl_account_id) : String((await this.accountByCode(schoolId, '5990')).id);
    const cashAccount = e.paid_from_id ? String((await this.db.findOne<Row>('bank_accounts', { id: String(e.paid_from_id) }))?.gl_account_id) : String((await this.accountByCode(schoolId, '1100')).id);
    const j = await this.post(schoolId, { entryDate: String(e.expense_date), memo: `${e.expense_no} ${e.description ?? ''}`.trim(), sourceType: 'expense', sourceId: expenseId, lines: [{ accountId: expenseAccount, debit: Number(e.amount) }, { accountId: cashAccount, credit: Number(e.amount) }] });
    await this.db.update('expenses', { status: 'paid', paid_at: nowSql(), journal_entry_id: j.id, updated_at: nowSql() }, { id: expenseId });
    return { journalEntryId: j.id, entryNo: j.entryNo };
  }
  async expenses(schoolId: string, f: { status?: string; from?: string; to?: string } = {}) {
    const where = ['e.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.status) { where.push('e.status = ?'); params.push(f.status); }
    if (f.from) { where.push('e.expense_date >= ?'); params.push(f.from); }
    if (f.to) { where.push('e.expense_date <= ?'); params.push(f.to); }
    return this.db.query<Row>(`SELECT e.*, c.name AS category, v.name AS vendor FROM expenses e JOIN expense_categories c ON c.id = e.category_id LEFT JOIN vendors v ON v.id = e.vendor_id WHERE ${where.join(' AND ')} ORDER BY e.expense_date DESC LIMIT 200`, params);
  }
  async ensureExpenseCategories(schoolId: string) {
    if (await this.db.count('expense_categories', { school_id: schoolId })) return 0;
    const defaults: [string, string][] = [['Salaries & allowances', '5100'], ['Utilities', '5200'], ['Rent', '5300'], ['Repairs & maintenance', '5400'], ['Stationery & printing', '5500'], ['Transport running cost', '5600'], ['SMS & communication', '5800'], ['Miscellaneous', '5990']];
    for (const [name, code] of defaults) {
      const acc = await this.db.findOne<Row>('gl_accounts', { school_id: schoolId, code });
      await this.db.insert('expense_categories', { id: ulid(), school_id: schoolId, name, gl_account_id: acc ? String(acc.id) : null, requires_approval_above: null });
    }
    return defaults.length;
  }

  /** Cash/bank accounts the counter and the gateways settle into. */
  async ensureBankAccounts(schoolId: string) {
    if (await this.db.count('bank_accounts', { school_id: schoolId })) return 0;
    const cash = await this.accountByCode(schoolId, '1100');
    const mfs = await this.accountByCode(schoolId, '1220');
    await this.db.insert('bank_accounts', { id: ulid(), school_id: schoolId, gl_account_id: String(cash.id), bank_name: 'Cash box', branch: null, account_name: 'Counter cash', account_no: 'CASH', account_kind: 'cash_box', is_default_collection: true, status: 'active' });
    await this.db.insert('bank_accounts', { id: ulid(), school_id: schoolId, gl_account_id: String(mfs.id), bank_name: 'Mobile wallet', branch: null, account_name: 'bKash / Nagad', account_no: 'MFS', account_kind: 'mfs', is_default_collection: false, status: 'active' });
    return 2;
  }
  async bankAccounts(schoolId: string) { return this.db.findMany<Row>('bank_accounts', { school_id: schoolId, status: 'active' }, { orderBy: 'account_kind ASC' }); }

  /** Bank reconciliation: match imported statement lines to payments/expenses by amount and date. */
  async reconcile(schoolId: string, bankAccountId: string, days = 30) {
    const lines = await this.db.query<Row>(`SELECT * FROM bank_statement_lines WHERE school_id = ? AND bank_account_id = ? AND matched_id IS NULL ORDER BY txn_date DESC LIMIT 500`, [schoolId, bankAccountId]);
    let matched = 0;
    for (const l of lines) {
      const credit = Number(l.credit ?? 0), debit = Number(l.debit ?? 0);
      const from = new Date(Date.parse(String(l.txn_date)) - days * 86400_000).toISOString().slice(0, 10);
      if (credit > 0) {
        const p = await this.db.query<Row>(`SELECT id FROM payments WHERE school_id = ? AND status = 'success' AND amount = ? AND paid_at >= ? AND id NOT IN (SELECT matched_id FROM bank_statement_lines WHERE matched_id IS NOT NULL AND matched_type = 'payment') LIMIT 1`, [schoolId, credit, from]);
        if (p[0]) { await this.db.update('bank_statement_lines', { matched_type: 'payment', matched_id: String(p[0].id), matched_at: nowSql() }, { id: String(l.id) }); matched++; }
      } else if (debit > 0) {
        const e = await this.db.query<Row>(`SELECT id FROM expenses WHERE school_id = ? AND status = 'paid' AND amount = ? AND expense_date >= ? AND id NOT IN (SELECT matched_id FROM bank_statement_lines WHERE matched_id IS NOT NULL AND matched_type = 'expense') LIMIT 1`, [schoolId, debit, from]);
        if (e[0]) { await this.db.update('bank_statement_lines', { matched_type: 'expense', matched_id: String(e[0].id), matched_at: nowSql() }, { id: String(l.id) }); matched++; }
      }
    }
    return { lines: lines.length, matched, unmatched: lines.length - matched };
  }
  async importStatement(schoolId: string, bankAccountId: string, lines: { txnDate: string; description?: string; reference?: string; debit?: number; credit?: number; balance?: number }[]) {
    const batch = ulid();
    await this.db.insertMany('bank_statement_lines', lines.map(l => ({ id: ulid(), school_id: schoolId, bank_account_id: bankAccountId, txn_date: l.txnDate, description: l.description ?? null, reference: l.reference ?? null, debit: l.debit ?? 0, credit: l.credit ?? 0, balance: l.balance ?? null, import_batch: batch })));
    return { batch, imported: lines.length, ...(await this.reconcile(schoolId, bankAccountId)) };
  }

  /** Budgets per account with an alert when spending crosses the threshold. */
  async setBudget(schoolId: string, fiscalYearId: string, glAccountId: string, amount: number, alertAtPct = 90) {
    const ex = await this.db.findOne<{ id: string }>('budgets', { fiscal_year_id: fiscalYearId, gl_account_id: glAccountId, cost_center_id: null });
    if (ex) { await this.db.update('budgets', { amount, alert_at_pct: alertAtPct, updated_at: nowSql() }, { id: ex.id }); return ex.id; }
    const id = ulid(); await this.db.insert('budgets', { id, school_id: schoolId, fiscal_year_id: fiscalYearId, gl_account_id: glAccountId, cost_center_id: null, amount, alert_at_pct: alertAtPct }); return id;
  }
  async budgetStatus(schoolId: string, fiscalYearId: string) {
    const fy = await this.db.findOne<Row>('fiscal_years', { id: fiscalYearId, school_id: schoolId });
    if (!fy) throw notFound('fiscal year');
    return this.db.query<Row>(`SELECT b.*, a.code, a.name, COALESCE((SELECT SUM(l.debit) - SUM(l.credit) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = b.gl_account_id AND e.entry_date BETWEEN ? AND ? AND e.status = 'posted'), 0) AS spent
      FROM budgets b JOIN gl_accounts a ON a.id = b.gl_account_id WHERE b.school_id = ? AND b.fiscal_year_id = ? ORDER BY a.code`, [String(fy.start_date), String(fy.end_date), schoolId, fiscalYearId]);
  }
}

export const round = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
