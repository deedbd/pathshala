-- =====================================================================
--  17 · STUDENT WELFARE: behaviour & discipline, health, counselling
-- =====================================================================

CREATE TABLE behaviour_categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name         text NOT NULL,                          -- Helping others | Late homework | Bullying
  polarity     text NOT NULL,                          -- positive | negative
  default_points smallint NOT NULL DEFAULT 1,
  severity     text NOT NULL DEFAULT 'low',            -- low | medium | high | critical
  notify_guardian boolean NOT NULL DEFAULT true,
  UNIQUE (school_id, name)
);

CREATE TABLE behaviour_incidents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id    uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  category_id   uuid NOT NULL REFERENCES behaviour_categories(id) ON DELETE RESTRICT,
  incident_date date NOT NULL DEFAULT CURRENT_DATE,
  points        smallint NOT NULL,                     -- signed: +merit / -demerit
  description   text NOT NULL,
  reported_by   uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  witnesses     text,
  attachments   uuid[] NOT NULL DEFAULT '{}',
  guardian_notified_at timestamptz,
  status        text NOT NULL DEFAULT 'open',          -- open | under_review | actioned | closed
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_incidents_student ON behaviour_incidents(student_id, incident_date DESC);

CREATE TABLE disciplinary_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  incident_id  uuid REFERENCES behaviour_incidents(id) ON DELETE SET NULL,
  student_id   uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  action_type  text NOT NULL,                          -- verbal_warning | written_warning | detention | suspension | expulsion | counselling
  from_date    date,
  to_date      date,
  description  text,
  is_auto_proposed boolean NOT NULL DEFAULT false,     -- points threshold rule
  status       approval_status NOT NULL DEFAULT 'pending',
  approved_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  guardian_acknowledged_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Points thresholds → automatic consequence proposals
CREATE TABLE behaviour_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name           text NOT NULL,
  window_days    smallint NOT NULL DEFAULT 30,
  threshold_points smallint NOT NULL,                  -- e.g. -10 within 30 days
  action_type    text NOT NULL,                        -- detention | counselling | certificate_of_merit
  notify_roles   text[] NOT NULL DEFAULT '{class_teacher}',
  is_active      boolean NOT NULL DEFAULT true
);

CREATE TABLE health_records (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id   uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  recorded_on  date NOT NULL DEFAULT CURRENT_DATE,
  height_cm    numeric(5,1),
  weight_kg    numeric(5,1),
  bmi          numeric(4,1),
  vision_left  text,
  vision_right text,
  blood_pressure text,
  allergies    text[] NOT NULL DEFAULT '{}',
  chronic_conditions text[] NOT NULL DEFAULT '{}',
  medications  text,
  doctor_notes text,
  recorded_by  uuid REFERENCES staff(id) ON DELETE SET NULL
);

CREATE TABLE vaccinations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  vaccine      text NOT NULL,
  dose_no      smallint NOT NULL DEFAULT 1,
  given_on     date,
  next_due_on  date,                                   -- automation: due reminder
  certificate_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  UNIQUE (student_id, vaccine, dose_no)
);

CREATE TABLE clinic_visits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  person_type  person_type NOT NULL,
  student_id   uuid REFERENCES students(id) ON DELETE CASCADE,
  staff_id     uuid REFERENCES staff(id) ON DELETE CASCADE,
  visited_at   timestamptz NOT NULL DEFAULT now(),
  complaint    text NOT NULL,
  treatment    text,
  medicines_given jsonb NOT NULL DEFAULT '[]',         -- [{item_id, qty}] → stock_movements
  referred_to  text,
  sent_home    boolean NOT NULL DEFAULT false,
  guardian_notified_at timestamptz,
  attended_by  uuid REFERENCES staff(id) ON DELETE SET NULL
);

CREATE TABLE counselling_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id   uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  counsellor_id uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  session_at   timestamptz NOT NULL,
  referral_source text,                                -- self | teacher | behaviour_rule | result_drop | guardian
  notes_encrypted bytea,                               -- pgp_sym_encrypt at app layer; restricted role only
  follow_up_at timestamptz,
  status       text NOT NULL DEFAULT 'scheduled',      -- scheduled | done | no_show
  created_at   timestamptz NOT NULL DEFAULT now()
);
