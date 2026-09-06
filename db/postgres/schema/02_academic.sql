-- =====================================================================
--  02 · ACADEMIC STRUCTURE: years, terms, classes, sections, subjects, rooms, periods, calendar
-- =====================================================================

CREATE TABLE academic_years (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name        text NOT NULL,                           -- '2026' or '2026-27'
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  is_current  boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'planned',         -- planned | active | closed
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, name),
  CHECK (end_date > start_date)
);
CREATE UNIQUE INDEX ux_academic_year_current ON academic_years(school_id) WHERE is_current;

CREATE TABLE terms (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  name             text NOT NULL,                      -- 1st Term | Half-Yearly | Annual
  sequence         smallint NOT NULL,
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  UNIQUE (academic_year_id, sequence)
);

CREATE TABLE shifts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name        text NOT NULL,                           -- Morning | Day
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  UNIQUE (school_id, name)
);

-- Grade / class level: Play, Nursery, KG, 1..12
CREATE TABLE classes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name          text NOT NULL,                         -- 'Class 6'
  numeric_level smallint NOT NULL,                     -- ordering & promotion (-2 play, -1 nursery, 0 KG, 1..12)
  stream        text,                                  -- Science | Arts | Commerce (9+)
  status        record_status NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, name)
);

CREATE TABLE rooms (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  campus_id  uuid NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
  name       text NOT NULL,
  building   text,
  floor      text,
  capacity   smallint,
  room_type  text NOT NULL DEFAULT 'classroom',        -- classroom | lab | hall | library | office
  UNIQUE (campus_id, name)
);

CREATE TABLE sections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  class_id         uuid NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
  campus_id        uuid REFERENCES campuses(id) ON DELETE SET NULL,
  shift_id         uuid REFERENCES shifts(id) ON DELETE SET NULL,
  name             text NOT NULL,                      -- 'A', 'Rose'
  capacity         smallint NOT NULL DEFAULT 40,
  room_id          uuid REFERENCES rooms(id) ON DELETE SET NULL,
  class_teacher_id uuid,                               -- FK added in 03_people.sql
  gender_policy    text NOT NULL DEFAULT 'mixed',      -- mixed | boys | girls  (used by auto section allocation)
  status           record_status NOT NULL DEFAULT 'active',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (academic_year_id, class_id, name)
);

CREATE TABLE subjects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name         text NOT NULL,
  name_bn      text,
  code         text NOT NULL,                          -- BD board subject code e.g. '101' Bangla 1st
  subject_type text NOT NULL DEFAULT 'theory',         -- theory | practical | both | activity
  is_optional  boolean NOT NULL DEFAULT false,
  status       record_status NOT NULL DEFAULT 'active',
  UNIQUE (school_id, code)
);

-- Which subjects a class studies in a given year, and how they are marked
CREATE TABLE class_subjects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  class_id         uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id       uuid NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  is_compulsory    boolean NOT NULL DEFAULT true,
  full_marks       numeric(6,2) NOT NULL DEFAULT 100,
  pass_marks       numeric(6,2) NOT NULL DEFAULT 33,
  theory_marks     numeric(6,2),
  practical_marks  numeric(6,2),
  ca_marks         numeric(6,2),                       -- continuous assessment
  credit           numeric(4,2) NOT NULL DEFAULT 1,    -- weight in GPA
  weekly_periods   smallint NOT NULL DEFAULT 5,
  sequence         smallint NOT NULL DEFAULT 0,        -- order on report card
  UNIQUE (academic_year_id, class_id, subject_id)
);

-- Optional subject choice per student (e.g. Higher Math vs Agriculture)
CREATE TABLE student_optional_subjects (
  student_id       uuid NOT NULL,                      -- FK added in 03_people.sql
  class_subject_id uuid NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  PRIMARY KEY (student_id, class_subject_id)
);

CREATE TABLE periods (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  shift_id    uuid REFERENCES shifts(id) ON DELETE CASCADE,
  name        text NOT NULL,                           -- '1st', 'Tiffin'
  sequence    smallint NOT NULL,
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  is_break    boolean NOT NULL DEFAULT false,
  UNIQUE (school_id, shift_id, sequence)
);

CREATE TABLE houses (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name      text NOT NULL,
  color     text,
  UNIQUE (school_id, name)
);

-- Holidays, vacations, exam windows, events — drives attendance & billing automation
CREATE TABLE calendar_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid REFERENCES academic_years(id) ON DELETE CASCADE,
  title            text NOT NULL,
  event_type       text NOT NULL,                      -- holiday | vacation | exam | event | ptm | deadline
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  is_holiday       boolean NOT NULL DEFAULT false,     -- attendance auto = holiday, no reminders sent
  applies_to       jsonb NOT NULL DEFAULT '{}',        -- {"campus_ids":[], "class_ids":[], "audience":["staff"]}
  description      text,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX ix_calendar_dates ON calendar_events(school_id, start_date, end_date);

-- Weekly weekend definition per school (BD: Fri+Sat)
CREATE TABLE weekly_offs (
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),   -- 0 = Sunday
  PRIMARY KEY (school_id, day_of_week)
);
