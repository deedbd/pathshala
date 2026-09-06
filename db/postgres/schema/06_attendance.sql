-- =====================================================================
--  06 · ATTENDANCE & LEAVE: devices, raw punches, student/staff attendance, leave workflow
-- =====================================================================

CREATE TABLE attendance_devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  campus_id    uuid REFERENCES campuses(id) ON DELETE SET NULL,
  name         text NOT NULL,
  device_type  text NOT NULL,                          -- biometric | rfid | face | qr | gps_bus
  vendor       text,                                   -- zkteco | hikvision | custom
  serial_no    text UNIQUE,
  api_key_hash text,
  location     text,
  direction    text NOT NULL DEFAULT 'both',           -- in | out | both
  last_seen_at timestamptz,
  is_active    boolean NOT NULL DEFAULT true
);

-- Raw punches exactly as received; a worker resolves them into attendance rows
CREATE TABLE device_punch_logs (
  id           bigserial PRIMARY KEY,
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  device_id    uuid NOT NULL REFERENCES attendance_devices(id) ON DELETE CASCADE,
  identifier   text NOT NULL,                          -- biometric_id / rfid_tag
  punched_at   timestamptz NOT NULL,
  direction    text,
  raw_payload  jsonb,
  person_type  person_type,                            -- resolved
  person_id    uuid,
  processed_at timestamptz,
  error        text
);
CREATE INDEX ix_punch_unprocessed ON device_punch_logs(school_id) WHERE processed_at IS NULL;
CREATE INDEX ix_punch_person_time ON device_punch_logs(person_id, punched_at);

-- Daily student attendance (one row per student per day)
CREATE TABLE student_attendance (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  section_id  uuid REFERENCES sections(id) ON DELETE SET NULL,
  date        date NOT NULL,
  status      attendance_status NOT NULL,
  check_in    timestamptz,
  check_out   timestamptz,
  late_minutes smallint,
  source      attendance_source NOT NULL DEFAULT 'manual',
  marked_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  remarks     text,
  guardian_notified_at timestamptz,                    -- automation stamp (absent/late SMS)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, date)
);
CREATE INDEX ix_student_att_section_date ON student_attendance(section_id, date);
CREATE INDEX ix_student_att_student ON student_attendance(student_id, date DESC);

-- Optional period-wise attendance (college / subject-wise)
CREATE TABLE student_period_attendance (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  slot_id     uuid NOT NULL REFERENCES timetable_slots(id) ON DELETE CASCADE,
  date        date NOT NULL,
  status      attendance_status NOT NULL,
  marked_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, slot_id, date)
);

CREATE TABLE staff_attendance (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  staff_id         uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  date             date NOT NULL,
  status           attendance_status NOT NULL,
  check_in         timestamptz,
  check_out        timestamptz,
  late_minutes     smallint,
  early_leave_minutes smallint,
  work_minutes     smallint,
  overtime_minutes smallint,
  source           attendance_source NOT NULL DEFAULT 'manual',
  marked_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  remarks          text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_id, date)
);

-- Policies: cut-off times, thresholds, escalation. One per school+audience (+optional class)
CREATE TABLE attendance_policies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id             uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  audience              person_type NOT NULL,          -- student | staff
  class_id              uuid REFERENCES classes(id) ON DELETE CASCADE,
  shift_id              uuid REFERENCES shifts(id) ON DELETE CASCADE,
  late_after_minutes    smallint NOT NULL DEFAULT 15,
  half_day_after_minutes smallint NOT NULL DEFAULT 120,
  auto_absent_at        time,                          -- e.g. 10:30 → unmarked = absent, SMS guardian
  notify_on_arrival     boolean NOT NULL DEFAULT true,
  notify_on_absent      boolean NOT NULL DEFAULT true,
  notify_on_late        boolean NOT NULL DEFAULT true,
  consecutive_absent_alert smallint NOT NULL DEFAULT 3, -- escalate to class teacher
  min_attendance_pct    numeric(5,2) NOT NULL DEFAULT 75,
  block_exam_below_min  boolean NOT NULL DEFAULT false,
  late_count_to_lop     smallint,                      -- staff: N lates = 1 leave-without-pay
  is_active             boolean NOT NULL DEFAULT true
);

CREATE TABLE leave_types (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name              text NOT NULL,                     -- Casual | Sick | Earned | Maternity | Study
  code              text NOT NULL,
  audience          person_type NOT NULL,
  days_per_year     numeric(5,1) NOT NULL DEFAULT 0,
  accrual           text NOT NULL DEFAULT 'yearly',    -- yearly | monthly | none
  is_paid           boolean NOT NULL DEFAULT true,
  carry_forward_max numeric(5,1) NOT NULL DEFAULT 0,
  requires_document boolean NOT NULL DEFAULT false,
  min_notice_days   smallint NOT NULL DEFAULT 0,
  UNIQUE (school_id, code)
);

CREATE TABLE leave_balances (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  staff_id         uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  leave_type_id    uuid NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  allocated        numeric(5,1) NOT NULL DEFAULT 0,
  carried_forward  numeric(5,1) NOT NULL DEFAULT 0,
  used             numeric(5,1) NOT NULL DEFAULT 0,
  UNIQUE (staff_id, leave_type_id, academic_year_id)
);

CREATE TABLE leave_applications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  applicant_type  person_type NOT NULL,
  student_id      uuid REFERENCES students(id) ON DELETE CASCADE,
  staff_id        uuid REFERENCES staff(id) ON DELETE CASCADE,
  leave_type_id   uuid NOT NULL REFERENCES leave_types(id) ON DELETE RESTRICT,
  from_date       date NOT NULL,
  to_date         date NOT NULL,
  half_day        text,                                -- first | second | NULL
  days            numeric(5,1) NOT NULL,
  reason          text NOT NULL,
  document_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  applied_by      uuid REFERENCES users(id) ON DELETE SET NULL,   -- guardian for students
  status          approval_status NOT NULL DEFAULT 'pending',
  approval_request_id uuid,                            -- soft ref → approval_requests (20_platform)
  decided_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at      timestamptz,
  decision_note   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (to_date >= from_date),
  CHECK ((applicant_type = 'student' AND student_id IS NOT NULL) OR (applicant_type = 'staff' AND staff_id IS NOT NULL))
);
CREATE INDEX ix_leave_pending ON leave_applications(school_id, status) WHERE status = 'pending';
ALTER TABLE timetable_substitutions ADD FOREIGN KEY (leave_application_id) REFERENCES leave_applications(id) ON DELETE SET NULL;

-- Monthly attendance summary (materialised nightly; used by report cards, eligibility, alerts)
CREATE MATERIALIZED VIEW mv_student_attendance_monthly AS
SELECT school_id, student_id, date_trunc('month', date)::date AS month,
       count(*) FILTER (WHERE status IN ('present','late','half_day')) AS present_days,
       count(*) FILTER (WHERE status = 'absent')  AS absent_days,
       count(*) FILTER (WHERE status = 'late')    AS late_days,
       count(*) FILTER (WHERE status = 'excused') AS excused_days,
       count(*) FILTER (WHERE status <> 'holiday') AS working_days
FROM student_attendance
GROUP BY school_id, student_id, date_trunc('month', date);
CREATE UNIQUE INDEX ux_mv_att_monthly ON mv_student_attendance_monthly(student_id, month);
