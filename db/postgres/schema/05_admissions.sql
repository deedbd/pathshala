-- =====================================================================
--  05 · ADMISSIONS: campaign → enquiry → application → test → merit → offer → enrol
-- =====================================================================

CREATE TABLE admission_campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  name             text NOT NULL,                      -- 'Admission 2027'
  opens_at         timestamptz NOT NULL,
  closes_at        timestamptz NOT NULL,
  form_fee         numeric(14,2) NOT NULL DEFAULT 0,
  admission_fee_head_id uuid,                          -- soft ref → fee_heads (which head to invoice on offer)
  requires_test    boolean NOT NULL DEFAULT true,
  auto_merit_list  boolean NOT NULL DEFAULT true,
  auto_offer       boolean NOT NULL DEFAULT true,      -- offer top-N automatically after merit list
  offer_validity_days smallint NOT NULL DEFAULT 7,
  status           text NOT NULL DEFAULT 'draft',      -- draft | open | closed | archived
  public_form_slug text UNIQUE,                        -- online form URL
  form_schema      jsonb NOT NULL DEFAULT '[]',        -- dynamic extra fields
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Seats offered per class in a campaign (drives shortlist/waitlist automation)
CREATE TABLE admission_campaign_classes (
  campaign_id   uuid NOT NULL REFERENCES admission_campaigns(id) ON DELETE CASCADE,
  class_id      uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  seats         smallint NOT NULL,
  min_age_years numeric(4,1),
  max_age_years numeric(4,1),
  test_id       uuid,                                  -- FK added below
  PRIMARY KEY (campaign_id, class_id)
);

CREATE TABLE admission_enquiries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  campaign_id    uuid REFERENCES admission_campaigns(id) ON DELETE SET NULL,
  student_name   text NOT NULL,
  guardian_name  text NOT NULL,
  phone          text NOT NULL,
  email          citext,
  class_id       uuid REFERENCES classes(id) ON DELETE SET NULL,
  source         text,                                 -- walk_in | website | facebook | referral | call
  assigned_to    uuid REFERENCES staff(id) ON DELETE SET NULL,   -- auto round-robin
  status         text NOT NULL DEFAULT 'new',          -- new | contacted | visited | converted | lost
  next_follow_up_at timestamptz,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_enquiry_followup ON admission_enquiries(school_id, next_follow_up_at) WHERE status IN ('new','contacted','visited');

CREATE TABLE enquiry_followups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id  uuid NOT NULL REFERENCES admission_enquiries(id) ON DELETE CASCADE,
  note        text NOT NULL,
  channel     text,                                    -- call | visit | sms | email
  by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  next_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admission_applications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  campaign_id      uuid NOT NULL REFERENCES admission_campaigns(id) ON DELETE CASCADE,
  enquiry_id       uuid REFERENCES admission_enquiries(id) ON DELETE SET NULL,
  application_no   text NOT NULL,
  class_id         uuid NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
  shift_id         uuid REFERENCES shifts(id) ON DELETE SET NULL,
  -- applicant snapshot (copied into students on enrolment)
  first_name       text NOT NULL,
  last_name        text,
  gender           gender_type NOT NULL,
  date_of_birth    date NOT NULL,
  photo_file_id    uuid REFERENCES files(id) ON DELETE SET NULL,
  guardian_name    text NOT NULL,
  guardian_phone   text NOT NULL,
  guardian_email   citext,
  guardian_relation text,
  address          jsonb NOT NULL DEFAULT '{}',
  previous_school  jsonb NOT NULL DEFAULT '{}',
  extra_fields     jsonb NOT NULL DEFAULT '{}',        -- answers to campaign.form_schema
  sibling_student_id uuid REFERENCES students(id) ON DELETE SET NULL,   -- sibling priority rule
  status           application_status NOT NULL DEFAULT 'draft',
  form_fee_invoice_id uuid,                            -- FK added in 09_fees.sql
  test_score       numeric(6,2),
  merit_rank       integer,
  waitlist_position integer,
  student_id       uuid REFERENCES students(id) ON DELETE SET NULL,  -- set on enrolment
  submitted_at     timestamptz,
  decided_at       timestamptz,
  decided_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  rejection_reason text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, application_no)
);
CREATE INDEX ix_applications_status ON admission_applications(campaign_id, class_id, status);

CREATE TABLE application_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES admission_applications(id) ON DELETE CASCADE,
  doc_type       text NOT NULL,
  file_id        uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  verified_at    timestamptz,
  verified_by    uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE admission_tests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  campaign_id  uuid NOT NULL REFERENCES admission_campaigns(id) ON DELETE CASCADE,
  class_id     uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name         text NOT NULL,
  held_at      timestamptz NOT NULL,
  duration_min smallint,
  venue        text,
  total_marks  numeric(6,2) NOT NULL DEFAULT 100,
  pass_marks   numeric(6,2),
  components   jsonb NOT NULL DEFAULT '[]',            -- [{"name":"Written","marks":70},{"name":"Viva","marks":30}]
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE admission_campaign_classes ADD FOREIGN KEY (test_id) REFERENCES admission_tests(id) ON DELETE SET NULL;

CREATE TABLE admission_test_results (
  test_id        uuid NOT NULL REFERENCES admission_tests(id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES admission_applications(id) ON DELETE CASCADE,
  component_marks jsonb NOT NULL DEFAULT '{}',
  total_marks    numeric(6,2),
  is_absent      boolean NOT NULL DEFAULT false,
  remarks        text,
  entered_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  entered_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (test_id, application_id)
);

CREATE TABLE admission_offers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id              uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  application_id         uuid NOT NULL UNIQUE REFERENCES admission_applications(id) ON DELETE CASCADE,
  offered_at             timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL,          -- automation: auto-revoke + promote waitlist
  admission_fee_invoice_id uuid,                        -- FK added in 09_fees.sql
  offer_letter_file_id   uuid REFERENCES files(id) ON DELETE SET NULL,
  accepted_at            timestamptz,
  declined_at            timestamptz,
  revoked_at             timestamptz,
  revoke_reason          text
);
