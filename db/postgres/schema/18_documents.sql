-- =====================================================================
--  18 · DOCUMENTS: certificate templates, issued certificates (QR verifiable), ID cards, document requests
-- =====================================================================

CREATE TABLE document_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  doc_type      text NOT NULL,                         -- tc | testimonial | character | bonafide | id_card | admit_card | report_card | payslip | receipt | offer_letter | appointment_letter
  name          text NOT NULL,
  html_template text NOT NULL,                         -- handlebars/liquid with {{variables}}
  css           text,
  page_size     text NOT NULL DEFAULT 'A4',
  orientation   text NOT NULL DEFAULT 'portrait',
  variables     text[] NOT NULL DEFAULT '{}',
  is_default    boolean NOT NULL DEFAULT false,
  version       integer NOT NULL DEFAULT 1,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, doc_type, name)
);
CREATE UNIQUE INDEX ux_doc_template_default ON document_templates(school_id, doc_type) WHERE is_default;

-- Guardian/student asks for a TC / testimonial; eligibility checked automatically (dues, library, hostel)
CREATE TABLE document_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  doc_type      text NOT NULL,
  person_type   person_type NOT NULL,
  student_id    uuid REFERENCES students(id) ON DELETE CASCADE,
  staff_id      uuid REFERENCES staff(id) ON DELETE CASCADE,
  requested_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  reason        text,
  fee_invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  eligibility   jsonb,                                 -- {"dues_clear":false,"library_clear":true,...} filled by automation
  status        text NOT NULL DEFAULT 'requested',     -- requested | blocked | approved | issued | rejected
  approval_request_id uuid,
  decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE issued_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  template_id      uuid REFERENCES document_templates(id) ON DELETE SET NULL,
  request_id       uuid REFERENCES document_requests(id) ON DELETE SET NULL,
  doc_type         text NOT NULL,
  document_no      text NOT NULL,
  person_type      person_type NOT NULL,
  student_id       uuid REFERENCES students(id) ON DELETE SET NULL,
  staff_id         uuid REFERENCES staff(id) ON DELETE SET NULL,
  data_snapshot    jsonb NOT NULL,                     -- values rendered into the template (frozen)
  file_id          uuid REFERENCES files(id) ON DELETE SET NULL,
  verification_code text NOT NULL UNIQUE,              -- printed as QR → /verify/<code>
  issued_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  issued_at        timestamptz NOT NULL DEFAULT now(),
  valid_until      date,
  revoked_at       timestamptz,
  revoke_reason    text,
  UNIQUE (school_id, document_no)
);
CREATE INDEX ix_issued_docs_student ON issued_documents(student_id, doc_type);

CREATE TABLE id_cards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  person_type   person_type NOT NULL,
  student_id    uuid REFERENCES students(id) ON DELETE CASCADE,
  staff_id      uuid REFERENCES staff(id) ON DELETE CASCADE,
  guardian_id   uuid REFERENCES guardians(id) ON DELETE CASCADE,
  card_no       text NOT NULL,
  template_id   uuid REFERENCES document_templates(id) ON DELETE SET NULL,
  valid_from    date NOT NULL,
  valid_to      date NOT NULL,
  rfid_tag      text,
  file_id       uuid REFERENCES files(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'active',        -- pending_print | active | lost | expired | cancelled
  printed_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, card_no)
);
