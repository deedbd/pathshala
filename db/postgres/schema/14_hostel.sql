-- =====================================================================
--  14 · HOSTEL: buildings, rooms, beds, allocation, out-pass, visitors, mess
-- =====================================================================

CREATE TABLE hostels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  campus_id   uuid REFERENCES campuses(id) ON DELETE SET NULL,
  name        text NOT NULL,
  hostel_type text NOT NULL,                           -- boys | girls | staff
  warden_id   uuid REFERENCES staff(id) ON DELETE SET NULL,
  address     jsonb NOT NULL DEFAULT '{}',
  curfew_time time,                                    -- automation: late-return alert
  fee_head_id uuid REFERENCES fee_heads(id) ON DELETE SET NULL,
  status      record_status NOT NULL DEFAULT 'active',
  UNIQUE (school_id, name)
);

CREATE TABLE hostel_rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hostel_id   uuid NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  room_no     text NOT NULL,
  floor       text,
  room_type   text NOT NULL DEFAULT 'shared',          -- single | double | shared | dorm
  capacity    smallint NOT NULL,
  monthly_fee numeric(14,2) NOT NULL DEFAULT 0,
  amenities   text[] NOT NULL DEFAULT '{}',
  status      record_status NOT NULL DEFAULT 'active',
  UNIQUE (hostel_id, room_no)
);

CREATE TABLE hostel_beds (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES hostel_rooms(id) ON DELETE CASCADE,
  bed_no  text NOT NULL,
  status  text NOT NULL DEFAULT 'vacant',              -- vacant | occupied | maintenance
  UNIQUE (room_id, bed_no)
);

CREATE TABLE hostel_allocations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id       uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  bed_id           uuid NOT NULL REFERENCES hostel_beds(id) ON DELETE RESTRICT,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  from_date        date NOT NULL,
  to_date          date,
  monthly_fee      numeric(14,2) NOT NULL,             -- snapshot used by invoicing
  status           record_status NOT NULL DEFAULT 'active',
  created_at       timestamptz NOT NULL DEFAULT now(),
  EXCLUDE USING gist (bed_id WITH =, daterange(from_date, to_date, '[]') WITH &&)
);

CREATE TABLE hostel_outpasses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id     uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  hostel_id      uuid NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  leave_from     timestamptz NOT NULL,
  expected_return timestamptz NOT NULL,
  actual_out_at  timestamptz,
  actual_return_at timestamptz,
  reason         text NOT NULL,
  destination    text,
  guardian_consent_at timestamptz,                     -- guardian approves via app
  status         approval_status NOT NULL DEFAULT 'pending',
  approved_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  late_alert_sent_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hostel_visitors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hostel_id    uuid NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  student_id   uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  visitor_name text NOT NULL,
  relation     text,
  phone        text,
  id_proof     text,
  in_at        timestamptz NOT NULL DEFAULT now(),
  out_at       timestamptz,
  approved_by  uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE hostel_attendance (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hostel_id  uuid NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date       date NOT NULL,
  roll_call  text NOT NULL DEFAULT 'night',            -- morning | night
  status     attendance_status NOT NULL,
  marked_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (student_id, date, roll_call)
);

CREATE TABLE mess_menus (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hostel_id   uuid NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  meal        text NOT NULL,                           -- breakfast | lunch | dinner
  items       text NOT NULL,
  UNIQUE (hostel_id, day_of_week, meal)
);

CREATE TABLE hostel_complaints (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hostel_id   uuid NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  student_id  uuid REFERENCES students(id) ON DELETE SET NULL,
  category    text NOT NULL,                           -- maintenance | food | safety | other
  description text NOT NULL,
  status      text NOT NULL DEFAULT 'open',            -- open | in_progress | resolved
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
