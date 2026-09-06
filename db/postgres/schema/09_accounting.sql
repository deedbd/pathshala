-- =====================================================================
--  09 · ACCOUNTING: chart of accounts, fiscal years, journals, bank, expenses, budgets
--  (loaded before fees so fee heads can map to GL income accounts)
-- =====================================================================

CREATE TABLE fiscal_years (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name       text NOT NULL,                            -- 'FY 2026-27' (BD: July–June)
  start_date date NOT NULL,
  end_date   date NOT NULL,
  is_closed  boolean NOT NULL DEFAULT false,
  UNIQUE (school_id, name)
);

CREATE TABLE gl_accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  code         text NOT NULL,                          -- 1000 Assets, 1100 Cash, 4000 Tuition Income ...
  name         text NOT NULL,
  account_type gl_account_type NOT NULL,
  parent_id    uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  is_group     boolean NOT NULL DEFAULT false,
  is_system    boolean NOT NULL DEFAULT false,         -- auto-posting targets (fee income, bank, receivable)
  status       record_status NOT NULL DEFAULT 'active',
  UNIQUE (school_id, code)
);

CREATE TABLE cost_centers (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name      text NOT NULL,                             -- Campus / Department / Transport / Hostel
  campus_id uuid REFERENCES campuses(id) ON DELETE SET NULL,
  UNIQUE (school_id, name)
);

CREATE TABLE bank_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  gl_account_id uuid NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  bank_name     text NOT NULL,
  branch        text,
  account_name  text NOT NULL,
  account_no    text NOT NULL,
  routing_no    text,
  account_kind  text NOT NULL DEFAULT 'bank',          -- bank | mfs (bKash/Nagad merchant) | cash_box
  is_default_collection boolean NOT NULL DEFAULT false,
  status        record_status NOT NULL DEFAULT 'active'
);

-- Double-entry journal. Every money movement (fee payment, payroll, expense) posts here automatically.
CREATE TABLE journal_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  fiscal_year_id uuid REFERENCES fiscal_years(id) ON DELETE RESTRICT,
  entry_no       text NOT NULL,
  entry_date     date NOT NULL DEFAULT CURRENT_DATE,
  memo           text,
  source_type    text,                                 -- payment | refund | payroll_run | expense | manual | inventory
  source_id      uuid,
  status         journal_status NOT NULL DEFAULT 'posted',
  reversal_of_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  posted_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  is_auto        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, entry_no)
);
CREATE INDEX ix_journal_source ON journal_entries(source_type, source_id);
CREATE INDEX ix_journal_date ON journal_entries(school_id, entry_date);

CREATE TABLE journal_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id       uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id     uuid NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  cost_center_id uuid REFERENCES cost_centers(id) ON DELETE SET NULL,
  debit          numeric(14,2) NOT NULL DEFAULT 0,
  credit         numeric(14,2) NOT NULL DEFAULT 0,
  description    text,
  CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0))
);
CREATE INDEX ix_journal_lines_account ON journal_lines(account_id);

-- Enforce balanced entries when posting (deferred check via trigger)
CREATE OR REPLACE FUNCTION assert_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d numeric; c numeric;
BEGIN
  SELECT coalesce(sum(debit),0), coalesce(sum(credit),0) INTO d, c FROM journal_lines WHERE entry_id = NEW.id;
  IF NEW.status = 'posted' AND d <> c THEN
    RAISE EXCEPTION 'Journal % is not balanced (debit % / credit %)', NEW.entry_no, d, c;
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER trg_journal_balanced AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

CREATE TABLE expense_categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name          text NOT NULL,                         -- Utilities | Repairs | Stationery | Events
  gl_account_id uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  requires_approval_above numeric(14,2),
  UNIQUE (school_id, name)
);

CREATE TABLE vendors (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name      text NOT NULL,
  phone     text,
  email     citext,
  address   jsonb NOT NULL DEFAULT '{}',
  tax_id    text,
  bank_details jsonb NOT NULL DEFAULT '{}',
  status    record_status NOT NULL DEFAULT 'active'
);

CREATE TABLE expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  expense_no      text NOT NULL,
  category_id     uuid NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  vendor_id       uuid REFERENCES vendors(id) ON DELETE SET NULL,
  cost_center_id  uuid REFERENCES cost_centers(id) ON DELETE SET NULL,
  expense_date    date NOT NULL DEFAULT CURRENT_DATE,
  amount          numeric(14,2) NOT NULL,
  tax_amount      numeric(14,2) NOT NULL DEFAULT 0,
  paid_from_id    uuid REFERENCES bank_accounts(id) ON DELETE SET NULL,
  payment_method  payment_method,
  reference       text,
  description     text,
  bill_file_id    uuid REFERENCES files(id) ON DELETE SET NULL,
  requested_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  status          approval_status NOT NULL DEFAULT 'pending',
  approval_request_id uuid,                            -- soft ref → approval_requests
  approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  paid_at         timestamptz,
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, expense_no)
);

-- Non-fee income: donations, hall rent, canteen contract ...
CREATE TABLE other_incomes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  gl_account_id    uuid NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  received_in_id   uuid REFERENCES bank_accounts(id) ON DELETE SET NULL,
  income_date      date NOT NULL DEFAULT CURRENT_DATE,
  amount           numeric(14,2) NOT NULL,
  payer            text,
  description      text,
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE budgets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  fiscal_year_id uuid NOT NULL REFERENCES fiscal_years(id) ON DELETE CASCADE,
  gl_account_id  uuid NOT NULL REFERENCES gl_accounts(id) ON DELETE CASCADE,
  cost_center_id uuid REFERENCES cost_centers(id) ON DELETE CASCADE,
  amount         numeric(14,2) NOT NULL,
  alert_at_pct   numeric(5,2) NOT NULL DEFAULT 90,     -- automation: warn when spend crosses this
  UNIQUE (fiscal_year_id, gl_account_id, cost_center_id)
);

-- Bank statement import + auto matching to payments/expenses
CREATE TABLE bank_statement_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  txn_date        date NOT NULL,
  description     text,
  reference       text,
  debit           numeric(14,2) NOT NULL DEFAULT 0,
  credit          numeric(14,2) NOT NULL DEFAULT 0,
  balance         numeric(14,2),
  matched_type    text,                                -- payment | expense | payroll | manual
  matched_id      uuid,
  matched_at      timestamptz,
  import_batch    text,
  UNIQUE (bank_account_id, txn_date, reference, debit, credit)
);
