import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { NumberingService } from './numbering.js';
import type { TaskService } from '../tasks.js';
import type { ApprovalService } from '../approvals.js';
import type { AccountingService } from './accounting.js';
import { round } from './accounting.js';
import { HttpError, badRequest, notFound } from '../context.js';

export interface PoLine { itemId: string; quantity: number; unitCost: number }

/**
 * Procurement and stock: items in stores, an append-only movement ledger that maintains the level of
 * each item, requisitions and quotations, purchase orders with approval, and goods receipt, which is
 * where the money and the stock meet — the receipt posts the expense, adds the stock, and creates a
 * fixed asset with its own tag for anything in an asset category. Falling below the reorder level
 * drafts a purchase order by itself.
 */
export class InventoryService {
  constructor(
    private db: Db, private outbox: OutboxService, private notifications: NotificationService, private numbering: NumberingService,
    private tasks: TaskService, private approvals: ApprovalService, private accounting: AccountingService,
  ) {}

  // ---------- setup ----------
  async ensureSetup(schoolId: string) {
    let made = 0;
    const categories: [string, boolean, string][] = [['Stationery', false, '5500'], ['Cleaning', false, '5990'], ['Laboratory', false, '5990'], ['Furniture', true, '1510'], ['Computers', true, '1520'], ['Sports', false, '5990'], ['Medicine', false, '5990']];
    for (const [name, isAsset, gl] of categories) {
      if (await this.db.findOne('inventory_categories', { school_id: schoolId, name })) continue;
      const account = await this.db.findOne<{ id: string }>('gl_accounts', { school_id: schoolId, code: gl });
      await this.db.insert('inventory_categories', { id: ulid(), school_id: schoolId, name, is_asset: isAsset, gl_account_id: account?.id ?? null });
      made++;
    }
    if (!(await this.db.count('stores', { school_id: schoolId }))) { await this.db.insert('stores', { id: ulid(), school_id: schoolId, name: 'Main store', campus_id: null, keeper_id: null }); made++; }
    return made;
  }
  async categories(schoolId: string) { return this.db.findMany<Row>('inventory_categories', { school_id: schoolId }, { orderBy: 'name ASC' }); }
  async stores(schoolId: string) { return this.db.findMany<Row>('stores', { school_id: schoolId }, { orderBy: 'name ASC' }); }
  async addItem(schoolId: string, i: { categoryId: string; sku?: string; name: string; unit?: string; reorderLevel?: number; reorderQty?: number | null; preferredVendorId?: string | null; lastCost?: number | null; barcode?: string | null }) {
    const sku = i.sku?.trim() || await this.numbering.next(schoolId, 'item_sku', { prefix: 'SKU-', padding: 5 });
    if (await this.db.findOne('inventory_items', { school_id: schoolId, sku })) throw new HttpError(409, `${sku} already exists`, 'conflict');
    const id = ulid();
    await this.db.insert('inventory_items', { id, school_id: schoolId, category_id: i.categoryId, sku, name: i.name, unit: i.unit ?? 'pcs', reorder_level: i.reorderLevel ?? 0, reorder_qty: i.reorderQty ?? null, preferred_vendor_id: i.preferredVendorId ?? null, last_cost: i.lastCost ?? null, barcode: i.barcode ?? null, status: 'active' });
    return { id, sku };
  }
  async items(schoolId: string, storeId?: string) {
    return this.db.query<Row>(`SELECT i.*, c.name AS category_name, c.is_asset, COALESCE(l.quantity, 0) AS quantity FROM inventory_items i JOIN inventory_categories c ON c.id = i.category_id
      LEFT JOIN stock_levels l ON l.item_id = i.id${storeId ? ' AND l.store_id = ?' : ''} WHERE i.school_id = ? ORDER BY i.name LIMIT 1000`, storeId ? [storeId, schoolId] : [schoolId]);
  }

  // ---------- stock ----------
  /**
   * The one way stock ever moves. The ledger row is the truth; `stock_levels` is a running total
   * kept beside it so a stock report never has to add up years of movements.
   */
  async move(schoolId: string, m: { itemId: string; storeId: string; moveType: 'in' | 'out' | 'adjust' | 'transfer' | 'return' | 'consume'; quantity: number; unitCost?: number | null; refType?: string | null; refId?: string | null; issuedToStaffId?: string | null; issuedToRoomId?: string | null; note?: string | null; createdBy?: string | null }, tx?: Db) {
    const run = async (t: Db) => {
      // an adjustment carries its own sign — a count can find less on the shelf as easily as more
      if (m.moveType === 'adjust' ? m.quantity === 0 : m.quantity <= 0) throw badRequest(m.moveType === 'adjust' ? 'an adjustment of zero changes nothing' : 'quantity must be positive');
      const signed = m.moveType === 'adjust' ? m.quantity : ['out', 'consume'].includes(m.moveType) ? -m.quantity : m.quantity;
      const level = await t.findOne<Row>('stock_levels', { item_id: m.itemId, store_id: m.storeId });
      const current = Number(level?.quantity ?? 0);
      if (signed < 0 && current + signed < 0) throw new HttpError(409, `only ${current} in stock`, 'insufficient');
      const id = ulid();
      await t.insert('stock_movements', { id, school_id: schoolId, item_id: m.itemId, store_id: m.storeId, move_type: m.moveType, quantity: m.quantity, unit_cost: m.unitCost ?? null, ref_type: m.refType ?? null, ref_id: m.refId ?? null, issued_to_staff_id: m.issuedToStaffId ?? null, issued_to_room_id: m.issuedToRoomId ?? null, note: m.note ?? null, created_by: m.createdBy ?? null, created_at: nowSql() });
      const quantity = round(current + signed);
      if (level) await t.update('stock_levels', { quantity, updated_at: nowSql() }, { id: String(level.id) });
      else await t.insert('stock_levels', { id: ulid(), school_id: schoolId, item_id: m.itemId, store_id: m.storeId, quantity, updated_at: nowSql() });
      if (m.unitCost) await t.update('inventory_items', { last_cost: m.unitCost, updated_at: nowSql() }, { id: m.itemId });
      return { id, quantity };
    };
    const r = tx ? await run(tx) : await this.db.transaction(run);
    await this.checkReorder(schoolId, m.itemId, m.storeId, r.quantity);
    return r;
  }
  async stock(schoolId: string, storeId?: string) {
    const where = storeId ? ' AND l.store_id = ?' : '';
    return this.db.query<Row>(`SELECT l.*, i.name, i.sku, i.unit, i.reorder_level, s.name AS store_name FROM stock_levels l JOIN inventory_items i ON i.id = l.item_id JOIN stores s ON s.id = l.store_id WHERE l.school_id = ?${where} ORDER BY i.name`, storeId ? [schoolId, storeId] : [schoolId]);
  }
  async movements(schoolId: string, itemId: string) {
    return this.db.query<Row>(`SELECT m.*, s.name AS store_name FROM stock_movements m JOIN stores s ON s.id = m.store_id WHERE m.school_id = ? AND m.item_id = ? ORDER BY m.created_at DESC LIMIT 200`, [schoolId, itemId]);
  }
  /** L1: dropping below the reorder level drafts a purchase order and tells the store keeper once. */
  private async checkReorder(schoolId: string, itemId: string, storeId: string, quantity: number) {
    const item = await this.db.findOne<Row>('inventory_items', { id: itemId });
    if (!item || Number(item.reorder_level) <= 0 || quantity > Number(item.reorder_level)) return null;
    const open = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM purchase_order_items pi JOIN purchase_orders p ON p.id = pi.po_id WHERE pi.item_id = ? AND p.status IN ('draft','pending_approval','approved','ordered','partially_received')`, [itemId]);
    if (Number(open[0]?.n ?? 0) > 0) return null;
    if (!item.preferred_vendor_id) {
      // one open "order this" per item: a shelf that runs down over a week is one problem, not seven
      await this.tasks.ensure({ schoolId, title: `${item.name} is down to ${quantity} ${item.unit} — choose a vendor and order`, taskType: 'inventory.reorder', assignedRole: 'admin', entityType: 'inventory.item', entityId: itemId, priority: 'high' });
      return null;
    }
    const qty = Number(item.reorder_qty ?? item.reorder_level);
    const po = await this.createPurchaseOrder(schoolId, { vendorId: String(item.preferred_vendor_id), storeId, lines: [{ itemId, quantity: qty, unitCost: Number(item.last_cost ?? 0) }], isAuto: true });
    await this.notifications.notifyRole(schoolId, 'admin', { channels: ['in_app', 'push'], eventKey: 'inventory.reorder_drafted', title: 'Stock is low', body: `${item.name} is down to ${quantity} ${item.unit}. A draft order for ${qty} is waiting for approval.`, entityType: 'inventory.purchase_order', entityId: po.id });
    return po.id;
  }

  // ---------- requisition to purchase order ----------
  async requisition(schoolId: string, r: { requestedBy: string; departmentId?: string | null; items: { itemId: string; quantity: number }[]; justification?: string | null }) {
    const id = ulid();
    await this.db.insert('requisitions', { id, school_id: schoolId, requested_by: r.requestedBy, department_id: r.departmentId ?? null, items: r.items as never, justification: r.justification ?? null, status: 'pending', approval_request_id: null, approved_by: null });
    const ap = await this.approvals.request({ schoolId, entityType: 'inventory.requisition', entityId: id, summary: { lines: r.items.length } });
    await this.db.update('requisitions', { approval_request_id: ap.id, status: ap.status === 'approved' ? 'approved' : 'pending', updated_at: nowSql() }, { id });
    return { id, status: ap.status };
  }
  async addQuotation(schoolId: string, q: { requisitionId?: string | null; vendorId: string; quotedAt?: string; validUntil?: string | null; items: { itemId: string; quantity: number; unitCost: number }[]; fileId?: string | null }) {
    const total = round(q.items.reduce((a, i) => a + i.quantity * i.unitCost, 0));
    const id = ulid();
    await this.db.insert('quotations', { id, school_id: schoolId, requisition_id: q.requisitionId ?? null, vendor_id: q.vendorId, quoted_at: q.quotedAt ?? nowSql().slice(0, 10), valid_until: q.validUntil ?? null, items: q.items as never, total, file_id: q.fileId ?? null, is_selected: false });
    return { id, total };
  }
  /** Picks the cheapest quotation of a requisition unless one is named, and orders from it. */
  async selectQuotation(schoolId: string, requisitionId: string, quotationId?: string) {
    const quotes = await this.db.findMany<Row>('quotations', { school_id: schoolId, requisition_id: requisitionId }, { orderBy: 'total ASC' });
    if (!quotes.length) throw badRequest('no quotations for this requisition');
    const chosen = quotationId ? quotes.find(q => String(q.id) === quotationId) : quotes[0];
    if (!chosen) throw notFound('quotation');
    await this.db.execute(`UPDATE quotations SET is_selected = FALSE WHERE requisition_id = ?`, [requisitionId]);
    await this.db.update('quotations', { is_selected: true, updated_at: nowSql() }, { id: String(chosen.id) });
    const store = (await this.stores(schoolId))[0];
    const lines = (json<PoLine[]>(chosen.items) ?? []).map(l => ({ itemId: l.itemId, quantity: Number(l.quantity), unitCost: Number(l.unitCost) }));
    const po = await this.createPurchaseOrder(schoolId, { vendorId: String(chosen.vendor_id), storeId: String(store!.id), requisitionId, lines });
    await this.db.update('requisitions', { status: 'ordered', updated_at: nowSql() }, { id: requisitionId });
    return { quotationId: String(chosen.id), total: Number(chosen.total), purchaseOrderId: po.id };
  }
  async createPurchaseOrder(schoolId: string, p: { vendorId: string; storeId: string; requisitionId?: string | null; lines: PoLine[]; expectedDate?: string | null; isAuto?: boolean; createdBy?: string | null }) {
    if (!p.lines.length) throw badRequest('a purchase order needs at least one line');
    const id = ulid();
    const poNo = await this.numbering.next(schoolId, 'po_no', { prefix: 'PO-', padding: 5, resetYearly: true });
    const subtotal = round(p.lines.reduce((a, l) => a + l.quantity * l.unitCost, 0));
    await this.db.transaction(async tx => {
      await tx.insert('purchase_orders', { id, school_id: schoolId, po_no: poNo, vendor_id: p.vendorId, store_id: p.storeId, requisition_id: p.requisitionId ?? null, order_date: nowSql().slice(0, 10), expected_date: p.expectedDate ?? null, subtotal, tax_total: 0, total: subtotal, status: 'pending_approval', is_auto: !!p.isAuto, approval_request_id: null, approved_by: null, bill_id: null, created_by: p.createdBy ?? null });
      await tx.insertMany('purchase_order_items', p.lines.map(l => ({ id: ulid(), school_id: schoolId, po_id: id, item_id: l.itemId, quantity: l.quantity, received_qty: 0, unit_cost: l.unitCost })));
    });
    const ap = await this.approvals.request({ schoolId, entityType: 'inventory.purchase_order', entityId: id, summary: { poNo, total: subtotal } });
    await this.db.update('purchase_orders', { approval_request_id: ap.id, status: ap.status === 'approved' ? 'approved' : 'pending_approval', approved_by: ap.status === 'approved' ? null : null, updated_at: nowSql() }, { id });
    return { id, poNo, total: subtotal, status: ap.status };
  }
  async purchaseOrders(schoolId: string, status?: string) {
    const where: Row = { school_id: schoolId };
    if (status) where.status = status;
    return this.db.query<Row>(`SELECT p.*, v.name AS vendor_name, s.name AS store_name FROM purchase_orders p JOIN vendors v ON v.id = p.vendor_id JOIN stores s ON s.id = p.store_id WHERE p.school_id = ?${status ? ' AND p.status = ?' : ''} ORDER BY p.order_date DESC LIMIT 300`, status ? [schoolId, status] : [schoolId]);
  }
  async purchaseOrder(schoolId: string, id: string) {
    const po = await this.db.findOne<Row>('purchase_orders', { id, school_id: schoolId });
    if (!po) throw notFound('purchase order');
    const lines = await this.db.query<Row>(`SELECT i.*, it.name, it.sku, it.unit FROM purchase_order_items i JOIN inventory_items it ON it.id = i.item_id WHERE i.po_id = ?`, [id]);
    return { po, lines };
  }
  /**
   * L2: goods arrive. Stock goes up, the expense and its journal are posted, and anything in an
   * asset category becomes a tagged fixed asset. Receiving part of an order is normal and allowed.
   */
  async receive(schoolId: string, poId: string, received: { itemId: string; quantity: number }[], receivedBy?: string | null) {
    const po = await this.db.findOne<Row>('purchase_orders', { id: poId, school_id: schoolId });
    if (!po) throw notFound('purchase order');
    if (!['approved', 'ordered', 'partially_received'].includes(String(po.status))) throw new HttpError(409, `a ${po.status} order cannot be received`, 'not_approved');
    const lines = await this.db.query<Row>(`SELECT i.*, it.category_id, it.name FROM purchase_order_items i JOIN inventory_items it ON it.id = i.item_id WHERE i.po_id = ?`, [poId]);
    const grnId = ulid();
    let value = 0; const assets: string[] = [];
    await this.db.transaction(async tx => {
      await tx.insert('goods_receipts', { id: grnId, school_id: schoolId, po_id: poId, received_at: nowSql(), received_by: receivedBy ?? null, items: received as never, notes: null });
      for (const r of received) {
        const line = lines.find(l => String(l.item_id) === r.itemId);
        if (!line) throw badRequest('that item is not on this order');
        const outstanding = Number(line.quantity) - Number(line.received_qty);
        if (r.quantity > outstanding) throw badRequest(`${line.name}: only ${outstanding} still outstanding`);
        await this.move(schoolId, { itemId: r.itemId, storeId: String(po.store_id), moveType: 'in', quantity: r.quantity, unitCost: Number(line.unit_cost), refType: 'goods_receipt', refId: grnId, createdBy: receivedBy }, tx);
        await tx.update('purchase_order_items', { received_qty: round(Number(line.received_qty) + r.quantity) }, { id: String(line.id) });
        value = round(value + r.quantity * Number(line.unit_cost));
        const category = await tx.findOne<Row>('inventory_categories', { id: String(line.category_id) });
        if (Number(category?.is_asset)) for (let i = 0; i < r.quantity; i++) assets.push(await this.createAsset(schoolId, { name: String(line.name), itemId: r.itemId, purchaseCost: Number(line.unit_cost), poId, vendorId: String(po.vendor_id) }, tx));
      }
      const after = await tx.query<Row>(`SELECT quantity, received_qty FROM purchase_order_items WHERE po_id = ?`, [poId]);
      const complete = after.every(l => Number(l.received_qty) >= Number(l.quantity));
      await tx.update('purchase_orders', { status: complete ? 'received' : 'partially_received', updated_at: nowSql() }, { id: poId });
    });
    // the money side: one expense per receipt, journalled by the accounting module
    const category = await this.db.findOne<Row>('expense_categories', { school_id: schoolId, name: 'Stationery & printing' }) ?? (await this.db.findMany<Row>('expense_categories', { school_id: schoolId }, { limit: 1 }))[0];
    const expense = category ? await this.accounting.createExpense(schoolId, { categoryId: String(category.id), vendorId: String(po.vendor_id), amount: value, description: `Goods received against ${po.po_no}`, requestedBy: receivedBy ?? null }) : null;
    await this.outbox.emitNow({ type: 'po.received', schoolId, aggregateType: 'inventory.purchase_order', aggregateId: poId, payload: { poId, grnId, value, assets: assets.length } });
    return { grnId, value, assets: assets.length, expenseId: expense?.id ?? null };
  }

  // ---------- issuing ----------
  async issueRequest(schoolId: string, r: { requestedBy: string; storeId: string; items: { itemId: string; quantity: number }[]; purpose?: string | null }) {
    const id = ulid();
    await this.db.insert('issue_requests', { id, school_id: schoolId, requested_by: r.requestedBy, store_id: r.storeId, items: r.items as never, purpose: r.purpose ?? null, status: 'pending', approved_by: null, issued_at: null });
    const ap = await this.approvals.request({ schoolId, entityType: 'inventory.issue_request', entityId: id, summary: { lines: r.items.length } });
    if (ap.status === 'approved') return { id, ...(await this.issueApproved(schoolId, id)) };
    return { id, status: 'pending' as const };
  }
  /** L3: approved consumables leave the store and land on the requester's name. */
  async issueApproved(schoolId: string, requestId: string, issuedBy?: string | null) {
    const r = await this.db.findOne<Row>('issue_requests', { id: requestId, school_id: schoolId });
    if (!r) throw notFound('issue request');
    if (r.status === 'issued') return { status: 'issued' as const, alreadyIssued: true };
    const items = json<{ itemId: string; quantity: number }[]>(r.items) ?? [];
    const staff = await this.db.findOne<Row>('staff', { id: String(r.requested_by) });
    await this.db.transaction(async tx => {
      for (const i of items) await this.move(schoolId, { itemId: i.itemId, storeId: String(r.store_id), moveType: 'out', quantity: Number(i.quantity), refType: 'issue_request', refId: requestId, issuedToStaffId: staff ? String(staff.id) : null, createdBy: issuedBy }, tx);
      await tx.update('issue_requests', { status: 'issued', approved_by: issuedBy ?? null, issued_at: nowSql(), updated_at: nowSql() }, { id: requestId });
    });
    return { status: 'issued' as const, lines: items.length };
  }

  // ---------- assets ----------
  async createAsset(schoolId: string, a: { name: string; itemId?: string | null; purchaseCost?: number | null; poId?: string | null; vendorId?: string | null; serialNo?: string | null; locationRoomId?: string | null; custodianStaffId?: string | null; warrantyUntil?: string | null; depreciationPct?: number | null }, tx?: Db) {
    const t = tx ?? this.db;
    const id = ulid();
    const tag = await this.numbering.next(schoolId, 'asset_tag', { prefix: 'AST-', padding: 5 }, t);
    await t.insert('assets', {
      id, school_id: schoolId, item_id: a.itemId ?? null, asset_tag: tag, name: a.name, serial_no: a.serialNo ?? null, purchase_date: nowSql().slice(0, 10), purchase_cost: a.purchaseCost ?? null,
      vendor_id: a.vendorId ?? null, po_id: a.poId ?? null, warranty_until: a.warrantyUntil ?? null, depreciation_pct: a.depreciationPct ?? null, current_value: a.purchaseCost ?? null,
      location_room_id: a.locationRoomId ?? null, custodian_staff_id: a.custodianStaffId ?? null, condition_note: 'new', status: 'in_store', qr_file_id: null, disposed_at: null, disposal_note: null,
    });
    return id;
  }
  async assets(schoolId: string, f: { status?: string } = {}) {
    const where: Row = { school_id: schoolId };
    if (f.status) where.status = f.status;
    return this.db.findMany<Row>('assets', where, { orderBy: 'asset_tag ASC', limit: 1000 });
  }
  async assignAsset(schoolId: string, assetId: string, to: { roomId?: string | null; custodianStaffId?: string | null }) {
    return this.db.update('assets', { location_room_id: to.roomId ?? null, custodian_staff_id: to.custodianStaffId ?? null, status: 'in_use', updated_at: nowSql() }, { id: assetId, school_id: schoolId });
  }
  async serviceAsset(schoolId: string, m: { assetId: string; serviceDate?: string; serviceType?: 'preventive' | 'repair' | 'calibration' | 'inspection'; cost?: number | null; vendorId?: string | null; nextDueDate?: string | null; notes?: string | null }) {
    const id = ulid();
    await this.db.insert('asset_maintenance', { id, school_id: schoolId, asset_id: m.assetId, service_date: m.serviceDate ?? nowSql().slice(0, 10), service_type: m.serviceType ?? 'repair', cost: m.cost ?? null, vendor_id: m.vendorId ?? null, expense_id: null, next_due_date: m.nextDueDate ?? null, notes: m.notes ?? null });
    return id;
  }
  /** A physical count: what the sheet says against what the ledger says. */
  async auditStock(schoolId: string, storeId: string, counted: { itemId: string; quantity: number }[], name = 'Stock count') {
    const results: { itemId: string; system: number; counted: number; diff: number }[] = [];
    for (const c of counted) {
      const level = await this.db.findOne<Row>('stock_levels', { item_id: c.itemId, store_id: storeId });
      const system = Number(level?.quantity ?? 0);
      const diff = round(c.quantity - system);
      results.push({ itemId: c.itemId, system, counted: c.quantity, diff });
      if (diff !== 0) await this.move(schoolId, { itemId: c.itemId, storeId, moveType: 'adjust', quantity: diff, unitCost: null, refType: 'stock_audit', note: `counted ${c.quantity} against ${system} on the books` });
    }
    const id = ulid();
    await this.db.insert('asset_audits', { id, school_id: schoolId, name, started_at: nowSql().slice(0, 10), finished_at: nowSql().slice(0, 10), results: results as never, status: 'completed' });
    return { id, checked: results.length, discrepancies: results.filter(r => r.diff !== 0).length };
  }

  // ---------- scheduled ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      /**
       * L4: servicing and warranties.
       *
       * As with the fleet, the old pass wrote a new task every night for thirty nights and then went
       * quiet on the day the date passed — so an asset that was actually overdue for service was the
       * one the office heard nothing about. The window now has no floor, an overdue service is called
       * overdue, and `tasks.ensure` keeps one open task per service record rather than thirty.
       */
      'inventory.maintenance_due': async ({ schoolId }) => {
        const today = nowSql().slice(0, 10), soon = addDays(today, 30);
        const due = await this.db.query<Row>(`SELECT m.*, a.name, a.asset_tag FROM asset_maintenance m JOIN assets a ON a.id = m.asset_id WHERE m.school_id = ? AND m.next_due_date IS NOT NULL AND m.next_due_date <= ? AND a.status <> 'disposed'`, [schoolId, soon]);
        let raised = 0, overdue = 0;
        for (const m of due) {
          const on = String(m.next_due_date).slice(0, 10);
          if (on < today) overdue++;
          if (await this.tasks.ensure({ schoolId, title: on < today ? `${m.name} (${m.asset_tag}) was due for service on ${on}` : `Service ${m.name} (${m.asset_tag}) by ${on}`, taskType: 'inventory.maintenance', assignedRole: 'admin', entityType: 'inventory.maintenance', entityId: String(m.id), dueAt: on, priority: on < today ? 'high' : 'normal' })) raised++;
        }
        const warranty = await this.db.query<Row>(`SELECT * FROM assets WHERE school_id = ? AND warranty_until IS NOT NULL AND warranty_until BETWEEN ? AND ? AND status <> 'disposed'`, [schoolId, today, soon]);
        for (const a of warranty) { if (await this.tasks.ensure({ schoolId, title: `Warranty on ${a.name} (${a.asset_tag}) ends on ${String(a.warranty_until).slice(0, 10)}`, taskType: 'inventory.warranty', assignedRole: 'admin', entityType: 'inventory.asset', entityId: String(a.id), dueAt: String(a.warranty_until).slice(0, 10) })) raised++; }
        return { maintenance: due.length, overdue, warranty: warranty.length, tasks: raised };
      },
      /**
       * L7: everything below its reorder level, whether or not anything moved.
       *
       * `checkReorder` fires on a stock movement, which covers the ordinary case and misses three
       * that are not rare: a reorder level raised after the fact, an automatic order somebody
       * cancelled, and an item that simply sat at zero because nothing has moved it in months. A
       * daily sweep asks the question of every item instead of waiting to be asked, and it takes the
       * same two roads `checkReorder` takes — a draft order when the item has a preferred vendor, a
       * task naming the shortfall when it does not, and neither when an order is already open. The
       * draft still waits for approval: spending money stays a decision.
       */
      'inventory.reorder_sweep': async ({ schoolId }) => {
        const low = await this.db.query<Row>(`SELECT i.id, i.name, i.sku, i.unit, i.reorder_level, i.reorder_qty, i.preferred_vendor_id, i.last_cost, l.store_id, COALESCE(l.quantity, 0) AS quantity
          FROM inventory_items i LEFT JOIN stock_levels l ON l.item_id = i.id
          WHERE i.school_id = ? AND i.status = 'active' AND i.reorder_level > 0 AND COALESCE(l.quantity, 0) <= i.reorder_level ORDER BY i.name LIMIT 300`, [schoolId]);
        const store = (await this.stores(schoolId))[0];
        let drafted = 0, flagged = 0;
        const seen = new Set<string>();
        for (const i of low) {
          const itemId = String(i.id);
          if (seen.has(itemId)) continue;                          // one item, one decision, whichever store is short
          seen.add(itemId);
          const open = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM purchase_order_items pi JOIN purchase_orders p ON p.id = pi.po_id WHERE pi.item_id = ? AND p.status IN ('draft','pending_approval','approved','ordered','partially_received')`, [itemId]);
          if (Number(open[0]?.n ?? 0) > 0) continue;
          const storeId = (i.store_id as string) ?? (store ? String(store.id) : null);
          let poId: string | null = null;
          if (i.preferred_vendor_id && storeId) {
            const qty = Number(i.reorder_qty ?? i.reorder_level);
            poId = (await this.createPurchaseOrder(schoolId, { vendorId: String(i.preferred_vendor_id), storeId, lines: [{ itemId, quantity: qty, unitCost: Number(i.last_cost ?? 0) }], isAuto: true })).id;
            await this.notifications.notifyRoleOnce(schoolId, 'admin', 24, { channels: ['in_app', 'push'], eventKey: 'inventory.reorder_drafted', title: 'Stock is low', body: `${i.name} is down to ${Number(i.quantity)} ${i.unit}. A draft order for ${qty} is waiting for approval.`, entityType: 'inventory.purchase_order', entityId: poId });
            drafted++;
          } else {
            if (await this.tasks.ensure({ schoolId, title: `${i.name} is down to ${Number(i.quantity)} ${i.unit} — choose a vendor and order`, taskType: 'inventory.reorder', assignedRole: 'admin', entityType: 'inventory.item', entityId: itemId, priority: 'high' })) flagged++;
          }
          await this.outbox.emitNow({ type: 'stock.below_reorder', schoolId, aggregateType: 'inventory.item', aggregateId: itemId, payload: { itemId, sku: String(i.sku), name: String(i.name), quantity: Number(i.quantity), reorderLevel: Number(i.reorder_level), purchaseOrderId: poId } });
        }
        return { low: seen.size, drafted, flagged };
      },
    };
  }
}

const addDays = (date: string, days: number) => { const d = new Date(`${date.slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
