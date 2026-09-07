import { createHash } from 'node:crypto';
import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { TaskService } from '../tasks.js';
import type { NumberingService } from './numbering.js';
import type { AccountingService } from './accounting.js';
import { round } from './accounting.js';
import type { FeesService } from './fees.js';
import type { SettingsService } from '../settings.js';
import { HttpError, badRequest, notFound } from '../context.js';

export interface SaleLine { productId: string; quantity?: number }

/**
 * Wallet, canteen and shop. A child carries a card, not cash: the guardian tops the wallet up, the
 * canteen scans the card, and the balance moves. Three rules hold the whole module together:
 *
 * - A top-up is not income. The school is holding somebody else's money, so it lands on the wallet
 *   liability account and only becomes income when something is actually sold.
 * - The wallet is a ledger, not a number. Every movement writes a row with the balance after it, and
 *   the balance on the wallet is only ever the last row's — so a disputed lunch can be traced.
 * - A daily limit is what a guardian asked for, so the till refuses the sale that would break it
 *   rather than letting it through and reporting it afterwards.
 */
export class CommerceService {
  constructor(
    private db: Db, private outbox: OutboxService, private notifications: NotificationService,
    private tasks: TaskService, private numbering: NumberingService, private accounting: AccountingService,
    private fees: FeesService, private settings: SettingsService,
  ) {}

  // ---------- wallets ----------
  async wallet(schoolId: string, studentId: string, create = true) {
    const ex = await this.db.findOne<Row>('wallets', { school_id: schoolId, student_id: studentId });
    if (ex) return ex;
    if (!create) throw notFound('wallet');
    if (!(await this.db.findOne('students', { id: studentId, school_id: schoolId }))) throw notFound('student');
    const id = ulid();
    const dailyLimit = (await this.settings.get<number>(schoolId, 'commerce.default_daily_limit')) ?? null;
    await this.db.insert('wallets', { id, school_id: schoolId, student_id: studentId, staff_id: null, balance: 0, daily_limit: dailyLimit, status: 'active' });
    return (await this.db.findOne<Row>('wallets', { id }))!;
  }
  /** The card the canteen scans. It is derived, not stored, so a lost card is replaced by a new number. */
  cardCode(schoolId: string, walletId: string, serial = 1) {
    return createHash('sha256').update(`${schoolId}:${walletId}:${serial}`).digest('hex').slice(0, 12).toUpperCase();
  }
  async walletByCard(schoolId: string, code: string) {
    const wallets = await this.db.findMany<Row>('wallets', { school_id: schoolId, status: 'active' }, { limit: 5000 });
    const want = code.trim().toUpperCase();
    for (const w of wallets) for (const serial of [1, 2, 3]) if (this.cardCode(schoolId, String(w.id), serial) === want) return w;
    throw notFound('card');
  }
  /**
   * Money in. `paymentId` ties the top-up to a payment the fees module already recorded and journaled
   * as cash; without one this posts its own entry, so the liability is on the books either way.
   */
  async topUp(schoolId: string, studentId: string, amount: number, opts: { method?: 'cash' | 'bkash' | 'nagad' | 'bank_transfer' | 'card'; paymentId?: string | null; createdBy?: string | null; description?: string | null } = {}) {
    if (amount <= 0) throw badRequest('a top-up must be positive');
    const wallet = await this.wallet(schoolId, studentId);
    if (wallet.status !== 'active') throw new HttpError(409, `this wallet is ${wallet.status}`, 'conflict');
    const method = opts.method ?? 'cash';
    let journalEntryId: string | null = null;
    if (!opts.paymentId) {
      const cashCode = ['bkash', 'nagad'].includes(method) ? '1220' : method === 'cash' ? '1100' : '1210';
      journalEntryId = (await this.accounting.post(schoolId, {
        entryDate: nowSql().slice(0, 10), memo: `Wallet top-up ${studentId}`, sourceType: 'commerce.topup', sourceId: String(wallet.id),
        lines: [{ accountCode: cashCode, debit: amount, description: 'Wallet top-up received' }, { accountCode: '2500', credit: amount, description: 'Held for the student' }],
      })).id;
    }
    const entry = await this.move(schoolId, String(wallet.id), 'topup', amount, { sourceType: 'commerce.topup', paymentId: opts.paymentId ?? null, description: opts.description ?? `Top-up by ${method}`, createdBy: opts.createdBy ?? null });
    await this.notifyGuardians(schoolId, studentId, 'commerce.wallet_topped_up', 'Wallet topped up', `Tk ${amount} added. The balance is now Tk ${entry.balanceAfter}.`);
    await this.outbox.emitNow({ type: 'wallet.topped_up', schoolId, aggregateType: 'commerce.wallet', aggregateId: String(wallet.id), payload: { walletId: String(wallet.id), studentId, amount, balance: entry.balanceAfter } });
    return { ...entry, journalEntryId };
  }
  /** One movement, one row, and the balance the wallet is left with. Never call this outside a sale or a top-up. */
  private async move(schoolId: string, walletId: string, kind: 'topup' | 'spend' | 'refund' | 'adjustment' | 'transfer', amount: number, opts: { sourceType?: string | null; sourceId?: string | null; paymentId?: string | null; description?: string | null; createdBy?: string | null } = {}, tx?: Db) {
    const run = async (t: Db) => {
      const w = await t.findOne<Row>('wallets', { id: walletId });
      if (!w) throw notFound('wallet');
      const signed = kind === 'spend' ? -Math.abs(amount) : kind === 'adjustment' ? amount : Math.abs(amount);
      const balanceAfter = round(Number(w.balance) + signed);
      if (balanceAfter < 0) throw new HttpError(409, `the wallet holds only ${Number(w.balance)}`, 'insufficient_balance');
      await t.insert('wallet_transactions', { id: ulid(), school_id: schoolId, wallet_id: walletId, kind, amount: round(Math.abs(amount)), balance_after: balanceAfter, source_type: opts.sourceType ?? null, source_id: opts.sourceId ?? null, payment_id: opts.paymentId ?? null, description: opts.description ?? null, created_by: opts.createdBy ?? null });
      await t.update('wallets', { balance: balanceAfter, updated_at: nowSql() }, { id: walletId });
      return { walletId, kind, amount: round(Math.abs(amount)), balanceAfter };
    };
    return tx ? run(tx) : this.db.transaction(run);
  }
  async walletStatement(schoolId: string, studentId: string, limit = 100) {
    const wallet = await this.db.findOne<Row>('wallets', { school_id: schoolId, student_id: studentId });
    if (!wallet) return { wallet: null, entries: [], spentToday: 0 };
    const entries = await this.db.findMany<Row>('wallet_transactions', { wallet_id: String(wallet.id) }, { orderBy: 'created_at DESC, id DESC', limit });
    return { wallet, entries, spentToday: await this.spentToday(String(wallet.id)) };
  }
  async setWallet(schoolId: string, studentId: string, p: { dailyLimit?: number | null; status?: 'active' | 'frozen' | 'closed' }) {
    const wallet = await this.wallet(schoolId, studentId);
    await this.db.update('wallets', { daily_limit: p.dailyLimit === undefined ? wallet.daily_limit : p.dailyLimit, status: p.status ?? wallet.status, updated_at: nowSql() }, { id: String(wallet.id) });
    return { id: String(wallet.id), dailyLimit: p.dailyLimit ?? wallet.daily_limit, status: p.status ?? wallet.status };
  }
  private async spentToday(walletId: string, onDate = nowSql().slice(0, 10)) {
    const r = await this.db.query<{ spent: number }>(`SELECT COALESCE(SUM(amount), 0) AS spent FROM wallet_transactions WHERE wallet_id = ? AND kind = 'spend' AND created_at >= ? AND created_at <= ?`, [walletId, `${onDate} 00:00:00`, `${onDate} 23:59:59`]);
    return round(Number(r[0]?.spent ?? 0));
  }

  // ---------- outlets and products ----------
  async createOutlet(schoolId: string, o: { name: string; kind?: 'canteen' | 'bookshop' | 'uniform' | 'stationery' | 'other'; campusId?: string | null }) {
    const id = ulid();
    const income = await this.accounting.accountByCode(schoolId, '4180');
    await this.db.insert('pos_outlets', { id, school_id: schoolId, name: o.name, kind: o.kind ?? 'canteen', campus_id: o.campusId ?? null, income_gl_account_id: String(income.id), status: 'active' });
    return id;
  }
  async outlets(schoolId: string) { return this.db.findMany<Row>('pos_outlets', { school_id: schoolId }, { orderBy: 'name ASC' }); }
  async addProduct(schoolId: string, p: { outletId: string; name: string; price: number; sku?: string | null; category?: string | null; inventoryItemId?: string | null }) {
    if (p.price < 0) throw badRequest('a price cannot be negative');
    const id = ulid();
    await this.db.insert('pos_products', { id, school_id: schoolId, outlet_id: p.outletId, name: p.name, sku: p.sku ?? null, price: round(p.price), tax_rate_id: null, inventory_item_id: p.inventoryItemId ?? null, image_file_id: null, is_active: true, category: p.category ?? null });
    return id;
  }
  async products(schoolId: string, outletId?: string) {
    const where: Row = { school_id: schoolId, is_active: true };
    if (outletId) where.outlet_id = outletId;
    return this.db.findMany<Row>('pos_products', where, { orderBy: 'category ASC, name ASC', limit: 500 });
  }
  async setProduct(schoolId: string, productId: string, p: { price?: number; isActive?: boolean; name?: string }) {
    const row: Row = { updated_at: nowSql() };
    if (p.price != null) row.price = round(p.price);
    if (p.isActive != null) row.is_active = p.isActive;
    if (p.name) row.name = p.name;
    if (!(await this.db.update('pos_products', row, { id: productId, school_id: schoolId }))) throw notFound('product');
    return { id: productId };
  }

  // ---------- the till ----------
  /**
   * A sale at the counter. Paid from the wallet it is one transaction: the balance drops, the sale
   * posts Dr wallet liability / Cr shop income, and the guardian is told what was bought — which is
   * the whole point of a cashless canteen for the person paying for it.
   */
  async sell(schoolId: string, s: { outletId: string; lines: SaleLine[]; studentId?: string | null; cardCode?: string | null; paidBy?: 'wallet' | 'cash' | 'bkash' | 'card' | 'invoice'; cashierId?: string | null }) {
    if (!s.lines.length) throw badRequest('a sale needs at least one item');
    const outlet = await this.db.findOne<Row>('pos_outlets', { id: s.outletId, school_id: schoolId });
    if (!outlet) throw notFound('outlet');
    let studentId = s.studentId ?? null;
    let wallet: Row | null = null;
    if (s.cardCode) { wallet = await this.walletByCard(schoolId, s.cardCode); studentId = String(wallet.student_id); }
    const paidBy = s.paidBy ?? (wallet || studentId ? 'wallet' : 'cash');
    if (paidBy === 'wallet') {
      if (!studentId) throw badRequest('a wallet sale needs the card or the student');
      wallet = wallet ?? await this.wallet(schoolId, studentId);
      if (wallet.status !== 'active') throw new HttpError(409, `this wallet is ${wallet.status}`, 'conflict');
    }

    const items: { productId: string; name: string; quantity: number; unitPrice: number; amount: number }[] = [];
    let subtotal = 0;
    for (const line of s.lines) {
      const product = await this.db.findOne<Row>('pos_products', { id: line.productId, school_id: schoolId, is_active: true });
      if (!product) throw notFound(`product ${line.productId}`);
      if (String(product.outlet_id) !== s.outletId) throw badRequest(`${product.name} is not sold at this outlet`);
      const quantity = round(line.quantity ?? 1);
      if (quantity <= 0) throw badRequest('a quantity must be positive');
      const amount = round(Number(product.price) * quantity);
      items.push({ productId: String(product.id), name: String(product.name), quantity, unitPrice: round(Number(product.price)), amount });
      subtotal = round(subtotal + amount);
    }
    const total = subtotal;

    // the limit the guardian set is a refusal at the till, not a report afterwards
    if (paidBy === 'wallet' && wallet!.daily_limit != null) {
      const spent = await this.spentToday(String(wallet!.id));
      if (round(spent + total) > Number(wallet!.daily_limit)) throw new HttpError(409, `this would take today's spending to ${round(spent + total)}, over the ${Number(wallet!.daily_limit)} daily limit`, 'daily_limit');
    }

    const id = ulid();
    const saleNo = await this.numbering.next(schoolId, 'pos_sale_no', { prefix: 'POS-', padding: 6, resetYearly: true });
    await this.db.transaction(async tx => {
      await tx.insert('pos_sales', { id, school_id: schoolId, outlet_id: s.outletId, sale_no: saleNo, student_id: studentId, wallet_id: wallet ? String(wallet.id) : null, cashier_id: s.cashierId ?? null, subtotal, tax: 0, total, paid_by: paidBy, payment_id: null, status: 'completed', journal_entry_id: null });
      await tx.insertMany('pos_sale_items', items.map(i => ({ id: ulid(), school_id: schoolId, sale_id: id, product_id: i.productId, quantity: i.quantity, unit_price: i.unitPrice, amount: i.amount })));
      if (paidBy === 'wallet') await this.move(schoolId, String(wallet!.id), 'spend', total, { sourceType: 'commerce.sale', sourceId: id, description: items.map(i => `${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`).join(', ').slice(0, 200), createdBy: s.cashierId ?? null }, tx);
    });
    // wallet money was already taken in as cash at top-up, so a wallet sale only turns the liability into income
    const debit = paidBy === 'wallet' ? { accountCode: '2500', debit: total, description: `Sale ${saleNo}` }
      : paidBy === 'cash' ? { accountCode: '1100', debit: total, description: `Sale ${saleNo}` }
        : paidBy === 'bkash' ? { accountCode: '1220', debit: total, description: `Sale ${saleNo}` }
          : paidBy === 'invoice' ? { accountCode: '1300', debit: total, description: `Sale ${saleNo}` }
            : { accountCode: '1210', debit: total, description: `Sale ${saleNo}` };
    const j = await this.accounting.post(schoolId, { entryDate: nowSql().slice(0, 10), memo: `${outlet.name} sale ${saleNo}`, sourceType: 'commerce.sale', sourceId: id, lines: [debit, { accountId: String(outlet.income_gl_account_id), credit: total, description: String(outlet.name) }] });
    await this.db.update('pos_sales', { journal_entry_id: j.id, updated_at: nowSql() }, { id });
    if (paidBy === 'invoice' && studentId) await this.fees.createInvoice(schoolId, { studentId, items: items.map(i => ({ description: `${outlet.name}: ${i.name} ×${i.quantity}`, amount: i.amount })), notes: `pos:${id}` });
    if (paidBy === 'wallet' && studentId) {
      const balance = Number((await this.db.findOne<Row>('wallets', { id: String(wallet!.id) }))!.balance);
      await this.notifyGuardians(schoolId, studentId, 'commerce.sale', `${outlet.name}`, `${items.map(i => i.name).join(', ')} — Tk ${total}. Wallet balance Tk ${balance}.`);
      if (balance < ((await this.settings.get<number>(schoolId, 'commerce.low_balance_at')) ?? 50)) {
        await this.notifyGuardians(schoolId, studentId, 'commerce.low_balance', 'Wallet running low', `Only Tk ${balance} left on the wallet.`);
      }
    }
    await this.outbox.emitNow({ type: 'pos.sold', schoolId, aggregateType: 'commerce.sale', aggregateId: id, payload: { saleId: id, saleNo, outletId: s.outletId, studentId: studentId ?? '', total, paidBy } });
    return { id, saleNo, total, items, paidBy, journalEntryId: j.id };
  }
  /** A refund puts the money back where it came from, and reverses the entry rather than editing it. */
  async refundSale(schoolId: string, saleId: string, reason: string) {
    const sale = await this.db.findOne<Row>('pos_sales', { id: saleId, school_id: schoolId });
    if (!sale) throw notFound('sale');
    if (sale.status !== 'completed') throw new HttpError(409, `this sale is already ${sale.status}`, 'conflict');
    const total = round(Number(sale.total));
    if (sale.paid_by === 'wallet' && sale.wallet_id) await this.move(schoolId, String(sale.wallet_id), 'refund', total, { sourceType: 'commerce.refund', sourceId: saleId, description: reason.slice(0, 200) });
    const outlet = await this.db.findOne<Row>('pos_outlets', { id: String(sale.outlet_id) });
    const credit = sale.paid_by === 'wallet' ? { accountCode: '2500', credit: total, description: 'Refunded to the wallet' }
      : sale.paid_by === 'cash' ? { accountCode: '1100', credit: total, description: 'Refunded in cash' }
        : { accountCode: '1210', credit: total, description: 'Refunded' };
    const j = await this.accounting.post(schoolId, { entryDate: nowSql().slice(0, 10), memo: `Refund ${sale.sale_no}: ${reason.slice(0, 80)}`, sourceType: 'commerce.refund', sourceId: saleId, lines: [{ accountId: String(outlet?.income_gl_account_id), debit: total, description: 'Sale reversed' }, credit] });
    await this.db.update('pos_sales', { status: 'refunded', updated_at: nowSql() }, { id: saleId });
    return { id: saleId, status: 'refunded' as const, amount: total, journalEntryId: j.id };
  }
  async sales(schoolId: string, f: { outletId?: string; studentId?: string; from?: string; to?: string } = {}) {
    const where: string[] = ['s.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.outletId) { where.push('s.outlet_id = ?'); params.push(f.outletId); }
    if (f.studentId) { where.push('s.student_id = ?'); params.push(f.studentId); }
    if (f.from) { where.push('s.created_at >= ?'); params.push(`${f.from} 00:00:00`); }
    if (f.to) { where.push('s.created_at <= ?'); params.push(`${f.to} 23:59:59`); }
    return this.db.query<Row>(`SELECT s.*, o.name AS outlet_name, st.first_name, st.last_name, st.admission_no FROM pos_sales s JOIN pos_outlets o ON o.id = s.outlet_id LEFT JOIN students st ON st.id = s.student_id WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC LIMIT 200`, params);
  }
  /** What the till took today, split by how it was paid — the number the counter is counted against. */
  async dayBook(schoolId: string, outletId: string, onDate = nowSql().slice(0, 10)) {
    const rows = await this.db.query<{ paid_by: string; n: number; total: number }>(`SELECT paid_by, COUNT(*) AS n, COALESCE(SUM(total), 0) AS total FROM pos_sales WHERE school_id = ? AND outlet_id = ? AND status = 'completed' AND created_at BETWEEN ? AND ? GROUP BY paid_by`, [schoolId, outletId, `${onDate} 00:00:00`, `${onDate} 23:59:59`]);
    const top = await this.db.query<Row>(`SELECT p.name, SUM(i.quantity) AS qty, SUM(i.amount) AS amount FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id JOIN pos_products p ON p.id = i.product_id WHERE s.school_id = ? AND s.outlet_id = ? AND s.status = 'completed' AND s.created_at BETWEEN ? AND ? GROUP BY p.id, p.name ORDER BY amount DESC LIMIT 10`, [schoolId, outletId, `${onDate} 00:00:00`, `${onDate} 23:59:59`]);
    return { date: onDate, byMethod: rows, total: round(rows.reduce((a, r) => a + Number(r.total), 0)), bestSellers: top };
  }

  // ---------- what a guardian orders from the app ----------
  /** Uniform and books ordered from the app: the invoice is raised now, the goods handed over later. */
  async placeOrder(schoolId: string, o: { studentId: string; outletId: string; lines: SaleLine[]; notes?: string | null }) {
    if (!o.lines.length) throw badRequest('an order needs at least one item');
    const outlet = await this.db.findOne<Row>('pos_outlets', { id: o.outletId, school_id: schoolId });
    if (!outlet) throw notFound('outlet');
    const items: { productId: string; name: string; quantity: number; amount: number }[] = [];
    let total = 0;
    for (const line of o.lines) {
      const product = await this.db.findOne<Row>('pos_products', { id: line.productId, school_id: schoolId, is_active: true });
      if (!product) throw notFound(`product ${line.productId}`);
      const quantity = round(line.quantity ?? 1);
      const amount = round(Number(product.price) * quantity);
      items.push({ productId: String(product.id), name: String(product.name), quantity, amount });
      total = round(total + amount);
    }
    const id = ulid();
    const orderNo = await this.numbering.next(schoolId, 'shop_order_no', { prefix: 'ORD-', padding: 5, resetYearly: true });
    const invoice = await this.fees.createInvoice(schoolId, { studentId: o.studentId, items: items.map(i => ({ description: `${outlet.name}: ${i.name} ×${i.quantity}`, amount: i.amount })), notes: `shop:${id}` });
    await this.db.insert('shop_orders', { id, school_id: schoolId, order_no: orderNo, student_id: o.studentId, outlet_id: o.outletId, items: items as never, total, status: 'placed', invoice_id: invoice.id, notes: o.notes ?? null });
    await this.notifyGuardians(schoolId, o.studentId, 'commerce.order_placed', 'Order placed', `${orderNo}: ${items.map(i => i.name).join(', ')} — Tk ${total}. It will be ready to collect once the invoice is paid.`);
    await this.outbox.emitNow({ type: 'shop.ordered', schoolId, aggregateType: 'commerce.order', aggregateId: id, payload: { orderId: id, orderNo, studentId: o.studentId, total } });
    return { id, orderNo, total, invoiceId: invoice.id };
  }
  async setOrderStatus(schoolId: string, orderId: string, status: 'paid' | 'ready' | 'delivered' | 'cancelled') {
    const order = await this.db.findOne<Row>('shop_orders', { id: orderId, school_id: schoolId });
    if (!order) throw notFound('order');
    await this.db.update('shop_orders', { status, updated_at: nowSql() }, { id: orderId });
    if (status === 'ready') await this.notifyGuardians(schoolId, String(order.student_id), 'commerce.order_ready', 'Ready to collect', `${order.order_no} is ready at the ${(await this.db.findOne<Row>('pos_outlets', { id: String(order.outlet_id) }))?.name}.`);
    return { id: orderId, status };
  }
  async orders(schoolId: string, f: { studentId?: string; status?: string } = {}) {
    const where: Row = { school_id: schoolId };
    if (f.studentId) where.student_id = f.studentId;
    if (f.status) where.status = f.status;
    const rows = await this.db.findMany<Row>('shop_orders', where, { orderBy: 'created_at DESC', limit: 200 });
    return rows.map(r => ({ ...r, items: json(r.items) }) as Row);
  }
  /** An order whose invoice has been paid is an order that can be picked up. */
  async onInvoicePaid(schoolId: string, invoiceId: string) {
    const order = await this.db.findOne<Row>('shop_orders', { school_id: schoolId, invoice_id: invoiceId, status: 'placed' });
    if (!order) return null;
    return this.setOrderStatus(schoolId, String(order.id), 'paid');
  }

  private async notifyGuardians(schoolId: string, studentId: string, eventKey: string, title: string, body: string, entity?: { type: string; id: string }) {
    const guardians = await this.db.query<{ user_id: string | null; phone: string }>(`SELECT g.user_id, g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND sg.receives_notifications = TRUE`, [studentId]);
    for (const g of guardians) await this.notifications.notify({ schoolId, userId: g.user_id, address: g.phone, channels: ['push', 'in_app'], eventKey, title, body, entityType: entity?.type ?? 'people.student', entityId: entity?.id ?? studentId });
  }

  // ---------- scheduled jobs ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      // P4/P5: the till's own day book, the wallets about to run dry, and the goods nobody handed over
      'commerce.day_close': async ({ schoolId, payload, deadline }) => this.dayClose(schoolId, { onDate: (payload.onDate as string) || undefined, deadline }),
    };
  }

  private async openTaskFor(schoolId: string, entityType: string, entityId: string) {
    return this.db.findOne<Row>('tasks', { school_id: schoolId, entity_type: entityType, entity_id: entityId, status: 'open' });
  }
  private async messagedSince(schoolId: string, eventKey: string, entityId: string, since: string) {
    const r = await this.db.query<{ id: string }>(`SELECT id FROM notifications WHERE school_id = ? AND event_key = ? AND entity_id = ? AND created_at >= ? LIMIT 1`, [schoolId, eventKey, entityId, since]);
    return !!r[0];
  }

  /**
   * The end of a trading day, without anyone closing anything by hand:
   *
   * - each outlet's day book goes to accounts once — the key is the outlet *and the date*, so a
   *   second run on the same evening sends nothing
   * - a wallet under the school's low-balance mark tells the guardian, at most once a week: a child
   *   who cannot buy lunch is worth a message, a family told the same thing every night is not
   * - an order paid for and still not handed over is one task, once, for whoever runs the shop
   *
   * Nothing here tops a wallet up. Moving a family's money without them asking is not automation.
   */
  async dayClose(schoolId: string, opts: { onDate?: string; deadline?: number } = {}) {
    const onDate = opts.onDate ?? nowSql().slice(0, 10);
    const deadline = opts.deadline ?? Date.now() + 20_000;
    const out = { outlets: 0, lowBalance: 0, staleOrders: 0, total: 0 };

    for (const o of await this.outlets(schoolId)) {
      if (Date.now() > deadline) break;
      const book = await this.dayBook(schoolId, String(o.id), onDate);
      if (book.total <= 0) continue;
      out.total = round(out.total + book.total);
      // one message per outlet per day: `entity_id` holds an id and nothing else (CHAR(26) on MySQL),
      // so the day is the window the lookup runs over rather than part of the key
      const key = String(o.id);
      if (await this.messagedSince(schoolId, 'commerce.day_book', key, `${onDate} 00:00:00`)) continue;
      const split = book.byMethod.map(m => `${m.paid_by} Tk ${round(Number(m.total))}`).join(', ');
      for (const role of ['accountant', 'admin']) await this.notifications.notifyRole(schoolId, role, { channels: ['in_app', 'push'], eventKey: 'commerce.day_book', title: `${o.name}: Tk ${book.total} today`, body: `${split}. Best seller: ${book.bestSellers[0]?.name ?? '—'}.`, data: { total: book.total }, entityType: 'commerce.outlet', entityId: key });
      out.outlets++;
    }

    const floor = (await this.settings.get<number>(schoolId, 'commerce.low_balance_at')) ?? 50;
    const weekAgo = nowSql(new Date(Date.parse(`${onDate}T00:00:00Z`) - 7 * 86400_000));
    const low = await this.db.query<Row>(`SELECT w.id, w.student_id, w.balance FROM wallets w WHERE w.school_id = ? AND w.status = 'active' AND w.balance < ?
      AND EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.wallet_id = w.id) ORDER BY w.balance LIMIT 500`, [schoolId, floor]);
    for (const w of low) {
      if (Date.now() > deadline) break;
      if (await this.messagedSince(schoolId, 'commerce.low_balance', String(w.id), weekAgo)) continue;
      await this.notifyGuardians(schoolId, String(w.student_id), 'commerce.low_balance', 'Wallet running low', `Only Tk ${round(Number(w.balance))} is left on the card. Top it up from the app or at the office.`, { type: 'commerce.wallet', id: String(w.id) });
      out.lowBalance++;
    }

    const cutoff = new Date(Date.parse(`${onDate}T00:00:00Z`) - 3 * 86400_000).toISOString().slice(0, 10);
    const waiting = await this.db.query<Row>(`SELECT o.id, o.order_no, o.student_id, o.total FROM shop_orders o WHERE o.school_id = ? AND o.status = 'paid' AND o.updated_at <= ? ORDER BY o.updated_at LIMIT 100`, [schoolId, `${cutoff} 23:59:59`]);
    for (const o of waiting) {
      if (await this.openTaskFor(schoolId, 'commerce.order', String(o.id))) continue;
      const st = await this.db.findOne<Row>('students', { id: String(o.student_id) });
      await this.tasks.create({
        schoolId, title: `Order ${o.order_no} is paid for and still on the shelf`, taskType: 'commerce.order', assignedRole: 'admin', priority: 'normal',
        description: `${st ? `${st.first_name} ${st.last_name ?? ''}`.trim() : 'A family'} paid Tk ${round(Number(o.total))} more than three days ago. Mark it ready when it is packed — the guardian is told the moment you do.`,
        entityType: 'commerce.order', entityId: String(o.id),
      });
      out.staleOrders++;
    }
    return out;
  }
}
