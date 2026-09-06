-- =====================================================================
--  10 · FEES & BILLING: heads, structures, discounts, fines, invoices, payments, ledger, reminders
-- =====================================================================

CREATE TABLE fee_heads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name           text NOT NULL,                        -- Tuition | Admission | Exam | Transport | Hostel | Library Fine
  code           text NOT NULL,
  head_kind      text NOT NULL DEFAULT 'academic',     -- academic | transport | hostel | fine | misc
  gl_account_id  uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,   -- income account for auto-posting
  is_refundable  boolean NOT NULL DEFAULT false,
  tax_pct        numeric(5,2) NOT NULL DEFAULT 0,
  status         record_status NOT NULL DEFAULT 'active',
  UNIQUE (school_id, code)
);

CREATE TABLE late_fine_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name        text NOT NULL,
  grace_days  smallint NOT NULL DEFAULT 0,
  fine_type   text NOT NULL,                           -- flat | percent | per_day | per_week
  value       numeric(14,2) NOT NULL,
  max_amount  numeric(14,2),
  fine_head_id uuid REFERENCES fee_heads(id) ON DELETE SET NULL,
  UNIQUE (school_id, name)
);

-- Fee plan for a class (optionally campus/shift) in a year
CREATE TABLE fee_structures (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  class_id         uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  campus_id        uuid REFERENCES campuses(id) ON DELETE CASCADE,
  shift_id         uuid REFERENCES shifts(id) ON DELETE CASCADE,
  name             text NOT NULL,
  status           record_status NOT NULL DEFAULT 'active',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (academic_year_id, class_id, campus_id, shift_id)
);

CREATE TABLE fee_structure_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fee_structure_id  uuid NOT NULL REFERENCES fee_structures(id) ON DELETE CASCADE,
  fee_head_id       uuid NOT NULL REFERENCES fee_heads(id) ON DELETE RESTRICT,
  amount            numeric(14,2) NOT NULL,
  frequency         fee_frequency NOT NULL DEFAULT 'monthly',
  due_day           smallint NOT NULL DEFAULT 10,      -- day of month invoices fall due
  applicable_months smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6,7,8,9,10,11,12}',
  late_fine_rule_id uuid REFERENCES late_fine_rules(id) ON DELETE SET NULL,
  UNIQUE (fee_structure_id, fee_head_id)
);

-- Per-student deviations from the class structure (e.g. special amount, waived head)
CREATE TABLE student_fee_overrides (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id       uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  fee_head_id      uuid NOT NULL REFERENCES fee_heads(id) ON DELETE CASCADE,
  amount           numeric(14,2),                      -- NULL = waived
  reason           text,
  approved_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (student_id, academic_year_id, fee_head_id)
);

CREATE TABLE discount_schemes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name             text NOT NULL,                      -- Sibling 20% | Merit Scholarship | Staff Child | Need-based
  discount_kind    text NOT NULL,                      -- sibling | merit | staff_child | need_based | early_payment | custom
  value_type       text NOT NULL,                      -- percent | flat
  value            numeric(14,2) NOT NULL,
  applies_to_heads uuid[] NOT NULL DEFAULT '{}',       -- empty = all heads
  auto_rule        jsonb,                              -- e.g. {"min_gpa":5,"exam_type":"Annual"} or {"sibling_index":2}
  requires_approval boolean NOT NULL DEFAULT true,
  status           record_status NOT NULL DEFAULT 'active',
  UNIQUE (school_id, name)
);

CREATE TABLE student_discounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id         uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  discount_scheme_id uuid NOT NULL REFERENCES discount_schemes(id) ON DELETE CASCADE,
  academic_year_id   uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  value_override     numeric(14,2),
  valid_from         date,
  valid_to           date,
  is_auto            boolean NOT NULL DEFAULT false,   -- proposed by automation (sibling / merit)
  status             approval_status NOT NULL DEFAULT 'pending',
  approved_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, discount_scheme_id, academic_year_id)
);

-- One generation run (e.g. "March 2027 tuition for all classes")
CREATE TABLE invoice_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  billing_period   date NOT NULL,                      -- first day of month
  scope            jsonb NOT NULL DEFAULT '{}',        -- {"class_ids":[...]} empty = all
  generated_by     uuid REFERENCES users(id) ON DELETE SET NULL,   -- NULL = scheduler
  invoice_count    integer NOT NULL DEFAULT 0,
  total_amount     numeric(14,2) NOT NULL DEFAULT 0,
  status           job_status NOT NULL DEFAULT 'pending',
  started_at       timestamptz,
  finished_at      timestamptz,
  error            text,
  UNIQUE (academic_year_id, billing_period, scope)
);

CREATE TABLE invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  invoice_no       text NOT NULL,
  student_id       uuid REFERENCES students(id) ON DELETE RESTRICT,
  application_id   uuid REFERENCES admission_applications(id) ON DELETE SET NULL,  -- pre-enrolment invoices
  academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL,
  batch_id         uuid REFERENCES invoice_batches(id) ON DELETE SET NULL,
  billing_period   date,                               -- month this invoice covers
  issue_date       date NOT NULL DEFAULT CURRENT_DATE,
  due_date         date NOT NULL,
  subtotal         numeric(14,2) NOT NULL DEFAULT 0,
  discount_total   numeric(14,2) NOT NULL DEFAULT 0,
  fine_total       numeric(14,2) NOT NULL DEFAULT 0,
  tax_total        numeric(14,2) NOT NULL DEFAULT 0,
  total            numeric(14,2) NOT NULL DEFAULT 0,
  paid_total       numeric(14,2) NOT NULL DEFAULT 0,
  balance          numeric(14,2) GENERATED ALWAYS AS (total - paid_total) STORED,
  status           invoice_status NOT NULL DEFAULT 'issued',
  is_auto          boolean NOT NULL DEFAULT true,
  notes            text,
  pdf_file_id      uuid REFERENCES files(id) ON DELETE SET NULL,
  last_reminder_stage text,                            -- before_due | due | overdue_7 | overdue_15 | overdue_30
  last_reminder_at timestamptz,
  fine_applied_at  timestamptz,
  cancelled_at     timestamptz,
  cancel_reason    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, invoice_no),
  CHECK (student_id IS NOT NULL OR application_id IS NOT NULL)
);
CREATE INDEX ix_invoices_student ON invoices(student_id, status);
CREATE INDEX ix_invoices_due ON invoices(school_id, due_date) WHERE status IN ('issued','partially_paid','overdue');
ALTER TABLE admission_applications ADD FOREIGN KEY (form_fee_invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;
ALTER TABLE admission_offers ADD FOREIGN KEY (admission_fee_invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;
ALTER TABLE admission_campaigns ADD FOREIGN KEY (admission_fee_head_id) REFERENCES fee_heads(id) ON DELETE SET NULL;

CREATE TABLE invoice_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  fee_head_id     uuid REFERENCES fee_heads(id) ON DELETE SET NULL,
  description     text NOT NULL,
  quantity        numeric(8,2) NOT NULL DEFAULT 1,
  unit_amount     numeric(14,2) NOT NULL,
  discount_amount numeric(14,2) NOT NULL DEFAULT 0,
  discount_id     uuid REFERENCES student_discounts(id) ON DELETE SET NULL,
  tax_amount      numeric(14,2) NOT NULL DEFAULT 0,
  amount          numeric(14,2) NOT NULL,              -- qty*unit - discount + tax
  item_kind       text NOT NULL DEFAULT 'fee',         -- fee | fine | adjustment | previous_due
  source_type     text,                                -- library_issue | transport | hostel | ...
  source_id       uuid
);

CREATE TABLE payment_gateways (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  provider    text NOT NULL,                           -- sslcommerz | bkash | nagad | stripe | aamarpay
  display_name text NOT NULL,
  credentials jsonb NOT NULL,                          -- encrypted at rest (app-layer KMS)
  is_sandbox  boolean NOT NULL DEFAULT true,
  is_active   boolean NOT NULL DEFAULT true,
  settle_to_bank_account_id uuid REFERENCES bank_accounts(id) ON DELETE SET NULL,
  fee_pct     numeric(5,2) NOT NULL DEFAULT 0,         -- gateway charge, auto-expensed
  UNIQUE (school_id, provider)
);

CREATE TABLE payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  payment_no       text NOT NULL,
  student_id       uuid REFERENCES students(id) ON DELETE RESTRICT,
  application_id   uuid REFERENCES admission_applications(id) ON DELETE SET NULL,
  payer_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  amount           numeric(14,2) NOT NULL,
  method           payment_method NOT NULL,
  gateway_id       uuid REFERENCES payment_gateways(id) ON DELETE SET NULL,
  gateway_txn_id   text,
  gateway_payload  jsonb,
  bank_account_id  uuid REFERENCES bank_accounts(id) ON DELETE SET NULL,   -- where money landed
  reference        text,                               -- cheque no / MFS trx id
  paid_at          timestamptz NOT NULL DEFAULT now(),
  received_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  status           payment_status NOT NULL DEFAULT 'success',
  receipt_file_id  uuid REFERENCES files(id) ON DELETE SET NULL,
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, payment_no),
  UNIQUE (gateway_id, gateway_txn_id)
);
CREATE INDEX ix_payments_student ON payments(student_id, paid_at DESC);

-- A payment can settle several invoices; unallocated remainder = advance credit
CREATE TABLE payment_allocations (
  payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount     numeric(14,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (payment_id, invoice_id)
);

CREATE TABLE refunds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  payment_id       uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  amount           numeric(14,2) NOT NULL,
  reason           text NOT NULL,
  requested_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  status           approval_status NOT NULL DEFAULT 'pending',
  approved_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  refunded_at      timestamptz,
  gateway_refund_id text,
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Running per-student ledger (append-only). balance_after > 0 = student owes.
CREATE TABLE student_ledger_entries (
  id            bigserial PRIMARY KEY,
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id    uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  entry_type    text NOT NULL,                         -- invoice | payment | refund | adjustment | fine | write_off
  ref_type      text NOT NULL,
  ref_id        uuid NOT NULL,
  debit         numeric(14,2) NOT NULL DEFAULT 0,      -- charges
  credit        numeric(14,2) NOT NULL DEFAULT 0,      -- payments
  balance_after numeric(14,2) NOT NULL,
  description   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_ledger_student ON student_ledger_entries(student_id, id DESC);

CREATE TABLE fee_reminders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  invoice_id      uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  stage           text NOT NULL,                       -- before_due | due | overdue_7 | overdue_15 | overdue_30 | call_task
  channel         notification_channel NOT NULL,
  notification_id uuid,                                -- soft ref → notifications
  sent_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, stage, channel)
);

-- Cash counter sessions (day-end close, cash-in-hand reconciliation)
CREATE TABLE cash_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  cashier_id    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  opening_cash  numeric(14,2) NOT NULL DEFAULT 0,
  expected_cash numeric(14,2),
  counted_cash  numeric(14,2),
  variance      numeric(14,2),
  deposited_to  uuid REFERENCES bank_accounts(id) ON DELETE SET NULL,
  note          text
);

-- Convenience views for dashboards / reminders
CREATE VIEW v_student_dues AS
SELECT s.school_id, s.id AS student_id,
       coalesce(sum(i.balance) FILTER (WHERE i.status IN ('issued','partially_paid','overdue')), 0) AS outstanding,
       coalesce(sum(i.balance) FILTER (WHERE i.status = 'overdue'), 0) AS overdue,
       min(i.due_date) FILTER (WHERE i.status IN ('issued','partially_paid','overdue')) AS oldest_due
FROM students s LEFT JOIN invoices i ON i.student_id = s.id
GROUP BY s.school_id, s.id;
