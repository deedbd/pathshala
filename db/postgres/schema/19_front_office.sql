-- =====================================================================
--  19 · FRONT OFFICE & ALUMNI: visitors, calls, postal, complaints, alumni
-- =====================================================================

CREATE TABLE visitor_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  campus_id     uuid REFERENCES campuses(id) ON DELETE SET NULL,
  visitor_name  text NOT NULL,
  phone         text,
  id_proof      text,
  purpose       text NOT NULL,                         -- admission | meeting | delivery | pickup | other
  to_meet_staff_id uuid REFERENCES staff(id) ON DELETE SET NULL,
  student_id    uuid REFERENCES students(id) ON DELETE SET NULL,   -- early pickup → must be allowed guardian
  badge_no      text,
  photo_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  in_at         timestamptz NOT NULL DEFAULT now(),
  out_at        timestamptz,
  host_notified_at timestamptz,
  logged_by     uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE call_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  direction    text NOT NULL,                          -- inbound | outbound
  caller_name  text,
  phone        text NOT NULL,
  purpose      text,
  notes        text,
  related_type text,                                   -- enquiry | invoice | complaint
  related_id   uuid,
  follow_up_at timestamptz,
  logged_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  called_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE postal_records (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  direction   text NOT NULL,                           -- dispatch | receive
  reference_no text,
  from_party  text,
  to_party    text,
  subject     text,
  record_date date NOT NULL DEFAULT CURRENT_DATE,
  file_id     uuid REFERENCES files(id) ON DELETE SET NULL,
  logged_by   uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE complaints (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  ticket_no      text NOT NULL,
  complainant_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  complainant_name text,
  complainant_phone text,
  student_id     uuid REFERENCES students(id) ON DELETE SET NULL,
  category       text NOT NULL,                        -- academic | fees | transport | staff_behaviour | facility | other
  subject        text NOT NULL,
  description    text NOT NULL,
  priority       text NOT NULL DEFAULT 'normal',       -- low | normal | high | urgent
  assigned_to    uuid REFERENCES staff(id) ON DELETE SET NULL,
  sla_due_at     timestamptz,                          -- automation: escalate on breach
  escalated_at   timestamptz,
  status         text NOT NULL DEFAULT 'open',         -- open | in_progress | resolved | closed | reopened
  resolution     text,
  resolved_at    timestamptz,
  satisfaction   smallint,                             -- 1..5 from complainant
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, ticket_no)
);

CREATE TABLE complaint_updates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id uuid NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  by_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  note         text NOT NULL,
  is_internal  boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alumni (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id      uuid UNIQUE REFERENCES students(id) ON DELETE SET NULL,
  full_name       text NOT NULL,
  graduation_year smallint NOT NULL,
  last_class_id   uuid REFERENCES classes(id) ON DELETE SET NULL,
  phone           text,
  email           citext,
  current_organisation text,
  current_position text,                               -- "current_role" is reserved in Postgres
  city            text,
  linkedin_url    text,
  is_public       boolean NOT NULL DEFAULT false,
  is_mentor       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
