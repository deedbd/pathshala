-- =====================================================================
--  11 · HR & PAYROLL: contracts, salary structures, payroll runs, payslips, loans, appraisals
-- =====================================================================

CREATE TABLE staff_contracts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  staff_id    uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  contract_type employment_type NOT NULL,
  start_date  date NOT NULL,
  end_date    date,                                    -- automation: expiry alert 30 days before
  file_id     uuid REFERENCES files(id) ON DELETE SET NULL,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE salary_components (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name          text NOT NULL,                         -- Basic | House Rent | Medical | Conveyance | PF | Tax | Loan
  code          text NOT NULL,
  component_type text NOT NULL,                        -- earning | deduction | employer_contribution
  calc_type     text NOT NULL DEFAULT 'fixed',         -- fixed | percent_of_basic | percent_of_gross | formula | attendance_based
  default_value numeric(14,2),
  formula       text,                                  -- e.g. "basic * 0.5" evaluated by payroll engine
  is_taxable    boolean NOT NULL DEFAULT true,
  is_statutory  boolean NOT NULL DEFAULT false,
  gl_account_id uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  sequence      smallint NOT NULL DEFAULT 0,
  UNIQUE (school_id, code)
);

CREATE TABLE salary_structures (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  staff_id       uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  effective_from date NOT NULL,
  effective_to   date,
  basic          numeric(14,2) NOT NULL,
  pay_frequency  text NOT NULL DEFAULT 'monthly',
  bank_account   jsonb NOT NULL DEFAULT '{}',          -- override of staff.bank_details
  approved_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  EXCLUDE USING gist (staff_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&)
);

CREATE TABLE salary_structure_items (
  structure_id uuid NOT NULL REFERENCES salary_structures(id) ON DELETE CASCADE,
  component_id uuid NOT NULL REFERENCES salary_components(id) ON DELETE CASCADE,
  value        numeric(14,2) NOT NULL,                 -- amount or percent depending on component.calc_type
  PRIMARY KEY (structure_id, component_id)
);

CREATE TABLE staff_loans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  staff_id          uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  loan_type         text NOT NULL,                     -- advance | loan | pf_loan
  principal         numeric(14,2) NOT NULL,
  monthly_deduction numeric(14,2) NOT NULL,
  balance           numeric(14,2) NOT NULL,
  starts_from       date NOT NULL,
  status            approval_status NOT NULL DEFAULT 'pending',
  approved_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  journal_entry_id  uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payroll_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  period_month     date NOT NULL,                      -- first day of month
  campus_id        uuid REFERENCES campuses(id) ON DELETE SET NULL,
  status           payroll_status NOT NULL DEFAULT 'draft',
  staff_count      integer NOT NULL DEFAULT 0,
  total_gross      numeric(14,2) NOT NULL DEFAULT 0,
  total_deductions numeric(14,2) NOT NULL DEFAULT 0,
  total_net        numeric(14,2) NOT NULL DEFAULT 0,
  calculated_at    timestamptz,
  approved_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at      timestamptz,
  paid_from_id     uuid REFERENCES bank_accounts(id) ON DELETE SET NULL,
  paid_at          timestamptz,
  bank_file_id     uuid REFERENCES files(id) ON DELETE SET NULL,   -- bulk transfer sheet
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, period_month, campus_id)
);

CREATE TABLE payslips (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  payroll_run_id   uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  staff_id         uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  structure_id     uuid REFERENCES salary_structures(id) ON DELETE SET NULL,
  working_days     numeric(4,1) NOT NULL,
  present_days     numeric(4,1) NOT NULL,
  paid_leave_days  numeric(4,1) NOT NULL DEFAULT 0,
  lop_days         numeric(4,1) NOT NULL DEFAULT 0,    -- loss of pay
  late_count       smallint NOT NULL DEFAULT 0,
  overtime_hours   numeric(5,1) NOT NULL DEFAULT 0,
  gross            numeric(14,2) NOT NULL,
  total_deductions numeric(14,2) NOT NULL,
  net_pay          numeric(14,2) NOT NULL,
  breakdown        jsonb NOT NULL,                     -- [{component, amount}] frozen snapshot
  payslip_file_id  uuid REFERENCES files(id) ON DELETE SET NULL,
  paid_at          timestamptz,
  payment_ref      text,
  status           text NOT NULL DEFAULT 'draft',      -- draft | approved | paid | held
  hold_reason      text,
  UNIQUE (payroll_run_id, staff_id)
);

CREATE TABLE appraisal_cycles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  name             text NOT NULL,
  criteria         jsonb NOT NULL,                     -- [{"key":"punctuality","weight":20}, ...]
  opens_at         date NOT NULL,
  closes_at        date NOT NULL
);

CREATE TABLE staff_appraisals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id      uuid NOT NULL REFERENCES appraisal_cycles(id) ON DELETE CASCADE,
  staff_id      uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  reviewer_id   uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  self_scores   jsonb,
  reviewer_scores jsonb,
  auto_metrics  jsonb,                                 -- attendance %, syllabus completion %, result avg — filled by system
  overall_score numeric(5,2),
  comments      text,
  status        text NOT NULL DEFAULT 'pending',       -- pending | self_done | reviewed | finalised
  finalised_at  timestamptz,
  UNIQUE (cycle_id, staff_id)
);

CREATE TABLE staff_trainings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  staff_id    uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  title       text NOT NULL,
  provider    text,
  start_date  date,
  end_date    date,
  certificate_file_id uuid REFERENCES files(id) ON DELETE SET NULL
);
