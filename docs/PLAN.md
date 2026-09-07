# Pathshala — Implementation plan v2 (Node/React on cPanel, portable)

Assumptions: 4 engineers (2 backend/TS, 1 React web, 1 React portal/PWA) + 1 designer/QA.
Target: first paying school live on Namecheap cPanel at **week 14**, general availability
(Year-1 scope of `ROADMAP-5Y.md`) at **week 40**. Order matters more than the week counts.

---

## Phase 0 · Foundation & zero-touch installer (weeks 1–3)

* Monorepo (pnpm + Turborepo): `apps/web` (React 19 + React Router framework mode SSR, Tailwind 4, Vite), `apps/server` (Node 22 + Express 5 host for Passenger), `packages/db` (Drizzle schema generated from `db/schema/*.def.mjs`, drizzle-kit migrations applied at boot), `packages/schemas` (Zod), `packages/adapters`, `packages/ui`.
* Pure-JS only: bcryptjs, own TOTP, jimp, pdf-lib/pdfmake, SheetJS, mysql2, Nodemailer, web-push. CI fails on any package with a native build step.
* Adapters with both implementations stubbed: db (mysql/sqlite/postgres), queue (db/bullmq), scheduler (in-app + heartbeat/cron), storage (uploads/s3), pdf (pdf-lib/chromium), realtime (sse/ws), push (webpush/fcm).
* Cloudflare in front (DNS, TLS, cache) and Turnstile on login, admission and contact forms.
* **Installer**: `install.php` bootstrap + Node `/install` wizard exactly as `HOSTING-CPANEL.md` (Node detection, DB detection with SQLite fallback, `.env`, `.htaccess`, cron via `uapi` or heartbeat, seeds, self-test, resume on failure).
* Auth (OTP, JWT, refresh, TOTP), tenancy scope, RBAC middleware, audit, files, settings, custom fields.
* Automation core: outbox, relay, rule engine (JSONLogic), scheduler with DB lock, background jobs, approvals, tasks, notifications (SMS/email/push providers, templates bn/en, quiet hours).
* Release pipeline: GitHub Actions builds the cPanel zip (Linux x64 node_modules baked in) and the Docker images from the same commit.

**Exit:** a fresh Namecheap account → upload zip → extract → open domain → dashboard in under 5 minutes with no cPanel clicks; rule → SMS + PDF end-to-end; same build boots in Docker with Postgres.

> **Status (7 Sep 2026): implemented.** Monorepo (`apps/server`, `apps/web`, `apps/installer`, `packages/db|core|adapters|events|schemas|ui`), all adapters with cPanel implementations and VPS stubs, `install.php` + `/install` wizard, auth (password/OTP/TOTP/session epoch/JWT), tenancy context, RBAC, audit, files, settings, custom fields, automation core (outbox → relay → system handlers + JSONLogic rules → DB queue with chunked jobs, scheduler with DB lock and heartbeat, approvals, tasks), notifications (templates bn/en, quiet hours, sms/email/push/in-app), release pipeline (cPanel zip + Docker from one commit). `tests/smoke.test.mjs` covers the exit criterion on SQLite locally and on MySQL 8 / Postgres 16 in CI. Not yet done: Cloudflare Turnstile is wired on login but untested against a real site key; a real Namecheap account run is still to be performed.

## Phase 1 · Academic core, people, website (weeks 4–7)

Academic structure (school/college/madrasa/coaching switches), students/guardians/staff, enrollments, Excel import with error file, timetable builder with clash rules + auto-generator v1, substitutions, syllabus & lesson plans, calendar, CMS website with admission form and notices, guardian PWA v0 (child card, notices, timetable), design system components.

**Exit:** 1,500 students imported in < 2 min; 40-section timetable generated with zero clashes; school website live on the school’s domain.

> **Status (7 Sep 2026): implemented (v0).** `packages/core/src/modules/`: academic (years with clone, terms, classes, subjects, class-subject matrix, sections with auto-placement, shifts/periods, rooms, calendar + weekly offs, institution presets for school/madrasa/college/coaching), people (students with numbering, enrollments, guardians shared by phone → sibling links, staff with subjects, portal accounts on first OTP), importer (SheetJS template → validate → chunked job → error workbook), timetable (versions, clash rules, greedy generator v1, teacher auto-assign, substitution suggestions), curriculum (syllabi/units, lesson plans, progress roll-up, weekly behind-schedule alert B6), cms (block pages, menu, notices, public admission enquiry → rule A1, contact), portal (children, child card, timetable). Console pages for each, public site at `/site`, guardian PWA v0 at `/portal` (manifest + service worker). `tests/phase1.test.mjs` proves the exit criteria on SQLite, MySQL and Postgres: 1,500-row import ≈ 4–5 s, 40 sections × 30 periods → 1,200 placed, 0 clashes. Not yet: Excel import for staff, timetable drag-and-drop editing, custom-domain routing test on a real host, design-system component library beyond the basics.

## Phase 2 · Attendance, communication, diary (weeks 8–10)

Device ingestion (ZKTeco/Hikvision push, RFID), QR/app marking, policies, auto-absent, leave workflow, substitutions from leave, chat & section channels, PTM slots, homework diary, KG daily report, teacher PWA v0.

**Exit:** absent SMS within 5 minutes of cut-off for every section; teacher marks a class in 30 s on a phone.

> **Status (7 Sep 2026): implemented.** `attendance` (policies per class with cut-off and grace, QR/app/manual marking with a whole-section default, device ingestion for ZKTeco and Hikvision push and RFID with replay protection, the auto-absent sweep that queues one guardian SMS per absentee, monthly summaries, leave types, leave requests with approval and balance, substitutions raised from an approved leave) and `communication` (direct chat, automatic section channels created when a timetable is published, broadcast with role and section targeting, PTM slots with capacity, homework diary with per-section publication, KG daily report). Console pages: attendance, diary, chat, plus the teacher PWA at `/teach`. `tests/phase2.test.mjs` proves the exit criterion — the cut-off sweep marks and notifies every absentee of 40 sections inside the 5-minute window, and a phone-sized section marking round-trip stays under a second. Green on SQLite, MySQL and Postgres. Not yet: OMR-free bulk attendance import, biometric device enrolment UI, chat file attachments.

## Phase 3 · Fees, payments, accounting (weeks 11–14) → **pilot go-live**

Fee heads/structures/overrides/discounts, monthly batch with pro-rata, bKash/Nagad/SSLCommerz IPN, counter cash sessions, allocation & ledger, reminder ladder, fines, refunds, instalment plans; GL seed for BD schools, auto-journals, expenses & approvals, bank reconciliation, budgets, statements; guardian PWA pay flow.

**Exit:** a month closes with balanced trial balance and zero manual fee journals; pilot school collects online.

> **Status (7 Sep 2026): implemented.** `fees` (heads, per-class structures with frequency and due day, discounts including the automatic sibling proposal A9, the chunked invoice batch with pro-rata for mid-month admissions, payments allocated oldest-first with advances kept visible, student ledger, the reminder ladder that survives a missed day, late fines, refunds, counter cash sessions with variance, signed and idempotent gateway IPN for bKash/Nagad/SSLCommerz, guardian pay flow) and `accounting` (double-entry GL where every fee, payment, refund and expense posts its own journal, trial balance, income statement, expenses with approval, bank import and reconciliation, budgets). Console pages: fees, accounts. `tests/phase3.test.mjs` proves the exit criterion — balanced trial balance, `is_auto` on every fee journal, and the receivable account agreeing with the fee module. Green on SQLite, MySQL and Postgres. Not yet: instalment plans UI, cheque clearing, MPO grant handling, PDF receipts.

## Phase 4 · Assessment (weeks 15–19)

Grading scales, exams, schedules, seat plans & admit cards with eligibility, marks entry (web grid + Excel + OMR v1), verification/lock, result engine (weights, ties, F→0), report cards (bn/en, pdfmake), publish scheduling, promotion, question bank & paper generator, online exams, competency assessment v1.

**Exit:** annual results for 1,500 students published with PDFs in < 10 min on shared hosting (chunked job).

> **Status (7 Sep 2026): implemented.** `assessment`: grading scales (the Bangladesh GPA 5.0 bands are seeded, `fail_gpa_zero` zeroes the GPA of anyone who fails a subject), exam types, exams with one schedule per class subject, seat plans that record *why* a student is ineligible (fees due, attendance below the exam's floor), the marks grid with theory/practical/continuous-assessment columns and an absent flag, verification then lock (a locked paper refuses further edits until it is unlocked), the result engine (per-subject grade and grade point, weighted GPA, ranks in section and class with `share_rank`/`dense`/`by_total` ties), report cards rendered in Bangla and English by pdfmake, publishing as a chunked background job that notifies each guardian, annual aggregation and promotion into the next year's enrolments, the question bank with blueprint-driven paper generation, auto-graded online exams, and the guardian result view. Console page: exams. `tests/phase4.test.mjs` proves the exit criterion on SQLite, MySQL and Postgres — 1,500 report cards render in roughly 40 s, far inside the 10-minute budget, in chunks of 25 so no single request outlives shared hosting's limit. Not yet: OMR marks capture, Excel marks import, admit-card PDFs, competency assessment.

## Phase 5 · HR & payroll (weeks 20–23)

Recruitment, onboarding, contracts, shifts, salary components/structures, loans, PF, tax slabs, payroll from attendance/leave, payslips, bank file, MPO split, appraisals, exits.

**Exit:** payroll for 150 staff drafted, approved, paid, journaled in one pass.

> **Status (7 Sep 2026): implemented.** `hr`: vacancies published on the school website with a public application form and a hiring pipeline that creates the staff record and its account, the onboarding checklist and its tasks, contracts and work shifts, salary components (house rent, medical, conveyance, provident fund both sides, income tax) with per-staff structures that supersede one another by date, the NBR tax slabs seeded per fiscal year, loans and advances that pay out as an asset and recover themselves through the payslip, the payroll run itself — a chunked job that reads staff attendance, approved leave, late-to-loss-of-pay policy and overtime, freezes one payslip per member of staff, renders the payslip PDFs and the bank transfer file, and posts one balanced journal (salary expense and employer provident fund against provident-fund and tax payable, loan recovery, the MPO share recognised as government grant income, and salary payable for what the school itself owes) — appraisal cycles with metrics the system measures itself, training records, and the exit with leave encashment, loan recovery and provident-fund payout. Console page: hr; staff see their own payslips at `/api/teach/payslips`. `tests/phase5.test.mjs` proves the exit criterion — 151 staff drafted, approved, paid and journaled in about 5 s with a balanced trial balance and no hand-written journal. Green on SQLite, MySQL and Postgres. Not yet: gratuity, MPO bank-file format per bank, appraisal forms in the teacher portal, recruitment interview scheduling.

## Phase 6 · Admissions & documents (weeks 24–26)

Campaigns, enquiry CRM, public form + form fee, tests, merit/lottery, offers with expiry, waitlist promotion, one-click enrolment; document templates, requests with eligibility, QR verification page, ID cards, print jobs.

**Exit (chosen; the plan sets none for this phase):** 500 applications taken from the public form through merit selection to enrolment without a spreadsheet.

> **Status (7 Sep 2026): implemented.** `admissions`: campaigns with seats and age limits per class and their own public address, the enquiry CRM (round-robin counsellor, acknowledgement, follow-up task, daily reminders and escalation), the public application form and status tracker, the form fee that submits the application and triggers the admit card, entrance tests and marks, the merit list — score, lottery or first-come, sibling priority, the older child breaking ties — which waits for the last mark of the class and never unseats an applicant who already holds an offer, offers with an expiry and an admission-fee invoice, hourly revocation of unpaid offers with the waitlist moving up, and enrolment the moment the admission fee is paid. `documents`: versioned templates, requests whose eligibility is checked against the modules that hold the debt, issued PDFs with a code anyone can verify on a public page, ID cards and chunked print batches. Console page: admissions. `tests/phase6.test.mjs` proves it on SQLite, MariaDB 11.4 and Postgres 16: 500 applications, 200 seats filled in strict merit order, the rest waitlisted, one enrolment through the money path, and a transfer certificate blocked by dues then issued and verified. Not yet: applicant document uploads, interview scheduling, the printed merit-list PDF, ID-card photos on the card.

## Phase 7 · Operations (weeks 27–31)

Library (catalogue import, barcode, fines to bill, reservations, reading logs), transport (routes, GPS vendor adapter, geofence push, boardings, driver PWA, compliance alerts), hostel (beds, out-pass with consent, roll call, mess/meal billing), inventory (requisition → quotation → PO → GRN → stock ledger, assets with QR, maintenance), front office (visitors with host push, gate passes, complaints with SLA).

**Exit (chosen; the plan sets none for this phase):** every operations module keeps its own books straight without anyone re-typing anything: a library fine reaches the student's invoice, a bus tells the right guardians, a hostel resident cannot leave without consent, a delivery becomes stock, an expense and a tagged asset, and a late ticket escalates itself.

> **Status (7 Sep 2026): implemented.** `library` (catalogue with copies and accession numbers, members with their own limits, issue and return, a daily fine capped at the price of the book and billed on the next invoice, renewals blocked while somebody is waiting, a reservation queue that offers a returned copy to the next reader for two days, reading logs, and one daily job that marks overdue loans, chases them once per stage and writes off what has been gone two months), `transport` (fleet with compliance dates, routes with geofenced stops, riders whose fee is snapshotted, the day's trips created by the scheduler, GPS ingestion that raises one approach alert per stop and logs over-speeding as a driver incident, boardings that also mark the child present in the morning, and the alert nobody wants to send by hand — a drop trip ending with a child still on board), `hostel` (rooms and beds with no double-booking, out-passes that need the guardian's consent before the warden approves them and a QR the gate scans both ways, late-return and night-roll-call watches, mess menu and meals, complaints that raise maintenance tasks), `inventory` (an append-only movement ledger with a running level beside it, requisition → quotation → purchase order with approval → goods receipt that adds stock, posts the expense and its journal and tags each asset, automatic reordering below the reorder level, issue requests, and stock counts written into the ledger as signed adjustments) and `frontoffice` (visitor book with a badge and a push to the host, gate passes only for people the guardians authorised, call and post registers, the helpdesk with an owner by category, a deadline by priority and an hourly escalation, and lost property). Console page: operations. `tests/phase7.test.mjs` proves all of it on SQLite, MariaDB 11.4 and Postgres 16. Not yet: the driver and helper PWA, barcode scanning hardware, per-meal mess billing onto the invoice, facilities and work orders (Phase 8 scope in the schema).

## Phase 8 · Welfare, LMS, engagement (weeks 32–36)

Behaviour points & rules, health, clinic (stock link), counselling (encrypted), safeguarding, SEN plans; LMS courses/lessons/materials/online classes; notices scheduling, surveys, newsletters; student PWA v1; co-curricular v1.

**Exit (chosen; the plan sets none for this phase):** a child's non-academic record is as automatic as their marks — points add up to a proposed action, a clinic visit moves stock and calls home, a course enrols its class, a late assignment is penalised once, and confidential notes stay unreadable to everyone but their owner.

> **Status (7 Sep 2026): implemented.** `welfare` (behaviour categories and signed points, threshold rules that propose an action once per window rather than every night, disciplinary actions the guardian must acknowledge, growth records with BMI, vaccinations with a reminder, the clinic taking its medicines out of the store through the stock ledger and calling home when a child is sent home, counselling and safeguarding notes encrypted at rest and readable only by the counsellor or case owner — the alert says a case exists, never what is in it — and special-needs plans), `lms` (courses with modules and lessons, publishing a class-subject course enrols that class by itself, per-lesson progress rolling up to a percentage, assignments whose late penalty is applied once at marking time, study materials, live classes with a Jitsi link that needs no account, attendance back from the platform, discussions, and an hourly job that reminds only those who have not handed in) and `engagement` (surveys on the form builder answered once per guardian and summarised by question type, newsletters that send once, events with RSVP and a QR ticket the gate scans once, clubs, house points, achievements and badges, and the weekly digest that stays silent when there is nothing to say). Console page: learning; students and guardians read their own at `/api/portal/learning/:studentId`. `tests/phase8.test.mjs` covers all of it on SQLite, MariaDB 11.4 and Postgres 16. Not yet: quizzes inside lessons, SCORM/H5P, certificates on course completion, the student PWA as its own app, competitions and the results ledger.

## Phase 9 · Hardening & GA (weeks 37–40)

Load test on a real Namecheap Stellar account (5 schools × 1,500 students in one tenant DB), memory/queue tuning, SQLite→MySQL migration tool, update mechanism with rollback, backup to Drive/Dropbox, security review (OTP limits, secrets, tenant scope fuzzing), bn/en QA, admin manual (bn), onboarding wizard, Year-2 flags shipped dark.

---

## Milestones

| Week | Milestone |
|---|---|
| 3 | Zip → dashboard in 5 minutes on cPanel; same build in Docker |
| 7 | Pilot data imported, timetable generated, website live |
| 10 | Attendance SMS live; teacher PWA in daily use |
| 14 | **Pilot go-live** with online fee collection |
| 19 | First result published through the system |
| 23 | First payroll paid through the system |
| 26 | Admission season run end-to-end |
| 31 | Bus GPS alerts live |
| 40 | **GA** · 5 schools · auto-update working |

## Team & ownership

| Role | Owns |
|---|---|
| Backend A | installer, adapters, automation platform, fees/accounting, HR |
| Backend B | academic, attendance, assessment, admissions, operations modules |
| Web | admin console, design system, print templates |
| Portal | guardian/student/teacher/driver PWA, push, offline, later Expo shell |
| Designer/QA | bn/en UX, test plans per automation row, pilot support, manuals |

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Host without Passenger/Node | Installer detects and shows the single enabling step; everything else stays automatic |
| Passenger recycles the process → scheduler pauses | Heartbeat tick on any request + PWA background ping; jobs are chunked and resumable |
| No MySQL creatable without clicks | SQLite fallback with one-click migration to MySQL later |
| Shared-hosting limits (RAM, CPU, disk) | Chunked batch jobs, rollup tables, pruning, quota warnings, off-site backups |
| SMS cost/delivery | Push first, SMS fallback, provider balance alerts, quiet hours |
| Automation surprises | Preview window after rule edits, per-rule kill switch, cooldowns, admin alerts |
| Future migration to VPS | Adapters + export/import; tested in CI every release (cPanel zip and Docker from one commit) |

## Definition of done (every feature)

Schema in `def.mjs` · events documented · handler idempotent · rule visible in Automation → Activity · failure alerts admin · works on SQLite and MySQL · bn and en · phone and desktop · integration test for the happy path and one failure.
