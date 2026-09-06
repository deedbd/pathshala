-- =====================================================================
--  03 · PEOPLE: students, enrollments, guardians, staff, departments
-- =====================================================================

CREATE TABLE departments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name       text NOT NULL,                            -- Science, Accounts, Transport ...
  head_staff_id uuid,                                  -- FK added below
  UNIQUE (school_id, name)
);

CREATE TABLE designations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name       text NOT NULL,                            -- Principal, Assistant Teacher, Accountant
  level      smallint NOT NULL DEFAULT 0,              -- hierarchy for approval routing
  UNIQUE (school_id, name)
);

CREATE TABLE staff (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id          uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  employee_no      text NOT NULL,
  first_name       text NOT NULL,
  last_name        text,
  name_bn          text,
  gender           gender_type,
  date_of_birth    date,
  phone            text,
  email            citext,
  nid_no           text,                               -- national ID
  photo_file_id    uuid REFERENCES files(id) ON DELETE SET NULL,
  campus_id        uuid REFERENCES campuses(id) ON DELETE SET NULL,
  department_id    uuid REFERENCES departments(id) ON DELETE SET NULL,
  designation_id   uuid REFERENCES designations(id) ON DELETE SET NULL,
  reports_to_id    uuid REFERENCES staff(id) ON DELETE SET NULL,
  staff_category   staff_category NOT NULL DEFAULT 'teaching',
  employment_type  employment_type NOT NULL DEFAULT 'permanent',
  join_date        date NOT NULL,
  probation_end    date,
  leave_date       date,
  status           staff_status NOT NULL DEFAULT 'active',
  address          jsonb NOT NULL DEFAULT '{}',
  emergency_contact jsonb NOT NULL DEFAULT '{}',
  bank_details     jsonb NOT NULL DEFAULT '{}',        -- encrypted at app layer
  biometric_id     text,                               -- id on attendance device
  rfid_tag         text,
  meta             jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (school_id, employee_no)
);
CREATE INDEX ix_staff_dept ON staff(school_id, department_id, status);
ALTER TABLE departments ADD FOREIGN KEY (head_staff_id) REFERENCES staff(id) ON DELETE SET NULL;
ALTER TABLE sections    ADD FOREIGN KEY (class_teacher_id) REFERENCES staff(id) ON DELETE SET NULL;

CREATE TABLE staff_qualifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  degree      text NOT NULL,
  institution text,
  passing_year smallint,
  result      text,
  file_id     uuid REFERENCES files(id) ON DELETE SET NULL
);

-- Subjects a teacher is qualified to teach (used by timetable + substitution engine)
CREATE TABLE staff_subjects (
  staff_id   uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, subject_id)
);

CREATE TABLE staff_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  doc_type    text NOT NULL,                           -- nid | certificate | contract | police_clearance
  file_id     uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  expires_at  date,                                    -- automation: expiry reminders
  verified_by uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at timestamptz
);

CREATE TABLE students (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id            uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  admission_no       text NOT NULL,
  first_name         text NOT NULL,
  last_name          text,
  name_bn            text,
  gender             gender_type NOT NULL,
  date_of_birth      date NOT NULL,
  blood_group        text,
  religion           text,
  nationality        text NOT NULL DEFAULT 'Bangladeshi',
  birth_certificate_no text,
  photo_file_id      uuid REFERENCES files(id) ON DELETE SET NULL,
  admission_date     date NOT NULL DEFAULT CURRENT_DATE,
  admission_class_id uuid REFERENCES classes(id) ON DELETE SET NULL,
  -- denormalised "current" pointers, kept in sync by enrollment triggers/service
  current_academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL,
  current_class_id   uuid REFERENCES classes(id) ON DELETE SET NULL,
  current_section_id uuid REFERENCES sections(id) ON DELETE SET NULL,
  current_roll_no    text,
  house_id           uuid REFERENCES houses(id) ON DELETE SET NULL,
  status             student_status NOT NULL DEFAULT 'active',
  status_changed_at  timestamptz,
  status_reason      text,
  present_address    jsonb NOT NULL DEFAULT '{}',
  permanent_address  jsonb NOT NULL DEFAULT '{}',
  previous_school    jsonb NOT NULL DEFAULT '{}',      -- {name, class, year, tc_no}
  medical_info       jsonb NOT NULL DEFAULT '{}',      -- allergies, conditions (summary; details in health_records)
  biometric_id       text,
  rfid_tag           text,
  meta               jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  UNIQUE (school_id, admission_no)
);
CREATE INDEX ix_students_section ON students(school_id, current_section_id) WHERE status = 'active';
CREATE INDEX ix_students_name_trgm ON students USING gin ((first_name || ' ' || coalesce(last_name,'')) gin_trgm_ops);
ALTER TABLE student_optional_subjects ADD FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE;

-- One row per student per academic year = full academic history
CREATE TABLE student_enrollments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id         uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  academic_year_id   uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  class_id           uuid NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
  section_id         uuid REFERENCES sections(id) ON DELETE SET NULL,
  roll_no            text,
  enrolled_on        date NOT NULL DEFAULT CURRENT_DATE,
  left_on            date,
  status             text NOT NULL DEFAULT 'active',   -- active | promoted | retained | transferred | left | graduated
  promoted_from_id   uuid REFERENCES student_enrollments(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, academic_year_id)
);
CREATE UNIQUE INDEX ux_enrollment_roll ON student_enrollments(section_id, roll_no) WHERE roll_no IS NOT NULL AND status = 'active';

CREATE TABLE guardians (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id       uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  full_name     text NOT NULL,
  phone         text NOT NULL,
  alt_phone     text,
  email         citext,
  occupation    text,
  nid_no        text,
  monthly_income numeric(14,2),                       -- for need-based scholarship rules
  address       jsonb NOT NULL DEFAULT '{}',
  photo_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, phone)                            -- same phone = same guardian → sibling detection
);

CREATE TABLE student_guardians (
  student_id            uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  guardian_id           uuid NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  relation              text NOT NULL,                 -- father | mother | grandparent | uncle | legal_guardian
  is_primary            boolean NOT NULL DEFAULT false,
  is_emergency_contact  boolean NOT NULL DEFAULT false,
  can_pickup            boolean NOT NULL DEFAULT true,
  receives_notifications boolean NOT NULL DEFAULT true,
  pays_fees             boolean NOT NULL DEFAULT false,
  PRIMARY KEY (student_id, guardian_id)
);
CREATE UNIQUE INDEX ux_student_primary_guardian ON student_guardians(student_id) WHERE is_primary;

CREATE TABLE student_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  doc_type    text NOT NULL,                           -- birth_certificate | tc | photo | marksheet | medical
  file_id     uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  verified_by uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Siblings are derived (shared guardian) — this view powers sibling discounts
CREATE VIEW v_student_siblings AS
SELECT a.student_id, b.student_id AS sibling_id, a.guardian_id
FROM student_guardians a
JOIN student_guardians b ON a.guardian_id = b.guardian_id AND a.student_id <> b.student_id;
