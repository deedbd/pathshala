-- =====================================================================
--  15 · INVENTORY & ASSETS: items, stores, purchase orders, stock ledger, fixed assets, maintenance
-- =====================================================================

CREATE TABLE inventory_categories (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name      text NOT NULL,                             -- Stationery | Lab | Furniture | IT | Sports
  is_asset  boolean NOT NULL DEFAULT false,            -- items here are tracked as fixed assets
  UNIQUE (school_id, name)
);

CREATE TABLE stores (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  campus_id uuid REFERENCES campuses(id) ON DELETE SET NULL,
  name      text NOT NULL,
  keeper_id uuid REFERENCES staff(id) ON DELETE SET NULL,
  UNIQUE (school_id, name)
);

CREATE TABLE inventory_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  category_id   uuid NOT NULL REFERENCES inventory_categories(id) ON DELETE RESTRICT,
  sku           text NOT NULL,
  name          text NOT NULL,
  unit          text NOT NULL DEFAULT 'pcs',
  reorder_level numeric(12,2) NOT NULL DEFAULT 0,      -- automation: draft PO when stock < level
  reorder_qty   numeric(12,2),
  preferred_vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL,
  last_cost     numeric(14,2),
  gl_account_id uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  status        record_status NOT NULL DEFAULT 'active',
  UNIQUE (school_id, sku)
);

CREATE TABLE stock_levels (
  item_id   uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  store_id  uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  quantity  numeric(12,2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, store_id)
);

CREATE TABLE purchase_orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  po_no        text NOT NULL,
  vendor_id    uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  store_id     uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  order_date   date NOT NULL DEFAULT CURRENT_DATE,
  expected_date date,
  subtotal     numeric(14,2) NOT NULL DEFAULT 0,
  tax_total    numeric(14,2) NOT NULL DEFAULT 0,
  total        numeric(14,2) NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'draft',          -- draft | pending_approval | approved | ordered | partially_received | received | cancelled
  is_auto      boolean NOT NULL DEFAULT false,         -- drafted by reorder automation
  approval_request_id uuid,
  approved_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  expense_id   uuid REFERENCES expenses(id) ON DELETE SET NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, po_no)
);

CREATE TABLE purchase_order_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id       uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id     uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  quantity    numeric(12,2) NOT NULL,
  received_qty numeric(12,2) NOT NULL DEFAULT 0,
  unit_cost   numeric(14,2) NOT NULL,
  UNIQUE (po_id, item_id)
);

-- Append-only stock ledger; stock_levels is the rollup
CREATE TABLE stock_movements (
  id          bigserial PRIMARY KEY,
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  item_id     uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  store_id    uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  move_type   stock_move_type NOT NULL,
  quantity    numeric(12,2) NOT NULL,                  -- positive; sign implied by move_type
  unit_cost   numeric(14,2),
  ref_type    text,                                    -- purchase_order | issue_request | adjustment | transfer
  ref_id      uuid,
  issued_to_staff_id uuid REFERENCES staff(id) ON DELETE SET NULL,
  issued_to_room_id  uuid REFERENCES rooms(id) ON DELETE SET NULL,
  note        text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_stock_moves_item ON stock_movements(item_id, created_at DESC);

CREATE OR REPLACE FUNCTION apply_stock_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE delta numeric;
BEGIN
  delta := CASE NEW.move_type WHEN 'in' THEN NEW.quantity WHEN 'return' THEN NEW.quantity
                               WHEN 'out' THEN -NEW.quantity WHEN 'transfer' THEN -NEW.quantity
                               ELSE NEW.quantity END;   -- 'adjust' carries signed quantity semantics via app
  INSERT INTO stock_levels(item_id, store_id, quantity) VALUES (NEW.item_id, NEW.store_id, delta)
  ON CONFLICT (item_id, store_id) DO UPDATE SET quantity = stock_levels.quantity + EXCLUDED.quantity, updated_at = now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_stock_movement AFTER INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();

CREATE TABLE assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  item_id         uuid REFERENCES inventory_items(id) ON DELETE SET NULL,
  asset_tag       text NOT NULL,
  name            text NOT NULL,
  serial_no       text,
  purchase_date   date,
  purchase_cost   numeric(14,2),
  vendor_id       uuid REFERENCES vendors(id) ON DELETE SET NULL,
  warranty_until  date,                                -- automation: expiry alert
  depreciation_pct numeric(5,2),
  current_value   numeric(14,2),
  location_room_id uuid REFERENCES rooms(id) ON DELETE SET NULL,
  custodian_staff_id uuid REFERENCES staff(id) ON DELETE SET NULL,
  condition       text NOT NULL DEFAULT 'good',
  status          text NOT NULL DEFAULT 'in_use',      -- in_use | in_store | repair | disposed | lost
  qr_file_id      uuid REFERENCES files(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, asset_tag)
);

CREATE TABLE asset_maintenance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id      uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  service_date  date NOT NULL,
  service_type  text NOT NULL,                         -- preventive | repair | calibration
  cost          numeric(14,2),
  vendor_id     uuid REFERENCES vendors(id) ON DELETE SET NULL,
  expense_id    uuid REFERENCES expenses(id) ON DELETE SET NULL,
  next_due_date date,
  notes         text
);

-- Staff request stationery / lab consumables; approval → 'out' movement
CREATE TABLE issue_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  store_id     uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  items        jsonb NOT NULL,                         -- [{item_id, qty}]
  purpose      text,
  status       approval_status NOT NULL DEFAULT 'pending',
  approved_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  issued_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
