# Pathshala schema reference

Generated from `db/schema/*.def.mjs` · 352 tables · 4068 columns · MySQL 8 / MariaDB 10.6+ (primary) and SQLite (fallback).

## Core · tenancy, identity, access

Every school is a tenant. Users log in by phone (OTP) or email; roles carry permissions; every change is audited.

### `schools`
One row per school (tenant). Settings JSON holds feature flags and policies.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| code | str(32) | required · unique · short slug, prefix for numbering |
| name | str(160) | required |
| name_bn | str(160) |  |
| institution_type | enum(school|college|school_college|madrasa|kindergarten|coaching|university) | required · default school |
| board | str(60) | Dhaka | Cambridge | Edexcel | Madrasah | IB |
| eiin | str(20) | BD Education Institute Identification Number |
| mpo_code | str(30) | MPO index for govt salary subsidy reporting |
| address | json |  |
| phone | str(30) |  |
| email | str(160) |  |
| website | str(160) |  |
| logo_file_id | ulid | → files (set after files exist) |
| timezone | str(40) | required · default 'Asia/Dhaka' |
| currency | str(3) | required · default 'BDT' |
| locale | str(10) | required · default 'bn' |
| plan_id | ulid | → saas_plans |
| status | enum(trial|active|suspended|closed) | required · default trial |
| trial_ends_at | dt |  |
| settings | json | policies, feature flags (see docs) |
| theme | json | brand colours, fonts, login background |
| custom_domain | str(160) | unique · white-label domain (CMS + portals) |
| onboarded_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |
| deleted_at | dt | Soft delete |

### `campuses`
Branches of one school; users can be scoped to a campus.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(120) | required |
| code | str(20) | required |
| address | json |  |
| phone | str(30) |  |
| is_main | bool | required · default false |
| status | enum(active|inactive) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `users`
Login identity for admins, staff, students and guardians. Phone is the primary login in Bangladesh.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| user_type | enum(admin|staff|student|guardian|alumni|vendor|api) | required |
| username | str(60) |  |
| email | str(160) |  |
| phone | str(20) |  |
| password_hash | str(255) |  |
| display_name | str(160) | required |
| avatar_file_id | ulid |  |
| locale | str(10) |  |
| is_active | bool | required · default true |
| email_verified_at | dt |  |
| phone_verified_at | dt |  |
| two_factor_secret | str(255) | TOTP secret (own implementation, pure JS) |
| two_factor_enabled | bool | required · default false |
| session_epoch | int | required · default 1 · bump to invalidate every session of this user |
| last_login_at | dt |  |
| failed_logins | small | required · default 0 |
| locked_until | dt |  |
| preferences | json | theme, language, notification prefs |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |
| deleted_at | dt | Soft delete |

### `roles`
Named permission sets (Principal, Accountant, Teacher…). System roles are seeded and protected.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(80) | required |
| slug | str(60) | required |
| description | text |  |
| is_system | bool | required · default false |
| level | small | required · default 0 · hierarchy used by approval routing |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `permissions`
Global catalogue: module.resource.action (fees.invoice.create).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| key_name | str(120) | required · unique |
| module | str(40) | required |
| description | str(255) |  |

### `role_permissions`
Role ↔ permission.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| role_id | ulid | required · → roles |
| permission_id | ulid | required · → permissions |

### `user_roles`
User ↔ role, optionally limited to a campus.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| user_id | ulid | required · → users |
| role_id | ulid | required · → roles |
| campus_id | ulid | → campuses |

### `auth_sessions`
Server sessions per device. Valid only while session.epoch == users.session_epoch.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| user_id | ulid | required · → users |
| token_hash | str(128) | required · unique |
| epoch | int | required · default 1 |
| device_name | str(120) |  |
| device_id | str(120) |  |
| platform | enum(web|android|ios|pwa|api) |  |
| ip | str(45) |  |
| user_agent | str(255) |  |
| expires_at | dt | required |
| revoked_at | dt |  |
| last_seen_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `push_subscriptions`
Web Push (VAPID) subscriptions per user/device; FCM/APNs tokens for native apps later.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| user_id | ulid | required · → users |
| kind | enum(webpush|fcm|apns) | required · default webpush |
| endpoint | str(500) | required |
| p256dh | str(255) |  |
| auth_key | str(255) |  |
| token | str(255) | FCM/APNs token when kind != webpush |
| user_agent | str(255) |  |
| last_used_at | dt |  |
| failed_count | small | required · default 0 |
| revoked_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `otp_codes`
One-time codes for login, verification, password reset, invites.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| user_id | ulid | → users |
| target | str(160) | required |
| channel | enum(sms|email|whatsapp) | required |
| purpose | enum(login|verify|reset|invite|consent) | required |
| code_hash | str(128) | required |
| attempts | small | required · default 0 |
| expires_at | dt | required |
| consumed_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `files`
Stored file metadata. Bytes live on local disk (shared hosting) or S3 when configured.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| uploaded_by | ulid | → users |
| disk | str(20) | required · default local |
| path | str(500) | required |
| file_name | str(255) | required |
| mime_type | str(120) | required |
| size_bytes | big | required |
| checksum | str(64) |  |
| visibility | enum(private|school|public) | required · default private |
| entity_type | str(60) | polymorphic owner |
| entity_id | ulid |  |
| purpose | str(60) | photo | document | receipt | report_card |
| width | int |  |
| height | int |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `settings`
Typed key/value policies per school (attendance.auto_absent_at, fees.reminder_stages…).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| key_name | str(120) | required |
| value | json |  |
| updated_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `custom_fields`
School-defined extra fields on any entity (student, staff, application…).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| entity_type | str(60) | required |
| field_key | str(60) | required |
| label | str(120) | required |
| label_bn | str(120) |  |
| field_type | enum(text|number|date|select|multiselect|bool|file|phone) | required |
| options | json |  |
| is_required | bool | required · default false |
| sort_order | small | required · default 0 |
| show_in_list | bool | required · default false |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `custom_field_values`
Values for custom fields.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| field_id | ulid | required · → custom_fields |
| entity_id | ulid | required |
| value | json |  |

### `audit_logs`
Append-only change log written by middleware for every mutation.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| actor_user_id | ulid |  |
| actor_type | enum(user|system|automation|api) | required · default user |
| action | str(40) | required |
| entity_type | str(60) | required |
| entity_id | ulid |  |
| before_data | json |  |
| after_data | json |  |
| ip | str(45) |  |
| user_agent | str(255) |  |
| request_id | str(64) |  |
| created_at | dt | required · default now |

### `number_sequences`
Per-school counters for admission no, invoice no, receipt no…

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| key_name | str(40) | required |
| prefix | str(20) | required · default '' |
| next_value | big | required · default 1 |
| padding | small | required · default 6 |
| reset_yearly | bool | required · default false |
| year_tag | str(10) |  |

### `translations`
Override UI strings per school and language (bn/en/ar).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| locale | str(10) | required |
| key_name | str(160) | required |
| value | text | required |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `feature_flags`
Platform-level flags with per-plan / per-school targeting.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| key_name | str(80) | required · unique |
| description | str(255) |  |
| default_on | bool | required · default false |
| targeting | json | {"plans":[],"schools":[],"percent":0} |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `installer_state`
Zero-touch installer progress (cPanel): DB detected, migrations, seeds, cron mode, health.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| step | str(60) | required · unique |
| status | enum(pending|done|failed|skipped) | required · default pending |
| detail | json |  |
| finished_at | dt |  |

### `system_health`
Self-check results (cron heartbeat, queue lag, disk, mail, SMS balance).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| check_key | str(60) | required · unique |
| status | enum(ok|warn|fail) | required · default ok |
| detail | json |  |
| checked_at | dt | required · default now |

## Automation platform · events, rules, jobs, approvals, workflows

The engine behind "every section automated": transactional outbox, editable rules, scheduler (real cron or request-driven heartbeat on shared hosting), approvals, tasks, webhooks, report builder.

### `outbox_events`
Domain events written in the same transaction as the change. Relay publishes to the job queue.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| event_uid | str(36) | required · unique |
| event_type | str(80) | required · student.enrolled, payment.received… |
| aggregate_type | str(60) | required |
| aggregate_id | ulid | required |
| payload | json |  |
| actor_user_id | ulid |  |
| occurred_at | dt | required · default now |
| published_at | dt |  |
| version | small | required · default 1 |

### `event_consumptions`
Idempotency: consumer × event processed once; failures count their attempts on one row.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| consumer | str(80) | required |
| event_uid | str(36) | required |
| attempts | small | required · default 1 |
| processed_at | dt | required · default now |

### `automation_rules`
WHEN trigger IF conditions (JSONLogic) THEN actions. Seeded system defaults are editable, not deletable.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| code | str(20) | required |
| name | str(160) | required |
| module | str(40) | required |
| description | text |  |
| trigger_kind | enum(event|schedule|threshold|manual) | required |
| event_type | str(80) |  |
| cron_expr | str(60) |  |
| conditions | json |  |
| actions | json |  |
| is_system | bool | required · default false |
| is_active | bool | required · default true |
| preview_until | dt | dry-run window after edits |
| priority | small | required · default 100 |
| cooldown_minutes | int |  |
| run_count | big | required · default 0 |
| last_run_at | dt |  |
| created_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `automation_runs`
One row per rule execution with result/error.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| rule_id | ulid | required · → automation_rules |
| trigger_event_uid | str(36) |  |
| aggregate_type | str(60) |  |
| aggregate_id | ulid |  |
| started_at | dt | required · default now |
| finished_at | dt |  |
| status | enum(running|success|failed|skipped|preview) | required · default running |
| actions_result | json |  |
| error | text |  |

### `scheduled_jobs`
Cron catalogue. On cPanel runs via one cron line or the request-driven heartbeat (web cron) with a lock.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| job_key | str(80) | required |
| cron_expr | str(60) | required |
| timezone | str(40) | required · default 'Asia/Dhaka' |
| payload | json |  |
| is_active | bool | required · default true |
| next_run_at | dt |  |
| last_run_at | dt |  |
| last_status | enum(success|failed|running) |  |
| last_duration_ms | int |  |
| locked_until | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `background_jobs`
Durable job queue (database driver on shared hosting). Long jobs run in chunks under 30 s each and resume from cursor.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| queue | str(40) | required |
| job_name | str(120) | required |
| payload | json |  |
| status | enum(pending|running|success|failed|cancelled|paused) | required · default pending |
| attempts | small | required · default 0 |
| max_attempts | small | required · default 5 |
| scheduled_for | dt | required · default now |
| started_at | dt |  |
| finished_at | dt |  |
| progress_pct | pct | required · default 0 |
| cursor | json | resume point for chunked work (last row id, page, sheet row) |
| total_items | int |  |
| done_items | int | required · default 0 |
| locked_until | dt |  |
| result | json |  |
| error | text |  |
| triggered_by | str(80) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `approval_workflows`
Multi-step approvals: which entity, which conditions pick this workflow, ordered approver steps.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| entity_type | str(60) | required |
| name | str(120) | required |
| conditions | json |  |
| steps | json | [{order:1, approver:{role:'hod'}}, {order:2, approver:{role:'principal'}}] |
| auto_approve_after_hours | int |  |
| escalate_after_hours | int |  |
| is_active | bool | required · default true |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `approval_requests`
A pending/decided approval for one entity.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| workflow_id | ulid | required · → approval_workflows |
| entity_type | str(60) | required |
| entity_id | ulid | required |
| requested_by | ulid | → users |
| current_step | small | required · default 1 |
| status | enum(pending|approved|rejected|cancelled|escalated) | required · default pending |
| summary | json |  |
| due_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `approval_actions`
Decision per step.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| request_id | ulid | required · → approval_requests |
| step | small | required |
| actor_id | ulid | → users |
| decision | enum(approved|rejected|delegated|auto_approved|escalated) | required |
| comment | text |  |
| acted_at | dt | required · default now |

### `tasks`
To-dos created by rules or people (call guardian, verify document, review lag).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| title | str(200) | required |
| description | text |  |
| task_type | str(40) |  |
| assigned_to | ulid | → users |
| assigned_role | str(60) |  |
| entity_type | str(60) |  |
| entity_id | ulid |  |
| due_at | dt |  |
| priority | enum(low|normal|high|urgent) | required · default normal |
| status | enum(open|in_progress|done|cancelled) | required · default open |
| created_by | str(80) | required · default system |
| completed_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `form_definitions`
No-code form builder (surveys, admission forms, feedback, custom registers).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(160) | required |
| slug | str(80) | required |
| purpose | enum(survey|admission|feedback|register|poll|consent|other) | required · default other |
| schema_json | json |  |
| audience | json |  |
| is_public | bool | required · default false |
| opens_at | dt |  |
| closes_at | dt |  |
| status | enum(draft|open|closed) | required · default draft |
| created_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `form_submissions`
Answers to a form.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| form_id | ulid | required · → form_definitions |
| submitted_by | ulid | → users |
| entity_type | str(60) |  |
| entity_id | ulid |  |
| answers | json |  |
| ip | str(45) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `workflow_definitions`
No-code workflow builder: states and transitions for custom processes.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(160) | required |
| entity_type | str(60) | required |
| states | json |  |
| transitions | json |  |
| is_active | bool | required · default true |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `webhooks`
Outbound webhooks to school ERPs / Zapier.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| url | str(500) | required |
| secret | str(128) | required |
| event_types | json |  |
| is_active | bool | required · default true |
| failure_count | int | required · default 0 |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `webhook_deliveries`
Delivery attempts.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| webhook_id | ulid | required · → webhooks |
| event_uid | str(36) | required |
| attempt | small | required · default 1 |
| response_code | small |  |
| response_body | text |  |
| delivered_at | dt |  |
| next_retry_at | dt |  |
| created_at | dt | required · default now |

### `integrations`
Connected providers (Zoom, Google, ZKTeco cloud, GPS vendor, gateways) with encrypted config.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| provider | str(60) | required |
| category | enum(meeting|sso|device|gps|payment|sms|email|storage|ai|accounting|other) | required |
| config | json |  |
| status | enum(connected|failed|disconnected) | required · default connected |
| last_sync_at | dt |  |
| last_error | text |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `api_keys`
Keys for third-party apps and integrations.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(120) | required |
| key_prefix | str(12) | required |
| key_hash | str(128) | required · unique |
| scopes | json |  |
| rate_limit_per_min | int | required · default 120 |
| expires_at | dt |  |
| last_used_at | dt |  |
| created_by | ulid | → users |
| revoked_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `report_definitions`
Report builder: saved queries/pivots with schedule and recipients.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(160) | required |
| module | str(40) | required |
| definition | json |  |
| output_format | enum(pdf|xlsx|csv|html) | required · default pdf |
| cron_expr | str(60) |  |
| recipients | json |  |
| is_system | bool | required · default false |
| created_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `report_snapshots`
Generated report files.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| definition_id | ulid | required · → report_definitions |
| params | json |  |
| file_id | ulid | → files |
| row_count | int |  |
| generated_at | dt | required · default now |

### `kpi_daily`
Daily KPI snapshot per school for dashboards and anomaly alerts.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| day | date | required |
| students_active | int |  |
| attendance_pct | pct |  |
| staff_attendance_pct | pct |  |
| fees_collected | money |  |
| fees_outstanding | money |  |
| new_enquiries | int |  |
| new_admissions | int |  |
| sms_sent | int |  |
| extra | json |  |

### `import_jobs`
Bulk Excel/CSV imports with mapping, validation and error file.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| entity_type | str(60) | required |
| file_id | ulid | required · → files |
| mapping | json |  |
| total_rows | int |  |
| success_rows | int |  |
| error_rows | int |  |
| errors_file_id | ulid | → files |
| status | enum(pending|validating|running|success|failed) | required · default pending |
| created_by | ulid | → users |
| finished_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `backups`
Automated backups (DB dump + files) to local, Google Drive, Dropbox or S3.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| kind | enum(database|files|full) | required |
| target | enum(local|gdrive|dropbox|s3) | required · default local |
| file_path | str(500) |  |
| size_bytes | big |  |
| status | enum(running|success|failed) | required · default running |
| started_at | dt | required · default now |
| finished_at | dt |  |
| error | text |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `notifications_queue_stats`
Hourly rollup of notification volume and cost (for the health page).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| hour | dt | required |
| channel | str(20) | required |
| sent | int | required · default 0 |
| delivered | int | required · default 0 |
| failed | int | required · default 0 |
| cost | money | required · default 0 |

## SaaS billing & partners

Sell the platform to many schools: plans, subscriptions, invoices to schools, resellers, white-label.

### `saas_plans`
Pricing plans with limits and enabled modules.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| name | str(80) | required · unique |
| price_monthly | money | required · default 0 |
| price_yearly | money | required · default 0 |
| currency | str(3) | required · default 'BDT' |
| student_limit | int |  |
| sms_included | int | required · default 0 |
| storage_gb | int | required · default 5 |
| modules | json |  |
| is_public | bool | required · default true |
| sort_order | small | required · default 0 |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `saas_subscriptions`
A school’s subscription to a plan.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| plan_id | ulid | required · → saas_plans |
| billing_cycle | enum(monthly|yearly) | required · default yearly |
| starts_at | date | required |
| ends_at | date |  |
| status | enum(trial|active|past_due|cancelled|expired) | required · default trial |
| auto_renew | bool | required · default true |
| price | money | required |
| discount_pct | pct | required · default 0 |
| reseller_id | ulid | → saas_partners |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `saas_invoices`
Invoices from the platform to the school.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| subscription_id | ulid | → saas_subscriptions |
| invoice_no | str(30) | required · unique |
| period_start | date | required |
| period_end | date | required |
| amount | money | required |
| tax | money | required · default 0 |
| total | money | required |
| status | enum(draft|issued|paid|overdue|void) | required · default issued |
| due_date | date | required |
| paid_at | dt |  |
| payment_ref | str(120) |  |
| pdf_file_id | ulid | → files |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `saas_usage`
Metered usage per month (students, SMS, storage, API calls).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| month | date | required |
| metric | str(40) | required |
| quantity | big | required · default 0 |

### `saas_partners`
Resellers / referral partners earning commission.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| name | str(160) | required |
| contact | json |  |
| commission_pct | pct | required · default 0 |
| referral_code | str(30) | required · unique |
| status | enum(active|inactive) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `saas_partner_payouts`
Commission payouts.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| partner_id | ulid | required · → saas_partners |
| period | date | required |
| amount | money | required |
| status | enum(pending|paid) | required · default pending |
| paid_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `saas_support_tickets`
Schools’ support requests to the platform team.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| subject | str(200) | required |
| body | text |  |
| priority | enum(low|normal|high|urgent) | required · default normal |
| status | enum(open|answered|closed) | required · default open |
| opened_by | ulid | → users |
| assigned_to | str(120) |  |
| closed_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

## Website & CMS

Every school gets a public website on its own domain: pages, news, gallery, notices, online admission form, results lookup, verification page.

### `cms_pages`
Public pages built from blocks.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| title | str(200) | required |
| slug | str(120) | required |
| locale | str(10) | required · default 'bn' |
| blocks | json |  |
| seo | json |  |
| is_home | bool | required · default false |
| status | enum(draft|published) | required · default draft |
| published_at | dt |  |
| author_id | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |
| deleted_at | dt | Soft delete |

### `cms_posts`
News, blog, achievements.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| title | str(200) | required |
| slug | str(120) | required |
| category | str(60) |  |
| excerpt | text |  |
| body | long |  |
| cover_file_id | ulid | → files |
| status | enum(draft|published) | required · default draft |
| published_at | dt |  |
| author_id | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |
| deleted_at | dt | Soft delete |

### `cms_menus`
Navigation menus.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(60) | required |
| items | json |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `cms_galleries`
Photo/video albums.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| title | str(200) | required |
| description | text |  |
| cover_file_id | ulid | → files |
| is_public | bool | required · default true |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `cms_gallery_items`
Album items.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| gallery_id | ulid | required · → cms_galleries |
| file_id | ulid | → files |
| video_url | str(500) |  |
| caption | str(255) |  |
| sort_order | small | required · default 0 |

### `cms_themes`
Website themes.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| name | str(80) | required · unique |
| preview_file_id | ulid |  |
| tokens | json |  |
| is_default | bool | required · default false |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `cms_domains`
Custom domains and SSL status for a school site.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| domain | str(160) | required · unique |
| is_primary | bool | required · default false |
| ssl_status | enum(pending|active|failed) | required · default pending |
| verified_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `cms_contact_messages`
Messages from the website contact form.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(160) | required |
| phone | str(30) |  |
| email | str(160) |  |
| message | text | required |
| status | enum(new|read|replied) | required · default new |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

## Academic structure

Years, terms/semesters, shifts, classes or programmes, sections/batches, subjects with credits, rooms, periods, calendar. Supports school (class-based), college (semester/credit), madrasa (hifz) and coaching (batch/course) in one model.

### `academic_years`
Session. Only one is current.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(20) | required |
| start_date | date | required |
| end_date | date | required |
| is_current | bool | required · default false |
| status | enum(planned|active|closed) | required · default planned |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `terms`
Terms (school) or semesters (college) inside a year.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| academic_year_id | ulid | required · → academic_years |
| name | str(60) | required |
| sequence | small | required |
| start_date | date | required |
| end_date | date | required |
| kind | enum(term|semester|trimester) | required · default term |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `shifts`
Morning / Day shifts with times.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(40) | required |
| start_time | time | required |
| end_time | time | required |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `programs`
College/university programmes (HSC Science, BBA…) or coaching courses. Schools may ignore.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(120) | required |
| code | str(20) | required |
| level | enum(secondary|higher_secondary|bachelor|master|diploma|coaching) | required |
| duration_terms | small |  |
| total_credits | dec(5,1) |  |
| department_id | ulid |  |
| status | enum(active|inactive) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `classes`
Grade level: Play, Nursery, KG, 1–12 (or programme year).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(60) | required |
| name_bn | str(60) |  |
| numeric_level | small | required |
| stream | str(40) | Science | Arts | Commerce | Hifz | Dakhil |
| program_id | ulid | → programs |
| status | enum(active|inactive) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `rooms`
Physical rooms; used by timetable, exams, events, bookings.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| campus_id | ulid | required · → campuses |
| name | str(60) | required |
| building | str(60) |  |
| floor | str(20) |  |
| capacity | small |  |
| room_type | enum(classroom|lab|hall|library|office|playground|other) | required · default classroom |
| amenities | json |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `sections`
Section (school) or batch (coaching) of a class in a year.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| academic_year_id | ulid | required · → academic_years |
| class_id | ulid | required · → classes |
| campus_id | ulid | → campuses |
| shift_id | ulid | → shifts |
| name | str(40) | required |
| capacity | small | required · default 40 |
| room_id | ulid | → rooms |
| class_teacher_id | ulid |  |
| gender_policy | enum(mixed|boys|girls) | required · default mixed |
| medium | enum(bangla|english|arabic) | required · default bangla |
| status | enum(active|inactive) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `subjects`
Subject catalogue with board codes.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(120) | required |
| name_bn | str(120) |  |
| code | str(20) | required |
| subject_type | enum(theory|practical|both|activity) | required · default theory |
| is_optional | bool | required · default false |
| department_id | ulid |  |
| status | enum(active|inactive) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `class_subjects`
Which subjects a class studies in a year and how they are marked (full/pass marks, theory/practical/CA split, credit).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| academic_year_id | ulid | required · → academic_years |
| class_id | ulid | required · → classes |
| subject_id | ulid | required · → subjects |
| is_compulsory | bool | required · default true |
| full_marks | dec(6,2) | required · default 100 |
| pass_marks | dec(6,2) | required · default 33 |
| theory_marks | dec(6,2) |  |
| practical_marks | dec(6,2) |  |
| ca_marks | dec(6,2) |  |
| credit | dec(4,2) | required · default 1 |
| weekly_periods | small | required · default 5 |
| sort_order | small | required · default 0 |
| assessment_mode | enum(marks|competency|both) | required · default marks · NCTB 2023+ competency-based support |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `student_subject_choices`
Optional/4th subject choice per student.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required |
| class_subject_id | ulid | required · → class_subjects |
| is_fourth | bool | required · default false |

### `periods`
Period grid per shift.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| shift_id | ulid | → shifts |
| name | str(30) | required |
| sequence | small | required |
| start_time | time | required |
| end_time | time | required |
| is_break | bool | required · default false |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `houses`
Houses for sports/points.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(60) | required |
| color | str(20) |  |
| points | int | required · default 0 |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `calendar_events`
Holidays, vacations, exam windows, events. Holidays drive attendance and reminder automation.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| academic_year_id | ulid | → academic_years |
| title | str(200) | required |
| event_type | enum(holiday|vacation|exam|event|ptm|deadline|meeting) | required |
| start_date | date | required |
| end_date | date | required |
| is_holiday | bool | required · default false |
| applies_to | json |  |
| description | text |  |
| created_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `weekly_offs`
Weekend days (BD: Fri, Sat).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| day_of_week | small | required |

### `hifz_progress`
Madrasa: Quran memorisation tracking per student (para/surah/ayah, revision).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required |
| recorded_on | date | required |
| para | small |  |
| surah | small |  |
| ayah_from | small |  |
| ayah_to | small |  |
| kind | enum(new|revision|test) | required · default new |
| quality | enum(excellent|good|fair|weak) |  |
| teacher_id | ulid |  |
| remarks | text |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

## People · students, guardians, staff

Students with one enrollment per year (history), guardians keyed by phone (siblings derived), staff with departments, designations, qualifications and documents.

### `departments`
Academic and admin departments.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(80) | required |
| head_staff_id | ulid |  |
| kind | enum(academic|admin|support) | required · default academic |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `designations`
Job titles with hierarchy level.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(80) | required |
| level | small | required · default 0 |
| category | enum(teaching|non_teaching|admin|support) | required · default teaching |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `staff`
Employee master.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| user_id | ulid | unique · → users |
| employee_no | str(30) | required |
| first_name | str(80) | required |
| last_name | str(80) |  |
| name_bn | str(160) |  |
| gender | enum(male|female|other) |  |
| date_of_birth | date |  |
| phone | str(20) |  |
| email | str(160) |  |
| nid_no | str(30) |  |
| photo_file_id | ulid | → files |
| campus_id | ulid | → campuses |
| department_id | ulid | → departments |
| designation_id | ulid | → designations |
| reports_to_id | ulid | → staff |
| staff_category | enum(teaching|non_teaching|admin|support) | required · default teaching |
| employment_type | enum(permanent|contract|part_time|intern|volunteer|mpo) | required · default permanent |
| mpo_index_no | str(30) | MPO listed teacher index |
| join_date | date | required |
| probation_end | date |  |
| leave_date | date |  |
| status | enum(active|probation|on_leave|resigned|terminated|retired) | required · default active |
| address | json |  |
| emergency_contact | json |  |
| bank_details | json |  |
| biometric_id | str(40) |  |
| rfid_tag | str(40) |  |
| meta | json |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |
| deleted_at | dt | Soft delete |

### `staff_qualifications`
Degrees.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| staff_id | ulid | required · → staff |
| degree | str(120) | required |
| institution | str(160) |  |
| passing_year | small |  |
| result | str(40) |  |
| file_id | ulid | → files |

### `staff_subjects`
Subjects a teacher can teach (timetable + substitution engine).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| staff_id | ulid | required · → staff |
| subject_id | ulid | required · → subjects |
| preference | small | required · default 1 |

### `staff_documents`
NID, certificates, contracts with expiry reminders.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| staff_id | ulid | required · → staff |
| doc_type | str(60) | required |
| file_id | ulid | required · → files |
| expires_at | date |  |
| verified_by | ulid | → users |
| verified_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `students`
Student master with denormalised current pointers.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| user_id | ulid | unique · → users |
| admission_no | str(30) | required |
| first_name | str(80) | required |
| last_name | str(80) |  |
| name_bn | str(160) |  |
| gender | enum(male|female|other) | required |
| date_of_birth | date | required |
| blood_group | str(5) |  |
| religion | str(30) |  |
| nationality | str(40) | required · default 'Bangladeshi' |
| birth_certificate_no | str(30) |  |
| nid_no | str(30) |  |
| photo_file_id | ulid | → files |
| admission_date | date | required |
| admission_class_id | ulid | → classes |
| current_academic_year_id | ulid | → academic_years |
| current_class_id | ulid | → classes |
| current_section_id | ulid | → sections |
| current_roll_no | str(10) |  |
| house_id | ulid | → houses |
| status | enum(applicant|active|suspended|graduated|transferred|dropped|alumni) | required · default active |
| status_changed_at | dt |  |
| status_reason | str(255) |  |
| present_address | json |  |
| permanent_address | json |  |
| previous_school | json |  |
| medical_summary | json |  |
| special_needs | json | accommodations, IEP flag |
| biometric_id | str(40) |  |
| rfid_tag | str(40) |  |
| wallet_id | ulid | → wallets |
| meta | json |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |
| deleted_at | dt | Soft delete |

### `student_enrollments`
One row per student per academic year: class, section, roll. Full history.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| academic_year_id | ulid | required · → academic_years |
| class_id | ulid | required · → classes |
| section_id | ulid | → sections |
| program_id | ulid | → programs |
| roll_no | str(10) |  |
| enrolled_on | date | required |
| left_on | date |  |
| status | enum(active|promoted|retained|transferred|left|graduated) | required · default active |
| promoted_from_id | ulid | → student_enrollments |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `guardians`
Guardian keyed by phone; same phone = same guardian = siblings.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| user_id | ulid | unique · → users |
| full_name | str(160) | required |
| phone | str(20) | required |
| alt_phone | str(20) |  |
| email | str(160) |  |
| occupation | str(80) |  |
| nid_no | str(30) |  |
| monthly_income | money |  |
| address | json |  |
| photo_file_id | ulid | → files |
| is_staff | bool | required · default false · staff-child discount rule |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `student_guardians`
Student ↔ guardian with relation and rights.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| guardian_id | ulid | required · → guardians |
| relation | enum(father|mother|grandparent|sibling|uncle|aunt|legal_guardian|other) | required |
| is_primary | bool | required · default false |
| is_emergency | bool | required · default false |
| can_pickup | bool | required · default true |
| receives_notifications | bool | required · default true |
| pays_fees | bool | required · default false |

### `pickup_authorisations`
KG/primary: who may collect the child; photo + ID; one-time passes.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| person_name | str(160) | required |
| relation | str(60) |  |
| phone | str(20) |  |
| photo_file_id | ulid | → files |
| id_proof | str(60) |  |
| valid_from | date |  |
| valid_to | date |  |
| is_one_time | bool | required · default false |
| approved_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `student_documents`
Uploaded student documents with verification.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| doc_type | str(60) | required |
| file_id | ulid | required · → files |
| verified_by | ulid | → users |
| verified_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `student_status_history`
Every status change (suspended, transferred…) with reason.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| from_status | str(20) |  |
| to_status | str(20) | required |
| reason | str(255) |  |
| changed_by | ulid | → users |
| changed_at | dt | required · default now |

## Curriculum & timetable

Teacher allocation, timetable with clash rules and auto-generation, substitutions, syllabus units, learning outcomes/competencies (NCTB 2023+), lesson plans.

### `section_subject_teachers`
Who teaches which subject in which section this year.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| section_id | ulid | required · → sections |
| class_subject_id | ulid | required · → class_subjects |
| teacher_id | ulid | required · → staff |
| is_primary | bool | required · default true |

### `timetable_versions`
Published versions of the timetable; auto-generator writes drafts.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| academic_year_id | ulid | required · → academic_years |
| name | str(80) | required |
| effective_from | date | required |
| effective_to | date |  |
| status | enum(draft|published|archived) | required · default draft |
| generated_by | enum(manual|auto) | required · default manual |
| constraints | json |  |
| score | dec(6,2) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `timetable_slots`
Section × day × period → subject, teacher, room. App enforces no teacher/room double booking.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| version_id | ulid | required · → timetable_versions |
| section_id | ulid | required · → sections |
| day_of_week | small | required |
| period_id | ulid | required · → periods |
| class_subject_id | ulid | → class_subjects |
| teacher_id | ulid | → staff |
| room_id | ulid | → rooms |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `timetable_substitutions`
Day-specific override when a teacher is absent; auto-suggested from free, qualified teachers.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| slot_id | ulid | required · → timetable_slots |
| on_date | date | required |
| original_teacher_id | ulid | → staff |
| substitute_teacher_id | ulid | → staff |
| reason | str(60) |  |
| leave_application_id | ulid |  |
| status | enum(suggested|pending|approved|rejected|cancelled) | required · default suggested |
| is_auto_suggested | bool | required · default false |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `syllabi`
Syllabus per class-subject and term.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| class_subject_id | ulid | required · → class_subjects |
| term_id | ulid | → terms |
| title | str(200) | required |
| file_id | ulid | → files |
| created_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `syllabus_units`
Chapters/units with planned end dates (behind-schedule alerts).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| syllabus_id | ulid | required · → syllabi |
| title | str(200) | required |
| sequence | small | required |
| planned_periods | small | required · default 1 |
| planned_end_date | date |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `learning_outcomes`
Competencies / performance indicators (NCTB 2023 curriculum) mapped to units and Bloom level.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| class_subject_id | ulid | required · → class_subjects |
| unit_id | ulid | → syllabus_units |
| code | str(30) | required |
| statement | text | required |
| statement_bn | text |  |
| bloom_level | enum(remember|understand|apply|analyse|evaluate|create) |  |
| weight | dec(4,2) | required · default 1 |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `lesson_plans`
Teacher lesson plans by date with outcomes, resources, homework and review.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| teacher_id | ulid | required · → staff |
| section_id | ulid | required · → sections |
| class_subject_id | ulid | required · → class_subjects |
| unit_id | ulid | → syllabus_units |
| plan_date | date | required |
| topic | str(200) | required |
| objectives | text |  |
| activities | text |  |
| outcomes | json |  |
| resources | json |  |
| homework | text |  |
| status | enum(planned|taught|skipped) | required · default planned |
| taught_at | dt |  |
| reviewed_by | ulid | → staff |
| review_note | text |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `syllabus_progress`
Rollup: units taught per section (refreshed by scheduler).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| syllabus_id | ulid | required · → syllabi |
| section_id | ulid | required · → sections |
| total_units | small | required · default 0 |
| taught_units | small | required · default 0 |
| pct | pct | required · default 0 |
| refreshed_at | dt | required · default now |

## Admissions & enquiry CRM

Campaign → enquiry → online application (public form, form fee) → test/interview → merit list → offer with expiry → enrolment, all automated; waitlist promotion; sibling priority; lottery mode (govt-style).

### `admission_campaigns`
A season with seats per class, fees, test settings and selection mode.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| academic_year_id | ulid | required · → academic_years |
| name | str(120) | required |
| opens_at | dt | required |
| closes_at | dt | required |
| form_fee | money | required · default 0 |
| admission_fee_head_id | ulid |  |
| selection_mode | enum(test|lottery|first_come|interview|mixed) | required · default test |
| requires_test | bool | required · default true |
| auto_merit_list | bool | required · default true |
| auto_offer | bool | required · default true |
| offer_validity_days | small | required · default 7 |
| sibling_priority | bool | required · default true |
| status | enum(draft|open|closed|archived) | required · default draft |
| public_form_slug | str(80) | unique |
| form_schema | json |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `admission_campaign_classes`
Seats and age limits per class.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| campaign_id | ulid | required · → admission_campaigns |
| class_id | ulid | required · → classes |
| seats | small | required |
| min_age_years | dec(4,1) |  |
| max_age_years | dec(4,1) |  |
| test_id | ulid |  |

### `admission_enquiries`
Lead with source, counsellor (round-robin) and follow-up date.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| campaign_id | ulid | → admission_campaigns |
| student_name | str(160) | required |
| guardian_name | str(160) | required |
| phone | str(20) | required |
| email | str(160) |  |
| class_id | ulid | → classes |
| source | enum(walk_in|website|facebook|referral|call|whatsapp|event|other) | required · default other |
| assigned_to | ulid | → staff |
| status | enum(new|contacted|visited|converted|lost) | required · default new |
| lost_reason | str(120) |  |
| next_follow_up_at | dt |  |
| notes | text |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `enquiry_followups`
Interaction log.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| enquiry_id | ulid | required · → admission_enquiries |
| note | text | required |
| channel | enum(call|visit|sms|email|whatsapp) |  |
| by_user_id | ulid | → users |
| next_at | dt |  |
| created_at | dt | required · default now |

### `admission_applications`
Application with applicant snapshot, pipeline status, score, rank, waitlist.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| campaign_id | ulid | required · → admission_campaigns |
| enquiry_id | ulid | → admission_enquiries |
| application_no | str(30) | required |
| class_id | ulid | required · → classes |
| shift_id | ulid | → shifts |
| first_name | str(80) | required |
| last_name | str(80) |  |
| gender | enum(male|female|other) | required |
| date_of_birth | date | required |
| photo_file_id | ulid | → files |
| guardian_name | str(160) | required |
| guardian_phone | str(20) | required |
| guardian_email | str(160) |  |
| guardian_relation | str(30) |  |
| address | json |  |
| previous_school | json |  |
| extra_fields | json |  |
| sibling_student_id | ulid | → students |
| status | enum(draft|submitted|screening|test_scheduled|tested|shortlisted|waitlisted|offered|accepted|enrolled|rejected|withdrawn) | required · default draft |
| form_fee_invoice_id | ulid |  |
| test_score | dec(6,2) |  |
| merit_rank | int |  |
| lottery_no | str(20) |  |
| waitlist_position | int |  |
| student_id | ulid | → students |
| submitted_at | dt |  |
| decided_at | dt |  |
| decided_by | ulid | → users |
| rejection_reason | str(255) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `application_documents`
Uploaded applicant documents.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| application_id | ulid | required · → admission_applications |
| doc_type | str(60) | required |
| file_id | ulid | required · → files |
| verified_at | dt |  |
| verified_by | ulid | → users |

### `admission_tests`
Entrance test/interview with components.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| campaign_id | ulid | required · → admission_campaigns |
| class_id | ulid | required · → classes |
| name | str(120) | required |
| held_at | dt | required |
| duration_min | small |  |
| venue | str(120) |  |
| total_marks | dec(6,2) | required · default 100 |
| pass_marks | dec(6,2) |  |
| components | json |  |
| online_exam_id | ulid |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `admission_test_results`
Score per applicant.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| test_id | ulid | required · → admission_tests |
| application_id | ulid | required · → admission_applications |
| component_marks | json |  |
| total_marks | dec(6,2) |  |
| is_absent | bool | required · default false |
| remarks | str(255) |  |
| entered_by | ulid | → users |
| entered_at | dt | required · default now |

### `admission_interviews`
Interview slots per applicant: when, where, who sits on the panel, and how it went.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| test_id | ulid | required · → admission_tests |
| application_id | ulid | → admission_applications |
| starts_at | dt | required |
| ends_at | dt | required |
| venue | str(120) |  |
| panel | json |  |
| status | enum(open|booked|attended|no_show|cancelled) | required · default open |
| notes | str(255) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `admission_offers`
Offer with expiry; auto-revoked and waitlist promoted when unpaid.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| application_id | ulid | required · unique · → admission_applications |
| offered_at | dt | required · default now |
| expires_at | dt | required |
| admission_fee_invoice_id | ulid |  |
| offer_letter_file_id | ulid | → files |
| accepted_at | dt |  |
| declined_at | dt |  |
| revoked_at | dt |  |
| revoke_reason | str(120) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

## Attendance & leave

Raw device punches resolved by a worker; daily and period attendance; policies with cut-off and thresholds; leave workflow with balances; substitution trigger.

### `attendance_devices`
Biometric / RFID / face / QR / bus readers.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| campus_id | ulid | → campuses |
| name | str(80) | required |
| device_type | enum(biometric|rfid|face|qr|gps_bus|mobile_app) | required |
| vendor | str(60) |  |
| serial_no | str(80) | unique |
| api_key_hash | str(128) |  |
| location | str(120) |  |
| direction | enum(in|out|both) | required · default both |
| last_seen_at | dt |  |
| is_active | bool | required · default true |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `device_punch_logs`
Punches exactly as received; resolved to a person later.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| device_id | ulid | required · → attendance_devices |
| identifier | str(80) | required |
| punched_at | dt | required |
| direction | str(10) |  |
| raw_payload | json |  |
| person_type | enum(student|staff) |  |
| person_id | ulid |  |
| processed_at | dt |  |
| error | str(255) |  |

### `student_attendance`
One row per student per day.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| section_id | ulid | → sections |
| on_date | date | required |
| status | enum(present|absent|late|half_day|excused|holiday) | required |
| check_in | dt |  |
| check_out | dt |  |
| late_minutes | small |  |
| source | enum(manual|device|app|import|system|bus) | required · default manual |
| marked_by | ulid | → users |
| remarks | str(255) |  |
| guardian_notified_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `student_period_attendance`
Period-wise attendance (college / subject-wise).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| slot_id | ulid | required · → timetable_slots |
| on_date | date | required |
| status | enum(present|absent|late|excused) | required |
| marked_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `staff_attendance`
Staff daily attendance with work/overtime minutes feeding payroll.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| staff_id | ulid | required · → staff |
| on_date | date | required |
| status | enum(present|absent|late|half_day|excused|holiday|wfh) | required |
| check_in | dt |  |
| check_out | dt |  |
| late_minutes | small |  |
| early_leave_minutes | small |  |
| work_minutes | small |  |
| overtime_minutes | small |  |
| source | enum(manual|device|app|import|system) | required · default manual |
| marked_by | ulid | → users |
| remarks | str(255) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `attendance_policies`
Cut-off time, late/half-day thresholds, notification switches, escalation, minimum %.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| audience | enum(student|staff) | required |
| class_id | ulid | → classes |
| shift_id | ulid | → shifts |
| late_after_minutes | small | required · default 15 |
| half_day_after_minutes | small | required · default 120 |
| auto_absent_at | time |  |
| notify_on_arrival | bool | required · default true |
| notify_on_absent | bool | required · default true |
| notify_on_late | bool | required · default true |
| consecutive_absent_alert | small | required · default 3 |
| min_attendance_pct | pct | required · default 75 |
| block_exam_below_min | bool | required · default false |
| late_count_to_lop | small |  |
| is_active | bool | required · default true |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `leave_types`
Casual, sick, earned, maternity, study… with accrual and carry-forward.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(60) | required |
| code | str(20) | required |
| audience | enum(student|staff) | required |
| days_per_year | dec(5,1) | required · default 0 |
| accrual | enum(yearly|monthly|none) | required · default yearly |
| is_paid | bool | required · default true |
| carry_forward_max | dec(5,1) | required · default 0 |
| requires_document | bool | required · default false |
| min_notice_days | small | required · default 0 |
| encashable | bool | required · default false |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `leave_balances`
Per staff per type per year.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| staff_id | ulid | required · → staff |
| leave_type_id | ulid | required · → leave_types |
| academic_year_id | ulid | required · → academic_years |
| allocated | dec(5,1) | required · default 0 |
| carried_forward | dec(5,1) | required · default 0 |
| used | dec(5,1) | required · default 0 |
| encashed | dec(5,1) | required · default 0 |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `leave_applications`
Student or staff leave through the approval workflow.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| applicant_type | enum(student|staff) | required |
| student_id | ulid | → students |
| staff_id | ulid | → staff |
| leave_type_id | ulid | required · → leave_types |
| from_date | date | required |
| to_date | date | required |
| half_day | enum(first|second) |  |
| days | dec(5,1) | required |
| reason | text | required |
| document_file_id | ulid | → files |
| applied_by | ulid | → users |
| status | enum(pending|approved|rejected|cancelled) | required · default pending |
| approval_request_id | ulid |  |
| decided_by | ulid | → users |
| decided_at | dt |  |
| decision_note | str(255) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `attendance_monthly_summary`
Rollup per student per month (refreshed nightly); used by report cards, eligibility, alerts.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| month | date | required |
| present_days | small | required · default 0 |
| absent_days | small | required · default 0 |
| late_days | small | required · default 0 |
| excused_days | small | required · default 0 |
| working_days | small | required · default 0 |
| pct | pct | required · default 0 |

## Examinations & assessment

Marks-based exams (BD GPA 5.0, credit-weighted) and competency-based assessment (NCTB 2023 performance indicators) side by side; schedules, seat plans, invigilators, admit cards with eligibility, verification & lock, result engine, report cards, promotion; question bank, question-paper generator, online exams with auto-grading, OMR scanning; board form fill-up and result import.

### `grading_scales`
Named scales (BD Board GPA 5.0, Cambridge A*–G, IB 1–7).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(80) | required |
| is_default | bool | required · default false |
| gpa_max | dec(4,2) | required · default 5 |
| fail_gpa_zero | bool | required · default true · F in any subject → GPA 0 (board rule) |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `grading_bands`
Grade bands with ranges and points.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| scale_id | ulid | required · → grading_scales |
| grade | str(5) | required |
| min_percent | pct | required |
| max_percent | pct | required |
| grade_point | dec(4,2) | required |
| is_fail | bool | required · default false |
| remarks | str(120) |  |

### `competency_scales`
Rating scales for competency-based assessment (e.g. NCTB triangle/circle/square, 1–4 rubric).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(80) | required |
| levels | json | [{code:'△',label:'Needs work',value:1},…] |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `exam_types`
Class test, half-yearly, annual, model test… with weight in the annual aggregate.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(60) | required |
| weight_pct | pct | required · default 100 |
| is_internal | bool | required · default false |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `exams`
An exam event for a year/term with scale, eligibility rules and publish time.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| academic_year_id | ulid | required · → academic_years |
| term_id | ulid | → terms |
| exam_type_id | ulid | required · → exam_types |
| grading_scale_id | ulid | required · → grading_scales |
| name | str(120) | required |
| start_date | date | required |
| end_date | date | required |
| marks_entry_deadline | dt |  |
| publish_at | dt |  |
| status | enum(draft|scheduled|ongoing|marks_entry|processing|published|locked) | required · default draft |
| require_fee_clearance | bool | required · default false |
| min_attendance_pct | pct |  |
| rank_scope | enum(section|class|both) | required · default section |
| tie_rule | enum(share_rank|dense|by_total) | required · default share_rank |
| created_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `exam_schedules`
One paper per class-subject: date, time, room, marks split.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| exam_id | ulid | required · → exams |
| class_subject_id | ulid | required · → class_subjects |
| exam_date | date |  |
| start_time | time |  |
| end_time | time |  |
| room_id | ulid | → rooms |
| full_marks | dec(6,2) | required |
| pass_marks | dec(6,2) | required |
| theory_marks | dec(6,2) |  |
| practical_marks | dec(6,2) |  |
| ca_marks | dec(6,2) |  |
| marks_entry_locked | bool | required · default false |
| question_paper_id | ulid |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `exam_invigilators`
Duty roster.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| schedule_id | ulid | required · → exam_schedules |
| room_id | ulid | required · → rooms |
| staff_id | ulid | required · → staff |

### `exam_seat_plans`
Seat per student per exam; admit-card file; eligibility flag.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| exam_id | ulid | required · → exams |
| student_id | ulid | required · → students |
| room_id | ulid | → rooms |
| seat_no | str(10) | required |
| admit_card_file_id | ulid | → files |
| is_eligible | bool | required · default true |
| ineligible_reason | str(60) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `marks`
Marks per student per paper with computed grade and workflow status.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| schedule_id | ulid | required · → exam_schedules |
| student_id | ulid | required · → students |
| theory_obtained | dec(6,2) |  |
| practical_obtained | dec(6,2) |  |
| ca_obtained | dec(6,2) |  |
| total_obtained | dec(6,2) |  |
| is_absent | bool | required · default false |
| grade | str(5) |  |
| grade_point | dec(4,2) |  |
| is_pass | bool |  |
| status | enum(draft|submitted|verified|locked) | required · default draft |
| entered_by | ulid | → users |
| entered_at | dt |  |
| verified_by | ulid | → users |
| verified_at | dt |  |
| remarks | str(120) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `competency_assessments`
Competency-based rating per student per learning outcome per term (no marks).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| outcome_id | ulid | required · → learning_outcomes |
| term_id | ulid | required · → terms |
| scale_id | ulid | required · → competency_scales |
| level_code | str(10) | required |
| evidence | json | file ids / notes |
| assessed_by | ulid | → staff |
| assessed_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `exam_results`
Aggregated result per student per exam, frozen on publish.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| exam_id | ulid | required · → exams |
| student_id | ulid | required · → students |
| section_id | ulid | → sections |
| total_full_marks | dec(8,2) | required |
| total_obtained | dec(8,2) | required |
| percentage | pct | required |
| gpa | dec(4,2) |  |
| grade | str(5) |  |
| failed_subjects | small | required · default 0 |
| is_pass | bool | required |
| rank_in_section | int |  |
| rank_in_class | int |  |
| attendance_pct | pct |  |
| teacher_remark | str(255) |  |
| principal_remark | str(255) |  |
| report_card_file_id | ulid | → files |
| published_at | dt |  |
| computed_at | dt | required · default now |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `annual_results`
Weighted aggregate across the year’s exams → promotion input.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| academic_year_id | ulid | required · → academic_years |
| student_id | ulid | required · → students |
| weighted_gpa | dec(4,2) |  |
| weighted_pct | pct |  |
| rank_in_class | int |  |
| decision | enum(promoted|retained|graduated|conditional|pending) | required · default pending |
| computed_at | dt | required · default now |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `promotion_rules`
Min GPA, max failed subjects, min attendance; auto-apply switch.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| academic_year_id | ulid | required · → academic_years |
| class_id | ulid | → classes |
| min_gpa | dec(4,2) | required · default 1 |
| max_failed_subjects | small | required · default 0 |
| min_attendance_pct | pct | required · default 0 |
| auto_apply | bool | required · default false |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `promotions`
Decision per enrollment.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| from_enrollment_id | ulid | required · unique · → student_enrollments |
| to_enrollment_id | ulid | → student_enrollments |
| decision | enum(promoted|retained|graduated|conditional) | required |
| annual_gpa | dec(4,2) |  |
| is_auto | bool | required · default false |
| decided_by | ulid | → users |
| note | str(255) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `questions`
Question bank with type, difficulty, outcome mapping and auto-grade answer key.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| subject_id | ulid | required · → subjects |
| class_id | ulid | → classes |
| unit_id | ulid | → syllabus_units |
| outcome_id | ulid | → learning_outcomes |
| q_type | enum(mcq|true_false|short|long|fill_blank|match|numeric|essay) | required |
| difficulty | enum(easy|medium|hard) | required · default medium |
| body | long | required |
| body_bn | long |  |
| options | json |  |
| answer | json |  |
| marks | dec(5,2) | required · default 1 |
| tags | json |  |
| ai_generated | bool | required · default false |
| created_by | ulid | → users |
| usage_count | int | required · default 0 |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `question_papers`
Generated/curated question papers (blueprint: marks by unit × difficulty), PDF output.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| class_subject_id | ulid | required · → class_subjects |
| exam_id | ulid | → exams |
| title | str(200) | required |
| blueprint | json |  |
| total_marks | dec(6,2) | required |
| duration_min | small |  |
| instructions | text |  |
| set_label | str(5) | A/B sets |
| pdf_file_id | ulid | → files |
| status | enum(draft|final) | required · default draft |
| created_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `question_paper_items`
Questions in a paper.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| paper_id | ulid | required · → question_papers |
| question_id | ulid | required · → questions |
| sequence | small | required |
| marks | dec(5,2) | required |
| section | str(20) |  |

### `online_exams`
Timed online exam; MCQ auto-graded; can sync into a formal paper.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| schedule_id | ulid | → exam_schedules |
| section_id | ulid | required · → sections |
| class_subject_id | ulid | required · → class_subjects |
| paper_id | ulid | → question_papers |
| title | str(200) | required |
| instructions | text |  |
| starts_at | dt | required |
| ends_at | dt | required |
| duration_min | small | required |
| total_marks | dec(6,2) | required |
| shuffle_questions | bool | required · default true |
| auto_grade | bool | required · default true |
| auto_publish | bool | required · default false |
| proctoring | json | webcam snapshots, tab-switch limit |
| status | enum(draft|scheduled|live|closed|published) | required · default draft |
| created_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `online_exam_attempts`
Attempt with answers, auto/manual score, proctoring meta.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| online_exam_id | ulid | required · → online_exams |
| student_id | ulid | required · → students |
| started_at | dt | required · default now |
| submitted_at | dt |  |
| answers | json |  |
| auto_score | dec(6,2) |  |
| manual_score | dec(6,2) |  |
| final_score | dec(6,2) |  |
| graded_by | ulid | → users |
| status | enum(in_progress|submitted|auto_graded|graded) | required · default in_progress |
| client_meta | json |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `omr_sheets`
Scanned OMR answer sheets processed by the OMR engine.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| schedule_id | ulid | → exam_schedules |
| online_exam_id | ulid | → online_exams |
| student_id | ulid | → students |
| file_id | ulid | required · → files |
| detected_roll | str(20) |  |
| answers | json |  |
| score | dec(6,2) |  |
| confidence | pct |  |
| status | enum(uploaded|processed|needs_review|applied|rejected) | required · default uploaded |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `board_registrations`
Board exam (SSC/HSC/JSC/Dakhil) registration and form fill-up per student with fees and export.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| academic_year_id | ulid | required · → academic_years |
| board | str(40) | required |
| exam_name | str(40) | required · SSC 2027 |
| registration_no | str(30) |  |
| roll_no | str(30) |  |
| centre | str(120) |  |
| group_name | str(30) |  |
| subjects | json |  |
| fee_invoice_id | ulid |  |
| status | enum(draft|submitted|confirmed|admitted|result_received) | required · default draft |
| board_result | json | imported GPA/grades |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

## LMS · courses, lessons, live classes

Courses (also coaching-centre products), lessons with video/notes, quizzes, assignments with late rules, live classes, discussion, progress tracking, certificates.

### `courses`
A course: tied to a class-subject or sold standalone (coaching, skills).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| class_subject_id | ulid | → class_subjects |
| title | str(200) | required |
| slug | str(120) | required |
| description | long |  |
| cover_file_id | ulid | → files |
| teacher_id | ulid | → staff |
| is_paid | bool | required · default false |
| price | money | required · default 0 |
| fee_head_id | ulid |  |
| status | enum(draft|published|archived) | required · default draft |
| published_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |
| deleted_at | dt | Soft delete |

### `course_modules`
Sections inside a course.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| course_id | ulid | required · → courses |
| title | str(200) | required |
| sequence | small | required |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `lessons`
Lesson content: video, notes, link, SCORM/H5P, quiz.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| module_id | ulid | required · → course_modules |
| title | str(200) | required |
| sequence | small | required |
| lesson_type | enum(video|note|link|file|quiz|assignment|live) | required |
| body | long |  |
| file_id | ulid | → files |
| video_url | str(500) |  |
| duration_min | small |  |
| is_free_preview | bool | required · default false |
| unit_id | ulid | → syllabus_units |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `course_enrollments`
Student enrolled in a course (auto for class-subject courses).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| course_id | ulid | required · → courses |
| student_id | ulid | required · → students |
| enrolled_at | dt | required · default now |
| progress_pct | pct | required · default 0 |
| completed_at | dt |  |
| certificate_doc_id | ulid |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `lesson_progress`
Per student per lesson.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| lesson_id | ulid | required · → lessons |
| student_id | ulid | required · → students |
| status | enum(not_started|in_progress|completed) | required · default not_started |
| seconds_watched | int | required · default 0 |
| last_position | int | required · default 0 |
| completed_at | dt |  |

### `lesson_quiz_attempts`
A go at the quiz inside a lesson: answers, score, and whether it passed.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| lesson_id | ulid | required · → lessons |
| student_id | ulid | required · → students |
| attempt_no | small | required · default 1 |
| answers | json |  |
| score | dec(6,2) | required · default 0 |
| max_score | dec(6,2) | required · default 0 |
| passed | bool | required · default false |
| submitted_at | dt | required · default now |

### `assignments`
Homework/assignment with due date, penalty and submission type.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| section_id | ulid | required · → sections |
| class_subject_id | ulid | required · → class_subjects |
| teacher_id | ulid | required · → staff |
| lesson_id | ulid | → lessons |
| title | str(200) | required |
| description | long |  |
| attachments | json |  |
| assigned_at | dt | required · default now |
| due_at | dt | required |
| max_marks | dec(6,2) |  |
| allow_late | bool | required · default true |
| late_penalty_pct | pct | required · default 0 |
| submission_type | enum(file|text|both|offline|photo) | required · default file |
| status | enum(draft|published|closed) | required · default published |
| reminder_sent_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `assignment_submissions`
Submission with grading and feedback; plagiarism score optional.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| assignment_id | ulid | required · → assignments |
| student_id | ulid | required · → students |
| submitted_at | dt | required · default now |
| is_late | bool | required · default false |
| text_answer | long |  |
| attachments | json |  |
| marks | dec(6,2) |  |
| feedback | text |  |
| similarity_pct | pct |  |
| graded_by | ulid | → users |
| graded_at | dt |  |
| status | enum(submitted|graded|returned|resubmit) | required · default submitted |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `study_materials`
Notes, slides, videos, links by unit.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| class_subject_id | ulid | → class_subjects |
| section_id | ulid | → sections |
| unit_id | ulid | → syllabus_units |
| title | str(200) | required |
| material_type | enum(note|slide|video|link|book|audio) | required |
| file_id | ulid | → files |
| external_url | str(500) |  |
| uploaded_by | ulid | → users |
| published_at | dt | required · default now |
| view_count | int | required · default 0 |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `online_classes`
Live class (Zoom/Meet/Jitsi) auto-created from timetable on remote days.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| section_id | ulid | required · → sections |
| class_subject_id | ulid | → class_subjects |
| teacher_id | ulid | required · → staff |
| slot_id | ulid | → timetable_slots |
| title | str(200) | required |
| platform | enum(zoom|google_meet|jitsi|bbb|youtube_live) | required |
| meeting_id | str(120) |  |
| join_url | str(500) |  |
| host_url | str(500) |  |
| starts_at | dt | required |
| duration_min | small | required · default 40 |
| recording_url | str(500) |  |
| status | enum(scheduled|live|ended|cancelled) | required · default scheduled |
| reminder_sent_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `online_class_attendance`
From platform webhooks.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| online_class_id | ulid | required · → online_classes |
| student_id | ulid | required · → students |
| joined_at | dt |  |
| left_at | dt |  |
| minutes | small |  |

### `discussions`
Q&A threads under lessons/courses.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| course_id | ulid | → courses |
| lesson_id | ulid | → lessons |
| author_id | ulid | → users |
| parent_id | ulid | → discussions |
| body | text | required |
| is_answer | bool | required · default false |
| upvotes | int | required · default 0 |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

## Daily diary & early years

Homework diary for all classes; kindergarten daily report (meals, nap, mood, toilet, photos); teacher remarks; guardian acknowledgement.

### `diary_entries`
Per section per day: homework, notes, announcements — replaces the paper diary.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| section_id | ulid | required · → sections |
| on_date | date | required |
| teacher_id | ulid | → staff |
| class_subject_id | ulid | → class_subjects |
| entry_type | enum(homework|note|reminder|announcement) | required · default homework |
| body | text | required |
| attachments | json |  |
| due_date | date |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `diary_acknowledgements`
Guardian saw/acknowledged.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| entry_id | ulid | required · → diary_entries |
| student_id | ulid | required · → students |
| guardian_id | ulid | → guardians |
| acked_at | dt | required · default now |

### `daily_reports`
Early-years daily report per child (meals, nap, mood, activities, photos).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| on_date | date | required |
| meals | json |  |
| nap_minutes | small |  |
| mood | enum(happy|calm|tired|upset|sick) |  |
| activities | json |  |
| toilet | json |  |
| notes | text |  |
| photos | json |  |
| teacher_id | ulid | → staff |
| sent_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `student_remarks`
Teacher remarks/observations on a student (positive or concern) visible to guardians.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| teacher_id | ulid | required · → staff |
| on_date | date | required |
| remark | text | required |
| polarity | enum(positive|neutral|concern) | required · default neutral |
| visible_to_guardian | bool | required · default true |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

## Co-curricular · clubs, sports, achievements, portfolio

Clubs and societies, sports teams and fixtures, house points, competitions, awards, student portfolio and skills badges.

### `clubs`
Clubs/societies with advisor.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(120) | required |
| category | enum(academic|sports|arts|social|tech|religious|other) | required · default other |
| advisor_id | ulid | → staff |
| description | text |  |
| meeting_schedule | str(120) |  |
| status | enum(active|inactive) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `club_memberships`
Members and roles.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| club_id | ulid | required · → clubs |
| student_id | ulid | required · → students |
| role | enum(member|secretary|president|captain) | required · default member |
| joined_on | date | required |
| left_on | date |  |

### `competitions`
Internal/external competitions and events with results.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(200) | required |
| kind | enum(sports|academic|cultural|science|debate|olympiad|other) | required |
| level | enum(intra|inter_school|district|national|international) | required · default intra |
| held_on | date |  |
| venue | str(160) |  |
| organiser | str(160) |  |
| event_id | ulid |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `competition_results`
Placement per participant/team.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| competition_id | ulid | required · → competitions |
| student_id | ulid | → students |
| club_id | ulid | → clubs |
| house_id | ulid | → houses |
| position | small |  |
| award | str(120) |  |
| points | int | required · default 0 |
| certificate_doc_id | ulid |  |

### `house_points`
Points ledger per house (behaviour, sports, competitions).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| house_id | ulid | required · → houses |
| student_id | ulid | → students |
| points | int | required |
| reason | str(160) | required |
| source_type | str(40) |  |
| source_id | ulid |  |
| awarded_by | ulid | → staff |
| awarded_at | dt | required · default now |

### `achievements`
Student achievements and awards (portfolio).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| title | str(200) | required |
| category | str(60) |  |
| achieved_on | date |  |
| description | text |  |
| file_id | ulid | → files |
| verified_by | ulid | → staff |
| is_public | bool | required · default false |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `skill_badges`
Badge catalogue (e.g. Reading star, Coder L1).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(80) | required |
| icon_file_id | ulid | → files |
| criteria | text |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `student_badges`
Badges earned.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| badge_id | ulid | required · → skill_badges |
| student_id | ulid | required · → students |
| awarded_by | ulid | → staff |
| awarded_at | dt | required · default now |

## Library & e-library

Catalogue with copies and barcodes, members, issues/returns with fines to the student bill, reservations, e-books and reading logs.

### `library_categories`
Category tree.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(80) | required |
| parent_id | ulid | → library_categories |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `library_books`
Title-level record.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| isbn | str(20) |  |
| title | str(255) | required |
| subtitle | str(255) |  |
| authors | json |  |
| publisher | str(160) |  |
| edition | str(40) |  |
| published_year | small |  |
| language | str(10) | required · default 'bn' |
| category_id | ulid | → library_categories |
| subject_id | ulid | → subjects |
| class_id | ulid | → classes |
| pages | small |  |
| price | money |  |
| cover_file_id | ulid | → files |
| ebook_file_id | ulid | → files |
| description | text |  |
| total_copies | int | required · default 0 |
| available_copies | int | required · default 0 |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `library_book_copies`
Physical copy with accession no and status.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| book_id | ulid | required · → library_books |
| accession_no | str(30) | required |
| barcode | str(40) |  |
| rack | str(20) |  |
| shelf | str(20) |  |
| condition_note | enum(new|good|fair|poor) | required · default good |
| status | enum(available|issued|reserved|lost|damaged|withdrawn) | required · default available |
| acquired_on | date |  |
| source | enum(purchase|donation) | required · default purchase |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `library_members`
Student or staff member with limits.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| member_type | enum(student|staff|guardian) | required |
| student_id | ulid | → students |
| staff_id | ulid | → staff |
| card_no | str(30) | required |
| max_books | small | required · default 2 |
| loan_days | small | required · default 14 |
| fine_per_day | money | required · default 5 |
| status | enum(active|blocked|inactive) | required · default active |
| blocked_reason | str(120) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `library_issues`
Issue/return with fine accrual and reminder stage.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| copy_id | ulid | required · → library_book_copies |
| member_id | ulid | required · → library_members |
| issued_at | dt | required · default now |
| due_at | date | required |
| returned_at | dt |  |
| renew_count | small | required · default 0 |
| issued_by | ulid | → users |
| returned_to | ulid | → users |
| fine_amount | money | required · default 0 |
| fine_invoice_item_id | ulid |  |
| fine_waived_by | ulid | → users |
| reminder_stage | str(20) |  |
| status | enum(issued|returned|lost|overdue) | required · default issued |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `library_reservations`
Hold queue.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| book_id | ulid | required · → library_books |
| member_id | ulid | required · → library_members |
| reserved_at | dt | required · default now |
| notified_at | dt |  |
| expires_at | dt |  |
| status | enum(waiting|ready|fulfilled|expired|cancelled) | required · default waiting |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `reading_logs`
Reading programme: pages read, reviews (reading badges).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| book_id | ulid | required · → library_books |
| pages_read | int | required · default 0 |
| finished | bool | required · default false |
| review | text |  |
| rating | small |  |
| logged_at | dt | required · default now |

## Fees & billing

Fee heads mapped to GL, class structures, per-student overrides, discount schemes (sibling/merit/staff/need), monthly invoice batches with pro-rata, gateway payments (bKash, Nagad, Rocket, SSLCommerz, Stripe) allocated oldest-first, advance credit, fines, reminder ladder, refunds, cash sessions, instalment plans.

### `fee_heads`
Tuition, admission, exam, transport, hostel, fine, canteen…

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(80) | required |
| code | str(20) | required |
| head_kind | enum(academic|transport|hostel|fine|misc|course|shop|canteen) | required · default academic |
| gl_account_id | ulid |  |
| is_refundable | bool | required · default false |
| tax_pct | pct | required · default 0 |
| status | enum(active|inactive) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `late_fine_rules`
Grace days, flat/percent/per-day, cap.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(80) | required |
| grace_days | small | required · default 0 |
| fine_type | enum(flat|percent|per_day|per_week) | required |
| value | money | required |
| max_amount | money |  |
| fine_head_id | ulid | → fee_heads |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `fee_structures`
Fee plan for a class (optionally campus/shift/programme) per year.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| academic_year_id | ulid | required · → academic_years |
| class_id | ulid | required · → classes |
| campus_id | ulid | → campuses |
| shift_id | ulid | → shifts |
| program_id | ulid | → programs |
| name | str(120) | required |
| status | enum(active|inactive) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `fee_structure_items`
Head × amount × frequency × due day × months.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| fee_structure_id | ulid | required · → fee_structures |
| fee_head_id | ulid | required · → fee_heads |
| amount | money | required |
| frequency | enum(one_time|monthly|quarterly|half_yearly|yearly|per_term) | required · default monthly |
| due_day | small | required · default 10 |
| applicable_months | json |  |
| late_fine_rule_id | ulid | → late_fine_rules |

### `student_fee_overrides`
Per-student amount or waiver for a head.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| academic_year_id | ulid | required · → academic_years |
| fee_head_id | ulid | required · → fee_heads |
| amount | money |  |
| reason | str(160) |  |
| approved_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `discount_schemes`
Sibling / merit / staff child / need-based / early payment with auto rule.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(120) | required |
| discount_kind | enum(sibling|merit|staff_child|need_based|early_payment|scholarship|custom) | required |
| value_type | enum(percent|flat) | required |
| value | money | required |
| applies_to_heads | json |  |
| auto_rule | json |  |
| requires_approval | bool | required · default true |
| budget_cap | money |  |
| status | enum(active|inactive) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `student_discounts`
Discount granted (or auto-proposed) to a student for a year.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| discount_scheme_id | ulid | required · → discount_schemes |
| academic_year_id | ulid | required · → academic_years |
| value_override | money |  |
| valid_from | date |  |
| valid_to | date |  |
| is_auto | bool | required · default false |
| status | enum(pending|approved|rejected|expired) | required · default pending |
| approved_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `instalment_plans`
Split a large fee (admission, yearly) into instalments per student.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| fee_head_id | ulid | required · → fee_heads |
| total_amount | money | required |
| instalments | json | [{due:'2026-10-10',amount:5000},…] |
| status | enum(active|completed|cancelled) | required · default active |
| approved_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `invoice_batches`
One generation run (e.g. October tuition for all classes).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| academic_year_id | ulid | required · → academic_years |
| billing_period | date | required |
| scope | json |  |
| generated_by | ulid | → users |
| invoice_count | int | required · default 0 |
| total_amount | money | required · default 0 |
| status | enum(pending|running|success|failed) | required · default pending |
| started_at | dt |  |
| finished_at | dt |  |
| error | text |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `invoices`
Student (or applicant) invoice with totals, status and reminder stamps.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| invoice_no | str(30) | required |
| student_id | ulid | → students |
| application_id | ulid | → admission_applications |
| academic_year_id | ulid | → academic_years |
| batch_id | ulid | → invoice_batches |
| billing_period | date |  |
| issue_date | date | required |
| due_date | date | required |
| subtotal | money | required · default 0 |
| discount_total | money | required · default 0 |
| fine_total | money | required · default 0 |
| tax_total | money | required · default 0 |
| total | money | required · default 0 |
| paid_total | money | required · default 0 |
| balance | money | required · default 0 |
| status | enum(draft|issued|partially_paid|paid|overdue|cancelled|written_off) | required · default issued |
| is_auto | bool | required · default true |
| notes | str(255) |  |
| pdf_file_id | ulid | → files |
| last_reminder_stage | str(20) |  |
| last_reminder_at | dt |  |
| fine_applied_at | dt |  |
| cancelled_at | dt |  |
| cancel_reason | str(160) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `invoice_items`
Lines: fee, fine, adjustment, previous due; source pointer (library issue, transport…).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| invoice_id | ulid | required · → invoices |
| fee_head_id | ulid | → fee_heads |
| description | str(200) | required |
| quantity | dec(8,2) | required · default 1 |
| unit_amount | money | required |
| discount_amount | money | required · default 0 |
| discount_id | ulid | → student_discounts |
| tax_amount | money | required · default 0 |
| amount | money | required |
| item_kind | enum(fee|fine|adjustment|previous_due|course|shop) | required · default fee |
| source_type | str(40) |  |
| source_id | ulid |  |

### `payment_gateways`
Configured gateways with encrypted credentials and settlement account.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| provider | enum(sslcommerz|bkash|nagad|rocket|upay|aamarpay|shurjopay|stripe|paypal|razorpay) | required |
| display_name | str(80) | required |
| credentials | json |  |
| is_sandbox | bool | required · default true |
| is_active | bool | required · default true |
| settle_to_bank_account_id | ulid |  |
| fee_pct | pct | required · default 0 |
| fee_fixed | money | required · default 0 |
| sort_order | small | required · default 0 |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `payments`
Money received; allocated to invoices; journal auto-posted.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| payment_no | str(30) | required |
| student_id | ulid | → students |
| application_id | ulid | → admission_applications |
| payer_user_id | ulid | → users |
| amount | money | required |
| method | enum(cash|bank_transfer|cheque|card|bkash|nagad|rocket|upay|sslcommerz|stripe|wallet|adjustment|other) | required |
| gateway_id | ulid | → payment_gateways |
| gateway_txn_id | str(120) |  |
| gateway_payload | json |  |
| bank_account_id | ulid |  |
| reference | str(120) |  |
| paid_at | dt | required · default now |
| received_by | ulid | → users |
| status | enum(pending|success|failed|refunded|reversed) | required · default success |
| receipt_file_id | ulid | → files |
| journal_entry_id | ulid |  |
| cash_session_id | ulid |  |
| notes | str(255) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `payment_allocations`
Payment → invoice amounts; unallocated remainder = advance credit.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| payment_id | ulid | required · → payments |
| invoice_id | ulid | required · → invoices |
| amount | money | required |

### `refunds`
Refund with approval, gateway refund id and reversal journal.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| payment_id | ulid | required · → payments |
| amount | money | required |
| reason | str(255) | required |
| requested_by | ulid | → users |
| status | enum(pending|approved|rejected|refunded) | required · default pending |
| approved_by | ulid | → users |
| refunded_at | dt |  |
| gateway_refund_id | str(120) |  |
| journal_entry_id | ulid |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `student_ledger_entries`
Append-only running ledger per student.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| entry_type | enum(invoice|payment|refund|adjustment|fine|write_off|advance) | required |
| ref_type | str(40) | required |
| ref_id | ulid | required |
| debit | money | required · default 0 |
| credit | money | required · default 0 |
| balance_after | money | required |
| description | str(200) |  |
| created_at | dt | required · default now |

### `fee_reminders`
Reminder sent per invoice per stage per channel.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| invoice_id | ulid | required · → invoices |
| stage | str(20) | required |
| channel | enum(sms|push|email|whatsapp|call_task) | required |
| notification_id | ulid |  |
| sent_at | dt | required · default now |

### `cash_sessions`
Counter session with opening/closing count and variance.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| cashier_id | ulid | required · → users |
| opened_at | dt | required · default now |
| closed_at | dt |  |
| opening_cash | money | required · default 0 |
| expected_cash | money |  |
| counted_cash | money |  |
| variance | money |  |
| deposited_to | ulid |  |
| note | str(255) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `fee_collection_daily`
Rollup per day per method for dashboards.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| on_date | date | required |
| method | str(20) | required |
| count | int | required · default 0 |
| amount | money | required · default 0 |

## Accounting · GL, AP/AR, assets, statements

Full double-entry: chart of accounts, journals (auto-posted from fees, payroll, purchases, POS), expenses with approvals, vendors/bills (AP), bank & MFS accounts with reconciliation, budgets, fixed-asset depreciation, VAT/tax, cost centres, financial statements, year-end close.

### `fiscal_years`
Financial year (BD: July–June).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(20) | required |
| start_date | date | required |
| end_date | date | required |
| is_closed | bool | required · default false |
| closed_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `gl_accounts`
Chart of accounts tree.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| code | str(20) | required |
| name | str(120) | required |
| account_type | enum(asset|liability|equity|income|expense) | required |
| parent_id | ulid | → gl_accounts |
| is_group | bool | required · default false |
| is_system | bool | required · default false |
| status | enum(active|inactive) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `cost_centers`
Campus / department / project for reporting.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(80) | required |
| campus_id | ulid | → campuses |
| department_id | ulid | → departments |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `bank_accounts`
Bank, MFS merchant and cash boxes.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| gl_account_id | ulid | required · → gl_accounts |
| bank_name | str(120) | required |
| branch | str(120) |  |
| account_name | str(160) | required |
| account_no | str(60) | required |
| routing_no | str(30) |  |
| account_kind | enum(bank|mfs|cash_box|card) | required · default bank |
| is_default_collection | bool | required · default false |
| status | enum(active|inactive) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `journal_entries`
Balanced entries; app refuses unbalanced.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| fiscal_year_id | ulid | → fiscal_years |
| entry_no | str(30) | required |
| entry_date | date | required |
| memo | str(255) |  |
| source_type | str(40) |  |
| source_id | ulid |  |
| status | enum(draft|posted|reversed) | required · default posted |
| reversal_of_id | ulid | → journal_entries |
| posted_by | ulid | → users |
| is_auto | bool | required · default true |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `journal_lines`
Debit/credit lines.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| entry_id | ulid | required · → journal_entries |
| account_id | ulid | required · → gl_accounts |
| cost_center_id | ulid | → cost_centers |
| debit | money | required · default 0 |
| credit | money | required · default 0 |
| description | str(200) |  |

### `expense_categories`
Expense categories with GL account and approval threshold.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(80) | required |
| gl_account_id | ulid | → gl_accounts |
| requires_approval_above | money |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `vendors`
Suppliers/contractors.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(160) | required |
| phone | str(30) |  |
| email | str(160) |  |
| address | json |  |
| tax_id | str(40) |  |
| bank_details | json |  |
| payable_gl_account_id | ulid | → gl_accounts |
| status | enum(active|inactive) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `expenses`
Expense claim/voucher with approval and payment.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| expense_no | str(30) | required |
| category_id | ulid | required · → expense_categories |
| vendor_id | ulid | → vendors |
| cost_center_id | ulid | → cost_centers |
| expense_date | date | required |
| amount | money | required |
| tax_amount | money | required · default 0 |
| paid_from_id | ulid | → bank_accounts |
| payment_method | str(20) |  |
| reference | str(120) |  |
| description | str(255) |  |
| bill_file_id | ulid | → files |
| requested_by | ulid | → users |
| status | enum(pending|approved|rejected|paid) | required · default pending |
| approval_request_id | ulid |  |
| approved_by | ulid | → users |
| paid_at | dt |  |
| journal_entry_id | ulid | → journal_entries |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `vendor_bills`
Accounts payable: bills from vendors (from POs) with due dates and payments.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| vendor_id | ulid | required · → vendors |
| bill_no | str(60) | required |
| bill_date | date | required |
| due_date | date |  |
| subtotal | money | required |
| tax | money | required · default 0 |
| total | money | required |
| paid_total | money | required · default 0 |
| status | enum(open|partially_paid|paid|void) | required · default open |
| po_id | ulid |  |
| file_id | ulid | → files |
| journal_entry_id | ulid | → journal_entries |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `vendor_payments`
Payments to vendors.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| vendor_id | ulid | required · → vendors |
| bill_id | ulid | → vendor_bills |
| amount | money | required |
| paid_from_id | ulid | → bank_accounts |
| method | str(20) |  |
| reference | str(120) |  |
| paid_at | dt | required · default now |
| journal_entry_id | ulid | → journal_entries |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `other_incomes`
Non-fee income (rent, donations receipts, interest).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| gl_account_id | ulid | required · → gl_accounts |
| received_in_id | ulid | → bank_accounts |
| income_date | date | required |
| amount | money | required |
| payer | str(160) |  |
| description | str(255) |  |
| journal_entry_id | ulid | → journal_entries |
| created_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `budgets`
Budget per account/cost centre with alert threshold.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| fiscal_year_id | ulid | required · → fiscal_years |
| gl_account_id | ulid | required · → gl_accounts |
| cost_center_id | ulid | → cost_centers |
| amount | money | required |
| alert_at_pct | pct | required · default 90 |
| alerted_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `bank_statement_lines`
Imported statement lines with auto-match.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| bank_account_id | ulid | required · → bank_accounts |
| txn_date | date | required |
| description | str(255) |  |
| reference | str(120) |  |
| debit | money | required · default 0 |
| credit | money | required · default 0 |
| balance | money |  |
| matched_type | str(20) |  |
| matched_id | ulid |  |
| matched_at | dt |  |
| import_batch | str(40) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `fixed_assets_ledger`
Depreciation schedule per asset (straight-line / reducing).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| asset_id | ulid | required |
| fiscal_year_id | ulid | required · → fiscal_years |
| method | enum(straight_line|reducing) | required · default straight_line |
| rate_pct | pct | required |
| opening_value | money | required |
| depreciation | money | required |
| closing_value | money | required |
| journal_entry_id | ulid | → journal_entries |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `tax_rates`
VAT/AIT rates.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(60) | required |
| rate_pct | pct | required |
| kind | enum(vat|ait|other) | required · default vat |
| gl_account_id | ulid | → gl_accounts |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `financial_statements`
Generated statements (income statement, balance sheet, cash flow) per period.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| fiscal_year_id | ulid | required · → fiscal_years |
| kind | enum(income_statement|balance_sheet|cash_flow|trial_balance|receivables_ageing) | required |
| period_start | date | required |
| period_end | date | required |
| data | json |  |
| file_id | ulid | → files |
| generated_at | dt | required · default now |

## Student wallet & POS · canteen, shop

Cashless campus: guardian tops up a wallet (bKash/Nagad/counter), student pays by RFID/QR at canteen and school shop; daily spend limits; products, stock, sales, refunds; uniform/book orders.

### `wallets`
One wallet per student (or staff).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | unique · → students |
| staff_id | ulid | unique · → staff |
| balance | money | required · default 0 |
| daily_limit | money |  |
| status | enum(active|frozen|closed) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `wallet_transactions`
Top-ups, spends, refunds; append-only.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| wallet_id | ulid | required · → wallets |
| kind | enum(topup|spend|refund|adjustment|transfer) | required |
| amount | money | required |
| balance_after | money | required |
| source_type | str(40) |  |
| source_id | ulid |  |
| payment_id | ulid | → payments |
| description | str(200) |  |
| created_by | ulid | → users |
| created_at | dt | required · default now |

### `pos_outlets`
Canteen, bookshop, uniform shop.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(80) | required |
| kind | enum(canteen|bookshop|uniform|stationery|other) | required |
| campus_id | ulid | → campuses |
| income_gl_account_id | ulid | → gl_accounts |
| status | enum(active|inactive) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `pos_products`
Sellable products with price and stock link.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| outlet_id | ulid | required · → pos_outlets |
| name | str(160) | required |
| sku | str(40) |  |
| price | money | required |
| tax_rate_id | ulid | → tax_rates |
| inventory_item_id | ulid |  |
| image_file_id | ulid | → files |
| is_active | bool | required · default true |
| category | str(60) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `pos_sales`
A sale (wallet, cash or gateway).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| outlet_id | ulid | required · → pos_outlets |
| sale_no | str(30) | required |
| student_id | ulid | → students |
| wallet_id | ulid | → wallets |
| cashier_id | ulid | → users |
| subtotal | money | required |
| tax | money | required · default 0 |
| total | money | required |
| paid_by | enum(wallet|cash|bkash|card|invoice) | required |
| payment_id | ulid | → payments |
| status | enum(completed|refunded|void) | required · default completed |
| journal_entry_id | ulid | → journal_entries |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `pos_sale_items`
Lines.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| sale_id | ulid | required · → pos_sales |
| product_id | ulid | required · → pos_products |
| quantity | dec(8,2) | required · default 1 |
| unit_price | money | required |
| amount | money | required |

### `shop_orders`
Guardian orders (uniform, books) from the app with delivery/pickup.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| order_no | str(30) | required |
| student_id | ulid | required · → students |
| outlet_id | ulid | required · → pos_outlets |
| items | json |  |
| total | money | required |
| status | enum(placed|paid|ready|delivered|cancelled) | required · default placed |
| invoice_id | ulid | → invoices |
| notes | str(255) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

## HR & payroll

Recruitment, onboarding checklists, contracts, shifts, salary structures with formula components, loans/advances, payroll runs from attendance & leave (LOP, overtime, tax slabs, PF, gratuity), payslips, bank files, MPO subsidy split, appraisals, training, exit.

### `job_postings`
Vacancies published on the website.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| title | str(160) | required |
| department_id | ulid | → departments |
| designation_id | ulid | → designations |
| description | long |  |
| vacancies | small | required · default 1 |
| salary_range | str(80) |  |
| closes_at | date |  |
| status | enum(draft|open|closed) | required · default draft |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `job_applicants`
Applicants with CV and interview pipeline.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| posting_id | ulid | required · → job_postings |
| full_name | str(160) | required |
| phone | str(20) | required |
| email | str(160) |  |
| cv_file_id | ulid | → files |
| score | dec(5,2) |  |
| stage | enum(applied|shortlisted|interview|offered|hired|rejected) | required · default applied |
| interview_at | dt |  |
| notes | text |  |
| staff_id | ulid | → staff |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `onboarding_checklists`
Per new staff: tasks like ID card, biometric enrol, bank details.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| staff_id | ulid | required · → staff |
| items | json |  |
| completed_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `staff_contracts`
Contract periods with expiry alerts.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| staff_id | ulid | required · → staff |
| contract_type | enum(permanent|contract|part_time|intern|volunteer|mpo) | required |
| start_date | date | required |
| end_date | date |  |
| file_id | ulid | → files |
| notes | text |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `work_shifts`
Staff work shifts / rosters.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(60) | required |
| start_time | time | required |
| end_time | time | required |
| days | json |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `staff_shift_assignments`
Who is on which shift when.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| staff_id | ulid | required · → staff |
| shift_id | ulid | required · → work_shifts |
| from_date | date | required |
| to_date | date |  |

### `salary_components`
Earning/deduction/employer components with calculation type and formula.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(80) | required |
| code | str(20) | required |
| component_type | enum(earning|deduction|employer_contribution) | required |
| calc_type | enum(fixed|percent_of_basic|percent_of_gross|formula|attendance_based|slab) | required · default fixed |
| default_value | money |  |
| formula | str(255) |  |
| is_taxable | bool | required · default true |
| is_statutory | bool | required · default false |
| gl_account_id | ulid | → gl_accounts |
| sort_order | small | required · default 0 |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `salary_structures`
Per staff with effective range (no overlap, app-enforced).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| staff_id | ulid | required · → staff |
| effective_from | date | required |
| effective_to | date |  |
| basic | money | required |
| pay_frequency | enum(monthly|weekly) | required · default monthly |
| mpo_portion | money | required · default 0 · part paid by government (MPO) |
| bank_account | json |  |
| approved_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `salary_structure_items`
Component values.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| structure_id | ulid | required · → salary_structures |
| component_id | ulid | required · → salary_components |
| value | money | required |

### `tax_slabs`
Income tax slabs (NBR) per fiscal year and taxpayer category.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| fiscal_year_id | ulid | required · → fiscal_years |
| category | enum(general|female_senior|disabled) | required · default general |
| slabs | json |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `staff_loans`
Loans/advances with monthly deduction.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| staff_id | ulid | required · → staff |
| loan_type | enum(advance|loan|pf_loan) | required |
| principal | money | required |
| monthly_deduction | money | required |
| balance | money | required |
| starts_from | date | required |
| status | enum(pending|approved|rejected|active|closed) | required · default pending |
| approved_by | ulid | → users |
| journal_entry_id | ulid | → journal_entries |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `provident_fund_accounts`
PF balance per staff (employee + employer + interest).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| staff_id | ulid | required · unique · → staff |
| employee_total | money | required · default 0 |
| employer_total | money | required · default 0 |
| interest_total | money | required · default 0 |
| withdrawn_total | money | required · default 0 |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `payroll_runs`
Monthly run with totals and approval.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| period_month | date | required |
| campus_id | ulid | → campuses |
| status | enum(draft|calculated|approved|paid|locked) | required · default draft |
| staff_count | int | required · default 0 |
| total_gross | money | required · default 0 |
| total_deductions | money | required · default 0 |
| total_net | money | required · default 0 |
| total_mpo | money | required · default 0 |
| calculated_at | dt |  |
| approved_by | ulid | → users |
| approved_at | dt |  |
| paid_from_id | ulid | → bank_accounts |
| paid_at | dt |  |
| bank_file_id | ulid | → files |
| journal_entry_id | ulid | → journal_entries |
| created_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `payslips`
Frozen payslip per staff per run.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| payroll_run_id | ulid | required · → payroll_runs |
| staff_id | ulid | required · → staff |
| structure_id | ulid | → salary_structures |
| working_days | dec(4,1) | required |
| present_days | dec(4,1) | required |
| paid_leave_days | dec(4,1) | required · default 0 |
| lop_days | dec(4,1) | required · default 0 |
| late_count | small | required · default 0 |
| overtime_hours | dec(5,1) | required · default 0 |
| gross | money | required |
| total_deductions | money | required |
| tax | money | required · default 0 |
| net_pay | money | required |
| breakdown | json |  |
| payslip_file_id | ulid | → files |
| paid_at | dt |  |
| payment_ref | str(120) |  |
| status | enum(draft|approved|paid|held) | required · default draft |
| hold_reason | str(160) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `appraisal_cycles`
Cycle with weighted criteria.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| academic_year_id | ulid | required · → academic_years |
| name | str(120) | required |
| criteria | json |  |
| opens_at | date | required |
| closes_at | date | required |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `staff_appraisals`
Self + reviewer scores, auto metrics.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| cycle_id | ulid | required · → appraisal_cycles |
| staff_id | ulid | required · → staff |
| reviewer_id | ulid | required · → staff |
| self_scores | json |  |
| reviewer_scores | json |  |
| auto_metrics | json |  |
| overall_score | dec(5,2) |  |
| comments | text |  |
| status | enum(pending|self_done|reviewed|finalised) | required · default pending |
| finalised_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `staff_trainings`
Training records and certificates.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| staff_id | ulid | required · → staff |
| title | str(160) | required |
| provider | str(160) |  |
| start_date | date |  |
| end_date | date |  |
| hours | dec(5,1) |  |
| certificate_file_id | ulid | → files |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `staff_exits`
Resignation/termination with clearance and final settlement.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| staff_id | ulid | required · unique · → staff |
| exit_type | enum(resignation|termination|retirement|end_of_contract|death) | required |
| notice_date | date |  |
| last_working_day | date | required |
| clearance | json |  |
| settlement | json |  |
| settlement_journal_id | ulid | → journal_entries |
| status | enum(initiated|cleared|settled) | required · default initiated |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

## Scholarships, donations & fundraising

Scholarship funds and awards (internal, govt stipend, donor-sponsored), donor management, campaigns, pledges and receipts, sponsor-a-student, zakat fund.

### `scholarship_funds`
A fund with balance and rules.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(160) | required |
| kind | enum(internal|government_stipend|donor|zakat|alumni) | required |
| balance | money | required · default 0 |
| gl_account_id | ulid | → gl_accounts |
| rules | json |  |
| status | enum(active|closed) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `scholarship_awards`
Award to a student for a period; links to a discount.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| fund_id | ulid | required · → scholarship_funds |
| student_id | ulid | required · → students |
| academic_year_id | ulid | required · → academic_years |
| amount | money | required |
| frequency | enum(monthly|yearly|one_time) | required · default yearly |
| discount_id | ulid | → student_discounts |
| sponsor_donor_id | ulid |  |
| status | enum(proposed|approved|active|ended) | required · default proposed |
| approved_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `donors`
Individuals/organisations who give.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(160) | required |
| kind | enum(individual|organisation|alumni) | required · default individual |
| phone | str(30) |  |
| email | str(160) |  |
| address | json |  |
| alumni_id | ulid |  |
| total_donated | money | required · default 0 |
| is_anonymous | bool | required · default false |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `fundraising_campaigns`
Campaign with goal and public page.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| title | str(200) | required |
| slug | str(120) | required |
| goal_amount | money | required |
| raised_amount | money | required · default 0 |
| starts_at | date |  |
| ends_at | date |  |
| description | long |  |
| cover_file_id | ulid | → files |
| status | enum(draft|live|closed) | required · default draft |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `donations`
Donation/pledge with receipt and journal.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| donor_id | ulid | required · → donors |
| campaign_id | ulid | → fundraising_campaigns |
| fund_id | ulid | → scholarship_funds |
| amount | money | required |
| kind | enum(pledge|received) | required · default received |
| method | str(20) |  |
| reference | str(120) |  |
| received_at | dt |  |
| receipt_doc_id | ulid |  |
| journal_entry_id | ulid | → journal_entries |
| message | text |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

## Transport & GPS

Routes, geofenced stops, vehicles with document expiry, driver/helper app, daily trips, GPS telemetry, RFID boardings with guardian push, delay/over-speed alerts, fuel and maintenance, route fee into billing.

### `vehicles`
Fleet with compliance dates.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| campus_id | ulid | → campuses |
| registration_no | str(30) | required |
| vehicle_type | enum(bus|microbus|van|car) | required · default bus |
| make_model | str(80) |  |
| capacity | small | required |
| driver_id | ulid | → staff |
| helper_id | ulid | → staff |
| gps_device_id | str(60) |  |
| insurance_expiry | date |  |
| fitness_expiry | date |  |
| tax_token_expiry | date |  |
| route_permit_expiry | date |  |
| odometer_km | int |  |
| status | enum(active|maintenance|inactive) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `transport_routes`
Route with default fee.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(120) | required |
| vehicle_id | ulid | → vehicles |
| start_point | str(120) |  |
| end_point | str(120) |  |
| distance_km | dec(6,2) |  |
| monthly_fee | money | required · default 0 |
| fee_head_id | ulid | → fee_heads |
| status | enum(active|inactive) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `route_stops`
Ordered stops with geofence and times.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| route_id | ulid | required · → transport_routes |
| name | str(120) | required |
| sequence | small | required |
| latitude | dec(9,6) |  |
| longitude | dec(9,6) |  |
| geofence_m | small | required · default 300 |
| pickup_time | time |  |
| drop_time | time |  |
| fee_override | money |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `student_transport`
Student assignment to route/stop with fee snapshot.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| academic_year_id | ulid | required · → academic_years |
| route_id | ulid | required · → transport_routes |
| stop_id | ulid | required · → route_stops |
| trip_type | enum(pickup|drop|both) | required · default both |
| start_date | date | required |
| end_date | date |  |
| monthly_fee | money | required |
| status | enum(active|inactive) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `vehicle_trips`
Daily trip instance with status and delay stamp.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| vehicle_id | ulid | required · → vehicles |
| route_id | ulid | required · → transport_routes |
| trip_date | date | required |
| trip_type | enum(pickup|drop) | required |
| driver_id | ulid | → staff |
| helper_id | ulid | → staff |
| scheduled_start | time |  |
| started_at | dt |  |
| ended_at | dt |  |
| status | enum(scheduled|running|completed|cancelled|delayed) | required · default scheduled |
| delay_alert_sent_at | dt |  |
| checklist | json |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `vehicle_gps_logs`
Telemetry (prune/rotate monthly).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| vehicle_id | ulid | required · → vehicles |
| trip_id | ulid | → vehicle_trips |
| latitude | dec(9,6) | required |
| longitude | dec(9,6) | required |
| speed_kmh | dec(5,1) |  |
| heading | small |  |
| recorded_at | dt | required |

### `transport_boardings`
Boarded/alighted per student per trip.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| trip_id | ulid | required · → vehicle_trips |
| student_id | ulid | required · → students |
| stop_id | ulid | → route_stops |
| boarded_at | dt |  |
| alighted_at | dt |  |
| source | enum(rfid|helper_app|manual) | required · default rfid |
| guardian_notified_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `stop_alerts`
Approaching/arrived/departed alerts sent per trip-stop.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| trip_id | ulid | required · → vehicle_trips |
| stop_id | ulid | required · → route_stops |
| alert_type | enum(approaching|arrived|departed) | required |
| sent_at | dt | required · default now |

### `vehicle_maintenance`
Service history with next due.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| vehicle_id | ulid | required · → vehicles |
| service_type | str(60) | required |
| service_date | date | required |
| odometer_km | int |  |
| cost | money |  |
| vendor_id | ulid | → vendors |
| expense_id | ulid | → expenses |
| next_due_date | date |  |
| next_due_km | int |  |
| notes | text |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `fuel_logs`
Fuel fills.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| vehicle_id | ulid | required · → vehicles |
| filled_at | dt | required · default now |
| litres | dec(7,2) | required |
| cost | money | required |
| odometer_km | int |  |
| expense_id | ulid | → expenses |

### `driver_incidents`
Accidents, over-speed, complaints per driver.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| vehicle_id | ulid | required · → vehicles |
| driver_id | ulid | → staff |
| kind | enum(overspeed|accident|complaint|breakdown|other) | required |
| occurred_at | dt | required |
| details | text |  |
| severity | enum(low|medium|high) | required · default low |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

## Hostel

Hostels, rooms, beds with non-overlapping allocation, out-passes with guardian consent and curfew alerts, roll calls, visitors, mess menu and meal billing, laundry, complaints.

### `hostels`
Building with warden, curfew and fee head.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| campus_id | ulid | → campuses |
| name | str(120) | required |
| hostel_type | enum(boys|girls|staff) | required |
| warden_id | ulid | → staff |
| address | json |  |
| curfew_time | time |  |
| fee_head_id | ulid | → fee_heads |
| status | enum(active|inactive) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `hostel_rooms`
Rooms with capacity and fee.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| hostel_id | ulid | required · → hostels |
| room_no | str(20) | required |
| floor | str(10) |  |
| room_type | enum(single|double|shared|dorm) | required · default shared |
| capacity | small | required |
| monthly_fee | money | required · default 0 |
| amenities | json |  |
| status | enum(active|maintenance|inactive) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `hostel_beds`
Individual beds.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| room_id | ulid | required · → hostel_rooms |
| bed_no | str(10) | required |
| status | enum(vacant|occupied|maintenance) | required · default vacant |

### `hostel_allocations`
Student on a bed for a period (no overlap, app-enforced).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| bed_id | ulid | required · → hostel_beds |
| academic_year_id | ulid | required · → academic_years |
| from_date | date | required |
| to_date | date |  |
| monthly_fee | money | required |
| status | enum(active|ended) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `hostel_outpasses`
Leave from hostel with guardian consent, warden approval, QR, late-return alert.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| hostel_id | ulid | required · → hostels |
| leave_from | dt | required |
| expected_return | dt | required |
| actual_out_at | dt |  |
| actual_return_at | dt |  |
| reason | str(200) | required |
| destination | str(160) |  |
| guardian_consent_at | dt |  |
| status | enum(pending|approved|rejected|out|returned|late) | required · default pending |
| approved_by | ulid | → users |
| qr_code | str(64) |  |
| late_alert_sent_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `hostel_visitors`
Visitor log per resident.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| hostel_id | ulid | required · → hostels |
| student_id | ulid | required · → students |
| visitor_name | str(160) | required |
| relation | str(40) |  |
| phone | str(20) |  |
| id_proof | str(60) |  |
| in_at | dt | required · default now |
| out_at | dt |  |
| approved_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `hostel_attendance`
Morning/night roll call.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| hostel_id | ulid | required · → hostels |
| student_id | ulid | required · → students |
| on_date | date | required |
| roll_call | enum(morning|night) | required · default night |
| status | enum(present|absent|on_outpass|sick) | required |
| marked_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `mess_menus`
Weekly menu.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| hostel_id | ulid | required · → hostels |
| day_of_week | small | required |
| meal | enum(breakfast|lunch|snack|dinner) | required |
| items | str(255) | required |

### `meal_records`
Per-meal attendance/billing (optional per-meal mess billing).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| hostel_id | ulid | required · → hostels |
| student_id | ulid | required · → students |
| on_date | date | required |
| meal | enum(breakfast|lunch|snack|dinner) | required |
| taken | bool | required · default true |
| cost | money |  |

### `laundry_records`
Laundry drop/return tracking.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| hostel_id | ulid | required · → hostels |
| student_id | ulid | required · → students |
| dropped_at | dt | required · default now |
| items | small | required |
| returned_at | dt |  |
| charge | money |  |

### `hostel_complaints`
Resident complaints.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| hostel_id | ulid | required · → hostels |
| student_id | ulid | → students |
| category | enum(maintenance|food|safety|cleanliness|other) | required |
| description | text | required |
| status | enum(open|in_progress|resolved) | required · default open |
| resolved_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

## Procurement, inventory & assets

Items and stores, requisitions, quotations/tenders, purchase orders with approvals, goods receipt, append-only stock ledger, issue requests, fixed assets with QR tags, maintenance and depreciation, disposal.

### `inventory_categories`
Categories; asset categories create fixed assets on receipt.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(80) | required |
| is_asset | bool | required · default false |
| gl_account_id | ulid | → gl_accounts |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `stores`
Stores/warehouses with keeper.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(80) | required |
| campus_id | ulid | → campuses |
| keeper_id | ulid | → staff |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `inventory_items`
Item master with reorder rule.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| category_id | ulid | required · → inventory_categories |
| sku | str(40) | required |
| name | str(160) | required |
| unit | str(20) | required · default pcs |
| reorder_level | dec(12,2) | required · default 0 |
| reorder_qty | dec(12,2) |  |
| preferred_vendor_id | ulid | → vendors |
| last_cost | money |  |
| barcode | str(60) |  |
| status | enum(active|inactive) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `stock_levels`
Current quantity per item per store (maintained by app on each movement).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| item_id | ulid | required · → inventory_items |
| store_id | ulid | required · → stores |
| quantity | dec(12,2) | required · default 0 |
| updated_at | dt | required · default now |

### `requisitions`
Purchase requests from departments.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| requested_by | ulid | required · → staff |
| department_id | ulid | → departments |
| items | json |  |
| justification | text |  |
| status | enum(pending|approved|rejected|ordered) | required · default pending |
| approval_request_id | ulid |  |
| approved_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `quotations`
Vendor quotations / tender bids for a requisition.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| requisition_id | ulid | → requisitions |
| vendor_id | ulid | required · → vendors |
| quoted_at | date | required |
| valid_until | date |  |
| items | json |  |
| total | money | required |
| file_id | ulid | → files |
| is_selected | bool | required · default false |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `purchase_orders`
PO with approval, receipt and bill link.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| po_no | str(30) | required |
| vendor_id | ulid | required · → vendors |
| store_id | ulid | required · → stores |
| requisition_id | ulid | → requisitions |
| order_date | date | required |
| expected_date | date |  |
| subtotal | money | required · default 0 |
| tax_total | money | required · default 0 |
| total | money | required · default 0 |
| status | enum(draft|pending_approval|approved|ordered|partially_received|received|cancelled) | required · default draft |
| is_auto | bool | required · default false |
| approval_request_id | ulid |  |
| approved_by | ulid | → users |
| bill_id | ulid | → vendor_bills |
| created_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `purchase_order_items`
PO lines with received qty.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| po_id | ulid | required · → purchase_orders |
| item_id | ulid | required · → inventory_items |
| quantity | dec(12,2) | required |
| received_qty | dec(12,2) | required · default 0 |
| unit_cost | money | required |

### `goods_receipts`
GRN against a PO.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| po_id | ulid | required · → purchase_orders |
| received_at | dt | required · default now |
| received_by | ulid | → users |
| items | json |  |
| notes | str(255) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `stock_movements`
Append-only ledger: in/out/adjust/transfer/return.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| item_id | ulid | required · → inventory_items |
| store_id | ulid | required · → stores |
| move_type | enum(in|out|adjust|transfer|return|consume) | required |
| quantity | dec(12,2) | required |
| unit_cost | money |  |
| ref_type | str(40) |  |
| ref_id | ulid |  |
| issued_to_staff_id | ulid | → staff |
| issued_to_room_id | ulid | → rooms |
| note | str(255) |  |
| created_by | ulid | → users |
| created_at | dt | required · default now |

### `issue_requests`
Consumable requests → stock-out on approval.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| requested_by | ulid | required · → staff |
| store_id | ulid | required · → stores |
| items | json |  |
| purpose | str(160) |  |
| status | enum(pending|approved|rejected|issued) | required · default pending |
| approved_by | ulid | → users |
| issued_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `assets`
Fixed asset with tag, custodian, warranty and value.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| item_id | ulid | → inventory_items |
| asset_tag | str(30) | required |
| name | str(160) | required |
| serial_no | str(80) |  |
| purchase_date | date |  |
| purchase_cost | money |  |
| vendor_id | ulid | → vendors |
| po_id | ulid | → purchase_orders |
| warranty_until | date |  |
| depreciation_pct | pct |  |
| current_value | money |  |
| location_room_id | ulid | → rooms |
| custodian_staff_id | ulid | → staff |
| condition_note | enum(new|good|fair|repair|damaged) | required · default good |
| status | enum(in_use|in_store|repair|disposed|lost) | required · default in_use |
| qr_file_id | ulid | → files |
| disposed_at | date |  |
| disposal_note | str(255) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `asset_maintenance`
Service history with next due.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| asset_id | ulid | required · → assets |
| service_date | date | required |
| service_type | enum(preventive|repair|calibration|inspection) | required |
| cost | money |  |
| vendor_id | ulid | → vendors |
| expense_id | ulid | → expenses |
| next_due_date | date |  |
| notes | text |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `asset_audits`
Periodic physical verification runs.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(120) | required |
| started_at | date | required |
| finished_at | date |  |
| results | json |  |
| status | enum(running|completed) | required · default running |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

## Facilities & maintenance

Room/hall/ground bookings, work orders for repairs, cleaning schedules, utility meter readings, safety drills, generator/water logs.

### `room_bookings`
Book a room/hall/ground for an event or class (no overlap, app-enforced).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| room_id | ulid | required · → rooms |
| booked_by | ulid | required · → users |
| purpose | str(160) | required |
| starts_at | dt | required |
| ends_at | dt | required |
| status | enum(pending|approved|rejected|cancelled) | required · default pending |
| approved_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `work_orders`
Repair/maintenance requests with SLA.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| title | str(160) | required |
| description | text |  |
| location_room_id | ulid | → rooms |
| asset_id | ulid | → assets |
| category | enum(electrical|plumbing|civil|it|furniture|cleaning|other) | required |
| priority | enum(low|normal|high|urgent) | required · default normal |
| reported_by | ulid | → users |
| assigned_to | ulid | → staff |
| vendor_id | ulid | → vendors |
| status | enum(open|assigned|in_progress|done|cancelled) | required · default open |
| due_at | dt |  |
| cost | money |  |
| expense_id | ulid | → expenses |
| completed_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `cleaning_schedules`
Recurring cleaning tasks with checklist.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| area | str(120) | required |
| frequency | enum(daily|weekly|monthly) | required |
| assigned_to | ulid | → staff |
| checklist | json |  |
| last_done_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `utility_readings`
Electricity/water/gas meter readings and bills.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| utility | enum(electricity|water|gas|internet|generator_fuel) | required |
| campus_id | ulid | → campuses |
| read_at | date | required |
| reading | dec(12,2) | required |
| cost | money |  |
| expense_id | ulid | → expenses |

### `safety_drills`
Fire/earthquake drills and inspections.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| kind | enum(fire|earthquake|evacuation|first_aid|inspection) | required |
| held_on | date | required |
| participants | int |  |
| findings | text |  |
| file_id | ulid | → files |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

## Front office, helpdesk & gate

Visitor log with host notification and photo badge, gate passes, early pickup verification, call log, postal, complaints/helpdesk with SLA and escalation, lost & found.

### `visitor_logs`
Check-in/out with purpose, host and badge.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| campus_id | ulid | → campuses |
| visitor_name | str(160) | required |
| phone | str(20) |  |
| id_proof | str(60) |  |
| purpose | enum(admission|meeting|delivery|pickup|interview|vendor|other) | required · default other |
| to_meet_staff_id | ulid | → staff |
| student_id | ulid | → students |
| badge_no | str(20) |  |
| photo_file_id | ulid | → files |
| in_at | dt | required · default now |
| out_at | dt |  |
| host_notified_at | dt |  |
| logged_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `gate_passes`
Student early leave / staff out pass with QR.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| person_type | enum(student|staff) | required |
| student_id | ulid | → students |
| staff_id | ulid | → staff |
| reason | str(160) | required |
| out_at | dt | required |
| expected_in | dt |  |
| actual_in | dt |  |
| picked_by | str(160) |  |
| authorisation_id | ulid | → pickup_authorisations |
| approved_by | ulid | → users |
| qr_code | str(64) |  |
| status | enum(pending|approved|out|returned|rejected) | required · default pending |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `call_logs`
Inbound/outbound calls with follow-up.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| direction | enum(inbound|outbound) | required |
| caller_name | str(160) |  |
| phone | str(20) | required |
| purpose | str(160) |  |
| notes | text |  |
| related_type | str(40) |  |
| related_id | ulid |  |
| follow_up_at | dt |  |
| logged_by | ulid | → users |
| called_at | dt | required · default now |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `postal_records`
Dispatch/receive register.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| direction | enum(dispatch|receive) | required |
| reference_no | str(60) |  |
| from_party | str(160) |  |
| to_party | str(160) |  |
| subject | str(200) |  |
| record_date | date | required |
| file_id | ulid | → files |
| logged_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `complaints`
Helpdesk tickets with category, priority, SLA, escalation and satisfaction.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| ticket_no | str(30) | required |
| complainant_user_id | ulid | → users |
| complainant_name | str(160) |  |
| complainant_phone | str(20) |  |
| student_id | ulid | → students |
| category | enum(academic|fees|transport|hostel|staff_behaviour|facility|safety|it|other) | required |
| subject | str(200) | required |
| description | text | required |
| priority | enum(low|normal|high|urgent) | required · default normal |
| assigned_to | ulid | → staff |
| sla_due_at | dt |  |
| escalated_at | dt |  |
| status | enum(open|in_progress|resolved|closed|reopened) | required · default open |
| resolution | text |  |
| resolved_at | dt |  |
| satisfaction | small |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `complaint_updates`
Thread of updates.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| complaint_id | ulid | required · → complaints |
| by_user_id | ulid | → users |
| note | text | required |
| is_internal | bool | required · default false |
| created_at | dt | required · default now |

### `lost_found_items`
Lost & found register.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| description | str(200) | required |
| found_at | dt |  |
| location | str(120) |  |
| photo_file_id | ulid | → files |
| claimed_by | str(160) |  |
| claimed_at | dt |  |
| status | enum(found|claimed|disposed) | required · default found |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

## Communication · SMS, push, email, WhatsApp, chat

Providers per channel with balance and fallback, event-keyed templates in bn/en/ar, notification log with delivery and cost, preferences and quiet hours, notices, chat and section channels, PTM booking, surveys/polls, newsletters, IVR/voice broadcast.

### `messaging_providers`
SMS/email/push/WhatsApp/voice providers.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| channel | enum(sms|email|push|whatsapp|voice) | required |
| provider | str(60) | required |
| credentials | json |  |
| sender_id | str(80) |  |
| is_default | bool | required · default false |
| balance | money |  |
| low_balance_threshold | money |  |
| is_active | bool | required · default true |
| cost_per_unit | money |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `notification_templates`
Per event × channel × locale with placeholders.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| event_key | str(80) | required |
| channel | enum(sms|email|push|whatsapp|in_app|voice) | required |
| locale | str(10) | required · default 'bn' |
| subject | str(200) |  |
| body | text | required |
| variables | json |  |
| is_active | bool | required · default true |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `notifications`
Every message sent with status, provider id, cost, read time.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| recipient_user_id | ulid | → users |
| recipient_address | str(160) |  |
| channel | enum(sms|email|push|whatsapp|in_app|voice) | required |
| event_key | str(80) |  |
| template_id | ulid | → notification_templates |
| title | str(200) |  |
| body | text | required |
| data | json |  |
| entity_type | str(60) |  |
| entity_id | ulid |  |
| status | enum(queued|sent|delivered|failed|read) | required · default queued |
| provider_id | ulid | → messaging_providers |
| provider_msg_id | str(120) |  |
| cost | dec(10,4) |  |
| attempts | small | required · default 0 |
| error | str(255) |  |
| scheduled_for | dt | required · default now |
| sent_at | dt |  |
| delivered_at | dt |  |
| read_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `notification_preferences`
Per user per event per channel.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| user_id | ulid | required · → users |
| event_key | str(80) | required |
| channel | enum(sms|email|push|whatsapp|in_app|voice) | required |
| enabled | bool | required · default true |

### `notices`
Notices with audience, schedule, pin, attachments.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| title | str(200) | required |
| body | long | required |
| notice_type | enum(general|academic|exam|fee|holiday|urgent|event) | required · default general |
| audience | json |  |
| attachments | json |  |
| publish_at | dt | required · default now |
| expires_at | dt |  |
| is_pinned | bool | required · default false |
| send_push | bool | required · default true |
| send_sms | bool | required · default false |
| send_email | bool | required · default false |
| status | enum(draft|scheduled|published|archived) | required · default published |
| created_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |
| deleted_at | dt | Soft delete |

### `notice_reads`
Read receipts.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| notice_id | ulid | required · → notices |
| user_id | ulid | required · → users |
| read_at | dt | required · default now |

### `conversations`
Direct chats, groups, section channels, broadcast lists.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| kind | enum(direct|group|section_channel|broadcast|support) | required · default direct |
| subject | str(160) |  |
| section_id | ulid | → sections |
| created_by | ulid | → users |
| last_message_at | dt |  |
| is_locked | bool | required · default false |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `conversation_participants`
Members with role, mute and read pointer.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| conversation_id | ulid | required · → conversations |
| user_id | ulid | required · → users |
| role | enum(member|admin) | required · default member |
| muted | bool | required · default false |
| last_read_at | dt |  |

### `messages`
Chat messages with attachments; moderated.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| conversation_id | ulid | required · → conversations |
| sender_id | ulid | → users |
| body | text |  |
| attachments | json |  |
| reply_to_id | ulid | → messages |
| sent_at | dt | required · default now |
| edited_at | dt |  |
| deleted_at | dt |  |
| flagged | bool | required · default false |

### `ptm_slots`
Parent–teacher meeting slots.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| event_id | ulid |  |
| teacher_id | ulid | required · → staff |
| starts_at | dt | required |
| ends_at | dt | required |
| capacity | small | required · default 1 |
| room_id | ulid | → rooms |
| mode | enum(in_person|online) | required · default in_person |
| join_url | str(500) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `ptm_bookings`
Bookings with reminders and outcome notes.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| slot_id | ulid | required · → ptm_slots |
| student_id | ulid | required · → students |
| guardian_id | ulid | required · → guardians |
| status | enum(booked|attended|no_show|cancelled) | required · default booked |
| notes | text |  |
| reminder_sent_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `surveys`
Surveys/polls to guardians, students, staff (uses form builder).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| form_id | ulid | required · → form_definitions |
| title | str(200) | required |
| audience | json |  |
| is_anonymous | bool | required · default false |
| opens_at | dt |  |
| closes_at | dt |  |
| status | enum(draft|open|closed) | required · default draft |
| results | json |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `newsletters`
Email/WhatsApp newsletters and campaigns.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| title | str(200) | required |
| body | long |  |
| audience | json |  |
| channel | enum(email|whatsapp|sms) | required · default email |
| scheduled_for | dt |  |
| sent_at | dt |  |
| stats | json |  |
| status | enum(draft|scheduled|sent) | required · default draft |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `voice_broadcasts`
IVR / recorded voice calls (emergency, fee reminder).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| title | str(200) | required |
| audio_file_id | ulid | → files |
| tts_text | text |  |
| audience | json |  |
| scheduled_for | dt |  |
| stats | json |  |
| status | enum(draft|scheduled|running|done) | required · default draft |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

## Welfare · behaviour, health, counselling, safeguarding

Signed behaviour points with threshold rules and disciplinary actions, growth/health records, vaccinations, clinic visits with stock link, counselling with encrypted notes, insurance, safeguarding incidents, special-needs plans.

### `behaviour_categories`
Positive/negative categories with default points and severity.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(120) | required |
| polarity | enum(positive|negative) | required |
| default_points | small | required · default 1 |
| severity | enum(low|medium|high|critical) | required · default low |
| notify_guardian | bool | required · default true |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `behaviour_incidents`
An incident with points and reporter.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| category_id | ulid | required · → behaviour_categories |
| incident_date | date | required |
| points | small | required |
| description | text | required |
| reported_by | ulid | required · → staff |
| witnesses | str(255) |  |
| attachments | json |  |
| guardian_notified_at | dt |  |
| status | enum(open|under_review|actioned|closed) | required · default open |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `disciplinary_actions`
Warning, detention, suspension… with approval and guardian acknowledgement.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| incident_id | ulid | → behaviour_incidents |
| student_id | ulid | required · → students |
| action_type | enum(verbal_warning|written_warning|detention|suspension|expulsion|counselling|community_service) | required |
| from_date | date |  |
| to_date | date |  |
| description | text |  |
| is_auto_proposed | bool | required · default false |
| status | enum(pending|approved|rejected|completed) | required · default pending |
| approved_by | ulid | → users |
| guardian_acknowledged_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `behaviour_rules`
Threshold rules → proposed action.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(120) | required |
| window_days | small | required · default 30 |
| threshold_points | small | required |
| action_type | str(40) | required |
| notify_roles | json |  |
| is_active | bool | required · default true |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `health_records`
Growth and screening records.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| recorded_on | date | required |
| height_cm | dec(5,1) |  |
| weight_kg | dec(5,1) |  |
| bmi | dec(4,1) |  |
| vision_left | str(10) |  |
| vision_right | str(10) |  |
| hearing | str(20) |  |
| dental | str(40) |  |
| blood_pressure | str(15) |  |
| allergies | json |  |
| chronic_conditions | json |  |
| medications | text |  |
| doctor_notes | text |  |
| recorded_by | ulid | → staff |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `vaccinations`
Doses and next due.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| vaccine | str(80) | required |
| dose_no | small | required · default 1 |
| given_on | date |  |
| next_due_on | date |  |
| certificate_file_id | ulid | → files |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `clinic_visits`
School clinic visit with treatment, medicines (stock-out) and send-home flag.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| person_type | enum(student|staff) | required |
| student_id | ulid | → students |
| staff_id | ulid | → staff |
| visited_at | dt | required · default now |
| complaint | str(255) | required |
| treatment | text |  |
| medicines_given | json |  |
| referred_to | str(160) |  |
| sent_home | bool | required · default false |
| guardian_notified_at | dt |  |
| attended_by | ulid | → staff |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `counselling_sessions`
Sessions with encrypted notes (counsellor-only).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| counsellor_id | ulid | required · → staff |
| session_at | dt | required |
| referral_source | enum(self|teacher|behaviour_rule|result_drop|guardian|clinic) | required · default self |
| notes_encrypted | text |  |
| follow_up_at | dt |  |
| status | enum(scheduled|done|no_show|cancelled) | required · default scheduled |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `insurance_policies`
Student/staff insurance and claims.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| person_type | enum(student|staff) | required |
| student_id | ulid | → students |
| staff_id | ulid | → staff |
| provider | str(120) | required |
| policy_no | str(60) | required |
| coverage | money |  |
| valid_from | date |  |
| valid_to | date |  |
| claims | json |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `safeguarding_cases`
Confidential child-protection cases with restricted access.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| reported_by | ulid | → users |
| category | enum(abuse|neglect|bullying|online_safety|self_harm|other) | required |
| details_encrypted | text |  |
| risk_level | enum(low|medium|high) | required · default medium |
| status | enum(open|monitoring|closed) | required · default open |
| case_owner_id | ulid | → staff |
| closed_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `special_needs_plans`
IEP / accommodation plans.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| diagnosis | str(200) |  |
| accommodations | json |  |
| goals | json |  |
| review_date | date |  |
| coordinator_id | ulid | → staff |
| file_id | ulid | → files |
| status | enum(active|closed) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

## Documents, certificates & ID cards

HTML templates rendered to PDF, document requests with automatic eligibility (dues, library, hostel, discipline), issued documents with QR verification and e-signature, ID cards (student/staff/guardian) with RFID, bulk print jobs.

### `document_templates`
Versioned templates per document type.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| doc_type | enum(tc|testimonial|character|bonafide|id_card|admit_card|report_card|payslip|receipt|donation_receipt|invoice|offer_letter|appointment_letter|experience_letter|certificate|marksheet|custom) | required |
| name | str(120) | required |
| html_template | long | required |
| css | text |  |
| page_size | str(20) | required · default A4 |
| orientation | enum(portrait|landscape) | required · default portrait |
| variables | json |  |
| is_default | bool | required · default false |
| version | small | required · default 1 |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `document_requests`
Request with eligibility snapshot and fee.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| doc_type | str(40) | required |
| person_type | enum(student|staff|alumni) | required |
| student_id | ulid | → students |
| staff_id | ulid | → staff |
| requested_by | ulid | → users |
| reason | str(255) |  |
| fee_invoice_id | ulid | → invoices |
| eligibility | json |  |
| status | enum(requested|blocked|approved|issued|rejected) | required · default requested |
| approval_request_id | ulid |  |
| decided_by | ulid | → users |
| decided_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `issued_documents`
Issued document with frozen data, file and verification code.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| template_id | ulid | → document_templates |
| request_id | ulid | → document_requests |
| doc_type | str(40) | required |
| document_no | str(40) | required |
| person_type | enum(student|staff|alumni|other) | required |
| student_id | ulid | → students |
| staff_id | ulid | → staff |
| data_snapshot | json |  |
| file_id | ulid | → files |
| verification_code | str(32) | required · unique |
| signed_by | ulid | → users |
| signature_hash | str(128) |  |
| issued_at | dt | required · default now |
| valid_until | date |  |
| revoked_at | dt |  |
| revoke_reason | str(160) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `id_cards`
Cards with validity, RFID and print status.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| person_type | enum(student|staff|guardian|visitor) | required |
| student_id | ulid | → students |
| staff_id | ulid | → staff |
| guardian_id | ulid | → guardians |
| card_no | str(30) | required |
| template_id | ulid | → document_templates |
| valid_from | date | required |
| valid_to | date | required |
| rfid_tag | str(40) |  |
| file_id | ulid | → files |
| status | enum(pending_print|active|lost|expired|cancelled) | required · default pending_print |
| printed_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `print_jobs`
Bulk print batches (ID cards, admit cards, report cards).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| kind | str(40) | required |
| items | json |  |
| file_id | ulid | → files |
| status | enum(queued|rendering|ready|printed) | required · default queued |
| created_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `document_verifications`
Public verification hits (who checked what).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| document_id | ulid | required · → issued_documents |
| verified_at | dt | required · default now |
| ip | str(45) |  |
| user_agent | str(255) |  |

## Alumni & career

Alumni directory (auto-populated at graduation), profiles, batches, mentorship, job board, reunions, giving link.

### `alumni`
Alumni profile.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | unique · → students |
| user_id | ulid | unique · → users |
| full_name | str(160) | required |
| graduation_year | small | required |
| last_class_id | ulid | → classes |
| phone | str(20) |  |
| email | str(160) |  |
| current_organisation | str(160) |  |
| current_position | str(120) |  |
| city | str(80) |  |
| country | str(60) |  |
| linkedin_url | str(255) |  |
| bio | text |  |
| photo_file_id | ulid | → files |
| is_public | bool | required · default false |
| is_mentor | bool | required · default false |
| status | enum(active|inactive) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `alumni_batches`
Batch groups with reps.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| graduation_year | small | required |
| name | str(80) |  |
| rep_alumni_id | ulid | → alumni |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `mentorship_pairs`
Alumni mentor ↔ student.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| mentor_id | ulid | required · → alumni |
| student_id | ulid | required · → students |
| topic | str(160) |  |
| started_on | date | required |
| ended_on | date |  |
| status | enum(active|ended) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `job_board_posts`
Jobs/internships shared by alumni or partners.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| posted_by_alumni_id | ulid | → alumni |
| title | str(160) | required |
| company | str(160) |  |
| location | str(120) |  |
| description | text |  |
| apply_url | str(500) |  |
| expires_at | date |  |
| status | enum(open|closed) | required · default open |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

## Events & ticketing

School events with audience, RSVP, paid tickets (QR), volunteers, schedules, photo albums, feedback.

### `events`
Event with venue, audience, RSVP and ticketing.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| calendar_event_id | ulid | → calendar_events |
| title | str(200) | required |
| description | long |  |
| event_type | enum(sports|cultural|ptm|seminar|trip|ceremony|competition|workshop|other) | required |
| starts_at | dt | required |
| ends_at | dt |  |
| venue | str(160) |  |
| room_id | ulid | → rooms |
| audience | json |  |
| rsvp_required | bool | required · default false |
| ticket_price | money |  |
| ticket_limit | int |  |
| fee_head_id | ulid | → fee_heads |
| banner_file_id | ulid | → files |
| organiser_id | ulid | → staff |
| status | enum(draft|scheduled|live|completed|cancelled) | required · default scheduled |
| feedback_form_id | ulid | → form_definitions |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `event_rsvps`
Responses.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| event_id | ulid | required · → events |
| user_id | ulid | required · → users |
| student_id | ulid | → students |
| response | enum(yes|no|maybe) | required |
| guests | small | required · default 0 |
| responded_at | dt | required · default now |

### `event_tickets`
Paid/free tickets with QR and check-in.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| event_id | ulid | required · → events |
| holder_user_id | ulid | → users |
| holder_name | str(160) |  |
| quantity | small | required · default 1 |
| amount | money | required · default 0 |
| payment_id | ulid | → payments |
| qr_code | str(64) | required · unique |
| checked_in_at | dt |  |
| status | enum(reserved|paid|cancelled|used) | required · default reserved |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `event_schedule_items`
Programme items inside an event.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| event_id | ulid | required · → events |
| starts_at | dt | required |
| title | str(200) | required |
| presenter | str(160) |  |
| sequence | small | required · default 0 |

### `event_volunteers`
Volunteer sign-ups.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| event_id | ulid | required · → events |
| user_id | ulid | required · → users |
| role | str(80) |  |
| status | enum(applied|confirmed|declined) | required · default applied |

## Governance · committee, meetings, policies

Managing committee/board members and terms, meetings with agenda, minutes and resolutions, policy documents with acknowledgements, elections (student council).

### `committees`
Managing committee, academic council, PTA, student council.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(120) | required |
| kind | enum(managing|academic|pta|student_council|disciplinary|other) | required |
| status | enum(active|dissolved) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `committee_members`
Members with role and term.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| committee_id | ulid | required · → committees |
| person_name | str(160) | required |
| user_id | ulid | → users |
| role | str(80) | required |
| term_start | date |  |
| term_end | date |  |
| status | enum(active|ended) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `meetings`
Meeting with agenda, minutes and attendance.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| committee_id | ulid | → committees |
| title | str(200) | required |
| held_at | dt | required |
| venue | str(160) |  |
| agenda | json |  |
| minutes | long |  |
| attendees | json |  |
| minutes_file_id | ulid | → files |
| status | enum(scheduled|held|cancelled) | required · default scheduled |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `resolutions`
Decisions with follow-up tasks.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| meeting_id | ulid | required · → meetings |
| number | str(20) |  |
| text | text | required |
| owner_id | ulid | → users |
| due_date | date |  |
| status | enum(open|done|dropped) | required · default open |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `policy_documents`
School policies with versions and acknowledgement tracking.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| title | str(200) | required |
| category | str(60) |  |
| version | small | required · default 1 |
| file_id | ulid | → files |
| body | long |  |
| applies_to | json |  |
| effective_from | date |  |
| status | enum(draft|active|retired) | required · default draft |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `policy_acknowledgements`
Who acknowledged which policy.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| policy_id | ulid | required · → policy_documents |
| user_id | ulid | required · → users |
| acked_at | dt | required · default now |

### `elections`
Student council / class captain elections with online voting.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| title | str(200) | required |
| scope | json |  |
| opens_at | dt | required |
| closes_at | dt | required |
| candidates | json |  |
| results | json |  |
| status | enum(draft|open|closed) | required · default draft |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `election_votes`
Anonymous votes (voter hashed).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| election_id | ulid | required · → elections |
| voter_hash | str(64) | required |
| candidate_id | str(40) | required |
| cast_at | dt | required · default now |

## Compliance & government reporting

Bangladesh-specific returns: BANBEIS census, board registration exports, MPO salary sheets, stipend lists, EIIN data; data-protection: consent records, data export/delete requests, retention policies.

### `govt_reports`
Generated regulatory reports with period and file.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| report_type | enum(banbeis_census|board_registration|mpo_salary_sheet|stipend_list|annual_return|custom) | required |
| period | str(20) | required |
| data | json |  |
| file_id | ulid | → files |
| submitted_at | dt |  |
| status | enum(draft|generated|submitted|accepted) | required · default draft |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `stipend_programs`
Govt stipend schemes (PESP, secondary stipend) and enrolled students.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(160) | required |
| authority | str(120) |  |
| criteria | json |  |
| amount | money |  |
| frequency | enum(monthly|quarterly|half_yearly|yearly) |  |
| status | enum(active|closed) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `stipend_enrollments`
Students in a stipend programme with disbursement history.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| program_id | ulid | required · → stipend_programs |
| student_id | ulid | required · → students |
| enrolled_on | date | required |
| bank_or_mfs | json |  |
| disbursements | json |  |
| status | enum(active|suspended|ended) | required · default active |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `consent_records`
Guardian/staff consents (photo use, data processing, trips).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| user_id | ulid | required · → users |
| student_id | ulid | → students |
| consent_type | str(60) | required |
| granted | bool | required |
| granted_at | dt | required · default now |
| expires_at | dt |  |
| evidence | json |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `data_requests`
Data export / deletion requests (privacy).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| user_id | ulid | required · → users |
| kind | enum(export|delete|correct) | required |
| status | enum(requested|processing|done|rejected) | required · default requested |
| file_id | ulid | → files |
| processed_by | ulid | → users |
| processed_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `retention_policies`
How long to keep each data class.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| entity_type | str(60) | required |
| keep_years | small | required |
| action | enum(archive|anonymise|delete) | required · default archive |
| is_active | bool | required · default true |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

## Analytics, BI & predictions

Dashboards per role, saved metrics, data marts refreshed nightly, anomaly alerts, predictive models (dropout risk, fee-default risk, result risk), benchmarking across campuses/schools.

### `dashboards`
Configurable dashboards per role/user.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(120) | required |
| role_id | ulid | → roles |
| user_id | ulid | → users |
| layout | json |  |
| is_default | bool | required · default false |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `metrics`
Metric catalogue with query and thresholds.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| key_name | str(80) | required |
| name | str(160) | required |
| definition | json |  |
| unit | str(20) |  |
| warn_below | dec(12,2) |  |
| warn_above | dec(12,2) |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `metric_values`
Time series per metric per dimension.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| metric_id | ulid | required · → metrics |
| period | date | required |
| dimension | str(80) |  |
| value | dec(14,2) | required |

### `risk_scores`
Predicted risks per student with explanation, refreshed weekly.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| student_id | ulid | required · → students |
| risk_type | enum(dropout|fee_default|result_decline|attendance) | required |
| score | pct | required |
| factors | json |  |
| computed_at | dt | required · default now |
| acknowledged_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `anomaly_alerts`
Detected anomalies (collection drop, attendance dip, SMS spike).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| metric_key | str(80) | required |
| detected_at | dt | required · default now |
| expected | dec(14,2) |  |
| actual | dec(14,2) |  |
| severity | enum(info|warn|critical) | required · default warn |
| status | enum(open|acknowledged|resolved) | required · default open |
| details | json |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `benchmark_snapshots`
Anonymised cross-school benchmarks (platform level).

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| period | date | required |
| cohort | str(60) | required |
| metric_key | str(80) | required |
| p25 | dec(14,2) |  |
| p50 | dec(14,2) |  |
| p75 | dec(14,2) |  |

## AI assistant & automation copilots

Natural-language assistant for admins/teachers/guardians (answers from school data, drafts notices, explains reports), question and remark generation, lesson-plan drafts, OCR of marks sheets/documents, WhatsApp chatbot for guardians, prompt/usage governance.

### `ai_conversations`
Assistant chat sessions per user with channel.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| user_id | ulid | required · → users |
| channel | enum(web|app|whatsapp|sms) | required · default web |
| title | str(200) |  |
| context | json |  |
| last_message_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `ai_messages`
Messages with tool calls and token usage.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| conversation_id | ulid | required · → ai_conversations |
| role | enum(user|assistant|tool|system) | required |
| content | long |  |
| tool_calls | json |  |
| tokens_in | int | required · default 0 |
| tokens_out | int | required · default 0 |
| cost | dec(10,4) | required · default 0 |
| created_at | dt | required · default now |

### `ai_generations`
Generated artefacts (questions, remarks, lesson plans, notices, summaries) with review status.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| kind | enum(questions|remarks|lesson_plan|notice|summary|translation|report_narrative|other) | required |
| requested_by | ulid | → users |
| input | json |  |
| output | json |  |
| model | str(60) |  |
| status | enum(generated|reviewed|applied|discarded) | required · default generated |
| applied_to_type | str(60) |  |
| applied_to_id | ulid |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `ocr_jobs`
OCR/OMR of uploaded images (marks sheets, documents) into structured data.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| file_id | ulid | required · → files |
| kind | enum(marks_sheet|omr|document|id_card|receipt) | required |
| result | json |  |
| confidence | pct |  |
| status | enum(queued|done|needs_review|applied|failed) | required · default queued |
| applied_to_type | str(60) |  |
| applied_to_id | ulid |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `ai_policies`
Per-school AI settings: enabled features, data scope, monthly budget, model.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| features | json |  |
| data_scope | json |  |
| monthly_budget | money |  |
| model | str(60) |  |
| is_enabled | bool | required · default false |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `ai_usage_monthly`
Usage rollup for billing.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| month | date | required |
| tokens_in | big | required · default 0 |
| tokens_out | big | required · default 0 |
| cost | money | required · default 0 |

## Marketplace, plugins & developer platform

Extension points so third parties (and the school) can add apps without forking: plugins with hooks and settings, app installs per school, OAuth clients, public API scopes, theme packs, template packs.

### `plugins`
Registered plugins/apps.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| slug | str(80) | required · unique |
| name | str(160) | required |
| vendor | str(160) |  |
| description | text |  |
| version | str(20) | required |
| hooks | json |  |
| settings_schema | json |  |
| price_monthly | money | required · default 0 |
| status | enum(draft|published|suspended) | required · default draft |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `plugin_installs`
Plugin enabled for a school with settings.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| plugin_id | ulid | required · → plugins |
| settings | json |  |
| is_enabled | bool | required · default true |
| installed_by | ulid | → users |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `oauth_clients`
OAuth2 clients for third-party apps and SSO.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| name | str(160) | required |
| client_id | str(64) | required · unique |
| client_secret_hash | str(128) | required |
| redirect_uris | json |  |
| scopes | json |  |
| is_confidential | bool | required · default true |
| revoked_at | dt |  |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

### `oauth_tokens`
Issued access/refresh tokens.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| school_id | ulid | required · → schools · Tenant |
| client_id | ulid | required · → oauth_clients |
| user_id | ulid | → users |
| token_hash | str(128) | required · unique |
| kind | enum(access|refresh|authorization_code) | required |
| scopes | json |  |
| expires_at | dt | required |
| revoked_at | dt |  |
| created_at | dt | required · default now |

### `template_packs`
Installable packs: document templates, notification templates, chart of accounts, grading scales per board/country.

| Column | Type | Notes |
|---|---|---|
| id | ulid | required · ULID primary key |
| slug | str(80) | required · unique |
| name | str(160) | required |
| kind | enum(documents|notifications|accounting|grading|curriculum|forms) | required |
| locale | str(10) |  |
| content | json |  |
| version | str(20) | required |
| created_at | dt | required · default now |
| updated_at | dt | required · default now |

