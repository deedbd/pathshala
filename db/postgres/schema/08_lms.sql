-- =====================================================================
--  08 · LEARNING: assignments, submissions, study materials, online classes
-- =====================================================================

CREATE TABLE assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  section_id       uuid NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  class_subject_id uuid NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  teacher_id       uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  title            text NOT NULL,
  description      text,
  attachments      uuid[] NOT NULL DEFAULT '{}',       -- files.id
  assigned_at      timestamptz NOT NULL DEFAULT now(),
  due_at           timestamptz NOT NULL,
  max_marks        numeric(6,2),
  allow_late       boolean NOT NULL DEFAULT true,
  late_penalty_pct numeric(5,2) NOT NULL DEFAULT 0,
  submission_type  text NOT NULL DEFAULT 'file',       -- file | text | both | offline
  status           text NOT NULL DEFAULT 'published',  -- draft | published | closed
  reminder_sent_at timestamptz,                        -- automation stamp (24h-before nudge)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_assignments_due ON assignments(school_id, due_at) WHERE status = 'published';

CREATE TABLE assignment_submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id    uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  is_late       boolean NOT NULL DEFAULT false,
  text_answer   text,
  attachments   uuid[] NOT NULL DEFAULT '{}',
  marks         numeric(6,2),
  feedback      text,
  graded_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  graded_at     timestamptz,
  status        text NOT NULL DEFAULT 'submitted',     -- submitted | graded | returned | resubmit
  UNIQUE (assignment_id, student_id)
);

CREATE TABLE study_materials (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_subject_id uuid REFERENCES class_subjects(id) ON DELETE CASCADE,
  section_id       uuid REFERENCES sections(id) ON DELETE CASCADE,   -- NULL = whole class
  unit_id          uuid REFERENCES syllabus_units(id) ON DELETE SET NULL,
  title            text NOT NULL,
  material_type    text NOT NULL,                      -- note | slide | video | link | book
  file_id          uuid REFERENCES files(id) ON DELETE SET NULL,
  external_url     text,
  uploaded_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at     timestamptz NOT NULL DEFAULT now(),
  view_count       integer NOT NULL DEFAULT 0
);

CREATE TABLE online_classes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  section_id       uuid NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  class_subject_id uuid REFERENCES class_subjects(id) ON DELETE SET NULL,
  teacher_id       uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  slot_id          uuid REFERENCES timetable_slots(id) ON DELETE SET NULL,   -- auto-created from timetable if enabled
  title            text NOT NULL,
  platform         text NOT NULL,                      -- zoom | google_meet | jitsi | bbb
  meeting_id       text,
  join_url         text,
  host_url         text,
  starts_at        timestamptz NOT NULL,
  duration_min     smallint NOT NULL DEFAULT 40,
  recording_url    text,
  status           text NOT NULL DEFAULT 'scheduled',  -- scheduled | live | ended | cancelled
  reminder_sent_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_online_classes_start ON online_classes(school_id, starts_at);

CREATE TABLE online_class_attendance (
  online_class_id uuid NOT NULL REFERENCES online_classes(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  joined_at       timestamptz,
  left_at         timestamptz,
  minutes         smallint,
  source          attendance_source NOT NULL DEFAULT 'device',   -- platform webhook
  PRIMARY KEY (online_class_id, student_id)
);
