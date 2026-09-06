-- =====================================================================
--  04 · TIMETABLE & CURRICULUM: teacher allocation, slots, substitutions, syllabus, lesson plans
-- =====================================================================

-- Who teaches which subject in which section this year
CREATE TABLE section_subject_teachers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  section_id       uuid NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  class_subject_id uuid NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  teacher_id       uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  is_primary       boolean NOT NULL DEFAULT true,
  UNIQUE (section_id, class_subject_id, teacher_id)
);

CREATE TABLE timetable_slots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  section_id       uuid NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  day_of_week      smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  period_id        uuid NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  class_subject_id uuid REFERENCES class_subjects(id) ON DELETE SET NULL,
  teacher_id       uuid REFERENCES staff(id) ON DELETE SET NULL,
  room_id          uuid REFERENCES rooms(id) ON DELETE SET NULL,
  effective_from   date NOT NULL DEFAULT CURRENT_DATE,
  effective_to     date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- a section has one thing per period per day
  UNIQUE (section_id, day_of_week, period_id, effective_from),
  -- a teacher cannot be in two sections in the same period (overlapping effective ranges)
  EXCLUDE USING gist (
    teacher_id WITH =, day_of_week WITH =, period_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (teacher_id IS NOT NULL),
  -- neither can a room
  EXCLUDE USING gist (
    room_id WITH =, day_of_week WITH =, period_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (room_id IS NOT NULL)
);
CREATE INDEX ix_timetable_teacher ON timetable_slots(teacher_id, day_of_week);

-- Day-specific override: teacher absent → substitute (auto-suggested from free, qualified teachers)
CREATE TABLE timetable_substitutions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id             uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  slot_id               uuid NOT NULL REFERENCES timetable_slots(id) ON DELETE CASCADE,
  date                  date NOT NULL,
  original_teacher_id   uuid REFERENCES staff(id) ON DELETE SET NULL,
  substitute_teacher_id uuid REFERENCES staff(id) ON DELETE SET NULL,
  reason                text,                          -- leave | training | unassigned
  leave_application_id  uuid,                          -- soft ref → leave_applications
  status                approval_status NOT NULL DEFAULT 'pending',
  is_auto_suggested     boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slot_id, date)
);

CREATE TABLE syllabi (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_subject_id uuid NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  term_id          uuid REFERENCES terms(id) ON DELETE SET NULL,
  title            text NOT NULL,
  file_id          uuid REFERENCES files(id) ON DELETE SET NULL,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE syllabus_units (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  syllabus_id   uuid NOT NULL REFERENCES syllabi(id) ON DELETE CASCADE,
  title         text NOT NULL,                         -- chapter / unit
  sequence      smallint NOT NULL,
  planned_periods smallint NOT NULL DEFAULT 1,
  planned_end_date date,                               -- automation: behind-schedule alerts
  UNIQUE (syllabus_id, sequence)
);

CREATE TABLE lesson_plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  teacher_id       uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  section_id       uuid NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  class_subject_id uuid NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  unit_id          uuid REFERENCES syllabus_units(id) ON DELETE SET NULL,
  plan_date        date NOT NULL,
  topic            text NOT NULL,
  objectives       text,
  activities       text,
  resources        jsonb NOT NULL DEFAULT '[]',        -- file ids / links
  homework         text,
  status           text NOT NULL DEFAULT 'planned',    -- planned | taught | skipped
  taught_at        timestamptz,
  reviewed_by      uuid REFERENCES staff(id) ON DELETE SET NULL,
  review_note      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_lesson_plans_teacher_date ON lesson_plans(teacher_id, plan_date);

-- Syllabus coverage per section (rolled up from lesson_plans.status = taught)
CREATE VIEW v_syllabus_progress AS
SELECT s.id AS syllabus_id, lp.section_id,
       count(DISTINCT su.id) AS total_units,
       count(DISTINCT su.id) FILTER (WHERE lp.status = 'taught') AS taught_units
FROM syllabi s
JOIN syllabus_units su ON su.syllabus_id = s.id
LEFT JOIN lesson_plans lp ON lp.unit_id = su.id
GROUP BY s.id, lp.section_id;
