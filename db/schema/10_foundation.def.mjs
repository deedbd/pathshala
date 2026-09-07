// Foundation: tenancy & identity, automation platform, SaaS billing, website CMS
export default [
{ key:'core', group:'Foundation', title:'Core · tenancy, identity, access', color:'#2B5FA8', year:1,
  desc:'Every school is a tenant. Users log in by phone (OTP) or email; roles carry permissions; every change is audited.',
  tables:{
  schools:{ tenant:false, soft:true, desc:'One row per school (tenant). Settings JSON holds feature flags and policies.', cols:`
    code            str(32)   ! u                 # short slug, prefix for numbering
    name            str(160)  !
    name_bn         str(160)
    institution_type enum(school|college|school_college|madrasa|kindergarten|coaching|university) ! =school
    board           str(60)                        # Dhaka | Cambridge | Edexcel | Madrasah | IB
    eiin            str(20)                        # BD Education Institute Identification Number
    mpo_code        str(30)                        # MPO index for govt salary subsidy reporting
    address         json
    phone           str(30)
    email           str(160)
    website         str(160)
    logo_file_id    ulid                           # → files (set after files exist)
    timezone        str(40)   ! ='Asia/Dhaka'
    currency        str(3)    ! ='BDT'
    locale          str(10)   ! ='bn'
    plan_id         ulid      >saas_plans:null
    status          enum(trial|active|suspended|closed) ! =trial
    trial_ends_at   dt
    settings        json                           # policies, feature flags (see docs)
    theme           json                           # brand colours, fonts, login background
    custom_domain   str(160)  u                    # white-label domain (CMS + portals)
    onboarded_at    dt
  `},
  campuses:{ desc:'Branches of one school; users can be scoped to a campus.', cols:`
    name      str(120) !
    code      str(20)  !
    address   json
    phone     str(30)
    is_main   bool     ! =false
    status    enum(active|inactive) ! =active
  `, unique:[['school_id','code']] },
  users:{ soft:true, desc:'Login identity for admins, staff, students and guardians. Phone is the primary login in Bangladesh.', cols:`
    user_type     enum(admin|staff|student|guardian|alumni|vendor|api) !
    username      str(60)
    email         str(160)
    phone         str(20)
    password_hash str(255)
    display_name  str(160) !
    avatar_file_id ulid
    locale        str(10)
    is_active     bool ! =true
    email_verified_at dt
    phone_verified_at dt
    two_factor_secret str(255)          # TOTP secret (own implementation, pure JS)
    two_factor_enabled bool ! =false
    session_epoch int ! =1              # bump to invalidate every session of this user
    last_login_at dt
    failed_logins small ! =0
    locked_until  dt
    preferences   json          # theme, language, notification prefs
  `, unique:[['school_id','email'],['school_id','phone'],['school_id','username']] },
  roles:{ desc:'Named permission sets (Principal, Accountant, Teacher…). System roles are seeded and protected.', cols:`
    name        str(80) !
    slug        str(60) !
    description text
    is_system   bool ! =false
    level       small ! =0     # hierarchy used by approval routing
  `, unique:[['school_id','slug']] },
  permissions:{ tenant:false, ts:false, desc:'Global catalogue: module.resource.action (fees.invoice.create).', cols:`
    key_name    str(120) ! u
    module      str(40)  !
    description str(255)
  `},
  role_permissions:{ tenant:false, ts:false, desc:'Role ↔ permission.', cols:`
    role_id        ulid ! >roles
    permission_id  ulid ! >permissions
  `, unique:[['role_id','permission_id']] },
  user_roles:{ tenant:false, ts:false, desc:'User ↔ role, optionally limited to a campus.', cols:`
    user_id   ulid ! >users
    role_id   ulid ! >roles
    campus_id ulid >campuses:null
  `, unique:[['user_id','role_id','campus_id']] },
  school_groups:{ tenant:false, desc:'A trust or owner running several schools in one installation. Consolidated dashboards and inter-school transfers are read through the group, never school-to-school.', cols:`
    name           str(160) !
    name_bn        str(160)
    owner_user_id  ulid >users:null       # the trust's own login, if it has one
    base_currency  str(3) ! ='BDT'        # what a consolidated total is expressed in
    status         enum(active|closed) ! =active
    settings       json
  `},
  school_group_members:{ desc:'Which schools belong to a group. is_head marks the one whose console may read the others — membership alone never grants cross-school reach.', cols:`
    group_id   ulid ! >school_groups
    is_head    bool ! =false
    joined_on  date
  `, unique:[['group_id','school_id']] },
  currency_rates:{ tenant:false, desc:'Rate used to add money from schools that do not share a currency. Installation-wide: no row means no consolidated total, never a silent sum.', cols:`
    base_ccy   str(3) !                   # the currency being converted from
    quote_ccy  str(3) !                   # the currency being converted to
    rate       dec(18,8) !                # 1 base = <rate> quote
    as_of      date !
    source     str(60)                    # who said so (Bangladesh Bank, a manual entry, a feed)
  `, unique:[['base_ccy','quote_ccy','as_of']] },
  auth_sessions:{ tenant:false, desc:'Server sessions per device. Valid only while session.epoch == users.session_epoch.', cols:`
    user_id     ulid ! >users
    token_hash  str(128) ! u
    epoch       int ! =1
    device_name str(120)
    device_id   str(120)
    platform    enum(web|android|ios|pwa|api)
    ip          str(45)
    user_agent  str(255)
    expires_at  dt !
    revoked_at  dt
    last_seen_at dt
  `},
  push_subscriptions:{ tenant:false, desc:'Web Push (VAPID) subscriptions per user/device; FCM/APNs tokens for native apps later.', cols:`
    user_id     ulid ! >users
    kind        enum(webpush|fcm|apns) ! =webpush
    endpoint    str(500) !
    p256dh      str(255)
    auth_key    str(255)
    token       str(255)                # FCM/APNs token when kind != webpush
    user_agent  str(255)
    last_used_at dt
    failed_count small ! =0
    revoked_at  dt
  `, unique:[['user_id','endpoint']] },
  otp_codes:{ desc:'One-time codes for login, verification, password reset, invites.', cols:`
    user_id     ulid >users
    target      str(160) !
    channel     enum(sms|email|whatsapp) !
    purpose     enum(login|verify|reset|invite|consent) !
    code_hash   str(128) !
    attempts    small ! =0
    expires_at  dt !
    consumed_at dt
  `},
  files:{ desc:'Stored file metadata. Bytes live on local disk (shared hosting) or S3 when configured.', cols:`
    uploaded_by  ulid >users:null
    disk         str(20) ! =local
    path         str(500) !
    file_name    str(255) !
    mime_type    str(120) !
    size_bytes   big !
    checksum     str(64)
    visibility   enum(private|school|public) ! =private
    entity_type  str(60)  i          # polymorphic owner
    entity_id    ulid     i
    purpose      str(60)             # photo | document | receipt | report_card
    width        int
    height       int
  `},
  settings:{ desc:'Typed key/value policies per school (attendance.auto_absent_at, fees.reminder_stages…).', cols:`
    key_name   str(120) !
    value      json
    updated_by ulid >users:null
  `, unique:[['school_id','key_name']] },
  custom_fields:{ desc:'School-defined extra fields on any entity (student, staff, application…).', cols:`
    entity_type str(60) !
    field_key   str(60) !
    label       str(120) !
    label_bn    str(120)
    field_type  enum(text|number|date|select|multiselect|bool|file|phone) !
    options     json
    is_required bool ! =false
    sort_order  small ! =0
    show_in_list bool ! =false
  `, unique:[['school_id','entity_type','field_key']] },
  custom_field_values:{ ts:false, desc:'Values for custom fields.', cols:`
    field_id    ulid ! >custom_fields
    entity_id   ulid ! i
    value       json
  `, unique:[['field_id','entity_id']] },
  audit_logs:{ ts:false, desc:'Append-only change log written by middleware for every mutation.', cols:`
    actor_user_id ulid
    actor_type    enum(user|system|automation|api) ! =user
    action        str(40) !
    entity_type   str(60) !
    entity_id     ulid
    before_data   json
    after_data    json
    ip            str(45)
    user_agent    str(255)
    request_id    str(64)
    created_at    dt ! =now
  `, index:[['school_id','entity_type','entity_id'],['school_id','created_at']] },
  number_sequences:{ ts:false, desc:'Per-school counters for admission no, invoice no, receipt no…', cols:`
    key_name     str(40) !
    prefix       str(20) ! =''
    next_value   big ! =1
    padding      small ! =6
    reset_yearly bool ! =false
    year_tag     str(10)
  `, unique:[['school_id','key_name']] },
  translations:{ desc:'Override UI strings per school and language (bn/en/ar).', cols:`
    locale   str(10) !
    key_name str(160) !
    value    text !
  `, unique:[['school_id','locale','key_name']] },
  feature_flags:{ tenant:false, desc:'Platform-level flags with per-plan / per-school targeting.', cols:`
    key_name   str(80) ! u
    description str(255)
    default_on bool ! =false
    targeting  json      # {"plans":[],"schools":[],"percent":0}
  `},
  installer_state:{ tenant:false, ts:false, desc:'Zero-touch installer progress (cPanel): DB detected, migrations, seeds, cron mode, health.', cols:`
    step        str(60) ! u
    status      enum(pending|done|failed|skipped) ! =pending
    detail      json
    finished_at dt
  `},
  system_health:{ tenant:false, ts:false, desc:'Self-check results (cron heartbeat, queue lag, disk, mail, SMS balance).', cols:`
    check_key  str(60) ! u
    status     enum(ok|warn|fail) ! =ok
    detail     json
    checked_at dt ! =now
  `},
}},

{ key:'platform', group:'Foundation', title:'Automation platform · events, rules, jobs, approvals, workflows', color:'#147D6F', year:1,
  desc:'The engine behind "every section automated": transactional outbox, editable rules, scheduler (real cron or request-driven heartbeat on shared hosting), approvals, tasks, webhooks, report builder.',
  tables:{
  outbox_events:{ ts:false, desc:'Domain events written in the same transaction as the change. Relay publishes to the job queue.', cols:`
    event_uid      str(36) ! u
    event_type     str(80) ! i        # student.enrolled, payment.received…
    aggregate_type str(60) !
    aggregate_id   ulid !
    payload        json
    actor_user_id  ulid
    occurred_at    dt ! =now
    published_at   dt i
    version        small ! =1
  `, index:[['aggregate_type','aggregate_id']] },
  event_consumptions:{ tenant:false, ts:false, desc:'Idempotency: consumer × event processed once; failures count their attempts on one row.', cols:`
    consumer     str(80) !
    event_uid    str(36) !
    attempts     small ! =1
    processed_at dt ! =now
  `, unique:[['consumer','event_uid']] },
  automation_rules:{ desc:'WHEN trigger IF conditions (JSONLogic) THEN actions. Seeded system defaults are editable, not deletable.', cols:`
    code          str(20) !
    name          str(160) !
    module        str(40) !
    description   text
    trigger_kind  enum(event|schedule|threshold|manual) !
    event_type    str(80) i
    cron_expr     str(60)
    conditions    json
    actions       json
    is_system     bool ! =false
    is_active     bool ! =true
    preview_until dt                  # dry-run window after edits
    priority      small ! =100
    cooldown_minutes int
    run_count     big ! =0
    last_run_at   dt
    created_by    ulid >users:null
  `, unique:[['school_id','code']] },
  automation_runs:{ ts:false, desc:'One row per rule execution with result/error.', cols:`
    rule_id        ulid ! >automation_rules
    trigger_event_uid str(36)
    aggregate_type str(60)
    aggregate_id   ulid
    started_at     dt ! =now
    finished_at    dt
    status         enum(running|success|failed|skipped|preview) ! =running
    actions_result json
    error          text
  `, index:[['rule_id','started_at']] },
  scheduled_jobs:{ desc:'Cron catalogue. On cPanel runs via one cron line or the request-driven heartbeat (web cron) with a lock.', cols:`
    job_key      str(80) !
    cron_expr    str(60) !
    timezone     str(40) ! ='Asia/Dhaka'
    payload      json
    is_active    bool ! =true
    next_run_at  dt i
    last_run_at  dt
    last_status  enum(success|failed|running)
    last_duration_ms int
    locked_until dt
  `, unique:[['school_id','job_key']] },
  background_jobs:{ desc:'Durable job queue (database driver on shared hosting). Long jobs run in chunks under 30 s each and resume from cursor.', cols:`
    queue        str(40) !
    job_name     str(120) !
    payload      json
    status       enum(pending|running|success|failed|cancelled|paused) ! =pending
    attempts     small ! =0
    max_attempts small ! =5
    scheduled_for dt ! =now
    started_at   dt
    finished_at  dt
    progress_pct pct ! =0
    cursor       json                   # resume point for chunked work (last row id, page, sheet row)
    total_items  int
    done_items   int ! =0
    locked_until dt
    result       json
    error        text
    triggered_by str(80)
  `, index:[['school_id','status','scheduled_for']] },
  approval_workflows:{ desc:'Multi-step approvals: which entity, which conditions pick this workflow, ordered approver steps.', cols:`
    entity_type  str(60) !
    name         str(120) !
    conditions   json
    steps        json         # [{order:1, approver:{role:'hod'}}, {order:2, approver:{role:'principal'}}]
    auto_approve_after_hours int
    escalate_after_hours int
    is_active    bool ! =true
  `, unique:[['school_id','entity_type','name']] },
  approval_requests:{ desc:'A pending/decided approval for one entity.', cols:`
    workflow_id  ulid ! >approval_workflows:restrict
    entity_type  str(60) !
    entity_id    ulid !
    requested_by ulid >users:null
    current_step small ! =1
    status       enum(pending|approved|rejected|cancelled|escalated) ! =pending
    summary      json
    due_at       dt
  `, unique:[['entity_type','entity_id']], index:[['school_id','status']] },
  approval_actions:{ ts:false, desc:'Decision per step.', cols:`
    request_id ulid ! >approval_requests
    step       small !
    actor_id   ulid >users:null
    decision   enum(approved|rejected|delegated|auto_approved|escalated) !
    comment    text
    acted_at   dt ! =now
  `},
  tasks:{ desc:'To-dos created by rules or people (call guardian, verify document, review lag).', cols:`
    title        str(200) !
    description  text
    task_type    str(40)
    assigned_to  ulid >users:null
    assigned_role str(60)
    entity_type  str(60)
    entity_id    ulid
    due_at       dt
    priority     enum(low|normal|high|urgent) ! =normal
    status       enum(open|in_progress|done|cancelled) ! =open
    created_by   str(80) ! =system
    completed_at dt
  `, index:[['assigned_to','status']] },
  form_definitions:{ desc:'No-code form builder (surveys, admission forms, feedback, custom registers).', cols:`
    name        str(160) !
    slug        str(80) !
    purpose     enum(survey|admission|feedback|register|poll|consent|other) ! =other
    schema_json json
    audience    json
    is_public   bool ! =false
    opens_at    dt
    closes_at   dt
    status      enum(draft|open|closed) ! =draft
    created_by  ulid >users:null
  `, unique:[['school_id','slug']] },
  form_submissions:{ desc:'Answers to a form.', cols:`
    form_id     ulid ! >form_definitions
    submitted_by ulid >users:null
    entity_type str(60)
    entity_id   ulid
    answers     json
    ip          str(45)
  `},
  workflow_definitions:{ desc:'No-code workflow builder: states and transitions for custom processes.', cols:`
    name        str(160) !
    entity_type str(60) !
    states      json
    transitions json
    is_active   bool ! =true
  `},
  webhooks:{ desc:'Outbound webhooks to school ERPs / Zapier.', cols:`
    url         str(500) !
    secret      str(128) !
    event_types json
    is_active   bool ! =true
    failure_count int ! =0
  `},
  webhook_deliveries:{ ts:false, desc:'Delivery attempts.', cols:`
    webhook_id    ulid ! >webhooks
    event_uid     str(36) !
    attempt       small ! =1
    response_code small
    response_body text
    delivered_at  dt
    next_retry_at dt
    created_at    dt ! =now
  `},
  integrations:{ desc:'Connected providers (Zoom, Google, ZKTeco cloud, GPS vendor, gateways) with encrypted config.', cols:`
    provider     str(60) !
    category     enum(meeting|sso|device|gps|payment|sms|email|storage|ai|accounting|other) !
    config       json
    status       enum(connected|failed|disconnected) ! =connected
    last_sync_at dt
    last_error   text
  `, unique:[['school_id','provider']] },
  api_keys:{ desc:'Keys for third-party apps and integrations.', cols:`
    name        str(120) !
    key_prefix  str(12) !
    key_hash    str(128) ! u
    scopes      json
    rate_limit_per_min int ! =120
    expires_at  dt
    last_used_at dt
    created_by  ulid >users:null
    revoked_at  dt
  `},
  report_definitions:{ desc:'Report builder: saved queries/pivots with schedule and recipients.', cols:`
    name        str(160) !
    module      str(40) !
    definition  json
    output_format enum(pdf|xlsx|csv|html) ! =pdf
    cron_expr   str(60)
    recipients  json
    is_system   bool ! =false
    created_by  ulid >users:null
  `},
  report_snapshots:{ ts:false, desc:'Generated report files.', cols:`
    definition_id ulid ! >report_definitions
    params        json
    file_id       ulid >files:null
    row_count     int
    generated_at  dt ! =now
  `},
  kpi_daily:{ ts:false, desc:'Daily KPI snapshot per school for dashboards and anomaly alerts.', cols:`
    day               date !
    students_active   int
    attendance_pct    pct
    staff_attendance_pct pct
    fees_collected    money
    fees_outstanding  money
    new_enquiries     int
    new_admissions    int
    sms_sent          int
    extra             json
  `, unique:[['school_id','day']] },
  import_jobs:{ desc:'Bulk Excel/CSV imports with mapping, validation and error file.', cols:`
    entity_type  str(60) !
    file_id      ulid ! >files
    mapping      json
    total_rows   int
    success_rows int
    error_rows   int
    errors_file_id ulid >files:null
    status       enum(pending|validating|running|success|failed) ! =pending
    created_by   ulid >users:null
    finished_at  dt
  `},
  backups:{ desc:'Automated backups (DB dump + files) to local, Google Drive, Dropbox or S3.', cols:`
    kind        enum(database|files|full) !
    target      enum(local|gdrive|dropbox|s3) ! =local
    file_path   str(500)
    size_bytes  big
    status      enum(running|success|failed) ! =running
    started_at  dt ! =now
    finished_at dt
    error       text
  `},
  notifications_queue_stats:{ ts:false, desc:'Hourly rollup of notification volume and cost (for the health page).', cols:`
    hour       dt !
    channel    str(20) !
    sent       int ! =0
    delivered  int ! =0
    failed     int ! =0
    cost       money ! =0
  `, unique:[['school_id','hour','channel']] },
}},

{ key:'saas', group:'Foundation', title:'SaaS billing & partners', color:'#6B4FBB', year:2,
  desc:'Sell the platform to many schools: plans, subscriptions, invoices to schools, resellers, white-label.',
  tables:{
  saas_plans:{ tenant:false, desc:'Pricing plans with limits and enabled modules.', cols:`
    name          str(80) ! u
    price_monthly money ! =0
    price_yearly  money ! =0
    currency      str(3) ! ='BDT'
    student_limit int
    sms_included  int ! =0
    storage_gb    int ! =5
    modules       json
    is_public     bool ! =true
    sort_order    small ! =0
  `},
  saas_subscriptions:{ desc:'A school’s subscription to a plan.', cols:`
    plan_id       ulid ! >saas_plans:restrict
    billing_cycle enum(monthly|yearly) ! =yearly
    starts_at     date !
    ends_at       date
    status        enum(trial|active|past_due|cancelled|expired) ! =trial
    auto_renew    bool ! =true
    price         money !
    discount_pct  pct ! =0
    reseller_id   ulid >saas_partners:null
  `},
  saas_invoices:{ desc:'Invoices from the platform to the school.', cols:`
    subscription_id ulid >saas_subscriptions:null
    invoice_no    str(30) ! u
    period_start  date !
    period_end    date !
    amount        money !
    tax           money ! =0
    total         money !
    status        enum(draft|issued|paid|overdue|void) ! =issued
    due_date      date !
    paid_at       dt
    payment_ref   str(120)
    pdf_file_id   ulid >files:null
  `},
  saas_usage:{ ts:false, desc:'Metered usage per month (students, SMS, storage, API calls).', cols:`
    month       date !
    metric      str(40) !
    quantity    big ! =0
  `, unique:[['school_id','month','metric']] },
  saas_partners:{ tenant:false, desc:'Resellers / referral partners earning commission.', cols:`
    name          str(160) !
    contact       json
    commission_pct pct ! =0
    referral_code str(30) ! u
    status        enum(active|inactive) ! =active
  `},
  saas_partner_payouts:{ tenant:false, desc:'Commission payouts.', cols:`
    partner_id ulid ! >saas_partners
    period     date !
    amount     money !
    status     enum(pending|paid) ! =pending
    paid_at    dt
  `},
  saas_support_tickets:{ desc:'Schools’ support requests to the platform team.', cols:`
    subject     str(200) !
    body        text
    priority    enum(low|normal|high|urgent) ! =normal
    status      enum(open|answered|closed) ! =open
    opened_by   ulid >users:null
    assigned_to str(120)
    closed_at   dt
  `},
}},

{ key:'cms', group:'Foundation', title:'Website & CMS', color:'#B8741A', year:1,
  desc:'Every school gets a public website on its own domain: pages, news, gallery, notices, online admission form, results lookup, verification page.',
  tables:{
  cms_pages:{ soft:true, desc:'Public pages built from blocks.', cols:`
    title       str(200) !
    slug        str(120) !
    locale      str(10) ! ='bn'
    blocks      json
    seo         json
    is_home     bool ! =false
    status      enum(draft|published) ! =draft
    published_at dt
    author_id   ulid >users:null
  `, unique:[['school_id','slug','locale']] },
  cms_posts:{ soft:true, desc:'News, blog, achievements.', cols:`
    title       str(200) !
    slug        str(120) !
    category    str(60)
    excerpt     text
    body        long
    cover_file_id ulid >files:null
    status      enum(draft|published) ! =draft
    published_at dt
    author_id   ulid >users:null
  `, unique:[['school_id','slug']] },
  cms_menus:{ desc:'Navigation menus.', cols:`
    name   str(60) !
    items  json
  `, unique:[['school_id','name']] },
  cms_galleries:{ desc:'Photo/video albums.', cols:`
    title       str(200) !
    description text
    cover_file_id ulid >files:null
    is_public   bool ! =true
  `},
  cms_gallery_items:{ ts:false, desc:'Album items.', cols:`
    gallery_id ulid ! >cms_galleries
    file_id    ulid >files:null
    video_url  str(500)
    caption    str(255)
    sort_order small ! =0
  `},
  cms_themes:{ tenant:false, desc:'Website themes.', cols:`
    name     str(80) ! u
    preview_file_id ulid
    tokens   json
    is_default bool ! =false
  `},
  cms_domains:{ desc:'Custom domains and SSL status for a school site.', cols:`
    domain      str(160) ! u
    is_primary  bool ! =false
    ssl_status  enum(pending|active|failed) ! =pending
    verified_at dt
  `},
  cms_contact_messages:{ desc:'Messages from the website contact form.', cols:`
    name     str(160) !
    phone    str(30)
    email    str(160)
    message  text !
    status   enum(new|read|replied) ! =new
  `},
}},
];
