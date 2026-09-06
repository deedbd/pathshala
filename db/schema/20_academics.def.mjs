// Academics: structure (school/college/madrasa/coaching modes), people, curriculum & timetable, admissions
export default [
{ key:'academic', group:'Academics', title:'Academic structure', color:'#2E7D9A', year:1,
  desc:'Years, terms/semesters, shifts, classes or programmes, sections/batches, subjects with credits, rooms, periods, calendar. Supports school (class-based), college (semester/credit), madrasa (hifz) and coaching (batch/course) in one model.',
  tables:{
  academic_years:{ desc:'Session. Only one is current.', cols:`
    name        str(20) !
    start_date  date !
    end_date    date !
    is_current  bool ! =false
    status      enum(planned|active|closed) ! =planned
  `, unique:[['school_id','name']] },
  terms:{ desc:'Terms (school) or semesters (college) inside a year.', cols:`
    academic_year_id ulid ! >academic_years
    name        str(60) !
    sequence    small !
    start_date  date !
    end_date    date !
    kind        enum(term|semester|trimester) ! =term
  `, unique:[['academic_year_id','sequence']] },
  shifts:{ desc:'Morning / Day shifts with times.', cols:`
    name       str(40) !
    start_time time !
    end_time   time !
  `, unique:[['school_id','name']] },
  programs:{ desc:'College/university programmes (HSC Science, BBA…) or coaching courses. Schools may ignore.', cols:`
    name         str(120) !
    code         str(20) !
    level        enum(secondary|higher_secondary|bachelor|master|diploma|coaching) !
    duration_terms small
    total_credits dec(5,1)
    department_id ulid
    status       enum(active|inactive) ! =active
  `, unique:[['school_id','code']] },
  classes:{ desc:'Grade level: Play, Nursery, KG, 1–12 (or programme year).', cols:`
    name          str(60) !
    name_bn       str(60)
    numeric_level small !
    stream        str(40)          # Science | Arts | Commerce | Hifz | Dakhil
    program_id    ulid >programs:null
    status        enum(active|inactive) ! =active
  `, unique:[['school_id','name']] },
  rooms:{ desc:'Physical rooms; used by timetable, exams, events, bookings.', cols:`
    campus_id  ulid ! >campuses
    name       str(60) !
    building   str(60)
    floor      str(20)
    capacity   small
    room_type  enum(classroom|lab|hall|library|office|playground|other) ! =classroom
    amenities  json
  `, unique:[['campus_id','name']] },
  sections:{ desc:'Section (school) or batch (coaching) of a class in a year.', cols:`
    academic_year_id ulid ! >academic_years
    class_id      ulid ! >classes:restrict
    campus_id     ulid >campuses:null
    shift_id      ulid >shifts:null
    name          str(40) !
    capacity      small ! =40
    room_id       ulid >rooms:null
    class_teacher_id ulid
    gender_policy enum(mixed|boys|girls) ! =mixed
    medium        enum(bangla|english|arabic) ! =bangla
    status        enum(active|inactive) ! =active
  `, unique:[['academic_year_id','class_id','name']] },
  subjects:{ desc:'Subject catalogue with board codes.', cols:`
    name         str(120) !
    name_bn      str(120)
    code         str(20) !
    subject_type enum(theory|practical|both|activity) ! =theory
    is_optional  bool ! =false
    department_id ulid
    status       enum(active|inactive) ! =active
  `, unique:[['school_id','code']] },
  class_subjects:{ desc:'Which subjects a class studies in a year and how they are marked (full/pass marks, theory/practical/CA split, credit).', cols:`
    academic_year_id ulid ! >academic_years
    class_id        ulid ! >classes
    subject_id      ulid ! >subjects:restrict
    is_compulsory   bool ! =true
    full_marks      dec(6,2) ! =100
    pass_marks      dec(6,2) ! =33
    theory_marks    dec(6,2)
    practical_marks dec(6,2)
    ca_marks        dec(6,2)
    credit          dec(4,2) ! =1
    weekly_periods  small ! =5
    sort_order      small ! =0
    assessment_mode enum(marks|competency|both) ! =marks   # NCTB 2023+ competency-based support
  `, unique:[['academic_year_id','class_id','subject_id']] },
  student_subject_choices:{ ts:false, desc:'Optional/4th subject choice per student.', cols:`
    student_id       ulid ! i
    class_subject_id ulid ! >class_subjects
    is_fourth        bool ! =false
  `, unique:[['student_id','class_subject_id']] },
  periods:{ desc:'Period grid per shift.', cols:`
    shift_id   ulid >shifts
    name       str(30) !
    sequence   small !
    start_time time !
    end_time   time !
    is_break   bool ! =false
  `, unique:[['school_id','shift_id','sequence']] },
  houses:{ desc:'Houses for sports/points.', cols:`
    name   str(60) !
    color  str(20)
    points int ! =0
  `, unique:[['school_id','name']] },
  calendar_events:{ desc:'Holidays, vacations, exam windows, events. Holidays drive attendance and reminder automation.', cols:`
    academic_year_id ulid >academic_years
    title       str(200) !
    event_type  enum(holiday|vacation|exam|event|ptm|deadline|meeting) !
    start_date  date !
    end_date    date !
    is_holiday  bool ! =false
    applies_to  json
    description text
    created_by  ulid >users:null
  `, index:[['school_id','start_date','end_date']] },
  weekly_offs:{ ts:false, desc:'Weekend days (BD: Fri, Sat).', cols:`
    day_of_week small !
  `, unique:[['school_id','day_of_week']] },
  hifz_progress:{ desc:'Madrasa: Quran memorisation tracking per student (para/surah/ayah, revision).', cols:`
    student_id  ulid ! i
    recorded_on date !
    para        small
    surah       small
    ayah_from   small
    ayah_to     small
    kind        enum(new|revision|test) ! =new
    quality     enum(excellent|good|fair|weak)
    teacher_id  ulid
    remarks     text
  `},
}},

{ key:'people', group:'Academics', title:'People · students, guardians, staff', color:'#3A6EA5', year:1,
  desc:'Students with one enrollment per year (history), guardians keyed by phone (siblings derived), staff with departments, designations, qualifications and documents.',
  tables:{
  departments:{ desc:'Academic and admin departments.', cols:`
    name          str(80) !
    head_staff_id ulid
    kind          enum(academic|admin|support) ! =academic
  `, unique:[['school_id','name']] },
  designations:{ desc:'Job titles with hierarchy level.', cols:`
    name   str(80) !
    level  small ! =0
    category enum(teaching|non_teaching|admin|support) ! =teaching
  `, unique:[['school_id','name']] },
  staff:{ soft:true, desc:'Employee master.', cols:`
    user_id        ulid u >users:null
    employee_no    str(30) !
    first_name     str(80) !
    last_name      str(80)
    name_bn        str(160)
    gender         enum(male|female|other)
    date_of_birth  date
    phone          str(20)
    email          str(160)
    nid_no         str(30)
    photo_file_id  ulid >files:null
    campus_id      ulid >campuses:null
    department_id  ulid >departments:null
    designation_id ulid >designations:null
    reports_to_id  ulid >staff:null
    staff_category enum(teaching|non_teaching|admin|support) ! =teaching
    employment_type enum(permanent|contract|part_time|intern|volunteer|mpo) ! =permanent
    mpo_index_no   str(30)          # MPO listed teacher index
    join_date      date !
    probation_end  date
    leave_date     date
    status         enum(active|probation|on_leave|resigned|terminated|retired) ! =active
    address        json
    emergency_contact json
    bank_details   json
    biometric_id   str(40)
    rfid_tag       str(40)
    meta           json
  `, unique:[['school_id','employee_no']] },
  staff_qualifications:{ ts:false, desc:'Degrees.', cols:`
    staff_id     ulid ! >staff
    degree       str(120) !
    institution  str(160)
    passing_year small
    result       str(40)
    file_id      ulid >files:null
  `},
  staff_subjects:{ ts:false, desc:'Subjects a teacher can teach (timetable + substitution engine).', cols:`
    staff_id   ulid ! >staff
    subject_id ulid ! >subjects
    preference small ! =1
  `, unique:[['staff_id','subject_id']] },
  staff_documents:{ desc:'NID, certificates, contracts with expiry reminders.', cols:`
    staff_id    ulid ! >staff
    doc_type    str(60) !
    file_id     ulid ! >files
    expires_at  date
    verified_by ulid >users:null
    verified_at dt
  `},
  students:{ soft:true, desc:'Student master with denormalised current pointers.', cols:`
    user_id            ulid u >users:null
    admission_no       str(30) !
    first_name         str(80) !
    last_name          str(80)
    name_bn            str(160)
    gender             enum(male|female|other) !
    date_of_birth      date !
    blood_group        str(5)
    religion           str(30)
    nationality        str(40) ! ='Bangladeshi'
    birth_certificate_no str(30)
    nid_no             str(30)
    photo_file_id      ulid >files:null
    admission_date     date !
    admission_class_id ulid >classes:null
    current_academic_year_id ulid >academic_years:null
    current_class_id   ulid >classes:null
    current_section_id ulid >sections:null
    current_roll_no    str(10)
    house_id           ulid >houses:null
    status             enum(applicant|active|suspended|graduated|transferred|dropped|alumni) ! =active
    status_changed_at  dt
    status_reason      str(255)
    present_address    json
    permanent_address  json
    previous_school    json
    medical_summary    json
    special_needs      json           # accommodations, IEP flag
    biometric_id       str(40)
    rfid_tag           str(40)
    wallet_id          ulid            # → wallets
    meta               json
  `, unique:[['school_id','admission_no']], index:[['school_id','current_section_id','status']] },
  student_enrollments:{ desc:'One row per student per academic year: class, section, roll. Full history.', cols:`
    student_id       ulid ! >students
    academic_year_id ulid ! >academic_years
    class_id         ulid ! >classes:restrict
    section_id       ulid >sections:null
    program_id       ulid >programs:null
    roll_no          str(10)
    enrolled_on      date !
    left_on          date
    status           enum(active|promoted|retained|transferred|left|graduated) ! =active
    promoted_from_id ulid >student_enrollments:null
  `, unique:[['student_id','academic_year_id']], index:[['section_id','roll_no']] },
  guardians:{ desc:'Guardian keyed by phone; same phone = same guardian = siblings.', cols:`
    user_id       ulid u >users:null
    full_name     str(160) !
    phone         str(20) !
    alt_phone     str(20)
    email         str(160)
    occupation    str(80)
    nid_no        str(30)
    monthly_income money
    address       json
    photo_file_id ulid >files:null
    is_staff      bool ! =false      # staff-child discount rule
  `, unique:[['school_id','phone']] },
  student_guardians:{ ts:false, desc:'Student ↔ guardian with relation and rights.', cols:`
    student_id   ulid ! >students
    guardian_id  ulid ! >guardians
    relation     enum(father|mother|grandparent|sibling|uncle|aunt|legal_guardian|other) !
    is_primary   bool ! =false
    is_emergency bool ! =false
    can_pickup   bool ! =true
    receives_notifications bool ! =true
    pays_fees    bool ! =false
  `, unique:[['student_id','guardian_id']] },
  pickup_authorisations:{ desc:'KG/primary: who may collect the child; photo + ID; one-time passes.', cols:`
    student_id   ulid ! >students
    person_name  str(160) !
    relation     str(60)
    phone        str(20)
    photo_file_id ulid >files:null
    id_proof     str(60)
    valid_from   date
    valid_to     date
    is_one_time  bool ! =false
    approved_by  ulid >users:null
  `},
  student_documents:{ desc:'Uploaded student documents with verification.', cols:`
    student_id  ulid ! >students
    doc_type    str(60) !
    file_id     ulid ! >files
    verified_by ulid >users:null
    verified_at dt
  `},
  student_status_history:{ ts:false, desc:'Every status change (suspended, transferred…) with reason.', cols:`
    student_id  ulid ! >students
    from_status str(20)
    to_status   str(20) !
    reason      str(255)
    changed_by  ulid >users:null
    changed_at  dt ! =now
  `},
}},

{ key:'curriculum', group:'Academics', title:'Curriculum & timetable', color:'#4C7C59', year:1,
  desc:'Teacher allocation, timetable with clash rules and auto-generation, substitutions, syllabus units, learning outcomes/competencies (NCTB 2023+), lesson plans.',
  tables:{
  section_subject_teachers:{ ts:false, desc:'Who teaches which subject in which section this year.', cols:`
    section_id       ulid ! >sections
    class_subject_id ulid ! >class_subjects
    teacher_id       ulid ! >staff:restrict
    is_primary       bool ! =true
  `, unique:[['section_id','class_subject_id','teacher_id']] },
  timetable_versions:{ desc:'Published versions of the timetable; auto-generator writes drafts.', cols:`
    academic_year_id ulid ! >academic_years
    name          str(80) !
    effective_from date !
    effective_to  date
    status        enum(draft|published|archived) ! =draft
    generated_by  enum(manual|auto) ! =manual
    constraints   json
    score         dec(6,2)
  `},
  timetable_slots:{ desc:'Section × day × period → subject, teacher, room. App enforces no teacher/room double booking.', cols:`
    version_id       ulid ! >timetable_versions
    section_id       ulid ! >sections
    day_of_week      small !
    period_id        ulid ! >periods
    class_subject_id ulid >class_subjects:null
    teacher_id       ulid >staff:null
    room_id          ulid >rooms:null
  `, unique:[['version_id','section_id','day_of_week','period_id'],['version_id','teacher_id','day_of_week','period_id'],['version_id','room_id','day_of_week','period_id']] },
  timetable_substitutions:{ desc:'Day-specific override when a teacher is absent; auto-suggested from free, qualified teachers.', cols:`
    slot_id               ulid ! >timetable_slots
    on_date               date !
    original_teacher_id   ulid >staff:null
    substitute_teacher_id ulid >staff:null
    reason                str(60)
    leave_application_id  ulid
    status                enum(suggested|pending|approved|rejected|cancelled) ! =suggested
    is_auto_suggested     bool ! =false
  `, unique:[['slot_id','on_date']] },
  syllabi:{ desc:'Syllabus per class-subject and term.', cols:`
    class_subject_id ulid ! >class_subjects
    term_id          ulid >terms:null
    title            str(200) !
    file_id          ulid >files:null
    created_by       ulid >users:null
  `},
  syllabus_units:{ desc:'Chapters/units with planned end dates (behind-schedule alerts).', cols:`
    syllabus_id      ulid ! >syllabi
    title            str(200) !
    sequence         small !
    planned_periods  small ! =1
    planned_end_date date
  `, unique:[['syllabus_id','sequence']] },
  learning_outcomes:{ desc:'Competencies / performance indicators (NCTB 2023 curriculum) mapped to units and Bloom level.', cols:`
    class_subject_id ulid ! >class_subjects
    unit_id          ulid >syllabus_units:null
    code             str(30) !
    statement        text !
    statement_bn     text
    bloom_level      enum(remember|understand|apply|analyse|evaluate|create)
    weight           dec(4,2) ! =1
  `, unique:[['class_subject_id','code']] },
  lesson_plans:{ desc:'Teacher lesson plans by date with outcomes, resources, homework and review.', cols:`
    teacher_id       ulid ! >staff
    section_id       ulid ! >sections
    class_subject_id ulid ! >class_subjects
    unit_id          ulid >syllabus_units:null
    plan_date        date !
    topic            str(200) !
    objectives       text
    activities       text
    outcomes         json
    resources        json
    homework         text
    status           enum(planned|taught|skipped) ! =planned
    taught_at        dt
    reviewed_by      ulid >staff:null
    review_note      text
  `, index:[['teacher_id','plan_date']] },
  syllabus_progress:{ ts:false, desc:'Rollup: units taught per section (refreshed by scheduler).', cols:`
    syllabus_id  ulid ! >syllabi
    section_id   ulid ! >sections
    total_units  small ! =0
    taught_units small ! =0
    pct          pct ! =0
    refreshed_at dt ! =now
  `, unique:[['syllabus_id','section_id']] },
}},

{ key:'admissions', group:'Academics', title:'Admissions & enquiry CRM', color:'#8A5A1E', year:1,
  desc:'Campaign → enquiry → online application (public form, form fee) → test/interview → merit list → offer with expiry → enrolment, all automated; waitlist promotion; sibling priority; lottery mode (govt-style).',
  tables:{
  admission_campaigns:{ desc:'A season with seats per class, fees, test settings and selection mode.', cols:`
    academic_year_id ulid ! >academic_years
    name             str(120) !
    opens_at         dt !
    closes_at        dt !
    form_fee         money ! =0
    admission_fee_head_id ulid
    selection_mode   enum(test|lottery|first_come|interview|mixed) ! =test
    requires_test    bool ! =true
    auto_merit_list  bool ! =true
    auto_offer       bool ! =true
    offer_validity_days small ! =7
    sibling_priority bool ! =true
    status           enum(draft|open|closed|archived) ! =draft
    public_form_slug str(80) u
    form_schema      json
  `},
  admission_campaign_classes:{ ts:false, desc:'Seats and age limits per class.', cols:`
    campaign_id   ulid ! >admission_campaigns
    class_id      ulid ! >classes
    seats         small !
    min_age_years dec(4,1)
    max_age_years dec(4,1)
    test_id       ulid
  `, unique:[['campaign_id','class_id']] },
  admission_enquiries:{ desc:'Lead with source, counsellor (round-robin) and follow-up date.', cols:`
    campaign_id     ulid >admission_campaigns:null
    student_name    str(160) !
    guardian_name   str(160) !
    phone           str(20) !
    email           str(160)
    class_id        ulid >classes:null
    source          enum(walk_in|website|facebook|referral|call|whatsapp|event|other) ! =other
    assigned_to     ulid >staff:null
    status          enum(new|contacted|visited|converted|lost) ! =new
    lost_reason     str(120)
    next_follow_up_at dt i
    notes           text
  `},
  enquiry_followups:{ ts:false, desc:'Interaction log.', cols:`
    enquiry_id  ulid ! >admission_enquiries
    note        text !
    channel     enum(call|visit|sms|email|whatsapp)
    by_user_id  ulid >users:null
    next_at     dt
    created_at  dt ! =now
  `},
  admission_applications:{ desc:'Application with applicant snapshot, pipeline status, score, rank, waitlist.', cols:`
    campaign_id      ulid ! >admission_campaigns
    enquiry_id       ulid >admission_enquiries:null
    application_no   str(30) !
    class_id         ulid ! >classes:restrict
    shift_id         ulid >shifts:null
    first_name       str(80) !
    last_name        str(80)
    gender           enum(male|female|other) !
    date_of_birth    date !
    photo_file_id    ulid >files:null
    guardian_name    str(160) !
    guardian_phone   str(20) !
    guardian_email   str(160)
    guardian_relation str(30)
    address          json
    previous_school  json
    extra_fields     json
    sibling_student_id ulid >students:null
    status           enum(draft|submitted|screening|test_scheduled|tested|shortlisted|waitlisted|offered|accepted|enrolled|rejected|withdrawn) ! =draft
    form_fee_invoice_id ulid
    test_score       dec(6,2)
    merit_rank       int
    lottery_no       str(20)
    waitlist_position int
    student_id       ulid >students:null
    submitted_at     dt
    decided_at       dt
    decided_by       ulid >users:null
    rejection_reason str(255)
  `, unique:[['school_id','application_no']], index:[['campaign_id','class_id','status']] },
  application_documents:{ ts:false, desc:'Uploaded applicant documents.', cols:`
    application_id ulid ! >admission_applications
    doc_type       str(60) !
    file_id        ulid ! >files
    verified_at    dt
    verified_by    ulid >users:null
  `},
  admission_tests:{ desc:'Entrance test/interview with components.', cols:`
    campaign_id  ulid ! >admission_campaigns
    class_id     ulid ! >classes
    name         str(120) !
    held_at      dt !
    duration_min small
    venue        str(120)
    total_marks  dec(6,2) ! =100
    pass_marks   dec(6,2)
    components   json
    online_exam_id ulid
  `},
  admission_test_results:{ ts:false, desc:'Score per applicant.', cols:`
    test_id        ulid ! >admission_tests
    application_id ulid ! >admission_applications
    component_marks json
    total_marks    dec(6,2)
    is_absent      bool ! =false
    remarks        str(255)
    entered_by     ulid >users:null
    entered_at     dt ! =now
  `, unique:[['test_id','application_id']] },
  admission_offers:{ desc:'Offer with expiry; auto-revoked and waitlist promoted when unpaid.', cols:`
    application_id ulid ! u >admission_applications
    offered_at     dt ! =now
    expires_at     dt !
    admission_fee_invoice_id ulid
    offer_letter_file_id ulid >files:null
    accepted_at    dt
    declined_at    dt
    revoked_at     dt
    revoke_reason  str(120)
  `},
}},
];
