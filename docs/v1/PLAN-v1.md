# Pathshala — Implementation Plan

Assumptions: 4 engineers (2 backend, 1 web, 1 mobile) + 1 designer/QA, 36 working weeks,
first pilot school onboarded at week 16, general availability at week 36. Adjust the
week counts, not the order: each phase depends on the ones before it.

---

## Phase 0 · Foundation (weeks 1–2)

**Build**
* Monorepo (Turborepo), NestJS API, worker, Next.js shell, Expo shell, CI (lint, test, migrate, deploy).
* Apply `db/schema/00_common.sql`, `01_core.sql`, `20_platform.sql` first; Drizzle types generated from SQL.
* Tenancy middleware (`SET LOCAL app.school_id`), JWT + refresh sessions, SMS OTP login, RBAC guard reading `role_permissions`.
* File service (S3 pre-signed upload), audit middleware, settings service with typed keys.
* **Automation core**: outbox writer, relay, BullMQ queues, rule engine (JSONLogic), scheduler with leader lock, `automation_runs` UI.
* Notification service: providers (one BD SMS gateway + SMTP + FCM), templates bn/en, preferences, quiet hours.
* Gotenberg PDF service with `document_templates`.

**Exit criteria**: create a school, log in as admin via OTP, upload a file, fire a test event → rule → SMS arrives, PDF renders. RLS test suite passes (cross-tenant read returns 0 rows).

## Phase 1 · Academic core & people (weeks 3–6)

**Build** `02_academic`, `03_people`, `04_timetable`
* Academic years/terms/shifts/classes/sections/subjects/class-subjects, calendar & weekly offs.
* Students, enrollments, guardians (phone-keyed, sibling view), staff, departments, designations.
* Bulk Excel import (`import_jobs`) for students/staff/guardians — this is how a real school goes live.
* Timetable builder with DB clash constraints, teacher workload view, substitution suggestions.
* Auto user provisioning for every student/guardian/staff (rule H5 / A8 pieces).
* Guardian app v0: child profile, timetable, notices.

**Exit**: import 1,000 students from Excel in < 2 min with error file; timetable for 30 sections without a single clash; guardian logs in and sees the child.

## Phase 2 · Attendance & communication (weeks 7–9)

**Build** `06_attendance`, `16_communication`
* Device integration (ZKTeco/Hikvision push → `device_punch_logs`), manual marking UI, app QR marking.
* Policies, auto-absent job, late/absent/arrival notifications, consecutive-absence escalation.
* Leave types, balances, applications, approval workflows (first real use of `approval_requests`).
* Notices, section channels/chat, PTM slots.
* Teacher app v0: mark attendance, view timetable, chat.

**Exit**: 100% of absences produce a guardian SMS within 5 minutes of cut-off; leave approval triggers substitution suggestion.

## Phase 3 · Fees, payments & accounting (weeks 10–15)

**Build** `09_accounting`, `10_fees`
* Chart of accounts seed (BD school template), journals, expenses, bank accounts.
* Fee heads/structures/overrides/discounts/fine rules; monthly invoice batch job; pro-rata on enrolment.
* Counter collection with cash sessions; SSLCommerz + bKash + Nagad gateways (IPN handlers); allocation; ledger; receipts.
* Reminder ladder, overdue/fines job, blocks, refunds with approval, bank reconciliation import.
* Auto journal posting for every money movement; trial balance, receivables ageing, collection reports.
* Guardian app: invoices, pay online, receipts, ledger.

**Exit**: one month-end closes with trial balance in balance and zero manual journal entries for fee collections. **Pilot school goes live here (week 16) with Phases 0–3.**

## Phase 4 · Examinations & results (weeks 16–20)

**Build** `07_exams`
* Grading scales (BD GPA seed), exam types, exams, schedules, seat plans, invigilators, admit cards with eligibility.
* Marks entry (web grid + Excel import), validation, verification, lock.
* Result engine (GPA, ranks, pass/fail), report card templates, publish scheduling, tabulation sheet.
* Promotion rules and year-end promotion run; alumni conversion.
* Question bank, online exams with auto-grading.

**Exit**: annual result for 1,000 students computed, ranked and published with PDFs in < 10 min; promotion creates next-year enrollments.

## Phase 5 · HR & payroll (weeks 21–24)

**Build** `11_hr_payroll`
* Contracts, salary components/structures, loans, payroll draft from attendance + leave, approvals, payslips, bank file, journal.
* Appraisal cycles with auto metrics, document expiry alerts, staff onboarding/off-boarding automation.

**Exit**: payroll for 150 staff drafted in one click, approved, paid, posted; payslips delivered by SMS/app.

## Phase 6 · Admissions pipeline (weeks 25–27)

**Build** `05_admissions`
* Campaigns with seats per class, public online form, enquiry CRM with round-robin and follow-ups.
* Form-fee & admission-fee invoices via existing fees module, tests, results, merit list, offers with expiry, waitlist promotion, one-click enrolment (creates everything from Phase 1).

> Pull this phase forward if the pilot school's go-live coincides with admission season.

**Exit**: an applicant goes from online form → payment → test → merit → offer → enrolled student with guardian login, without staff touching the keyboard except entering test marks.

## Phase 7 · Operations modules (weeks 28–31)

**Build** `12_library`, `13_transport`, `14_hostel`, `15_inventory`
* Library: catalogue import, barcode issue/return, fines to invoices, reservations.
* Transport: routes/stops, GPS ingestion (vendor API or MQTT), geofence alerts, RFID boarding, helper app, document/maintenance reminders, route fee into invoicing.
* Hostel: rooms/beds with overlap constraint, allocation → invoicing, outpass with guardian consent, curfew alerts, mess menu.
* Inventory: stores, POs with approval, stock ledger trigger, reorder automation, assets with QR, maintenance.

**Exit**: each module's automation rows in `AUTOMATION.md` demonstrably fire in staging.

## Phase 8 · LMS, welfare, documents, front office (weeks 32–34)

**Build** `08_lms`, `17_welfare`, `18_documents`, `19_front_office`
* Assignments, materials, online classes (Zoom/Meet integration), attendance from platform webhooks.
* Behaviour points & rules, health records, vaccinations, clinic (stock link), counselling (encrypted notes).
* TC/testimonial/character certificate requests with eligibility engine, QR verification page, ID card batches.
* Visitor/call/postal logs, complaints with SLA, alumni directory.

## Phase 9 · Hardening & GA (weeks 35–36)

* Load test: 50 schools × 2,000 students; invoice batch and result engine under load; partition high-volume tables.
* Security review: RLS fuzzing, secrets rotation, OTP rate limits, dependency audit, backup restore drill (PITR).
* Metabase dashboards on `kpi_daily`; weekly digest; anomaly alerts.
* Onboarding playbook: Excel templates, chart-of-accounts template, default rules/templates (bn/en), device pairing guide.
* Documentation: admin manual (bn), API reference (OpenAPI), runbooks.

---

## Milestones

| Week | Milestone |
|---|---|
| 2 | Automation engine fires end-to-end (event → rule → SMS + PDF) |
| 6 | Pilot school data imported, timetable live, guardian app in hands of 50 parents |
| 9 | Attendance SMS live for the pilot |
| 16 | **Pilot go-live**: fees collected online, month-end closed |
| 20 | First exam result published through the system |
| 24 | First payroll paid through the system |
| 27 | Admission season run through the pipeline |
| 31 | Transport GPS alerts live |
| 36 | **General availability**, 5 schools onboarded |

## Team & ownership

| Role | Owns |
|---|---|
| Backend A | Core, automation platform, fees/accounting, HR |
| Backend B | Academic, attendance, exams, admissions, operations modules |
| Web | Admin/teacher web app, report/PDF templates |
| Mobile | Guardian, student, teacher, helper apps |
| Designer/QA | UX for bn/en, test plans per automation row, pilot support |

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| SMS cost & delivery in BD | Push first, SMS fallback; per-school provider choice; balance alerts; batch quiet hours |
| Biometric device variety | Ingest raw punches via a thin adapter per vendor; resolver is vendor-agnostic |
| Schools' messy legacy data | Import with validation + error file; "draft" students until verified |
| Result-rule variations (board vs school) | Grading scales, weights, tie rules all data-driven; result engine unit-tested against board samples |
| Automation surprises (wrong SMS at scale) | Rules default to preview mode for 48h after change; per-rule kill switch; cooldowns |
| Single VPS at start | Daily PITR + off-site object storage backups; restore drill in Phase 9 |

## Definition of done for any automation row

1. Event or cron entry exists and is documented in `AUTOMATION.md`.
2. Rule/handler is idempotent (re-running yields no duplicates).
3. `automation_runs` shows the run with a readable result.
4. Failure path notifies an admin.
5. Integration test covers the happy path and one failure.
