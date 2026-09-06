// Learning: attendance & leave, assessment (marks + competency), LMS, diary/homework, co-curricular, library
export default [
{ key:'attendance', group:'Academics', title:'Attendance & leave', color:'#1E7F4F', year:1,
  desc:'Raw device punches resolved by a worker; daily and period attendance; policies with cut-off and thresholds; leave workflow with balances; substitution trigger.',
  tables:{
  attendance_devices:{ desc:'Biometric / RFID / face / QR / bus readers.', cols:`
    campus_id    ulid >campuses:null
    name         str(80) !
    device_type  enum(biometric|rfid|face|qr|gps_bus|mobile_app) !
    vendor       str(60)
    serial_no    str(80) u
    api_key_hash str(128)
    location     str(120)
    direction    enum(in|out|both) ! =both
    last_seen_at dt
    is_active    bool ! =true
  `},
  device_punch_logs:{ ts:false, desc:'Punches exactly as received; resolved to a person later.', cols:`
    device_id    ulid ! >attendance_devices
    identifier   str(80) !
    punched_at   dt !
    direction    str(10)
    raw_payload  json
    person_type  enum(student|staff)
    person_id    ulid i
    processed_at dt i
    error        str(255)
  `},
  student_attendance:{ desc:'One row per student per day.', cols:`
    student_id   ulid ! >students
    section_id   ulid >sections:null
    on_date      date !
    status       enum(present|absent|late|half_day|excused|holiday) !
    check_in     dt
    check_out    dt
    late_minutes small
    source       enum(manual|device|app|import|system|bus) ! =manual
    marked_by    ulid >users:null
    remarks      str(255)
    guardian_notified_at dt
  `, unique:[['student_id','on_date']], index:[['section_id','on_date']] },
  student_period_attendance:{ desc:'Period-wise attendance (college / subject-wise).', cols:`
    student_id ulid ! >students
    slot_id    ulid ! >timetable_slots
    on_date    date !
    status     enum(present|absent|late|excused) !
    marked_by  ulid >users:null
  `, unique:[['student_id','slot_id','on_date']] },
  staff_attendance:{ desc:'Staff daily attendance with work/overtime minutes feeding payroll.', cols:`
    staff_id       ulid ! >staff
    on_date        date !
    status         enum(present|absent|late|half_day|excused|holiday|wfh) !
    check_in       dt
    check_out      dt
    late_minutes   small
    early_leave_minutes small
    work_minutes   small
    overtime_minutes small
    source         enum(manual|device|app|import|system) ! =manual
    marked_by      ulid >users:null
    remarks        str(255)
  `, unique:[['staff_id','on_date']] },
  attendance_policies:{ desc:'Cut-off time, late/half-day thresholds, notification switches, escalation, minimum %.', cols:`
    audience         enum(student|staff) !
    class_id         ulid >classes:null
    shift_id         ulid >shifts:null
    late_after_minutes small ! =15
    half_day_after_minutes small ! =120
    auto_absent_at   time
    notify_on_arrival bool ! =true
    notify_on_absent bool ! =true
    notify_on_late   bool ! =true
    consecutive_absent_alert small ! =3
    min_attendance_pct pct ! =75
    block_exam_below_min bool ! =false
    late_count_to_lop small
    is_active        bool ! =true
  `},
  leave_types:{ desc:'Casual, sick, earned, maternity, study… with accrual and carry-forward.', cols:`
    name              str(60) !
    code              str(20) !
    audience          enum(student|staff) !
    days_per_year     dec(5,1) ! =0
    accrual           enum(yearly|monthly|none) ! =yearly
    is_paid           bool ! =true
    carry_forward_max dec(5,1) ! =0
    requires_document bool ! =false
    min_notice_days   small ! =0
    encashable        bool ! =false
  `, unique:[['school_id','code']] },
  leave_balances:{ desc:'Per staff per type per year.', cols:`
    staff_id         ulid ! >staff
    leave_type_id    ulid ! >leave_types
    academic_year_id ulid ! >academic_years
    allocated        dec(5,1) ! =0
    carried_forward  dec(5,1) ! =0
    used             dec(5,1) ! =0
    encashed         dec(5,1) ! =0
  `, unique:[['staff_id','leave_type_id','academic_year_id']] },
  leave_applications:{ desc:'Student or staff leave through the approval workflow.', cols:`
    applicant_type  enum(student|staff) !
    student_id      ulid >students
    staff_id        ulid >staff
    leave_type_id   ulid ! >leave_types:restrict
    from_date       date !
    to_date         date !
    half_day        enum(first|second)
    days            dec(5,1) !
    reason          text !
    document_file_id ulid >files:null
    applied_by      ulid >users:null
    status          enum(pending|approved|rejected|cancelled) ! =pending
    approval_request_id ulid
    decided_by      ulid >users:null
    decided_at      dt
    decision_note   str(255)
  `, index:[['school_id','status']] },
  attendance_monthly_summary:{ ts:false, desc:'Rollup per student per month (refreshed nightly); used by report cards, eligibility, alerts.', cols:`
    student_id   ulid ! >students
    month        date !
    present_days small ! =0
    absent_days  small ! =0
    late_days    small ! =0
    excused_days small ! =0
    working_days small ! =0
    pct          pct ! =0
  `, unique:[['student_id','month']] },
}},

{ key:'assessment', group:'Academics', title:'Examinations & assessment', color:'#7B3FA0', year:1,
  desc:'Marks-based exams (BD GPA 5.0, credit-weighted) and competency-based assessment (NCTB 2023 performance indicators) side by side; schedules, seat plans, invigilators, admit cards with eligibility, verification & lock, result engine, report cards, promotion; question bank, question-paper generator, online exams with auto-grading, OMR scanning; board form fill-up and result import.',
  tables:{
  grading_scales:{ desc:'Named scales (BD Board GPA 5.0, Cambridge A*–G, IB 1–7).', cols:`
    name       str(80) !
    is_default bool ! =false
    gpa_max    dec(4,2) ! =5
    fail_gpa_zero bool ! =true      # F in any subject → GPA 0 (board rule)
  `, unique:[['school_id','name']] },
  grading_bands:{ ts:false, desc:'Grade bands with ranges and points.', cols:`
    scale_id    ulid ! >grading_scales
    grade       str(5) !
    min_percent pct !
    max_percent pct !
    grade_point dec(4,2) !
    is_fail     bool ! =false
    remarks     str(120)
  `, unique:[['scale_id','grade']] },
  competency_scales:{ desc:'Rating scales for competency-based assessment (e.g. NCTB triangle/circle/square, 1–4 rubric).', cols:`
    name   str(80) !
    levels json          # [{code:'△',label:'Needs work',value:1},…]
  `, unique:[['school_id','name']] },
  exam_types:{ desc:'Class test, half-yearly, annual, model test… with weight in the annual aggregate.', cols:`
    name        str(60) !
    weight_pct  pct ! =100
    is_internal bool ! =false
  `, unique:[['school_id','name']] },
  exams:{ desc:'An exam event for a year/term with scale, eligibility rules and publish time.', cols:`
    academic_year_id ulid ! >academic_years
    term_id          ulid >terms:null
    exam_type_id     ulid ! >exam_types:restrict
    grading_scale_id ulid ! >grading_scales:restrict
    name             str(120) !
    start_date       date !
    end_date         date !
    marks_entry_deadline dt
    publish_at       dt
    status           enum(draft|scheduled|ongoing|marks_entry|processing|published|locked) ! =draft
    require_fee_clearance bool ! =false
    min_attendance_pct pct
    rank_scope       enum(section|class|both) ! =section
    tie_rule         enum(share_rank|dense|by_total) ! =share_rank
    created_by       ulid >users:null
  `},
  exam_schedules:{ desc:'One paper per class-subject: date, time, room, marks split.', cols:`
    exam_id          ulid ! >exams
    class_subject_id ulid ! >class_subjects
    exam_date        date
    start_time       time
    end_time         time
    room_id          ulid >rooms:null
    full_marks       dec(6,2) !
    pass_marks       dec(6,2) !
    theory_marks     dec(6,2)
    practical_marks  dec(6,2)
    ca_marks         dec(6,2)
    marks_entry_locked bool ! =false
    question_paper_id ulid
  `, unique:[['exam_id','class_subject_id']] },
  exam_invigilators:{ ts:false, desc:'Duty roster.', cols:`
    schedule_id ulid ! >exam_schedules
    room_id     ulid ! >rooms
    staff_id    ulid ! >staff
  `, unique:[['schedule_id','room_id','staff_id']] },
  exam_seat_plans:{ desc:'Seat per student per exam; admit-card file; eligibility flag.', cols:`
    exam_id     ulid ! >exams
    student_id  ulid ! >students
    room_id     ulid ! >rooms
    seat_no     str(10) !
    admit_card_file_id ulid >files:null
    is_eligible bool ! =true
    ineligible_reason str(60)
  `, unique:[['exam_id','student_id'],['exam_id','room_id','seat_no']] },
  marks:{ desc:'Marks per student per paper with computed grade and workflow status.', cols:`
    schedule_id       ulid ! >exam_schedules
    student_id        ulid ! >students
    theory_obtained   dec(6,2)
    practical_obtained dec(6,2)
    ca_obtained       dec(6,2)
    total_obtained    dec(6,2)
    is_absent         bool ! =false
    grade             str(5)
    grade_point       dec(4,2)
    is_pass           bool
    status            enum(draft|submitted|verified|locked) ! =draft
    entered_by        ulid >users:null
    entered_at        dt
    verified_by       ulid >users:null
    verified_at       dt
    remarks           str(120)
  `, unique:[['schedule_id','student_id']], index:[['student_id']] },
  competency_assessments:{ desc:'Competency-based rating per student per learning outcome per term (no marks).', cols:`
    student_id   ulid ! >students
    outcome_id   ulid ! >learning_outcomes
    term_id      ulid ! >terms
    scale_id     ulid ! >competency_scales:restrict
    level_code   str(10) !
    evidence     json           # file ids / notes
    assessed_by  ulid >staff:null
    assessed_at  dt
  `, unique:[['student_id','outcome_id','term_id']] },
  exam_results:{ desc:'Aggregated result per student per exam, frozen on publish.', cols:`
    exam_id          ulid ! >exams
    student_id       ulid ! >students
    section_id       ulid >sections:null
    total_full_marks dec(8,2) !
    total_obtained   dec(8,2) !
    percentage       pct !
    gpa              dec(4,2)
    grade            str(5)
    failed_subjects  small ! =0
    is_pass          bool !
    rank_in_section  int
    rank_in_class    int
    attendance_pct   pct
    teacher_remark   str(255)
    principal_remark str(255)
    report_card_file_id ulid >files:null
    published_at     dt
    computed_at      dt ! =now
  `, unique:[['exam_id','student_id']], index:[['exam_id','section_id','rank_in_section']] },
  annual_results:{ desc:'Weighted aggregate across the year’s exams → promotion input.', cols:`
    academic_year_id ulid ! >academic_years
    student_id       ulid ! >students
    weighted_gpa     dec(4,2)
    weighted_pct     pct
    rank_in_class    int
    decision         enum(promoted|retained|graduated|conditional|pending) ! =pending
    computed_at      dt ! =now
  `, unique:[['academic_year_id','student_id']] },
  promotion_rules:{ desc:'Min GPA, max failed subjects, min attendance; auto-apply switch.', cols:`
    academic_year_id ulid ! >academic_years
    class_id         ulid >classes:null
    min_gpa          dec(4,2) ! =1
    max_failed_subjects small ! =0
    min_attendance_pct pct ! =0
    auto_apply       bool ! =false
  `, unique:[['academic_year_id','class_id']] },
  promotions:{ desc:'Decision per enrollment.', cols:`
    student_id         ulid ! >students
    from_enrollment_id ulid ! u >student_enrollments
    to_enrollment_id   ulid >student_enrollments:null
    decision           enum(promoted|retained|graduated|conditional) !
    annual_gpa         dec(4,2)
    is_auto            bool ! =false
    decided_by         ulid >users:null
    note               str(255)
  `},
  questions:{ desc:'Question bank with type, difficulty, outcome mapping and auto-grade answer key.', cols:`
    subject_id   ulid ! >subjects
    class_id     ulid >classes:null
    unit_id      ulid >syllabus_units:null
    outcome_id   ulid >learning_outcomes:null
    q_type       enum(mcq|true_false|short|long|fill_blank|match|numeric|essay) !
    difficulty   enum(easy|medium|hard) ! =medium
    body         long !
    body_bn      long
    options      json
    answer       json
    marks        dec(5,2) ! =1
    tags         json
    ai_generated bool ! =false
    created_by   ulid >users:null
    usage_count  int ! =0
  `, index:[['school_id','subject_id','class_id']] },
  question_papers:{ desc:'Generated/curated question papers (blueprint: marks by unit × difficulty), PDF output.', cols:`
    class_subject_id ulid ! >class_subjects
    exam_id          ulid >exams:null
    title            str(200) !
    blueprint        json
    total_marks      dec(6,2) !
    duration_min     small
    instructions     text
    set_label        str(5)          # A/B sets
    pdf_file_id      ulid >files:null
    status           enum(draft|final) ! =draft
    created_by       ulid >users:null
  `},
  question_paper_items:{ ts:false, desc:'Questions in a paper.', cols:`
    paper_id    ulid ! >question_papers
    question_id ulid ! >questions
    sequence    small !
    marks       dec(5,2) !
    section     str(20)
  `, unique:[['paper_id','question_id']] },
  online_exams:{ desc:'Timed online exam; MCQ auto-graded; can sync into a formal paper.', cols:`
    schedule_id      ulid >exam_schedules:null
    section_id       ulid ! >sections
    class_subject_id ulid ! >class_subjects
    paper_id         ulid >question_papers:null
    title            str(200) !
    instructions     text
    starts_at        dt !
    ends_at          dt !
    duration_min     small !
    total_marks      dec(6,2) !
    shuffle_questions bool ! =true
    auto_grade       bool ! =true
    auto_publish     bool ! =false
    proctoring       json            # webcam snapshots, tab-switch limit
    status           enum(draft|scheduled|live|closed|published) ! =draft
    created_by       ulid >users:null
  `},
  online_exam_attempts:{ desc:'Attempt with answers, auto/manual score, proctoring meta.', cols:`
    online_exam_id ulid ! >online_exams
    student_id     ulid ! >students
    started_at     dt ! =now
    submitted_at   dt
    answers        json
    auto_score     dec(6,2)
    manual_score   dec(6,2)
    final_score    dec(6,2)
    graded_by      ulid >users:null
    status         enum(in_progress|submitted|auto_graded|graded) ! =in_progress
    client_meta    json
  `, unique:[['online_exam_id','student_id']] },
  omr_sheets:{ desc:'Scanned OMR answer sheets processed by the OMR engine.', cols:`
    schedule_id  ulid >exam_schedules:null
    online_exam_id ulid >online_exams:null
    student_id   ulid >students:null
    file_id      ulid ! >files
    detected_roll str(20)
    answers      json
    score        dec(6,2)
    confidence   pct
    status       enum(uploaded|processed|needs_review|applied|rejected) ! =uploaded
  `},
  board_registrations:{ desc:'Board exam (SSC/HSC/JSC/Dakhil) registration and form fill-up per student with fees and export.', cols:`
    student_id       ulid ! >students
    academic_year_id ulid ! >academic_years
    board            str(40) !
    exam_name        str(40) !          # SSC 2027
    registration_no  str(30)
    roll_no          str(30)
    centre           str(120)
    group_name       str(30)
    subjects         json
    fee_invoice_id   ulid
    status           enum(draft|submitted|confirmed|admitted|result_received) ! =draft
    board_result     json               # imported GPA/grades
  `, unique:[['student_id','exam_name']] },
}},

{ key:'lms', group:'Academics', title:'LMS · courses, lessons, live classes', color:'#0F766E', year:1,
  desc:'Courses (also coaching-centre products), lessons with video/notes, quizzes, assignments with late rules, live classes, discussion, progress tracking, certificates.',
  tables:{
  courses:{ soft:true, desc:'A course: tied to a class-subject or sold standalone (coaching, skills).', cols:`
    class_subject_id ulid >class_subjects:null
    title        str(200) !
    slug         str(120) !
    description  long
    cover_file_id ulid >files:null
    teacher_id   ulid >staff:null
    is_paid      bool ! =false
    price        money ! =0
    fee_head_id  ulid
    status       enum(draft|published|archived) ! =draft
    published_at dt
  `, unique:[['school_id','slug']] },
  course_modules:{ desc:'Sections inside a course.', cols:`
    course_id  ulid ! >courses
    title      str(200) !
    sequence   small !
  `},
  lessons:{ desc:'Lesson content: video, notes, link, SCORM/H5P, quiz.', cols:`
    module_id    ulid ! >course_modules
    title        str(200) !
    sequence     small !
    lesson_type  enum(video|note|link|file|quiz|assignment|live) !
    body         long
    file_id      ulid >files:null
    video_url    str(500)
    duration_min small
    is_free_preview bool ! =false
    unit_id      ulid >syllabus_units:null
  `},
  course_enrollments:{ desc:'Student enrolled in a course (auto for class-subject courses).', cols:`
    course_id   ulid ! >courses
    student_id  ulid ! >students
    enrolled_at dt ! =now
    progress_pct pct ! =0
    completed_at dt
    certificate_doc_id ulid
  `, unique:[['course_id','student_id']] },
  lesson_progress:{ ts:false, desc:'Per student per lesson.', cols:`
    lesson_id    ulid ! >lessons
    student_id   ulid ! >students
    status       enum(not_started|in_progress|completed) ! =not_started
    seconds_watched int ! =0
    last_position int ! =0
    completed_at dt
  `, unique:[['lesson_id','student_id']] },
  assignments:{ desc:'Homework/assignment with due date, penalty and submission type.', cols:`
    section_id       ulid ! >sections
    class_subject_id ulid ! >class_subjects
    teacher_id       ulid ! >staff
    lesson_id        ulid >lessons:null
    title            str(200) !
    description      long
    attachments      json
    assigned_at      dt ! =now
    due_at           dt !
    max_marks        dec(6,2)
    allow_late       bool ! =true
    late_penalty_pct pct ! =0
    submission_type  enum(file|text|both|offline|photo) ! =file
    status           enum(draft|published|closed) ! =published
    reminder_sent_at dt
  `, index:[['school_id','due_at']] },
  assignment_submissions:{ desc:'Submission with grading and feedback; plagiarism score optional.', cols:`
    assignment_id ulid ! >assignments
    student_id    ulid ! >students
    submitted_at  dt ! =now
    is_late       bool ! =false
    text_answer   long
    attachments   json
    marks         dec(6,2)
    feedback      text
    similarity_pct pct
    graded_by     ulid >users:null
    graded_at     dt
    status        enum(submitted|graded|returned|resubmit) ! =submitted
  `, unique:[['assignment_id','student_id']] },
  study_materials:{ desc:'Notes, slides, videos, links by unit.', cols:`
    class_subject_id ulid >class_subjects
    section_id       ulid >sections
    unit_id          ulid >syllabus_units:null
    title            str(200) !
    material_type    enum(note|slide|video|link|book|audio) !
    file_id          ulid >files:null
    external_url     str(500)
    uploaded_by      ulid >users:null
    published_at     dt ! =now
    view_count       int ! =0
  `},
  online_classes:{ desc:'Live class (Zoom/Meet/Jitsi) auto-created from timetable on remote days.', cols:`
    section_id       ulid ! >sections
    class_subject_id ulid >class_subjects:null
    teacher_id       ulid ! >staff
    slot_id          ulid >timetable_slots:null
    title            str(200) !
    platform         enum(zoom|google_meet|jitsi|bbb|youtube_live) !
    meeting_id       str(120)
    join_url         str(500)
    host_url         str(500)
    starts_at        dt !
    duration_min     small ! =40
    recording_url    str(500)
    status           enum(scheduled|live|ended|cancelled) ! =scheduled
    reminder_sent_at dt
  `, index:[['school_id','starts_at']] },
  online_class_attendance:{ ts:false, desc:'From platform webhooks.', cols:`
    online_class_id ulid ! >online_classes
    student_id      ulid ! >students
    joined_at       dt
    left_at         dt
    minutes         small
  `, unique:[['online_class_id','student_id']] },
  discussions:{ desc:'Q&A threads under lessons/courses.', cols:`
    course_id  ulid >courses
    lesson_id  ulid >lessons
    author_id  ulid >users:null
    parent_id  ulid >discussions:null
    body       text !
    is_answer  bool ! =false
    upvotes    int ! =0
  `},
}},

{ key:'diary', group:'Academics', title:'Daily diary & early years', color:'#C2413B', year:1,
  desc:'Homework diary for all classes; kindergarten daily report (meals, nap, mood, toilet, photos); teacher remarks; guardian acknowledgement.',
  tables:{
  diary_entries:{ desc:'Per section per day: homework, notes, announcements — replaces the paper diary.', cols:`
    section_id   ulid ! >sections
    on_date      date !
    teacher_id   ulid >staff:null
    class_subject_id ulid >class_subjects:null
    entry_type   enum(homework|note|reminder|announcement) ! =homework
    body         text !
    attachments  json
    due_date     date
  `, index:[['section_id','on_date']] },
  diary_acknowledgements:{ ts:false, desc:'Guardian saw/acknowledged.', cols:`
    entry_id    ulid ! >diary_entries
    student_id  ulid ! >students
    guardian_id ulid >guardians:null
    acked_at    dt ! =now
  `, unique:[['entry_id','student_id']] },
  daily_reports:{ desc:'Early-years daily report per child (meals, nap, mood, activities, photos).', cols:`
    student_id  ulid ! >students
    on_date     date !
    meals       json
    nap_minutes small
    mood        enum(happy|calm|tired|upset|sick)
    activities  json
    toilet      json
    notes       text
    photos      json
    teacher_id  ulid >staff:null
    sent_at     dt
  `, unique:[['student_id','on_date']] },
  student_remarks:{ desc:'Teacher remarks/observations on a student (positive or concern) visible to guardians.', cols:`
    student_id  ulid ! >students
    teacher_id  ulid ! >staff
    on_date     date !
    remark      text !
    polarity    enum(positive|neutral|concern) ! =neutral
    visible_to_guardian bool ! =true
  `},
}},

{ key:'cocurricular', group:'Academics', title:'Co-curricular · clubs, sports, achievements, portfolio', color:'#B45309', year:2,
  desc:'Clubs and societies, sports teams and fixtures, house points, competitions, awards, student portfolio and skills badges.',
  tables:{
  clubs:{ desc:'Clubs/societies with advisor.', cols:`
    name        str(120) !
    category    enum(academic|sports|arts|social|tech|religious|other) ! =other
    advisor_id  ulid >staff:null
    description text
    meeting_schedule str(120)
    status      enum(active|inactive) ! =active
  `},
  club_memberships:{ ts:false, desc:'Members and roles.', cols:`
    club_id    ulid ! >clubs
    student_id ulid ! >students
    role       enum(member|secretary|president|captain) ! =member
    joined_on  date !
    left_on    date
  `, unique:[['club_id','student_id']] },
  competitions:{ desc:'Internal/external competitions and events with results.', cols:`
    name        str(200) !
    kind        enum(sports|academic|cultural|science|debate|olympiad|other) !
    level       enum(intra|inter_school|district|national|international) ! =intra
    held_on     date
    venue       str(160)
    organiser   str(160)
    event_id    ulid
  `},
  competition_results:{ ts:false, desc:'Placement per participant/team.', cols:`
    competition_id ulid ! >competitions
    student_id     ulid >students
    club_id        ulid >clubs
    house_id       ulid >houses
    position       small
    award          str(120)
    points         int ! =0
    certificate_doc_id ulid
  `},
  house_points:{ ts:false, desc:'Points ledger per house (behaviour, sports, competitions).', cols:`
    house_id    ulid ! >houses
    student_id  ulid >students
    points      int !
    reason      str(160) !
    source_type str(40)
    source_id   ulid
    awarded_by  ulid >staff:null
    awarded_at  dt ! =now
  `},
  achievements:{ desc:'Student achievements and awards (portfolio).', cols:`
    student_id  ulid ! >students
    title       str(200) !
    category    str(60)
    achieved_on date
    description text
    file_id     ulid >files:null
    verified_by ulid >staff:null
    is_public   bool ! =false
  `},
  skill_badges:{ desc:'Badge catalogue (e.g. Reading star, Coder L1).', cols:`
    name        str(80) !
    icon_file_id ulid >files:null
    criteria    text
  `},
  student_badges:{ ts:false, desc:'Badges earned.', cols:`
    badge_id   ulid ! >skill_badges
    student_id ulid ! >students
    awarded_by ulid >staff:null
    awarded_at dt ! =now
  `, unique:[['badge_id','student_id']] },
}},

{ key:'library', group:'Academics', title:'Library & e-library', color:'#6D28D9', year:1,
  desc:'Catalogue with copies and barcodes, members, issues/returns with fines to the student bill, reservations, e-books and reading logs.',
  tables:{
  library_categories:{ desc:'Category tree.', cols:`
    name      str(80) !
    parent_id ulid >library_categories:null
  `, unique:[['school_id','name']] },
  library_books:{ desc:'Title-level record.', cols:`
    isbn           str(20)
    title          str(255) !
    subtitle       str(255)
    authors        json
    publisher      str(160)
    edition        str(40)
    published_year small
    language       str(10) ! ='bn'
    category_id    ulid >library_categories:null
    subject_id     ulid >subjects:null
    class_id       ulid >classes:null
    pages          small
    price          money
    cover_file_id  ulid >files:null
    ebook_file_id  ulid >files:null
    description    text
    total_copies   int ! =0
    available_copies int ! =0
  `, index:[['school_id','title']] },
  library_book_copies:{ desc:'Physical copy with accession no and status.', cols:`
    book_id      ulid ! >library_books
    accession_no str(30) !
    barcode      str(40)
    rack         str(20)
    shelf        str(20)
    condition_note enum(new|good|fair|poor) ! =good
    status       enum(available|issued|reserved|lost|damaged|withdrawn) ! =available
    acquired_on  date
    source       enum(purchase|donation) ! =purchase
  `, unique:[['school_id','accession_no']] },
  library_members:{ desc:'Student or staff member with limits.', cols:`
    member_type  enum(student|staff|guardian) !
    student_id   ulid >students
    staff_id     ulid >staff
    card_no      str(30) !
    max_books    small ! =2
    loan_days    small ! =14
    fine_per_day money ! =5
    status       enum(active|blocked|inactive) ! =active
    blocked_reason str(120)
  `, unique:[['school_id','card_no']] },
  library_issues:{ desc:'Issue/return with fine accrual and reminder stage.', cols:`
    copy_id      ulid ! >library_book_copies:restrict
    member_id    ulid ! >library_members:restrict
    issued_at    dt ! =now
    due_at       date !
    returned_at  dt
    renew_count  small ! =0
    issued_by    ulid >users:null
    returned_to  ulid >users:null
    fine_amount  money ! =0
    fine_invoice_item_id ulid
    fine_waived_by ulid >users:null
    reminder_stage str(20)
    status       enum(issued|returned|lost|overdue) ! =issued
  `, index:[['school_id','due_at']] },
  library_reservations:{ desc:'Hold queue.', cols:`
    book_id     ulid ! >library_books
    member_id   ulid ! >library_members
    reserved_at dt ! =now
    notified_at dt
    expires_at  dt
    status      enum(waiting|ready|fulfilled|expired|cancelled) ! =waiting
  `},
  reading_logs:{ ts:false, desc:'Reading programme: pages read, reviews (reading badges).', cols:`
    student_id ulid ! >students
    book_id    ulid ! >library_books
    pages_read int ! =0
    finished   bool ! =false
    review     text
    rating     small
    logged_at  dt ! =now
  `},
}},
];
