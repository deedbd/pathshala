-- =====================================================================
--  07 · EXAMINATIONS: grading scales, exams, schedules, marks, results, promotion, question bank, online exams
-- =====================================================================

CREATE TABLE grading_scales (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name       text NOT NULL,                            -- 'BD Board GPA 5.0'
  is_default boolean NOT NULL DEFAULT false,
  gpa_max    numeric(4,2) NOT NULL DEFAULT 5.00,
  UNIQUE (school_id, name)
);

-- e.g. A+ 80-100 → 5.00 ; A 70-79 → 4.00 ; A- 60-69 → 3.50 ; B 50-59 → 3.00 ; C 40-49 → 2.00 ; D 33-39 → 1.00 ; F 0-32 → 0
CREATE TABLE grading_bands (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scale_id     uuid NOT NULL REFERENCES grading_scales(id) ON DELETE CASCADE,
  grade        text NOT NULL,
  min_percent  numeric(5,2) NOT NULL,
  max_percent  numeric(5,2) NOT NULL,
  grade_point  numeric(4,2) NOT NULL,
  is_fail      boolean NOT NULL DEFAULT false,
  remarks      text,
  UNIQUE (scale_id, grade),
  CHECK (max_percent >= min_percent)
);

CREATE TABLE exam_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name        text NOT NULL,                           -- Class Test | Half-Yearly | Annual | Model Test
  weight_pct  numeric(5,2) NOT NULL DEFAULT 100,       -- contribution to term/annual aggregate
  is_internal boolean NOT NULL DEFAULT false,
  UNIQUE (school_id, name)
);

CREATE TABLE exams (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  term_id          uuid REFERENCES terms(id) ON DELETE SET NULL,
  exam_type_id     uuid NOT NULL REFERENCES exam_types(id) ON DELETE RESTRICT,
  grading_scale_id uuid NOT NULL REFERENCES grading_scales(id) ON DELETE RESTRICT,
  name             text NOT NULL,
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  marks_entry_deadline timestamptz,
  publish_at       timestamptz,                        -- automation: results published at this time
  status           exam_status NOT NULL DEFAULT 'draft',
  require_fee_clearance boolean NOT NULL DEFAULT false, -- admit card only if no overdue invoices
  min_attendance_pct numeric(5,2),                     -- admit card eligibility
  rank_scope       text NOT NULL DEFAULT 'section',    -- section | class | both
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- A subject paper within an exam for a class (routine row)
CREATE TABLE exam_schedules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  exam_id          uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  class_subject_id uuid NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  exam_date        date,
  start_time       time,
  end_time         time,
  room_id          uuid REFERENCES rooms(id) ON DELETE SET NULL,
  full_marks       numeric(6,2) NOT NULL,
  pass_marks       numeric(6,2) NOT NULL,
  theory_marks     numeric(6,2),
  practical_marks  numeric(6,2),
  ca_marks         numeric(6,2),
  marks_entry_locked boolean NOT NULL DEFAULT false,
  UNIQUE (exam_id, class_subject_id)
);

CREATE TABLE exam_invigilators (
  schedule_id uuid NOT NULL REFERENCES exam_schedules(id) ON DELETE CASCADE,
  room_id     uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  staff_id    uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  PRIMARY KEY (schedule_id, room_id, staff_id)
);

CREATE TABLE exam_seat_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id     uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  room_id     uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seat_no     text NOT NULL,
  admit_card_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  is_eligible boolean NOT NULL DEFAULT true,
  ineligible_reason text,                              -- dues | attendance | suspended
  UNIQUE (exam_id, student_id),
  UNIQUE (exam_id, room_id, seat_no)
);

CREATE TABLE marks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  schedule_id       uuid NOT NULL REFERENCES exam_schedules(id) ON DELETE CASCADE,
  student_id        uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  theory_obtained   numeric(6,2),
  practical_obtained numeric(6,2),
  ca_obtained       numeric(6,2),
  total_obtained    numeric(6,2),                      -- computed by result engine
  is_absent         boolean NOT NULL DEFAULT false,
  grade             text,
  grade_point       numeric(4,2),
  is_pass           boolean,
  status            marks_status NOT NULL DEFAULT 'draft',
  entered_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  entered_at        timestamptz,
  verified_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at       timestamptz,
  remarks           text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, student_id)
);
CREATE INDEX ix_marks_student ON marks(student_id);

-- Aggregated result per student per exam (computed, then frozen on publish)
CREATE TABLE exam_results (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  exam_id          uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id       uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  section_id       uuid REFERENCES sections(id) ON DELETE SET NULL,
  total_full_marks numeric(8,2) NOT NULL,
  total_obtained   numeric(8,2) NOT NULL,
  percentage       numeric(5,2) NOT NULL,
  gpa              numeric(4,2),
  grade            text,
  failed_subjects  smallint NOT NULL DEFAULT 0,
  is_pass          boolean NOT NULL,
  rank_in_section  integer,
  rank_in_class    integer,
  attendance_pct   numeric(5,2),
  teacher_remark   text,
  principal_remark text,
  report_card_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  published_at     timestamptz,
  computed_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exam_id, student_id)
);
CREATE INDEX ix_exam_results_rank ON exam_results(exam_id, section_id, rank_in_section);

-- Year-end aggregate across weighted exams → promotion decision
CREATE TABLE promotion_rules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id           uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id    uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  class_id            uuid REFERENCES classes(id) ON DELETE CASCADE,   -- NULL = all classes
  min_gpa             numeric(4,2) NOT NULL DEFAULT 1.00,
  max_failed_subjects smallint NOT NULL DEFAULT 0,
  min_attendance_pct  numeric(5,2) NOT NULL DEFAULT 0,
  auto_apply          boolean NOT NULL DEFAULT false,  -- true = system promotes without manual review
  UNIQUE (academic_year_id, class_id)
);

CREATE TABLE promotions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id         uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  from_enrollment_id uuid NOT NULL REFERENCES student_enrollments(id) ON DELETE CASCADE,
  to_enrollment_id   uuid REFERENCES student_enrollments(id) ON DELETE SET NULL,
  decision           text NOT NULL,                    -- promoted | retained | graduated | conditional
  annual_gpa         numeric(4,2),
  is_auto            boolean NOT NULL DEFAULT false,
  decided_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at         timestamptz NOT NULL DEFAULT now(),
  note               text,
  UNIQUE (from_enrollment_id)
);

-- ---------- Question bank & online exams ----------
CREATE TABLE questions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  subject_id   uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  class_id     uuid REFERENCES classes(id) ON DELETE SET NULL,
  unit_id      uuid REFERENCES syllabus_units(id) ON DELETE SET NULL,
  q_type       text NOT NULL,                          -- mcq | true_false | short | long | fill_blank | match
  difficulty   text NOT NULL DEFAULT 'medium',         -- easy | medium | hard
  body         text NOT NULL,                          -- markdown / html
  options      jsonb,                                  -- [{"key":"a","text":"..."}]
  answer       jsonb,                                  -- {"key":"b"} or {"text":"..."} ; enables auto-grading
  marks        numeric(5,2) NOT NULL DEFAULT 1,
  tags         text[] NOT NULL DEFAULT '{}',
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_questions_subject ON questions(school_id, subject_id, class_id);

CREATE TABLE online_exams (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  schedule_id   uuid REFERENCES exam_schedules(id) ON DELETE SET NULL,   -- link to formal exam (marks sync)
  section_id    uuid NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  class_subject_id uuid NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  title         text NOT NULL,
  instructions  text,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  duration_min  smallint NOT NULL,
  total_marks   numeric(6,2) NOT NULL,
  shuffle_questions boolean NOT NULL DEFAULT true,
  auto_grade    boolean NOT NULL DEFAULT true,
  auto_publish  boolean NOT NULL DEFAULT false,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'draft',         -- draft | scheduled | live | closed | published
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE online_exam_questions (
  online_exam_id uuid NOT NULL REFERENCES online_exams(id) ON DELETE CASCADE,
  question_id    uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  sequence       smallint NOT NULL,
  marks          numeric(5,2) NOT NULL,
  PRIMARY KEY (online_exam_id, question_id)
);

CREATE TABLE online_exam_attempts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  online_exam_id uuid NOT NULL REFERENCES online_exams(id) ON DELETE CASCADE,
  student_id     uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  started_at     timestamptz NOT NULL DEFAULT now(),
  submitted_at   timestamptz,
  answers        jsonb NOT NULL DEFAULT '{}',          -- {question_id: answer}
  auto_score     numeric(6,2),
  manual_score   numeric(6,2),
  final_score    numeric(6,2),
  graded_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'in_progress',  -- in_progress | submitted | auto_graded | graded
  client_meta    jsonb NOT NULL DEFAULT '{}',          -- ip, tab-switch count, etc.
  UNIQUE (online_exam_id, student_id)
);
