// Finance: fees & billing, accounting, student wallet & POS, HR & payroll, scholarships & donations
export default [
{ key:'fees', group:'Finance', title:'Fees & billing', color:'#0E7490', year:1,
  desc:'Fee heads mapped to GL, class structures, per-student overrides, discount schemes (sibling/merit/staff/need), monthly invoice batches with pro-rata, gateway payments (bKash, Nagad, Rocket, SSLCommerz, Stripe) allocated oldest-first, advance credit, fines, reminder ladder, refunds, cash sessions, instalment plans.',
  tables:{
  fee_heads:{ desc:'Tuition, admission, exam, transport, hostel, fine, canteen…', cols:`
    name          str(80) !
    code          str(20) !
    head_kind     enum(academic|transport|hostel|fine|misc|course|shop|canteen) ! =academic
    gl_account_id ulid
    is_refundable bool ! =false
    tax_pct       pct ! =0
    status        enum(active|inactive) ! =active
  `, unique:[['school_id','code']] },
  late_fine_rules:{ desc:'Grace days, flat/percent/per-day, cap.', cols:`
    name        str(80) !
    grace_days  small ! =0
    fine_type   enum(flat|percent|per_day|per_week) !
    value       money !
    max_amount  money
    fine_head_id ulid >fee_heads:null
  `, unique:[['school_id','name']] },
  fee_structures:{ desc:'Fee plan for a class (optionally campus/shift/programme) per year.', cols:`
    academic_year_id ulid ! >academic_years
    class_id         ulid ! >classes
    campus_id        ulid >campuses:null
    shift_id         ulid >shifts:null
    program_id       ulid >programs:null
    name             str(120) !
    status           enum(active|inactive) ! =active
  `, unique:[['academic_year_id','class_id','campus_id','shift_id','program_id']] },
  fee_structure_items:{ ts:false, desc:'Head × amount × frequency × due day × months.', cols:`
    fee_structure_id  ulid ! >fee_structures
    fee_head_id       ulid ! >fee_heads:restrict
    amount            money !
    frequency         enum(one_time|monthly|quarterly|half_yearly|yearly|per_term) ! =monthly
    due_day           small ! =10
    applicable_months json
    late_fine_rule_id ulid >late_fine_rules:null
  `, unique:[['fee_structure_id','fee_head_id']] },
  student_fee_overrides:{ desc:'Per-student amount or waiver for a head.', cols:`
    student_id       ulid ! >students
    academic_year_id ulid ! >academic_years
    fee_head_id      ulid ! >fee_heads
    amount           money
    reason           str(160)
    approved_by      ulid >users:null
  `, unique:[['student_id','academic_year_id','fee_head_id']] },
  discount_schemes:{ desc:'Sibling / merit / staff child / need-based / early payment with auto rule.', cols:`
    name             str(120) !
    discount_kind    enum(sibling|merit|staff_child|need_based|early_payment|scholarship|custom) !
    value_type       enum(percent|flat) !
    value            money !
    applies_to_heads json
    auto_rule        json
    requires_approval bool ! =true
    budget_cap       money
    status           enum(active|inactive) ! =active
  `, unique:[['school_id','name']] },
  student_discounts:{ desc:'Discount granted (or auto-proposed) to a student for a year.', cols:`
    student_id         ulid ! >students
    discount_scheme_id ulid ! >discount_schemes
    academic_year_id   ulid ! >academic_years
    value_override     money
    valid_from         date
    valid_to           date
    is_auto            bool ! =false
    status             enum(pending|approved|rejected|expired) ! =pending
    approved_by        ulid >users:null
  `, unique:[['student_id','discount_scheme_id','academic_year_id']] },
  instalment_plans:{ desc:'Split a large fee (admission, yearly) into instalments per student.', cols:`
    student_id   ulid ! >students
    fee_head_id  ulid ! >fee_heads
    total_amount money !
    instalments  json           # [{due:'2026-10-10',amount:5000},…]
    status       enum(active|completed|cancelled) ! =active
    approved_by  ulid >users:null
  `},
  invoice_batches:{ desc:'One generation run (e.g. October tuition for all classes).', cols:`
    academic_year_id ulid ! >academic_years
    billing_period   date !
    scope            json
    generated_by     ulid >users:null
    invoice_count    int ! =0
    total_amount     money ! =0
    status           enum(pending|running|success|failed) ! =pending
    started_at       dt
    finished_at      dt
    error            text
  `},
  invoices:{ desc:'Student (or applicant) invoice with totals, status and reminder stamps.', cols:`
    invoice_no       str(30) !
    student_id       ulid >students:restrict
    application_id   ulid >admission_applications:null
    academic_year_id ulid >academic_years:null
    batch_id         ulid >invoice_batches:null
    billing_period   date
    issue_date       date !
    due_date         date !
    subtotal         money ! =0
    discount_total   money ! =0
    fine_total       money ! =0
    tax_total        money ! =0
    total            money ! =0
    paid_total       money ! =0
    balance          money ! =0
    status           enum(draft|issued|partially_paid|paid|overdue|cancelled|written_off) ! =issued
    is_auto          bool ! =true
    notes            str(255)
    pdf_file_id      ulid >files:null
    last_reminder_stage str(20)
    last_reminder_at dt
    fine_applied_at  dt
    cancelled_at     dt
    cancel_reason    str(160)
  `, unique:[['school_id','invoice_no']], index:[['student_id','status'],['school_id','due_date','status']] },
  invoice_items:{ ts:false, desc:'Lines: fee, fine, adjustment, previous due; source pointer (library issue, transport…).', cols:`
    invoice_id      ulid ! >invoices
    fee_head_id     ulid >fee_heads:null
    description     str(200) !
    quantity        dec(8,2) ! =1
    unit_amount     money !
    discount_amount money ! =0
    discount_id     ulid >student_discounts:null
    tax_amount      money ! =0
    amount          money !
    item_kind       enum(fee|fine|adjustment|previous_due|course|shop) ! =fee
    source_type     str(40)
    source_id       ulid
  `},
  payment_gateways:{ desc:'Configured gateways with encrypted credentials and settlement account.', cols:`
    provider    enum(sslcommerz|bkash|nagad|rocket|upay|aamarpay|shurjopay|stripe|paypal|razorpay) !
    display_name str(80) !
    credentials json
    is_sandbox  bool ! =true
    is_active   bool ! =true
    settle_to_bank_account_id ulid
    fee_pct     pct ! =0
    fee_fixed   money ! =0
    sort_order  small ! =0
  `, unique:[['school_id','provider']] },
  payments:{ desc:'Money received; allocated to invoices; journal auto-posted.', cols:`
    payment_no       str(30) !
    student_id       ulid >students:restrict
    application_id   ulid >admission_applications:null
    payer_user_id    ulid >users:null
    amount           money !
    method           enum(cash|bank_transfer|cheque|card|bkash|nagad|rocket|upay|sslcommerz|stripe|wallet|adjustment|other) !
    gateway_id       ulid >payment_gateways:null
    gateway_txn_id   str(120)
    gateway_payload  json
    bank_account_id  ulid
    reference        str(120)
    paid_at          dt ! =now
    received_by      ulid >users:null
    status           enum(pending|success|failed|refunded|reversed) ! =success
    receipt_file_id  ulid >files:null
    journal_entry_id ulid
    cash_session_id  ulid
    notes            str(255)
  `, unique:[['school_id','payment_no'],['gateway_id','gateway_txn_id']], index:[['student_id','paid_at']] },
  payment_allocations:{ ts:false, desc:'Payment → invoice amounts; unallocated remainder = advance credit.', cols:`
    payment_id ulid ! >payments
    invoice_id ulid ! >invoices
    amount     money !
  `, unique:[['payment_id','invoice_id']] },
  refunds:{ desc:'Refund with approval, gateway refund id and reversal journal.', cols:`
    payment_id       ulid ! >payments:restrict
    amount           money !
    reason           str(255) !
    requested_by     ulid >users:null
    status           enum(pending|approved|rejected|refunded) ! =pending
    approved_by      ulid >users:null
    refunded_at      dt
    gateway_refund_id str(120)
    journal_entry_id ulid
  `},
  student_ledger_entries:{ ts:false, desc:'Append-only running ledger per student.', cols:`
    student_id    ulid ! >students
    entry_type    enum(invoice|payment|refund|adjustment|fine|write_off|advance) !
    ref_type      str(40) !
    ref_id        ulid !
    debit         money ! =0
    credit        money ! =0
    balance_after money !
    description   str(200)
    created_at    dt ! =now
  `, index:[['student_id','created_at']] },
  fee_reminders:{ ts:false, desc:'Reminder sent per invoice per stage per channel.', cols:`
    invoice_id      ulid ! >invoices
    stage           str(20) !
    channel         enum(sms|push|email|whatsapp|call_task) !
    notification_id ulid
    sent_at         dt ! =now
  `, unique:[['invoice_id','stage','channel']] },
  cash_sessions:{ desc:'Counter session with opening/closing count and variance.', cols:`
    cashier_id    ulid ! >users:restrict
    opened_at     dt ! =now
    closed_at     dt
    opening_cash  money ! =0
    expected_cash money
    counted_cash  money
    variance      money
    deposited_to  ulid
    note          str(255)
  `},
  fee_collection_daily:{ ts:false, desc:'Rollup per day per method for dashboards.', cols:`
    on_date  date !
    method   str(20) !
    count    int ! =0
    amount   money ! =0
  `, unique:[['school_id','on_date','method']] },
}},

{ key:'accounting', group:'Finance', title:'Accounting · GL, AP/AR, assets, statements', color:'#155E75', year:1,
  desc:'Full double-entry: chart of accounts, journals (auto-posted from fees, payroll, purchases, POS), expenses with approvals, vendors/bills (AP), bank & MFS accounts with reconciliation, budgets, fixed-asset depreciation, VAT/tax, cost centres, financial statements, year-end close.',
  tables:{
  fiscal_years:{ desc:'Financial year (BD: July–June).', cols:`
    name       str(20) !
    start_date date !
    end_date   date !
    is_closed  bool ! =false
    closed_at  dt
  `, unique:[['school_id','name']] },
  gl_accounts:{ desc:'Chart of accounts tree.', cols:`
    code         str(20) !
    name         str(120) !
    account_type enum(asset|liability|equity|income|expense) !
    parent_id    ulid >gl_accounts:null
    is_group     bool ! =false
    is_system    bool ! =false
    status       enum(active|inactive) ! =active
  `, unique:[['school_id','code']] },
  cost_centers:{ desc:'Campus / department / project for reporting.', cols:`
    name      str(80) !
    campus_id ulid >campuses:null
    department_id ulid >departments:null
  `, unique:[['school_id','name']] },
  bank_accounts:{ desc:'Bank, MFS merchant and cash boxes.', cols:`
    gl_account_id ulid ! >gl_accounts:restrict
    bank_name     str(120) !
    branch        str(120)
    account_name  str(160) !
    account_no    str(60) !
    routing_no    str(30)
    account_kind  enum(bank|mfs|cash_box|card) ! =bank
    is_default_collection bool ! =false
    status        enum(active|inactive) ! =active
  `},
  journal_entries:{ desc:'Balanced entries; app refuses unbalanced.', cols:`
    fiscal_year_id ulid >fiscal_years:restrict
    entry_no       str(30) !
    entry_date     date !
    memo           str(255)
    source_type    str(40)
    source_id      ulid
    status         enum(draft|posted|reversed) ! =posted
    reversal_of_id ulid >journal_entries:null
    posted_by      ulid >users:null
    is_auto        bool ! =true
  `, unique:[['school_id','entry_no']], index:[['source_type','source_id'],['school_id','entry_date']] },
  journal_lines:{ ts:false, desc:'Debit/credit lines.', cols:`
    entry_id       ulid ! >journal_entries
    account_id     ulid ! >gl_accounts:restrict
    cost_center_id ulid >cost_centers:null
    debit          money ! =0
    credit         money ! =0
    description    str(200)
  `, index:[['account_id']] },
  expense_categories:{ desc:'Expense categories with GL account and approval threshold.', cols:`
    name          str(80) !
    gl_account_id ulid >gl_accounts:null
    requires_approval_above money
  `, unique:[['school_id','name']] },
  vendors:{ desc:'Suppliers/contractors.', cols:`
    name      str(160) !
    phone     str(30)
    email     str(160)
    address   json
    tax_id    str(40)
    bank_details json
    payable_gl_account_id ulid >gl_accounts:null
    status    enum(active|inactive) ! =active
  `},
  expenses:{ desc:'Expense claim/voucher with approval and payment.', cols:`
    expense_no      str(30) !
    category_id     ulid ! >expense_categories:restrict
    vendor_id       ulid >vendors:null
    cost_center_id  ulid >cost_centers:null
    expense_date    date !
    amount          money !
    tax_amount      money ! =0
    paid_from_id    ulid >bank_accounts:null
    payment_method  str(20)
    reference       str(120)
    description     str(255)
    bill_file_id    ulid >files:null
    requested_by    ulid >users:null
    status          enum(pending|approved|rejected|paid) ! =pending
    approval_request_id ulid
    approved_by     ulid >users:null
    paid_at         dt
    journal_entry_id ulid >journal_entries:null
  `, unique:[['school_id','expense_no']] },
  vendor_bills:{ desc:'Accounts payable: bills from vendors (from POs) with due dates and payments.', cols:`
    vendor_id   ulid ! >vendors:restrict
    bill_no     str(60) !
    bill_date   date !
    due_date    date
    subtotal    money !
    tax         money ! =0
    total       money !
    paid_total  money ! =0
    status      enum(open|partially_paid|paid|void) ! =open
    po_id       ulid
    file_id     ulid >files:null
    journal_entry_id ulid >journal_entries:null
  `},
  vendor_payments:{ desc:'Payments to vendors.', cols:`
    vendor_id   ulid ! >vendors:restrict
    bill_id     ulid >vendor_bills:null
    amount      money !
    paid_from_id ulid >bank_accounts:null
    method      str(20)
    reference   str(120)
    paid_at     dt ! =now
    journal_entry_id ulid >journal_entries:null
  `},
  other_incomes:{ desc:'Non-fee income (rent, donations receipts, interest).', cols:`
    gl_account_id  ulid ! >gl_accounts:restrict
    received_in_id ulid >bank_accounts:null
    income_date    date !
    amount         money !
    payer          str(160)
    description    str(255)
    journal_entry_id ulid >journal_entries:null
    created_by     ulid >users:null
  `},
  budgets:{ desc:'Budget per account/cost centre with alert threshold.', cols:`
    fiscal_year_id ulid ! >fiscal_years
    gl_account_id  ulid ! >gl_accounts
    cost_center_id ulid >cost_centers:null
    amount         money !
    alert_at_pct   pct ! =90
    alerted_at     dt
  `, unique:[['fiscal_year_id','gl_account_id','cost_center_id']] },
  bank_statement_lines:{ desc:'Imported statement lines with auto-match.', cols:`
    bank_account_id ulid ! >bank_accounts
    txn_date        date !
    description     str(255)
    reference       str(120)
    debit           money ! =0
    credit          money ! =0
    balance         money
    matched_type    str(20)
    matched_id      ulid
    matched_at      dt
    import_batch    str(40)
  `},
  fixed_assets_ledger:{ desc:'Depreciation schedule per asset (straight-line / reducing).', cols:`
    asset_id        ulid !
    fiscal_year_id  ulid ! >fiscal_years
    method          enum(straight_line|reducing) ! =straight_line
    rate_pct        pct !
    opening_value   money !
    depreciation    money !
    closing_value   money !
    journal_entry_id ulid >journal_entries:null
  `, unique:[['asset_id','fiscal_year_id']] },
  tax_rates:{ desc:'VAT/AIT rates.', cols:`
    name     str(60) !
    rate_pct pct !
    kind     enum(vat|ait|other) ! =vat
    gl_account_id ulid >gl_accounts:null
  `},
  financial_statements:{ ts:false, desc:'Generated statements (income statement, balance sheet, cash flow) per period.', cols:`
    fiscal_year_id ulid ! >fiscal_years
    kind           enum(income_statement|balance_sheet|cash_flow|trial_balance|receivables_ageing) !
    period_start   date !
    period_end     date !
    data           json
    file_id        ulid >files:null
    generated_at   dt ! =now
  `},
}},

{ key:'wallet', group:'Finance', title:'Student wallet & POS · canteen, shop', color:'#0891B2', year:2,
  desc:'Cashless campus: guardian tops up a wallet (bKash/Nagad/counter), student pays by RFID/QR at canteen and school shop; daily spend limits; products, stock, sales, refunds; uniform/book orders.',
  tables:{
  wallets:{ desc:'One wallet per student (or staff).', cols:`
    student_id   ulid u >students
    staff_id     ulid u >staff
    balance      money ! =0
    daily_limit  money
    status       enum(active|frozen|closed) ! =active
  `},
  wallet_transactions:{ ts:false, desc:'Top-ups, spends, refunds; append-only.', cols:`
    wallet_id    ulid ! >wallets
    kind         enum(topup|spend|refund|adjustment|transfer) !
    amount       money !
    balance_after money !
    source_type  str(40)
    source_id    ulid
    payment_id   ulid >payments:null
    description  str(200)
    created_by   ulid >users:null
    created_at   dt ! =now
  `, index:[['wallet_id','created_at']] },
  pos_outlets:{ desc:'Canteen, bookshop, uniform shop.', cols:`
    name      str(80) !
    kind      enum(canteen|bookshop|uniform|stationery|other) !
    campus_id ulid >campuses:null
    income_gl_account_id ulid >gl_accounts:null
    status    enum(active|inactive) ! =active
  `},
  pos_products:{ desc:'Sellable products with price and stock link.', cols:`
    outlet_id   ulid ! >pos_outlets
    name        str(160) !
    sku         str(40)
    price       money !
    tax_rate_id ulid >tax_rates:null
    inventory_item_id ulid
    image_file_id ulid >files:null
    is_active   bool ! =true
    category    str(60)
  `},
  pos_sales:{ desc:'A sale (wallet, cash or gateway).', cols:`
    outlet_id   ulid ! >pos_outlets
    sale_no     str(30) !
    student_id  ulid >students:null
    wallet_id   ulid >wallets:null
    cashier_id  ulid >users:null
    subtotal    money !
    tax         money ! =0
    total       money !
    paid_by     enum(wallet|cash|bkash|card|invoice) !
    payment_id  ulid >payments:null
    status      enum(completed|refunded|void) ! =completed
    journal_entry_id ulid >journal_entries:null
  `, unique:[['school_id','sale_no']] },
  pos_sale_items:{ ts:false, desc:'Lines.', cols:`
    sale_id    ulid ! >pos_sales
    product_id ulid ! >pos_products
    quantity   dec(8,2) ! =1
    unit_price money !
    amount     money !
  `},
  shop_orders:{ desc:'Guardian orders (uniform, books) from the app with delivery/pickup.', cols:`
    order_no    str(30) !
    student_id  ulid ! >students
    outlet_id   ulid ! >pos_outlets
    items       json
    total       money !
    status      enum(placed|paid|ready|delivered|cancelled) ! =placed
    invoice_id  ulid >invoices:null
    notes       str(255)
  `, unique:[['school_id','order_no']] },
}},

{ key:'hr', group:'Finance', title:'HR & payroll', color:'#9F1239', year:1,
  desc:'Recruitment, onboarding checklists, contracts, shifts, salary structures with formula components, loans/advances, payroll runs from attendance & leave (LOP, overtime, tax slabs, PF, gratuity), payslips, bank files, MPO subsidy split, appraisals, training, exit.',
  tables:{
  job_postings:{ desc:'Vacancies published on the website.', cols:`
    title        str(160) !
    department_id ulid >departments:null
    designation_id ulid >designations:null
    description  long
    vacancies    small ! =1
    salary_range str(80)
    closes_at    date
    status       enum(draft|open|closed) ! =draft
  `},
  job_applicants:{ desc:'Applicants with CV and interview pipeline.', cols:`
    posting_id  ulid ! >job_postings
    full_name   str(160) !
    phone       str(20) !
    email       str(160)
    cv_file_id  ulid >files:null
    score       dec(5,2)
    stage       enum(applied|shortlisted|interview|offered|hired|rejected) ! =applied
    interview_at dt
    notes       text
    staff_id    ulid >staff:null
  `},
  onboarding_checklists:{ desc:'Per new staff: tasks like ID card, biometric enrol, bank details.', cols:`
    staff_id   ulid ! >staff
    items      json
    completed_at dt
  `},
  staff_contracts:{ desc:'Contract periods with expiry alerts.', cols:`
    staff_id      ulid ! >staff
    contract_type enum(permanent|contract|part_time|intern|volunteer|mpo) !
    start_date    date !
    end_date      date
    file_id       ulid >files:null
    notes         text
  `},
  work_shifts:{ desc:'Staff work shifts / rosters.', cols:`
    name       str(60) !
    start_time time !
    end_time   time !
    days       json
  `},
  staff_shift_assignments:{ ts:false, desc:'Who is on which shift when.', cols:`
    staff_id   ulid ! >staff
    shift_id   ulid ! >work_shifts
    from_date  date !
    to_date    date
  `},
  salary_components:{ desc:'Earning/deduction/employer components with calculation type and formula.', cols:`
    name           str(80) !
    code           str(20) !
    component_type enum(earning|deduction|employer_contribution) !
    calc_type      enum(fixed|percent_of_basic|percent_of_gross|formula|attendance_based|slab) ! =fixed
    default_value  money
    formula        str(255)
    is_taxable     bool ! =true
    is_statutory   bool ! =false
    gl_account_id  ulid >gl_accounts:null
    sort_order     small ! =0
  `, unique:[['school_id','code']] },
  salary_structures:{ desc:'Per staff with effective range (no overlap, app-enforced).', cols:`
    staff_id       ulid ! >staff
    effective_from date !
    effective_to   date
    basic          money !
    pay_frequency  enum(monthly|weekly) ! =monthly
    mpo_portion    money ! =0        # part paid by government (MPO)
    bank_account   json
    approved_by    ulid >users:null
  `, index:[['staff_id','effective_from']] },
  salary_structure_items:{ ts:false, desc:'Component values.', cols:`
    structure_id ulid ! >salary_structures
    component_id ulid ! >salary_components
    value        money !
  `, unique:[['structure_id','component_id']] },
  tax_slabs:{ desc:'Income tax slabs (NBR) per fiscal year and taxpayer category.', cols:`
    fiscal_year_id ulid ! >fiscal_years
    category       enum(general|female_senior|disabled) ! =general
    slabs          json
  `},
  staff_loans:{ desc:'Loans/advances with monthly deduction.', cols:`
    staff_id          ulid ! >staff
    loan_type         enum(advance|loan|pf_loan) !
    principal         money !
    monthly_deduction money !
    balance           money !
    starts_from       date !
    status            enum(pending|approved|rejected|active|closed) ! =pending
    approved_by       ulid >users:null
    journal_entry_id  ulid >journal_entries:null
  `},
  provident_fund_accounts:{ desc:'PF balance per staff (employee + employer + interest).', cols:`
    staff_id        ulid ! u >staff
    employee_total  money ! =0
    employer_total  money ! =0
    interest_total  money ! =0
    withdrawn_total money ! =0
  `},
  payroll_runs:{ desc:'Monthly run with totals and approval.', cols:`
    period_month     date !
    campus_id        ulid >campuses:null
    status           enum(draft|calculated|approved|paid|locked) ! =draft
    staff_count      int ! =0
    total_gross      money ! =0
    total_deductions money ! =0
    total_net        money ! =0
    total_mpo        money ! =0
    calculated_at    dt
    approved_by      ulid >users:null
    approved_at      dt
    paid_from_id     ulid >bank_accounts:null
    paid_at          dt
    bank_file_id     ulid >files:null
    journal_entry_id ulid >journal_entries:null
    created_by       ulid >users:null
  `, unique:[['school_id','period_month','campus_id']] },
  payslips:{ desc:'Frozen payslip per staff per run.', cols:`
    payroll_run_id   ulid ! >payroll_runs
    staff_id         ulid ! >staff:restrict
    structure_id     ulid >salary_structures:null
    working_days     dec(4,1) !
    present_days     dec(4,1) !
    paid_leave_days  dec(4,1) ! =0
    lop_days         dec(4,1) ! =0
    late_count       small ! =0
    overtime_hours   dec(5,1) ! =0
    gross            money !
    total_deductions money !
    tax              money ! =0
    net_pay          money !
    breakdown        json
    payslip_file_id  ulid >files:null
    paid_at          dt
    payment_ref      str(120)
    status           enum(draft|approved|paid|held) ! =draft
    hold_reason      str(160)
  `, unique:[['payroll_run_id','staff_id']] },
  appraisal_cycles:{ desc:'Cycle with weighted criteria.', cols:`
    academic_year_id ulid ! >academic_years
    name      str(120) !
    criteria  json
    opens_at  date !
    closes_at date !
  `},
  staff_appraisals:{ desc:'Self + reviewer scores, auto metrics.', cols:`
    cycle_id        ulid ! >appraisal_cycles
    staff_id        ulid ! >staff
    reviewer_id     ulid ! >staff:restrict
    self_scores     json
    reviewer_scores json
    auto_metrics    json
    overall_score   dec(5,2)
    comments        text
    status          enum(pending|self_done|reviewed|finalised) ! =pending
    finalised_at    dt
  `, unique:[['cycle_id','staff_id']] },
  staff_trainings:{ desc:'Training records and certificates.', cols:`
    staff_id   ulid ! >staff
    title      str(160) !
    provider   str(160)
    start_date date
    end_date   date
    hours      dec(5,1)
    certificate_file_id ulid >files:null
  `},
  staff_exits:{ desc:'Resignation/termination with clearance and final settlement.', cols:`
    staff_id       ulid ! u >staff
    exit_type      enum(resignation|termination|retirement|end_of_contract|death) !
    notice_date    date
    last_working_day date !
    clearance      json
    settlement     json
    settlement_journal_id ulid >journal_entries:null
    status         enum(initiated|cleared|settled) ! =initiated
  `},
}},

{ key:'scholarships', group:'Finance', title:'Scholarships, donations & fundraising', color:'#4D7C0F', year:2,
  desc:'Scholarship funds and awards (internal, govt stipend, donor-sponsored), donor management, campaigns, pledges and receipts, sponsor-a-student, zakat fund.',
  tables:{
  scholarship_funds:{ desc:'A fund with balance and rules.', cols:`
    name        str(160) !
    kind        enum(internal|government_stipend|donor|zakat|alumni) !
    balance     money ! =0
    gl_account_id ulid >gl_accounts:null
    rules       json
    status      enum(active|closed) ! =active
  `},
  scholarship_awards:{ desc:'Award to a student for a period; links to a discount.', cols:`
    fund_id     ulid ! >scholarship_funds
    student_id  ulid ! >students
    academic_year_id ulid ! >academic_years
    amount      money !
    frequency   enum(monthly|yearly|one_time) ! =yearly
    discount_id ulid >student_discounts:null
    sponsor_donor_id ulid
    status      enum(proposed|approved|active|ended) ! =proposed
    approved_by ulid >users:null
  `},
  donors:{ desc:'Individuals/organisations who give.', cols:`
    name      str(160) !
    kind      enum(individual|organisation|alumni) ! =individual
    phone     str(30)
    email     str(160)
    address   json
    alumni_id ulid
    total_donated money ! =0
    is_anonymous bool ! =false
  `},
  fundraising_campaigns:{ desc:'Campaign with goal and public page.', cols:`
    title       str(200) !
    slug        str(120) !
    goal_amount money !
    raised_amount money ! =0
    starts_at   date
    ends_at     date
    description long
    cover_file_id ulid >files:null
    status      enum(draft|live|closed) ! =draft
  `, unique:[['school_id','slug']] },
  donations:{ desc:'Donation/pledge with receipt and journal.', cols:`
    donor_id     ulid ! >donors
    campaign_id  ulid >fundraising_campaigns:null
    fund_id      ulid >scholarship_funds:null
    amount       money !
    kind         enum(pledge|received) ! =received
    method       str(20)
    reference    str(120)
    received_at  dt
    receipt_doc_id ulid
    journal_entry_id ulid >journal_entries:null
    message      text
  `},
}},
];
