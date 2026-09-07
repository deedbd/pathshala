// Engagement & governance: communication, welfare, documents, alumni & career, events, governance, compliance, analytics, AI, marketplace
export default [
{ key:'communication', group:'Engagement', title:'Communication · SMS, push, email, WhatsApp, chat', color:'#1D4ED8', year:1,
  desc:'Providers per channel with balance and fallback, event-keyed templates in bn/en/ar, notification log with delivery and cost, preferences and quiet hours, notices, chat and section channels, PTM booking, surveys/polls, newsletters, IVR/voice broadcast.',
  tables:{
  messaging_providers:{ desc:'SMS/email/push/WhatsApp/voice providers.', cols:`
    channel     enum(sms|email|push|whatsapp|voice) !
    provider    str(60) !
    credentials json
    sender_id   str(80)
    is_default  bool ! =false
    balance     money
    low_balance_threshold money
    is_active   bool ! =true
    cost_per_unit money
  `},
  notification_templates:{ desc:'Per event × channel × locale with placeholders.', cols:`
    event_key  str(80) !
    channel    enum(sms|email|push|whatsapp|in_app|voice) !
    locale     str(10) ! ='bn'
    subject    str(200)
    body       text !
    variables  json
    is_active  bool ! =true
  `, unique:[['school_id','event_key','channel','locale']] },
  notifications:{ desc:'Every message sent with status, provider id, cost, read time.', cols:`
    recipient_user_id ulid >users
    recipient_address str(160)
    channel          enum(sms|email|push|whatsapp|in_app|voice) !
    event_key        str(80)
    template_id      ulid >notification_templates:null
    title            str(200)
    body             text !
    data             json
    entity_type      str(60)
    entity_id        ulid
    status           enum(queued|sent|delivered|failed|read) ! =queued
    provider_id      ulid >messaging_providers:null
    provider_msg_id  str(120)
    cost             dec(10,4)
    attempts         small ! =0
    error            str(255)
    scheduled_for    dt ! =now
    sent_at          dt
    delivered_at     dt
    read_at          dt
  `, index:[['status','scheduled_for'],['recipient_user_id','created_at'],['entity_type','entity_id']] },
  notification_preferences:{ ts:false, desc:'Per user per event per channel.', cols:`
    user_id   ulid ! >users
    event_key str(80) !
    channel   enum(sms|email|push|whatsapp|in_app|voice) !
    enabled   bool ! =true
  `, unique:[['user_id','event_key','channel']] },
  notices:{ soft:true, desc:'Notices with audience, schedule, pin, attachments.', cols:`
    title        str(200) !
    body         long !
    notice_type  enum(general|academic|exam|fee|holiday|urgent|event) ! =general
    audience     json
    attachments  json
    publish_at   dt ! =now
    expires_at   dt
    is_pinned    bool ! =false
    send_push    bool ! =true
    send_sms     bool ! =false
    send_email   bool ! =false
    status       enum(draft|scheduled|published|archived) ! =published
    created_by   ulid >users:null
  `, index:[['school_id','publish_at']] },
  notice_reads:{ ts:false, desc:'Read receipts.', cols:`
    notice_id ulid ! >notices
    user_id   ulid ! >users
    read_at   dt ! =now
  `, unique:[['notice_id','user_id']] },
  conversations:{ desc:'Direct chats, groups, section channels, broadcast lists.', cols:`
    kind        enum(direct|group|section_channel|broadcast|support) ! =direct
    subject     str(160)
    section_id  ulid >sections:null
    created_by  ulid >users:null
    last_message_at dt
    is_locked   bool ! =false
  `},
  conversation_participants:{ ts:false, desc:'Members with role, mute and read pointer.', cols:`
    conversation_id ulid ! >conversations
    user_id         ulid ! >users
    role            enum(member|admin) ! =member
    muted           bool ! =false
    last_read_at    dt
  `, unique:[['conversation_id','user_id']] },
  messages:{ ts:false, desc:'Chat messages with attachments; moderated.', cols:`
    conversation_id ulid ! >conversations
    sender_id       ulid >users:null
    body            text
    attachments     json
    reply_to_id     ulid >messages:null
    sent_at         dt ! =now
    edited_at       dt
    deleted_at      dt
    flagged         bool ! =false
  `, index:[['conversation_id','sent_at']] },
  ptm_slots:{ desc:'Parent–teacher meeting slots.', cols:`
    event_id   ulid
    teacher_id ulid ! >staff
    starts_at  dt !
    ends_at    dt !
    capacity   small ! =1
    room_id    ulid >rooms:null
    mode       enum(in_person|online) ! =in_person
    join_url   str(500)
  `, index:[['teacher_id','starts_at']] },
  ptm_bookings:{ desc:'Bookings with reminders and outcome notes.', cols:`
    slot_id     ulid ! >ptm_slots
    student_id  ulid ! >students
    guardian_id ulid ! >guardians
    status      enum(booked|attended|no_show|cancelled) ! =booked
    notes       text
    reminder_sent_at dt
  `, unique:[['slot_id','student_id']] },
  surveys:{ desc:'Surveys/polls to guardians, students, staff (uses form builder).', cols:`
    form_id     ulid ! >form_definitions
    title       str(200) !
    audience    json
    is_anonymous bool ! =false
    opens_at    dt
    closes_at   dt
    status      enum(draft|open|closed) ! =draft
    results     json
  `},
  newsletters:{ desc:'Email/WhatsApp newsletters and campaigns.', cols:`
    title       str(200) !
    body        long
    audience    json
    channel     enum(email|whatsapp|sms) ! =email
    scheduled_for dt
    sent_at     dt
    stats       json
    status      enum(draft|scheduled|sent) ! =draft
  `},
  voice_broadcasts:{ desc:'IVR / recorded voice calls (emergency, fee reminder).', cols:`
    title       str(200) !
    audio_file_id ulid >files:null
    tts_text    text
    audience    json
    scheduled_for dt
    stats       json
    status      enum(draft|scheduled|running|done) ! =draft
  `},
}},

{ key:'welfare', group:'Engagement', title:'Welfare · behaviour, health, counselling, safeguarding', color:'#BE123C', year:1,
  desc:'Signed behaviour points with threshold rules and disciplinary actions, growth/health records, vaccinations, clinic visits with stock link, counselling with encrypted notes, insurance, safeguarding incidents, special-needs plans.',
  tables:{
  behaviour_categories:{ desc:'Positive/negative categories with default points and severity.', cols:`
    name           str(120) !
    polarity       enum(positive|negative) !
    default_points small ! =1
    severity       enum(low|medium|high|critical) ! =low
    notify_guardian bool ! =true
  `, unique:[['school_id','name']] },
  behaviour_incidents:{ desc:'An incident with points and reporter.', cols:`
    student_id    ulid ! >students
    category_id   ulid ! >behaviour_categories:restrict
    incident_date date !
    points        small !
    description   text !
    reported_by   ulid ! >staff:restrict
    witnesses     str(255)
    attachments   json
    guardian_notified_at dt
    status        enum(open|under_review|actioned|closed) ! =open
  `, index:[['student_id','incident_date']] },
  disciplinary_actions:{ desc:'Warning, detention, suspension… with approval and guardian acknowledgement.', cols:`
    incident_id  ulid >behaviour_incidents:null
    student_id   ulid ! >students
    action_type  enum(verbal_warning|written_warning|detention|suspension|expulsion|counselling|community_service) !
    from_date    date
    to_date      date
    description  text
    is_auto_proposed bool ! =false
    status       enum(pending|approved|rejected|completed) ! =pending
    approved_by  ulid >users:null
    guardian_acknowledged_at dt
  `},
  behaviour_rules:{ desc:'Threshold rules → proposed action.', cols:`
    name             str(120) !
    window_days      small ! =30
    threshold_points small !
    action_type      str(40) !
    notify_roles     json
    is_active        bool ! =true
  `},
  health_records:{ desc:'Growth and screening records.', cols:`
    student_id   ulid ! >students
    recorded_on  date !
    height_cm    dec(5,1)
    weight_kg    dec(5,1)
    bmi          dec(4,1)
    vision_left  str(10)
    vision_right str(10)
    hearing      str(20)
    dental       str(40)
    blood_pressure str(15)
    allergies    json
    chronic_conditions json
    medications  text
    doctor_notes text
    recorded_by  ulid >staff:null
  `},
  vaccinations:{ desc:'Doses and next due.', cols:`
    student_id  ulid ! >students
    vaccine     str(80) !
    dose_no     small ! =1
    given_on    date
    next_due_on date
    certificate_file_id ulid >files:null
  `, unique:[['student_id','vaccine','dose_no']] },
  clinic_visits:{ desc:'School clinic visit with treatment, medicines (stock-out) and send-home flag.', cols:`
    person_type  enum(student|staff) !
    student_id   ulid >students
    staff_id     ulid >staff
    visited_at   dt ! =now
    complaint    str(255) !
    treatment    text
    medicines_given json
    referred_to  str(160)
    sent_home    bool ! =false
    guardian_notified_at dt
    attended_by  ulid >staff:null
  `},
  counselling_sessions:{ desc:'Sessions with encrypted notes (counsellor-only).', cols:`
    student_id     ulid ! >students
    counsellor_id  ulid ! >staff:restrict
    session_at     dt !
    referral_source enum(self|teacher|behaviour_rule|result_drop|guardian|clinic) ! =self
    notes_encrypted text
    follow_up_at   dt
    status         enum(scheduled|done|no_show|cancelled) ! =scheduled
  `},
  insurance_policies:{ desc:'Student/staff insurance and claims.', cols:`
    person_type  enum(student|staff) !
    student_id   ulid >students
    staff_id     ulid >staff
    provider     str(120) !
    policy_no    str(60) !
    coverage     money
    valid_from   date
    valid_to     date
    claims       json
  `},
  safeguarding_cases:{ desc:'Confidential child-protection cases with restricted access.', cols:`
    student_id    ulid ! >students
    reported_by   ulid >users:null
    category      enum(abuse|neglect|bullying|online_safety|self_harm|other) !
    details_encrypted text
    risk_level    enum(low|medium|high) ! =medium
    status        enum(open|monitoring|closed) ! =open
    case_owner_id ulid >staff:null
    closed_at     dt
  `},
  special_needs_plans:{ desc:'IEP / accommodation plans.', cols:`
    student_id   ulid ! >students
    diagnosis    str(200)
    accommodations json
    goals        json
    review_date  date
    coordinator_id ulid >staff:null
    file_id      ulid >files:null
    status       enum(active|closed) ! =active
  `},
}},

{ key:'documents', group:'Engagement', title:'Documents, certificates & ID cards', color:'#0F172A', year:1,
  desc:'HTML templates rendered to PDF, document requests with automatic eligibility (dues, library, hostel, discipline), issued documents with QR verification and e-signature, ID cards (student/staff/guardian) with RFID, bulk print jobs.',
  tables:{
  document_templates:{ desc:'Versioned templates per document type.', cols:`
    doc_type      enum(tc|testimonial|character|bonafide|id_card|admit_card|report_card|payslip|receipt|donation_receipt|invoice|offer_letter|appointment_letter|experience_letter|certificate|marksheet|custom) !
    name          str(120) !
    html_template long !
    css           text
    page_size     str(20) ! =A4
    orientation   enum(portrait|landscape) ! =portrait
    variables     json
    is_default    bool ! =false
    version       small ! =1
  `, unique:[['school_id','doc_type','name']] },
  document_requests:{ desc:'Request with eligibility snapshot and fee.', cols:`
    doc_type      str(40) !
    person_type   enum(student|staff|alumni) !
    student_id    ulid >students
    staff_id      ulid >staff
    requested_by  ulid >users:null
    reason        str(255)
    fee_invoice_id ulid >invoices:null
    eligibility   json
    status        enum(requested|blocked|approved|issued|rejected) ! =requested
    approval_request_id ulid
    decided_by    ulid >users:null
    decided_at    dt
  `},
  issued_documents:{ desc:'Issued document with frozen data, file and verification code.', cols:`
    template_id      ulid >document_templates:null
    request_id       ulid >document_requests:null
    doc_type         str(40) !
    document_no      str(40) !
    person_type      enum(student|staff|alumni|other) !
    student_id       ulid >students:null
    staff_id         ulid >staff:null
    data_snapshot    json
    file_id          ulid >files:null
    verification_code str(32) ! u
    signed_by        ulid >users:null
    signature_hash   str(128)
    issued_at        dt ! =now
    valid_until      date
    revoked_at       dt
    revoke_reason    str(160)
  `, unique:[['school_id','document_no']], index:[['student_id','doc_type']] },
  id_cards:{ desc:'Cards with validity, RFID and print status.', cols:`
    person_type  enum(student|staff|guardian|visitor) !
    student_id   ulid >students
    staff_id     ulid >staff
    guardian_id  ulid >guardians
    card_no      str(30) !
    template_id  ulid >document_templates:null
    valid_from   date !
    valid_to     date !
    rfid_tag     str(40)
    file_id      ulid >files:null
    status       enum(pending_print|active|lost|expired|cancelled) ! =pending_print
    printed_at   dt
  `, unique:[['school_id','card_no']] },
  print_jobs:{ desc:'Bulk print batches (ID cards, admit cards, report cards).', cols:`
    kind        str(40) !
    items       json
    file_id     ulid >files:null
    status      enum(queued|rendering|ready|printed) ! =queued
    created_by  ulid >users:null
  `},
  document_verifications:{ ts:false, desc:'Public verification hits (who checked what).', cols:`
    document_id ulid ! >issued_documents
    verified_at dt ! =now
    ip          str(45)
    user_agent  str(255)
  `},
}},

{ key:'alumni', group:'Engagement', title:'Alumni & career', color:'#5B21B6', year:2,
  desc:'Alumni directory (auto-populated at graduation), profiles, batches, mentorship, job board, reunions, giving link.',
  tables:{
  alumni:{ desc:'Alumni profile.', cols:`
    student_id      ulid u >students:null
    user_id         ulid u >users:null
    full_name       str(160) !
    graduation_year small !
    last_class_id   ulid >classes:null
    phone           str(20)
    email           str(160)
    current_organisation str(160)
    current_position str(120)
    city            str(80)
    country         str(60)
    linkedin_url    str(255)
    bio             text
    photo_file_id   ulid >files:null
    is_public       bool ! =false
    is_mentor       bool ! =false
    status          enum(active|inactive) ! =active
  `, index:[['school_id','graduation_year']] },
  alumni_batches:{ desc:'Batch groups with reps.', cols:`
    graduation_year small !
    name        str(80)
    rep_alumni_id ulid >alumni:null
  `, unique:[['school_id','graduation_year']] },
  mentorship_pairs:{ desc:'Alumni mentor ↔ student.', cols:`
    mentor_id  ulid ! >alumni
    student_id ulid ! >students
    topic      str(160)
    started_on date !
    ended_on   date
    status     enum(active|ended) ! =active
  `},
  job_board_posts:{ desc:'Jobs/internships shared by alumni or partners.', cols:`
    posted_by_alumni_id ulid >alumni:null
    title       str(160) !
    company     str(160)
    location    str(120)
    description text
    apply_url   str(500)
    expires_at  date
    status      enum(open|closed) ! =open
  `},
}},

{ key:'events', group:'Engagement', title:'Events & ticketing', color:'#C2410C', year:2,
  desc:'School events with audience, RSVP, paid tickets (QR), volunteers, schedules, photo albums, feedback.',
  tables:{
  events:{ desc:'Event with venue, audience, RSVP and ticketing.', cols:`
    calendar_event_id ulid >calendar_events:null
    title         str(200) !
    description   long
    event_type    enum(sports|cultural|ptm|seminar|trip|ceremony|competition|workshop|other) !
    starts_at     dt !
    ends_at       dt
    venue         str(160)
    room_id       ulid >rooms:null
    audience      json
    rsvp_required bool ! =false
    ticket_price  money
    ticket_limit  int
    fee_head_id   ulid >fee_heads:null
    banner_file_id ulid >files:null
    organiser_id  ulid >staff:null
    status        enum(draft|scheduled|live|completed|cancelled) ! =scheduled
    feedback_form_id ulid >form_definitions:null
  `},
  event_rsvps:{ ts:false, desc:'Responses.', cols:`
    event_id   ulid ! >events
    user_id    ulid ! >users
    student_id ulid >students:null
    response   enum(yes|no|maybe) !
    guests     small ! =0
    responded_at dt ! =now
  `, unique:[['event_id','user_id']] },
  event_tickets:{ desc:'Paid/free tickets with QR and check-in.', cols:`
    event_id    ulid ! >events
    holder_user_id ulid >users:null
    holder_name str(160)
    quantity    small ! =1
    amount      money ! =0
    payment_id  ulid >payments:null
    qr_code     str(64) ! u
    checked_in_at dt
    status      enum(reserved|paid|cancelled|used) ! =reserved
  `},
  event_schedule_items:{ ts:false, desc:'Programme items inside an event.', cols:`
    event_id   ulid ! >events
    starts_at  dt !
    title      str(200) !
    presenter  str(160)
    sequence   small ! =0
  `},
  event_volunteers:{ ts:false, desc:'Volunteer sign-ups.', cols:`
    event_id ulid ! >events
    user_id  ulid ! >users
    role     str(80)
    status   enum(applied|confirmed|declined) ! =applied
  `, unique:[['event_id','user_id']] },
}},

{ key:'governance', group:'Governance', title:'Governance · committee, meetings, policies', color:'#374151', year:2,
  desc:'Managing committee/board members and terms, meetings with agenda, minutes and resolutions, policy documents with acknowledgements, elections (student council).',
  tables:{
  committees:{ desc:'Managing committee, academic council, PTA, student council.', cols:`
    name   str(120) !
    kind   enum(managing|academic|pta|student_council|disciplinary|other) !
    status enum(active|dissolved) ! =active
  `},
  committee_members:{ desc:'Members with role and term.', cols:`
    committee_id ulid ! >committees
    person_name  str(160) !
    user_id      ulid >users:null
    role         str(80) !
    term_start   date
    term_end     date
    status       enum(active|ended) ! =active
  `},
  meetings:{ desc:'Meeting with agenda, minutes and attendance.', cols:`
    committee_id ulid >committees:null
    title        str(200) !
    held_at      dt !
    venue        str(160)
    agenda       json
    minutes      long
    attendees    json
    minutes_file_id ulid >files:null
    status       enum(scheduled|held|cancelled) ! =scheduled
  `},
  resolutions:{ desc:'Decisions with follow-up tasks.', cols:`
    meeting_id  ulid ! >meetings
    number      str(20)
    text        text !
    owner_id    ulid >users:null
    due_date    date
    status      enum(open|done|dropped) ! =open
  `},
  policy_documents:{ desc:'School policies with versions and acknowledgement tracking.', cols:`
    title       str(200) !
    category    str(60)
    version     small ! =1
    file_id     ulid >files:null
    body        long
    applies_to  json
    effective_from date
    status      enum(draft|active|retired) ! =draft
  `},
  policy_acknowledgements:{ ts:false, desc:'Who acknowledged which policy.', cols:`
    policy_id ulid ! >policy_documents
    user_id   ulid ! >users
    acked_at  dt ! =now
  `, unique:[['policy_id','user_id']] },
  elections:{ desc:'Student council / class captain elections with online voting.', cols:`
    title      str(200) !
    scope      json
    opens_at   dt !
    closes_at  dt !
    candidates json
    results    json
    status     enum(draft|open|closed) ! =draft
  `},
  election_votes:{ ts:false, desc:'Anonymous votes (voter hashed).', cols:`
    election_id ulid ! >elections
    voter_hash  str(64) !
    candidate_id str(40) !
    cast_at     dt ! =now
  `, unique:[['election_id','voter_hash']] },
}},

{ key:'compliance', group:'Governance', title:'Compliance & government reporting', color:'#78350F', year:2,
  desc:'Bangladesh-specific returns: BANBEIS census, board registration exports, MPO salary sheets, stipend lists, EIIN data; data-protection: consent records, data export/delete requests, retention policies.',
  tables:{
  govt_reports:{ desc:'Generated regulatory reports with period and file.', cols:`
    report_type  enum(banbeis_census|board_registration|mpo_salary_sheet|stipend_list|annual_return|custom) !
    period       str(20) !
    data         json
    file_id      ulid >files:null
    submitted_at dt
    status       enum(draft|generated|submitted|accepted) ! =draft
  `},
  stipend_programs:{ desc:'Govt stipend schemes (PESP, secondary stipend) and enrolled students.', cols:`
    name        str(160) !
    authority   str(120)
    criteria    json
    amount      money
    frequency   enum(monthly|quarterly|half_yearly|yearly)
    status      enum(active|closed) ! =active
  `},
  stipend_enrollments:{ desc:'Students in a stipend programme with disbursement history.', cols:`
    program_id  ulid ! >stipend_programs
    student_id  ulid ! >students
    enrolled_on date !
    bank_or_mfs json
    disbursements json
    status      enum(active|suspended|ended) ! =active
  `, unique:[['program_id','student_id']] },
  consent_records:{ desc:'Guardian/staff consents (photo use, data processing, trips).', cols:`
    user_id      ulid ! >users
    student_id   ulid >students:null
    consent_type str(60) !
    granted      bool !
    granted_at   dt ! =now
    expires_at   dt
    evidence     json
  `},
  data_requests:{ desc:'Data export / deletion requests (privacy).', cols:`
    user_id     ulid ! >users
    kind        enum(export|delete|correct) !
    status      enum(requested|processing|done|rejected) ! =requested
    file_id     ulid >files:null
    processed_by ulid >users:null
    processed_at dt
  `},
  retention_policies:{ desc:'How long to keep each data class.', cols:`
    entity_type str(60) !
    keep_years  small !
    action      enum(archive|anonymise|delete) ! =archive
    is_active   bool ! =true
  `, unique:[['school_id','entity_type']] },
}},

{ key:'analytics', group:'Governance', title:'Analytics, BI & predictions', color:'#0369A1', year:2,
  desc:'Dashboards per role, saved metrics, data marts refreshed nightly, anomaly alerts, predictive models (dropout risk, fee-default risk, result risk), benchmarking across campuses/schools.',
  tables:{
  dashboards:{ desc:'Configurable dashboards per role/user.', cols:`
    name      str(120) !
    role_id   ulid >roles:null
    user_id   ulid >users:null
    layout    json
    is_default bool ! =false
  `},
  metrics:{ desc:'Metric catalogue with query and thresholds.', cols:`
    key_name   str(80) !
    name       str(160) !
    definition json
    unit       str(20)
    warn_below dec(12,2)
    warn_above dec(12,2)
  `, unique:[['school_id','key_name']] },
  metric_values:{ ts:false, desc:'Time series per metric per dimension.', cols:`
    metric_id  ulid ! >metrics
    period     date !
    dimension  str(80)
    value      dec(14,2) !
  `, unique:[['metric_id','period','dimension']] },
  risk_scores:{ desc:'Predicted risks per student with explanation, refreshed weekly.', cols:`
    student_id  ulid ! >students
    risk_type   enum(dropout|fee_default|result_decline|attendance) !
    score       pct !
    factors     json
    computed_at dt ! =now
    acknowledged_by ulid >users:null
  `, unique:[['student_id','risk_type']] },
  anomaly_alerts:{ desc:'Detected anomalies (collection drop, attendance dip, SMS spike).', cols:`
    metric_key  str(80) !
    detected_at dt ! =now
    expected    dec(14,2)
    actual      dec(14,2)
    severity    enum(info|warn|critical) ! =warn
    status      enum(open|acknowledged|resolved) ! =open
    details     json
  `},
  benchmark_snapshots:{ tenant:false, ts:false, desc:'Anonymised cross-school benchmarks (platform level).', cols:`
    period     date !
    cohort     str(60) !
    metric_key str(80) !
    p25        dec(14,2)
    p50        dec(14,2)
    p75        dec(14,2)
  `, unique:[['period','cohort','metric_key']] },
}},

{ key:'ai', group:'Governance', title:'AI assistant & automation copilots', color:'#7E22CE', year:2,
  desc:'Natural-language assistant for admins/teachers/guardians (answers from school data, drafts notices, explains reports), question and remark generation, lesson-plan drafts, OCR of marks sheets/documents, WhatsApp chatbot for guardians, prompt/usage governance.',
  tables:{
  ai_conversations:{ desc:'Assistant chat sessions per user with channel.', cols:`
    user_id    ulid ! >users
    channel    enum(web|app|whatsapp|sms) ! =web
    title      str(200)
    context    json
    last_message_at dt
  `},
  ai_messages:{ ts:false, desc:'Messages with tool calls and token usage.', cols:`
    conversation_id ulid ! >ai_conversations
    role        enum(user|assistant|tool|system) !
    content     long
    tool_calls  json
    tokens_in   int ! =0
    tokens_out  int ! =0
    cost        dec(10,4) ! =0
    created_at  dt ! =now
  `},
  ai_generations:{ desc:'Generated artefacts (questions, remarks, lesson plans, notices, summaries) with review status.', cols:`
    kind        enum(questions|remarks|lesson_plan|notice|summary|translation|report_narrative|other) !
    requested_by ulid >users:null
    input       json
    output      json
    model       str(60)
    status      enum(generated|reviewed|applied|discarded) ! =generated
    applied_to_type str(60)
    applied_to_id ulid
  `},
  ocr_jobs:{ desc:'OCR/OMR of uploaded images (marks sheets, documents) into structured data.', cols:`
    file_id     ulid ! >files
    kind        enum(marks_sheet|omr|document|id_card|receipt) !
    result      json
    confidence  pct
    status      enum(queued|done|needs_review|applied|failed) ! =queued
    applied_to_type str(60)
    applied_to_id ulid
  `},
  ai_policies:{ desc:'Per-school AI settings: enabled features, data scope, monthly budget, model.', cols:`
    features     json
    data_scope   json
    monthly_budget money
    model        str(60)
    is_enabled   bool ! =false
  `},
  ai_usage_monthly:{ ts:false, desc:'Usage rollup for billing.', cols:`
    month     date !
    tokens_in big ! =0
    tokens_out big ! =0
    cost      money ! =0
  `, unique:[['school_id','month']] },
}},

{ key:'marketplace', group:'Governance', title:'Marketplace, plugins & developer platform', color:'#525252', year:3,
  desc:'Extension points so third parties (and the school) can add apps without forking: plugins with hooks and settings, app installs per school, OAuth clients, public API scopes, theme packs, template packs.',
  tables:{
  plugins:{ tenant:false, desc:'Registered plugins/apps.', cols:`
    slug        str(80) ! u
    name        str(160) !
    vendor      str(160)
    description text
    version     str(20) !
    hooks       json
    settings_schema json
    price_monthly money ! =0
    status      enum(draft|published|suspended) ! =draft
  `},
  plugin_installs:{ desc:'Plugin enabled for a school with settings.', cols:`
    plugin_id  ulid ! >plugins
    settings   json
    is_enabled bool ! =true
    installed_by ulid >users:null
  `, unique:[['school_id','plugin_id']] },
  oauth_clients:{ desc:'OAuth2 clients for third-party apps and SSO.', cols:`
    name          str(160) !
    client_id     str(64) ! u
    client_secret_hash str(128) !
    redirect_uris json
    scopes        json
    is_confidential bool ! =true
    revoked_at    dt
  `},
  oauth_tokens:{ ts:false, desc:'Issued access/refresh tokens.', cols:`
    client_id   ulid ! >oauth_clients
    user_id     ulid >users:null
    token_hash  str(128) ! u
    kind        enum(access|refresh|authorization_code) !
    scopes      json
    expires_at  dt !
    revoked_at  dt
    created_at  dt ! =now
  `},
  template_packs:{ tenant:false, desc:'Installable packs: document templates, notification templates, chart of accounts, grading scales per board/country.', cols:`
    slug     str(80) ! u
    name     str(160) !
    kind     enum(documents|notifications|accounting|grading|curriculum|forms) !
    locale   str(10)
    content  json
    version  str(20) !
  `},
}},
];
