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

## Phase 1 · Academic core, people, website (weeks 4–7)

Academic structure (school/college/madrasa/coaching switches), students/guardians/staff, enrollments, Excel import with error file, timetable builder with clash rules + auto-generator v1, substitutions, syllabus & lesson plans, calendar, CMS website with admission form and notices, guardian PWA v0 (child card, notices, timetable), design system components.

**Exit:** 1,500 students imported in < 2 min; 40-section timetable generated with zero clashes; school website live on the school’s domain.

## Phase 2 · Attendance, communication, diary (weeks 8–10)

Device ingestion (ZKTeco/Hikvision push, RFID), QR/app marking, policies, auto-absent, leave workflow, substitutions from leave, chat & section channels, PTM slots, homework diary, KG daily report, teacher PWA v0.

**Exit:** absent SMS within 5 minutes of cut-off for every section; teacher marks a class in 30 s on a phone.

## Phase 3 · Fees, payments, accounting (weeks 11–14) → **pilot go-live**

Fee heads/structures/overrides/discounts, monthly batch with pro-rata, bKash/Nagad/SSLCommerz IPN, counter cash sessions, allocation & ledger, reminder ladder, fines, refunds, instalment plans; GL seed for BD schools, auto-journals, expenses & approvals, bank reconciliation, budgets, statements; guardian PWA pay flow.

**Exit:** a month closes with balanced trial balance and zero manual fee journals; pilot school collects online.

## Phase 4 · Assessment (weeks 15–19)

Grading scales, exams, schedules, seat plans & admit cards with eligibility, marks entry (web grid + Excel + OMR v1), verification/lock, result engine (weights, ties, F→0), report cards (bn/en, pdfmake), publish scheduling, promotion, question bank & paper generator, online exams, competency assessment v1.

**Exit:** annual results for 1,500 students published with PDFs in < 10 min on shared hosting (chunked job).

## Phase 5 · HR & payroll (weeks 20–23)

Recruitment, onboarding, contracts, shifts, salary components/structures, loans, PF, tax slabs, payroll from attendance/leave, payslips, bank file, MPO split, appraisals, exits.

**Exit:** payroll for 150 staff drafted, approved, paid, journaled in one pass.

## Phase 6 · Admissions & documents (weeks 24–26)

Campaigns, enquiry CRM, public form + form fee, tests, merit/lottery, offers with expiry, waitlist promotion, one-click enrolment; document templates, requests with eligibility, QR verification page, ID cards, print jobs.

## Phase 7 · Operations (weeks 27–31)

Library (catalogue import, barcode, fines to bill, reservations, reading logs), transport (routes, GPS vendor adapter, geofence push, boardings, driver PWA, compliance alerts), hostel (beds, out-pass with consent, roll call, mess/meal billing), inventory (requisition → quotation → PO → GRN → stock ledger, assets with QR, maintenance), front office (visitors with host push, gate passes, complaints with SLA).

## Phase 8 · Welfare, LMS, engagement (weeks 32–36)

Behaviour points & rules, health, clinic (stock link), counselling (encrypted), safeguarding, SEN plans; LMS courses/lessons/materials/online classes; notices scheduling, surveys, newsletters; student PWA v1; co-curricular v1.

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
