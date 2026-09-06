-- =====================================================================
--  PATHSHALA — School Management Platform
--  PostgreSQL 16 schema · file 00: extensions, enums, helper functions
--  Conventions:
--    * uuid primary keys (gen_random_uuid)
--    * every tenant table carries school_id; RLS policy attached in 99_finalize.sql
--    * created_at / updated_at on every mutable table; deleted_at = soft delete
--    * money = numeric(14,2); percentages = numeric(5,2); times = timestamptz
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid, crypt()
CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive emails
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- exclusion constraints (timetable clashes)
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- fuzzy name search

-- ---------- enums ----------
CREATE TYPE user_type            AS ENUM ('admin','staff','student','guardian');
CREATE TYPE record_status        AS ENUM ('active','inactive','archived');
CREATE TYPE gender_type          AS ENUM ('male','female','other');
CREATE TYPE student_status       AS ENUM ('applicant','active','suspended','graduated','transferred','dropped','alumni');
CREATE TYPE staff_status         AS ENUM ('active','probation','on_leave','resigned','terminated','retired');
CREATE TYPE staff_category       AS ENUM ('teaching','non_teaching','admin','support');
CREATE TYPE employment_type      AS ENUM ('permanent','contract','part_time','intern','volunteer');
CREATE TYPE attendance_status    AS ENUM ('present','absent','late','half_day','excused','holiday');
CREATE TYPE attendance_source    AS ENUM ('manual','device','app','import','system');
CREATE TYPE approval_status      AS ENUM ('pending','approved','rejected','cancelled');
CREATE TYPE exam_status          AS ENUM ('draft','scheduled','ongoing','marks_entry','processing','published','locked');
CREATE TYPE marks_status         AS ENUM ('draft','submitted','verified','locked');
CREATE TYPE invoice_status       AS ENUM ('draft','issued','partially_paid','paid','overdue','cancelled','written_off');
CREATE TYPE payment_method       AS ENUM ('cash','bank_transfer','cheque','card','bkash','nagad','rocket','upay','sslcommerz','stripe','adjustment','other');
CREATE TYPE payment_status       AS ENUM ('pending','success','failed','refunded','reversed');
CREATE TYPE fee_frequency        AS ENUM ('one_time','monthly','quarterly','half_yearly','yearly');
CREATE TYPE notification_channel AS ENUM ('sms','email','push','whatsapp','in_app');
CREATE TYPE notification_status  AS ENUM ('queued','sent','delivered','failed','read');
CREATE TYPE application_status   AS ENUM ('draft','submitted','screening','test_scheduled','tested','shortlisted','waitlisted','offered','accepted','enrolled','rejected','withdrawn');
CREATE TYPE job_status           AS ENUM ('pending','running','success','failed','cancelled');
CREATE TYPE gl_account_type      AS ENUM ('asset','liability','equity','income','expense');
CREATE TYPE journal_status       AS ENUM ('draft','posted','reversed');
CREATE TYPE payroll_status       AS ENUM ('draft','calculated','approved','paid','locked');
CREATE TYPE copy_status          AS ENUM ('available','issued','reserved','lost','damaged','withdrawn');
CREATE TYPE trip_type            AS ENUM ('pickup','drop','both');
CREATE TYPE stock_move_type      AS ENUM ('in','out','adjust','transfer','return');
CREATE TYPE person_type          AS ENUM ('student','staff','guardian');

-- ---------- helpers ----------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- Current tenant, set per request:  SET LOCAL app.school_id = '<uuid>'
CREATE OR REPLACE FUNCTION current_school_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.school_id', true), '')::uuid $$;

-- Attach updated_at trigger + tenant RLS policy to a table (used by 99_finalize.sql)
CREATE OR REPLACE FUNCTION tenant_table(tbl regclass) RETURNS void LANGUAGE plpgsql AS $$
DECLARE n text := replace(tbl::text, '.', '_');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = tbl AND attname = 'updated_at' AND NOT attisdropped) THEN
    EXECUTE format('CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION set_updated_at()', n, tbl);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = tbl AND attname = 'school_id' AND NOT attisdropped) THEN
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (school_id = current_school_id()) WITH CHECK (school_id = current_school_id())', tbl);
  END IF;
END $$;

-- Per-school sequential numbers (admission no, invoice no, receipt no ...)
CREATE TABLE number_sequences (
  school_id   uuid NOT NULL,
  key         text NOT NULL,            -- 'admission_no' | 'invoice' | 'receipt' | 'employee_no' | ...
  prefix      text NOT NULL DEFAULT '',
  next_value  bigint NOT NULL DEFAULT 1,
  padding     smallint NOT NULL DEFAULT 6,
  reset_yearly boolean NOT NULL DEFAULT false,
  year_tag    text,
  PRIMARY KEY (school_id, key)
);

CREATE OR REPLACE FUNCTION next_number(p_school uuid, p_key text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r number_sequences; v text;
BEGIN
  INSERT INTO number_sequences(school_id, key) VALUES (p_school, p_key) ON CONFLICT DO NOTHING;
  UPDATE number_sequences SET next_value = next_value + 1
   WHERE school_id = p_school AND key = p_key RETURNING * INTO r;
  v := r.prefix || COALESCE(r.year_tag || '-', '') || lpad((r.next_value - 1)::text, r.padding, '0');
  RETURN v;
END $$;
