-- =====================================================================
--  20 · AUTOMATION PLATFORM: outbox events, rules, runs, schedules, jobs, approvals, webhooks, integrations, reports
--  This is what makes "every section automated" possible: every module writes events here,
--  workers consume them, rules decide what to do.
-- =====================================================================

-- Transactional outbox. Written in the SAME transaction as the domain change.
CREATE TABLE outbox_events (
  id             bigserial PRIMARY KEY,
  event_id       uuid NOT NULL DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  event_type     text NOT NULL,                        -- student.enrolled | attendance.marked | invoice.overdue | payment.received ...
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  payload        jsonb NOT NULL,
  actor_user_id  uuid,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,                          -- relay → message broker (BullMQ/Redis or NATS)
  version        smallint NOT NULL DEFAULT 1
);
CREATE INDEX ix_outbox_unpublished ON outbox_events(id) WHERE published_at IS NULL;
CREATE INDEX ix_outbox_aggregate ON outbox_events(aggregate_type, aggregate_id);

-- Consumer idempotency: (consumer, event) processed once
CREATE TABLE event_consumptions (
  consumer   text NOT NULL,
  event_id   uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

-- User-configurable rules: WHEN <trigger> IF <conditions> THEN <actions>
CREATE TABLE automation_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text,
  trigger_kind  text NOT NULL,                         -- event | schedule | threshold
  event_type    text,                                  -- when trigger_kind = event
  cron          text,                                  -- when trigger_kind = schedule (school timezone)
  conditions    jsonb NOT NULL DEFAULT '{}',           -- JSONLogic over event payload / query result
  actions       jsonb NOT NULL,                        -- [{"type":"notify","template":"attendance.absent","to":"guardians"}, {"type":"create_task",...}]
  is_system     boolean NOT NULL DEFAULT false,        -- shipped defaults, editable but not deletable
  is_active     boolean NOT NULL DEFAULT true,
  priority      smallint NOT NULL DEFAULT 100,
  cooldown_minutes integer,                            -- avoid duplicate firing per aggregate
  run_count     bigint NOT NULL DEFAULT 0,
  last_run_at   timestamptz,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((trigger_kind = 'event' AND event_type IS NOT NULL) OR (trigger_kind <> 'event'))
);
CREATE INDEX ix_rules_event ON automation_rules(school_id, event_type) WHERE is_active;

CREATE TABLE automation_runs (
  id            bigserial PRIMARY KEY,
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  rule_id       uuid NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  trigger_event_id uuid,
  aggregate_type text,
  aggregate_id  uuid,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        job_status NOT NULL DEFAULT 'running',
  actions_result jsonb,
  error         text
);
CREATE INDEX ix_automation_runs_rule ON automation_runs(rule_id, started_at DESC);

-- Cron-driven system jobs (invoice generation, payroll, reminders, snapshots)
CREATE TABLE scheduled_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid REFERENCES schools(id) ON DELETE CASCADE,   -- NULL = platform-wide
  job_key      text NOT NULL,                          -- fees.generate_monthly_invoices | attendance.auto_absent | payroll.draft_run
  cron         text NOT NULL,
  timezone     text NOT NULL DEFAULT 'Asia/Dhaka',
  payload      jsonb NOT NULL DEFAULT '{}',
  is_active    boolean NOT NULL DEFAULT true,
  next_run_at  timestamptz,
  last_run_at  timestamptz,
  last_status  job_status,
  locked_until timestamptz,                            -- leader lock for multi-worker deployments
  UNIQUE (school_id, job_key)
);

-- Durable record of every background job (BullMQ holds the live queue; this is the audit/history)
CREATE TABLE background_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid REFERENCES schools(id) ON DELETE CASCADE,
  queue        text NOT NULL,                          -- notifications | billing | reports | pdf | sync
  job_name     text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  status       job_status NOT NULL DEFAULT 'pending',
  attempts     smallint NOT NULL DEFAULT 0,
  max_attempts smallint NOT NULL DEFAULT 5,
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  result       jsonb,
  error        text,
  triggered_by text,                                   -- rule:<id> | schedule:<key> | user:<id>
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_bg_jobs_status ON background_jobs(school_id, status, scheduled_for);

-- Generic multi-step approvals (leave, expense, refund, discount, PO, TC, disciplinary action)
CREATE TABLE approval_workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  entity_type text NOT NULL,                           -- leave_application | expense | refund | ...
  name        text NOT NULL,
  conditions  jsonb NOT NULL DEFAULT '{}',             -- e.g. {"amount_gt": 50000} picks this workflow
  steps       jsonb NOT NULL,                          -- [{"order":1,"approver":{"role":"hod"}},{"order":2,"approver":{"role":"principal"}}]
  auto_approve_after_hours integer,                    -- optional SLA auto-approve / escalate
  is_active   boolean NOT NULL DEFAULT true,
  UNIQUE (school_id, entity_type, name)
);

CREATE TABLE approval_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  workflow_id  uuid NOT NULL REFERENCES approval_workflows(id) ON DELETE RESTRICT,
  entity_type  text NOT NULL,
  entity_id    uuid NOT NULL,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  current_step smallint NOT NULL DEFAULT 1,
  status       approval_status NOT NULL DEFAULT 'pending',
  summary      jsonb NOT NULL DEFAULT '{}',            -- what approver sees (amount, dates, reason)
  due_at       timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id)
);
CREATE INDEX ix_approvals_pending ON approval_requests(school_id, status) WHERE status = 'pending';

CREATE TABLE approval_actions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  step       smallint NOT NULL,
  actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  decision   text NOT NULL,                            -- approved | rejected | delegated | auto_approved | escalated
  comment    text,
  acted_at   timestamptz NOT NULL DEFAULT now()
);

-- Internal to-dos generated by automation (call guardian about dues, verify document, review syllabus lag)
CREATE TABLE tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  title        text NOT NULL,
  description  text,
  task_type    text,                                   -- follow_up_call | verify_document | review | maintenance
  assigned_to  uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_role text,
  entity_type  text,
  entity_id    uuid,
  due_at       timestamptz,
  priority     text NOT NULL DEFAULT 'normal',
  status       text NOT NULL DEFAULT 'open',           -- open | in_progress | done | cancelled
  created_by   text NOT NULL DEFAULT 'system',         -- system | rule:<id> | user:<id>
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_tasks_assignee ON tasks(assigned_to, status);

CREATE TABLE integrations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  provider    text NOT NULL,                           -- zoom | google_workspace | microsoft365 | zkteco_cloud | gps_vendor | nbr_vat
  config      jsonb NOT NULL,                          -- encrypted
  status      text NOT NULL DEFAULT 'connected',
  last_sync_at timestamptz,
  last_error  text,
  UNIQUE (school_id, provider)
);

CREATE TABLE webhooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  url         text NOT NULL,
  secret      text NOT NULL,
  event_types text[] NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id            bigserial PRIMARY KEY,
  webhook_id    uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_id      uuid NOT NULL,
  attempt       smallint NOT NULL DEFAULT 1,
  response_code smallint,
  response_body text,
  delivered_at  timestamptz,
  next_retry_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name        text NOT NULL,
  key_prefix  text NOT NULL,
  key_hash    text NOT NULL UNIQUE,
  scopes      text[] NOT NULL DEFAULT '{}',
  expires_at  timestamptz,
  last_used_at timestamptz,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at  timestamptz
);

-- Saved & scheduled reports (weekly principal digest, monthly collection report ...)
CREATE TABLE report_definitions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name        text NOT NULL,
  module      text NOT NULL,
  definition  jsonb NOT NULL,                          -- query builder AST / named report + params
  format      text NOT NULL DEFAULT 'pdf',             -- pdf | xlsx | csv
  cron        text,                                    -- NULL = on-demand
  recipients  jsonb NOT NULL DEFAULT '[]',             -- [{"role":"principal"},{"user_id":"..."}]
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE report_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id uuid NOT NULL REFERENCES report_definitions(id) ON DELETE CASCADE,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  params        jsonb NOT NULL DEFAULT '{}',
  file_id       uuid REFERENCES files(id) ON DELETE SET NULL,
  row_count     integer
);

-- Daily KPI snapshot for dashboards & anomaly alerts (collection drop, attendance dip)
CREATE TABLE kpi_daily (
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  day              date NOT NULL,
  students_active  integer,
  attendance_pct   numeric(5,2),
  staff_attendance_pct numeric(5,2),
  fees_collected   numeric(14,2),
  fees_outstanding numeric(14,2),
  new_enquiries    integer,
  new_admissions   integer,
  sms_sent         integer,
  extra            jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (school_id, day)
);

-- Data import jobs (Excel student/staff bulk upload during onboarding)
CREATE TABLE import_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  entity_type  text NOT NULL,                          -- students | staff | guardians | marks | books
  file_id      uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  mapping      jsonb NOT NULL DEFAULT '{}',
  total_rows   integer,
  success_rows integer,
  error_rows   integer,
  errors_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  status       job_status NOT NULL DEFAULT 'pending',
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
