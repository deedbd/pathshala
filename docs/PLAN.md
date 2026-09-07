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

> **Status (7 Sep 2026): implemented (v0).** `packages/core/src/modules/`: academic (years with clone, terms, classes, subjects, class-subject matrix, sections with auto-placement, shifts/periods, rooms, calendar + weekly offs, institution presets for school/madrasa/college/coaching), people (students with numbering, enrollments, guardians shared by phone → sibling links, staff with subjects, portal accounts on first OTP), importer (SheetJS template → validate → chunked job → error workbook, for students, staff — designation, subjects and the salary structure in one row — and a register of attendance), timetable (versions, clash rules, greedy generator v1, teacher auto-assign, substitution suggestions), curriculum (syllabi/units, lesson plans, progress roll-up, weekly behind-schedule alert B6), cms (block pages, menu, notices, public admission enquiry → rule A1, contact), portal (children, child card, timetable). Console pages for each, public site at `/site`, guardian PWA v0 at `/portal` (manifest + service worker). `tests/phase1.test.mjs` proves the exit criteria on SQLite, MySQL and Postgres: 1,500-row import ≈ 4–5 s, 40 sections × 30 periods → 1,200 placed, 0 clashes. Not yet: timetable drag-and-drop editing, custom-domain routing test on a real host, design-system component library beyond the basics.

## Phase 2 · Attendance, communication, diary (weeks 8–10)

Device ingestion (ZKTeco/Hikvision push, RFID), QR/app marking, policies, auto-absent, leave workflow, substitutions from leave, chat & section channels, PTM slots, homework diary, KG daily report, teacher PWA v0.

**Exit:** absent SMS within 5 minutes of cut-off for every section; teacher marks a class in 30 s on a phone.

> **Status (7 Sep 2026): implemented.** `attendance` (policies per class with cut-off and grace, QR/app/manual marking with a whole-section default, device ingestion for ZKTeco and Hikvision push and RFID with replay protection, the auto-absent sweep that queues one guardian SMS per absentee, monthly summaries, leave types, leave requests with approval and balance, substitutions raised from an approved leave) and `communication` (direct chat, automatic section channels created when a timetable is published, broadcast with role and section targeting, PTM slots with capacity, homework diary with per-section publication, KG daily report). Console pages: attendance, diary, chat, plus the teacher PWA at `/teach`. `tests/phase2.test.mjs` proves the exit criterion — the cut-off sweep marks and notifies every absentee of 40 sections inside the 5-minute window, and a phone-sized section marking round-trip stays under a second. Green on SQLite, MySQL and Postgres. Not yet: biometric device enrolment UI, chat file attachments.

## Phase 3 · Fees, payments, accounting (weeks 11–14) → **pilot go-live**

Fee heads/structures/overrides/discounts, monthly batch with pro-rata, bKash/Nagad/SSLCommerz IPN, counter cash sessions, allocation & ledger, reminder ladder, fines, refunds, instalment plans; GL seed for BD schools, auto-journals, expenses & approvals, bank reconciliation, budgets, statements; guardian PWA pay flow.

**Exit:** a month closes with balanced trial balance and zero manual fee journals; pilot school collects online.

> **Status (7 Sep 2026): implemented.** `fees` (heads, per-class structures with frequency and due day, discounts including the automatic sibling proposal A9, the chunked invoice batch with pro-rata for mid-month admissions, payments allocated oldest-first with advances kept visible, the receipt PDF the counter hands over, cheques held pending until the bank clears or returns them, instalment plans whose parts become invoices on the day each falls due, student ledger, the reminder ladder that survives a missed day, late fines, refunds, counter cash sessions with variance, signed and idempotent gateway IPN for bKash/Nagad/SSLCommerz, guardian pay flow) and `accounting` (double-entry GL where every fee, payment, refund and expense posts its own journal, trial balance, income statement, expenses with approval, bank import and reconciliation, budgets). Console pages: fees, accounts. `tests/phase3.test.mjs` proves the exit criterion — balanced trial balance, `is_auto` on every fee journal, and the receivable account agreeing with the fee module. Green on SQLite, MySQL and Postgres. Nothing outstanding in this phase; the MPO grant is handled with the payroll it belongs to (Phase 5).

## Phase 4 · Assessment (weeks 15–19)

Grading scales, exams, schedules, seat plans & admit cards with eligibility, marks entry (web grid + Excel + OMR v1), verification/lock, result engine (weights, ties, F→0), report cards (bn/en, pdfmake), publish scheduling, promotion, question bank & paper generator, online exams, competency assessment v1.

**Exit:** annual results for 1,500 students published with PDFs in < 10 min on shared hosting (chunked job).

> **Status (7 Sep 2026): implemented.** `assessment`: grading scales (the Bangladesh GPA 5.0 bands are seeded, `fail_gpa_zero` zeroes the GPA of anyone who fails a subject), exam types, exams with one schedule per class subject, seat plans that record *why* a student is ineligible (fees due, attendance below the exam's floor), the marks grid with theory/practical/continuous-assessment columns and an absent flag, the same grid as a spreadsheet a teacher fills in offline and uploads back (carrying student ids, and saving nothing at all if one row is wrong), verification then lock (a locked paper refuses further edits until it is unlocked), the result engine (per-subject grade and grade point, weighted GPA, ranks in section and class with `share_rank`/`dense`/`by_total` ties), report cards rendered in Bangla and English by pdfmake, publishing as a chunked background job that notifies each guardian, annual aggregation and promotion into the next year's enrolments, the question bank with blueprint-driven paper generation, auto-graded online exams, admit cards issued through the documents module when the seat plan is built (chunked like the report cards, with the guardians of anyone refused told why), and the guardian result view. Console page: exams. `tests/phase4.test.mjs` proves the exit criterion on SQLite, MySQL and Postgres — 1,500 report cards render in roughly 40 s, far inside the 10-minute budget, in chunks of 25 so no single request outlives shared hosting's limit. Not yet: OMR marks capture, competency assessment.

## Phase 5 · HR & payroll (weeks 20–23)

Recruitment, onboarding, contracts, shifts, salary components/structures, loans, PF, tax slabs, payroll from attendance/leave, payslips, bank file, MPO split, appraisals, exits.

**Exit:** payroll for 150 staff drafted, approved, paid, journaled in one pass.

> **Status (7 Sep 2026): implemented.** `hr`: vacancies published on the school website with a public application form and a hiring pipeline that creates the staff record and its account, the onboarding checklist and its tasks, contracts and work shifts, salary components (house rent, medical, conveyance, provident fund both sides, income tax) with per-staff structures that supersede one another by date, the NBR tax slabs seeded per fiscal year, loans and advances that pay out as an asset and recover themselves through the payslip, the payroll run itself — a chunked job that reads staff attendance, approved leave, late-to-loss-of-pay policy and overtime, freezes one payslip per member of staff, renders the payslip PDFs and the bank transfer file, and posts one balanced journal (salary expense and employer provident fund against provident-fund and tax payable, loan recovery, the MPO share recognised as government grant income, and salary payable for what the school itself owes) — appraisal cycles with metrics the system measures itself, training records, the MPO return grouped bank by bank with anyone missing an index number named rather than counted, one transfer file per bank, a reconciliation that turns a short government release into the school's own debt (and a task for whoever has to chase it), and the exit with leave encashment, gratuity on the school's own policy, loan recovery and provident-fund payout. Console page: hr; staff see their own payslips at `/api/teach/payslips`. `tests/phase5.test.mjs` proves the exit criterion — 151 staff drafted, approved, paid and journaled in about 5 s with a balanced trial balance and no hand-written journal. Green on SQLite, MySQL and Postgres. Not yet: appraisal forms in the teacher portal, recruitment interview scheduling (admission interviews are done — see Phase 6).

## Phase 6 · Admissions & documents (weeks 24–26)

Campaigns, enquiry CRM, public form + form fee, tests, merit/lottery, offers with expiry, waitlist promotion, one-click enrolment; document templates, requests with eligibility, QR verification page, ID cards, print jobs.

**Exit (chosen; the plan sets none for this phase):** 500 applications taken from the public form through merit selection to enrolment without a spreadsheet.

> **Status (7 Sep 2026): implemented.** `admissions`: campaigns with seats and age limits per class and their own public address, the enquiry CRM (round-robin counsellor, acknowledgement, follow-up task, daily reminders and escalation), the public application form and status tracker, the form fee that submits the application and triggers the admit card, entrance tests and marks, the merit list — score, lottery or first-come, sibling priority, the older child breaking ties — which waits for the last mark of the class and never unseats an applicant who already holds an offer, offers with an expiry and an admission-fee invoice, hourly revocation of unpaid offers with the waitlist moving up, and enrolment the moment the admission fee is paid. applicant documents with a checklist that names what is still missing and drops a verification when the paper is replaced, interview slots cut as a strip of times that hold one applicant each (the guardian is sent their own time; a no-show is recorded as one, and the interview is a component of the test rather than a replacement for the written score), and the merit list as a single sheet for the notice board. `documents`: versioned templates, requests whose eligibility is checked against the modules that hold the debt, issued PDFs with a code anyone can verify on a public page, ID cards carrying the photograph on file and chunked print batches. Console page: admissions. `tests/phase6.test.mjs` proves it on SQLite, MariaDB 11.4 and Postgres 16: 500 applications, 200 seats filled in strict merit order, the rest waitlisted, one enrolment through the money path, and a transfer certificate blocked by dues then issued and verified. Not yet: an applicant uploading their own documents from the public form (the office uploads them today).

## Phase 7 · Operations (weeks 27–31)

Library (catalogue import, barcode, fines to bill, reservations, reading logs), transport (routes, GPS vendor adapter, geofence push, boardings, driver PWA, compliance alerts), hostel (beds, out-pass with consent, roll call, mess/meal billing), inventory (requisition → quotation → PO → GRN → stock ledger, assets with QR, maintenance), front office (visitors with host push, gate passes, complaints with SLA).

**Exit (chosen; the plan sets none for this phase):** every operations module keeps its own books straight without anyone re-typing anything: a library fine reaches the student's invoice, a bus tells the right guardians, a hostel resident cannot leave without consent, a delivery becomes stock, an expense and a tagged asset, and a late ticket escalates itself.

> **Status (7 Sep 2026): implemented.** `library` (catalogue with copies and accession numbers, members with their own limits, issue and return, a daily fine capped at the price of the book and billed on the next invoice, renewals blocked while somebody is waiting, a reservation queue that offers a returned copy to the next reader for two days, reading logs, and one daily job that marks overdue loans, chases them once per stage and writes off what has been gone two months), `transport` (fleet with compliance dates, routes with geofenced stops, riders whose fee is snapshotted, the day's trips created by the scheduler, GPS ingestion that raises one approach alert per stop and logs over-speeding as a driver incident, boardings that also mark the child present in the morning, and the alert nobody wants to send by hand — a drop trip ending with a child still on board), `hostel` (rooms and beds with no double-booking, out-passes that need the guardian's consent before the warden approves them and a QR the gate scans both ways, late-return and night-roll-call watches, mess menu and meals, per-meal billing that charges what was actually eaten at the price each meal was taken at and never bills a month twice, complaints that raise maintenance tasks), `inventory` (an append-only movement ledger with a running level beside it, requisition → quotation → purchase order with approval → goods receipt that adds stock, posts the expense and its journal and tags each asset, automatic reordering below the reorder level, issue requests, and stock counts written into the ledger as signed adjustments) and `frontoffice` (visitor book with a badge and a push to the host, gate passes only for people the guardians authorised, call and post registers, the helpdesk with an owner by category, a deadline by priority and an hourly escalation, and lost property). Console page: operations. `tests/phase7.test.mjs` proves all of it on SQLite, MariaDB 11.4 and Postgres 16. Not yet: the driver and helper PWA, barcode scanning hardware, facilities and work orders (Phase 8 scope in the schema).

## Phase 8 · Welfare, LMS, engagement (weeks 32–36)

Behaviour points & rules, health, clinic (stock link), counselling (encrypted), safeguarding, SEN plans; LMS courses/lessons/materials/online classes; notices scheduling, surveys, newsletters; student PWA v1; co-curricular v1.

**Exit (chosen; the plan sets none for this phase):** a child's non-academic record is as automatic as their marks — points add up to a proposed action, a clinic visit moves stock and calls home, a course enrols its class, a late assignment is penalised once, and confidential notes stay unreadable to everyone but their owner.

> **Status (7 Sep 2026): implemented.** `welfare` (behaviour categories and signed points, threshold rules that propose an action once per window rather than every night, disciplinary actions the guardian must acknowledge, growth records with BMI, vaccinations with a reminder, the clinic taking its medicines out of the store through the stock ledger and calling home when a child is sent home, counselling and safeguarding notes encrypted at rest and readable only by the counsellor or case owner — the alert says a case exists, never what is in it — and special-needs plans), `lms` (courses with modules and lessons, publishing a class-subject course enrols that class by itself, quizzes inside a lesson that mark themselves and only show the right answer once the attempt is in, per-lesson progress rolling up to a percentage, a course certificate issued the moment the last lesson is done and verifiable by its code, assignments whose late penalty is applied once at marking time, study materials, live classes with a Jitsi link that needs no account, attendance back from the platform, discussions, and an hourly job that reminds only those who have not handed in) and `engagement` (surveys on the form builder answered once per guardian and summarised by question type, newsletters that send once, events with RSVP and a QR ticket the gate scans once, clubs, house points, achievements and badges, and the weekly digest that stays silent when there is nothing to say). Console page: learning; students and guardians read their own at `/api/portal/learning/:studentId`. `tests/phase8.test.mjs` covers all of it on SQLite, MariaDB 11.4 and Postgres 16. Not yet: a console page for building a lesson quiz (the API is there and tested), SCORM/H5P, the student PWA as its own app, competitions and the results ledger.

## Phase 9 · Hardening & GA (weeks 37–40)

Load test on a real Namecheap Stellar account (5 schools × 1,500 students in one tenant DB), memory/queue tuning, SQLite→MySQL migration tool, update mechanism with rollback, backup to Drive/Dropbox, security review (OTP limits, secrets, tenant scope fuzzing), bn/en QA, admin manual (bn), onboarding wizard, Year-2 flags shipped dark.

**Exit (chosen; the plan sets none for this phase):** the security review, the load run and the data-portability tools all run as one test suite, and the app answers a request in milliseconds while a backlog of thousands of events is still draining behind it.

> **Status (7 Sep 2026): implemented.** `platform`: a backup that is one gzipped JSON-lines file (data, never SQL, so it restores onto any of the three engines and opens in any text editor), restore that is safe to run twice, a Dropbox target for the off-site copy, the SQLite→MySQL move (`pnpm db:migrate`) that creates the target schema, copies every row in chunks with values normalised across engines, and compares the counts on both sides before anyone switches `.env`, the first-run checklist that the dashboard shows until a school has done all eight things, and a health panel with queue depth, storage, memory and the last backup. `InstallerService.addTenant` provisions further schools into the same database, with unique codes. The nightly `platform.backup` job keeps as many days as the school asks for. `docs/MANUAL-bn.md` is the Bangla manual for the head teacher and the office. `tests/phase9.test.mjs` is the security review as a test — cross-tenant reads and writes, portal boundaries, session epoch, OTP request and attempt limits, secrets at rest, the cron key, the closed installer — plus backup/restore, the engine move, bn/en parity across every one of the ~590 interface strings, the onboarding checklist and the load run. Green on SQLite, MariaDB 11.4 and Postgres 16.
>
> Two things the load run found and fixed, both invisible at small scale: five schools whose names truncate to the same eight letters collided on the school code, and a request answered in **24.8 s** while the relay chewed through a backlog of 11,800 events, because `node:sqlite` is synchronous and the background loop never yielded. The relay now works in slices with a time budget and yields to the event loop between events; the same request answers in **0.36 s**. `scripts/update.mjs` updates a live install and puts the old one back if the new one does not answer `/_health`: it backs up the database first, keeps `app/`, `db/`, `index.php` and `VERSION` beside it, extracts over the top without touching `.env`, `uploads/` or `storage/`, boots the result on a spare port, and restores the kept copy on any failure (`--rollback` undoes it later). Not yet: Google Drive and S3 backup targets, and a run on a real Namecheap account.

## Year 2 · Grow revenue & engagement (after GA)

The forty weeks above end at general availability. What follows is `docs/ROADMAP-5Y.md` year 2, built
in the same way: a module, its automation rows, its API, a console page, and a test that proves the
exit criterion on all three engines.

### Wallet, canteen and shop — shipped

> **Status (7 Sep 2026): implemented.** `commerce`: a wallet per student with a derived card code the
> canteen scans (derived, so a lost card is replaced by issuing the next serial rather than rewriting a
> record), top-ups that land on the wallet liability account because the school is holding somebody
> else's money, a movement ledger where every row carries the balance it left behind, a daily limit
> the till refuses a sale against rather than reporting afterwards, outlets and products, sales paid by
> wallet, cash, MFS or onto the fee bill, refunds that reverse the entry instead of editing it, the day
> book the counter is counted against, and orders a guardian places from the app — invoiced through the
> fee ledger, and moved to "ready to collect" by the payment itself. Console page: community.
> Not yet: RFID reader hardware, per-outlet cashier shifts and a canteen menu the guardian pre-books.

### Scholarships and fundraising — shipped

> **Status (7 Sep 2026): implemented.** `giving`: funds of five kinds with a commitment balance that
> refuses an award larger than the fund holds; awards that become the fee discount the invoice engine
> already understands (so no second journal counts the same taka twice), approval that is where the
> money is actually committed, and an ending that hands the unused part back; the rule a zakat fund
> carries in the real world — need-based awards only; donors, appeals with a public page that shows how
> far they have come and names nobody who asked not to be named, pledges that post nothing until they
> are honoured, and a donation receipt with a verification code. Console page: community; public pages
> at `/api/public/site/appeals` and `/api/public/site/appeals/:slug`.
> Not yet: online giving through the payment gateway, and recurring donations.

### Alumni, mentorship and the job board — shipped

> **Status (7 Sep 2026): implemented.** `alumni`: the directory is written the day a class graduates,
> from the records the school already holds, and running it again changes nothing; batches with a
> representative; a profile the former student owns — public or not, mentor or not — where the public
> view never carries a phone number, because the school passes messages on rather than handing out
> contact details; mentorship pairs capped at three per mentor, with both sides told; and a job board
> whose expired posts close themselves. Console page: community; public directory at
> `/api/public/site/alumni`.
> Not yet: alumni self-registration for people the school has no student record for, and reunions.

### Co-curricular and events — completed

> **Status (7 Sep 2026): implemented.** Competitions from the intra-house quiz to a national olympiad,
> where recording a result does the three things that otherwise never all happen: the child's
> portfolio, the house ledger (written once per result, so a correction never doubles the points), and
> a certificate for anyone placed. Events gained their programme — kept in time order whatever order it
> was typed in — and a volunteer crew where offering to help and being told to turn up are different
> things. `tests/year2a.test.mjs` covers all four modules on SQLite, MariaDB 11.4 and Postgres 16.
> Not yet: sports fixtures and league tables.


### Facilities and maintenance — shipped

> **Status (7 Sep 2026): implemented.** `facilities`: room bookings that refuse an overlap and lose to the
> timetable, because a class has nowhere else to go; work orders whose deadline comes from their priority
> (4 hours urgent, 24 high, 72 normal, a week low), are assigned, and post their cost as an expense in the
> same books as everything else; cleaning schedules that say how many hours late they are; meter readings
> that must count up — a lower one needs the meter-replaced flag rather than quietly averaging into a
> chart — with the bill booked against utilities; safety drills tracked per kind against the school's own
> interval. One daily watch chases what is past its deadline and names the drills nobody has held.
> Console page: institution.
> Not yet: asset depreciation schedules and a QR code on each room for reporting from a phone.

### Governance — shipped

> **Status (7 Sep 2026): implemented.** `governance`: committees whose members' terms end themselves;
> meetings with an agenda, minutes, and resolutions that become tasks with an owner and a date — the
> difference between minutes that are filed and minutes that are acted on — chased daily while they are
> open; policies where a new version is a new row (what somebody acknowledged must not change under them)
> and the status names who has not read it rather than reporting a percentage; and student-council
> elections with a secret ballot: the vote row keeps an HMAC of the voter's id keyed to that election, so
> the school can prove nobody voted twice and can never work out who anyone voted for. An election past
> its closing time counts itself. Console page: institution.
> Not yet: voting from the student PWA, and minutes circulated for approval before they are final.

### Compliance and government reporting — shipped

> **Status (7 Sep 2026): implemented.** `compliance`: the BANBEIS census built from the register on the
> day it is asked for — pupils by class and sex, staff by category, rooms and library stock, MPO-listed
> teachers — kept with the numbers it was built from and frozen once submitted; the stipend list an
> authority asks for, with disbursements recorded per period so arrears are visible; the MPO salary sheet
> (Phase 5) filed as a return; consent recorded as an append-only history, because the school must be
> able to show what it was allowed to do at the time it did it; a person's right to see what is held
> about them, produced as one JSON bundle, while a deletion request goes to a person rather than being
> carried out silently; and retention rules that report what is past its date and delete nothing.
> `tests/year2b.test.mjs` covers all three modules on SQLite, MariaDB 11.4 and Postgres 16.
> Not yet: board registration and result import (needs a board API), and automatic archival.


### Analytics — shipped

> **Status (7 Sep 2026): implemented.** `analytics`: a metric catalogue computed from the register
> rather than typed in (attendance, staff attendance, fees collected and outstanding, roll, admissions,
> enquiries, messages), the daily KPI row the dashboards read, role dashboards where each card carries
> its direction and what this school usually does, anomaly detection against the school's own recent
> median and spread — one open alert per metric, never a daily duplicate — risk scores for dropout,
> fee default, attendance and result decline that always carry their reasons and name a student to
> their class teacher once, and cross-school benchmarks published as quartiles with no school ever
> named. Console page: insights.
> Not yet: a report builder for numbers nobody thought of in advance.

### Communication+ — shipped

> **Status (7 Sep 2026): implemented.** WhatsApp (Meta Cloud API, template-aware because Meta only
> delivers a pre-approved template outside the 24-hour window) and voice calls (a generic IVR gateway)
> joined SMS, email, push and in-app as delivery channels, each with a log adapter so a school that has
> connected nothing still sees what would have gone out. `communication.broadcast` sends one message to
> an audience resolved from the school's own records — a class, guardians with unpaid fees, all staff —
> and a voice call reads the title out too, because a phone call has no subject line. Console page:
> insights.
> Not yet: an inbound WhatsApp chatbot, and IVR menus the guardian navigates.

### Assessment+ — shipped

> **Status (7 Sep 2026): implemented.** Competency-based assessment beside marks: NCTB-style scales
> (triangle, circle, square), learning outcomes per class subject, one rating per child per indicator
> per term, and a report that names the indicators still to be met rather than averaging them into a
> number. OMR: sheets ingested with the roll the machine read and how sure it was — anything under 90%
> confident, or a roll matching two children, waits for a person — and only the confident ones are
> applied to the marks grid. Board registration: SSC/HSC/JSC/Dakhil forms checked against what the
> child is actually taught, the board fee raised through the fee ledger, and results imported by
> registration or roll number with the unmatched ones reported rather than guessed at.
> `tests/year2c.test.mjs` covers all three on SQLite, MariaDB 11.4 and Postgres 16.
> Not yet: the OMR image engine itself (this is the half that decides what to do with what it read),
> and a live board API.


## Year 3 · Platform (after year 2)

### SaaS billing and partners — shipped

> **Status (7 Sep 2026): implemented.** `saas`: plans with limits (students, SMS, storage, modules),
> subscriptions with trials and resellers, usage metered from the rows that recorded it, invoices
> raised a fortnight before renewal, and a daily job that marks the overdue ones. What an unpaid bill
> costs a school is deliberate: new students and messages stop, and access to the register, attendance
> and results never does — locking a school out of its own records over an adult's oversight would
> punish children. A reseller's commission accrues when the school actually pays, not when the invoice
> is raised. `saas.*` is a super-admin permission, so a school's own administrator cannot see or change
> what the school is charged; the school sees its plan, its usage and its invoices at `/billing/me`.
> Not yet: taking the subscription payment through a gateway rather than recording it by hand.

### Marketplace, plugins and the public API — shipped

> **Status (7 Sep 2026): implemented.** `marketplace`: plugins that run on their own machines and
> receive the events they subscribed to as a signed webhook with a five-second timeout — a plugin that
> hangs or turns malicious slows nothing down and reads nothing it was not given; the install secret is
> shown once and only its hash is kept. OAuth2 clients with scopes, tokens stored as hashes, and a
> public API at `/api/v1` where every route names the scope it needs, so an application can only do
> what the school ticked; revoking a client kills its tokens. Template packs (documents, notification
> templates, grading scales) that fill in what is missing and never overwrite what a school has
> already changed.
> Not yet: the authorization-code grant for apps acting as a person, and paid plugin billing.

### AI assistant — shipped

> **Status (7 Sep 2026): implemented.** `ai`, split in two on purpose. Questions about the school's own
> data are answered from the database by code, with the real numbers — how many are absent, what is
> outstanding, when the next exam is — so the answer cannot be invented, costs nothing, and works on an
> installation that has never connected a provider. Drafting (a remark, a notice, a lesson plan,
> questions) needs a model, and every draft is stored as a draft: applying it is a separate act, which
> is also the audit trail for anything a model wrote. A guardian's question is answered about their own
> children and nobody else's, and each school's monthly AI spend is capped. The provider is any
> OpenAI-compatible endpoint. Console page: none yet — the assistant lives at `/api/ai/*`.
> Not yet: a chat panel in the console, the WhatsApp chatbot, and OCR of marks sheets.

## Year 4 · Scale & ecosystem (after year 3)

### Multi-school groups and the parent super-app — shipped

> **Status (7 Sep 2026): implemented.** `groups`, the only service in the codebase that reads across
> tenants, so every crossing is named and gated. A trust puts several schools of one installation into
> a group; the consolidated dashboard gives roll, attendance, fees collected in the window, fees
> outstanding and staff per school and then added up — from the same `kpi_daily` rows AnalyticsService
> writes for each school's own dashboard, so the trust and the head teacher cannot arrive at the
> meeting with different numbers, and every row states how many days it covers rather than reading
> short. Only the group's *head* school sees the others: a member is a member, and a branch principal
> who could read the next branch's collection would be a scandal, not a feature. Only the school the
> installation was created with can make a group at all, or the gate would be decoration — any school
> could otherwise group itself with its neighbour and appoint itself head. A shared staff pool shows
> who works for the group and how many published periods they carry, which is the question head office
> asks before it advertises a post. An inter-school transfer creates the child in the receiving school
> first and closes the row they left second (the other order loses a child if it fails halfway),
> carries the guardians over by phone so the family's login reaches the new school at once, lands them
> on the same rung of the ladder or asks which class rather than guessing, records what was
> outstanding without holding the child hostage to it, and returns the first transfer when it is asked
> twice. And money that spans currencies is refused rather than guessed: a group whose schools bill in
> BDT and USD gets its counts and no money total until a rate is recorded, then a total that carries
> the rate and the day it was taken from. The parent super-app is one guardian login reaching their
> children in every school of the installation, matched on the phone number they proved with an OTP,
> served at `/api/portal/family` and refused outright to any account that is not a guardian — no
> permission a school can grant reaches across the group. API: `apps/server/src/routes/phase16.ts`.
> Exit criterion: `tests/groups.test.mjs`.
> Not yet: a console page for the trust (the group lives at `/api/groups/*`), database-per-tenant and
> read replicas for very large groups, a rate feed instead of a typed-in rate, VAT returns and the
> auditor portal, and board/government API integrations.

---
### Safeguarding and wellbeing early warning — shipped
> **Status (7 Sep 2026): implemented.** `forecast.computeWellbeing` scores every pupil on attendance,
> negative behaviour points, a fall between the last two exams, and whether welfare is already
> involved, and writes the result to `risk_scores` as a fifth risk type beside the four
> `AnalyticsService.computeRisks` already keeps — through `AnalyticsService.saveRisk`, so the table
> still has exactly one writer and the "tell somebody once" rule has exactly one implementation.
> The confidential half obeys the rule the welfare module already follows, and then goes further:
> welfare involvement never scores on its own. A pupil in ordinary counselling with good attendance,
> steady marks and no incidents is not on the list at all, because flagging them would tell every
> reader of the watchlist that the child is seeing a counsellor — the exact inference the encrypted
> notes exist to prevent. It only ever adds a flat weight to something measurable that is already
> wrong, and counselling and a safeguarding case are worth the same, so the score cannot be read
> backwards to tell them apart. The stored reasons name the attendance, the points and the marks;
> they never carry a category, a session count, a risk level or a word of a note, and the alert that
> goes out is in-app only and says explicitly that it does not carry the reasons — a push would land
> on a lock screen a sibling or a neighbour can read. API: `/api/forecast/wellbeing`. Weekly job:
> `forecast.wellbeing` (P26).
> Not yet: a console watchlist page, a welfare-lead role separate from `principal`, and any signal
> from outside school — family illness, money trouble, a bereavement — which is often the whole story.
---
## Year 5 · Intelligence (after year 4)
### Fee forecasting and cash-flow projection — shipped
> **Status (7 Sep 2026): implemented.** `forecast.cashFlow` projects three to six months: what the
> active fee structures and the agreed instalment plans will bill each month, what this school —
> on its own collection record, never a rule of thumb — is likely to collect against it, what the
> arrears already on the books are worth at their own recovery rate, and what payroll and the
> ordinary monthly bills take back out. The collection rate counts only invoices that have already
> fallen due, because counting a bill raised last week as unpaid makes a punctual school look
> hopeless and every figure below it is then wrong. Opening cash comes from the posted journal lines
> on the accounts the bank and cash records point at, not from a typed-in number, so the projection
> starts where the ledger is. Every response carries `assumptions` — the rate used and what it was
> worked out from, the months of history actually found, the payroll basis, the roll — and
> `blindSpots`: no fee structure, no approved payroll run, no expenses recorded, grants and MPO
> subvention, and the fact that the roll is held at today's number. Rates are rounded before they are
> used, not only before they are printed, so the percentage shown reproduces the figures a head
> teacher checks with a calculator. `fallsDueInMonth` is shared with `FeesService` rather than copied,
> so the forecast cannot drift from the invoice run. API: `/api/forecast/cash-flow`.
> Not yet: a console page with the month-by-month chart, multi-currency, scenario comparison
> ("what if we raise tuition 10%"), and grants and donations as projected income.
### Staffing forecast — shipped
> **Status (7 Sep 2026): implemented.** `forecast.staffing` reads the published timetable and the
> leavers on record and reports, by subject, how many periods a week will have nobody to teach them —
> slots with no teacher at all, plus slots held by somebody leaving inside the horizon, including
> anyone who has already gone and whose classes were never reassigned, which is the commonest version
> of this and the one nobody notices until a Sunday morning. Spare capacity is counted across a
> teacher's whole week rather than per subject, so the arithmetic does not over-hire, and who could
> cover a subject is inferred only from who already teaches it in the grid — the system holds no
> qualifications, and guessing from a designation would put a Bangla teacher in front of a chemistry
> practical. Sections over capacity are reported beside it, because splitting one needs a teacher the
> timetable does not know about yet. The assumed full week is a stated, adjustable assumption
> (30 periods) shown next to this school's busiest actual load. API: `/api/forecast/staffing`.
> Monthly job: `forecast.monthly` (P24, P25) — it messages the office and emits an event; it never
> raises an invoice, opens a vacancy or reassigns a period.
> Not yet: qualification and training records feeding the cover inference, a hiring pipeline that
> turns a gap into a job posting for a person to approve, and substitution load over the term.
## Year 5 · Intelligence (after year 3)
### Voice-first guardian IVR — shipped
> **Status (7 Sep 2026): implemented.** `ivr`: the line a guardian who cannot read actually uses. A
> generic Bangladeshi IVR gateway answers the school's number and posts one step at a time to
> `/api/ivr/:school/step`; the service answers with the words to read out, the digits to accept next
> and whether to hang up. The caller is identified by their caller ID against `guardians.phone`, and
> that is treated as exactly what it is: enough to say what is already texted to that same number —
> today's attendance, what is outstanding, the next exam, the last result — and never enough for
> anything else. A number the school does not know is told politely to contact the office; it is
> never asked for a password, a date of birth or an admission number, because a caller who could be
> anybody must not be taught to hand those over on the phone. A guardian with more than one child
> picks by position in their own list, so there is no id to tamper with and no way to reach a child
> they are not a guardian of. Everything spoken is generated from the school's own rows through the
> owning services — the assistant's own queries answer the dues and the exam date, so there is only
> one set of numbers to keep true — in Bangla for a bn school and English for an en one, with the
> figures in the school's own numerals. Pressing 9 raises a callback task, once, however often the
> gateway retries. The service keeps no state between steps (every key pressed comes back with the
> next request), so a Passenger process recycled mid-call does not drop the caller. The webhook
> authenticates with its own shared secret — `IVR_SECRET` or an encrypted per-school setting,
> compared in constant time — is rate-limited per calling number, and an install with no secret
> configured is closed rather than open. Each call is one line in the front office's call register
> with what was asked and what was answered. Exit criterion: `tests/ivr.test.mjs`.
> Not yet: a console page for the register and the menu (both live at `/api/ivr/*`), speech instead
> of keypresses, and the outbound half — a call the school places when the guardian does not ring.
### College and coaching modes — shipped
> **Status (7 Sep 2026): implemented.** `college`: the same tables a school uses, read the way an
> institution that counts credits rather than years needs them. A programme carries how many terms it
> runs for and how many credits it takes to finish, and dividing one by the other is the credit ceiling
> a semester registration is checked against — the load the timetable, the rooms and the teachers were
> sized for. Registration is `course_registrations`, one row per student per term per subject, and the
> credit is copied onto it rather than looked up later, so repricing a subject next year cannot rewrite
> last year's GPA. Everything is validated before anything is written: a half-registered student would
> have the ceiling enforced against a total nobody agreed to. A student may only register for what
> their own class is offered, only while the semester is open, and a course that already carries a
> grade can never be dropped. Results are struck against the school's own grading scale, and the GPA is
> weighted by credit rather than by how many subjects happen to be on the sheet — a four-credit paper
> moves the average four times as far as a one-credit lab. A retake replaces the attempt it repeats:
> counting a failure and the pass that cancelled it would punish the student twice for one course. The
> programme certificate is earned by credits, never by reaching the last semester, and the shortfall is
> named so the office can say exactly what is left; `issued_documents` has no column pointing back at a
> programme, so the snapshot it already keeps is what makes a second certificate impossible. Department
> portals scope people, subjects, programmes and the registered credit load to one department, and only
> a member of a department can head it. For coaching centres a batch is sold rather than admitted into:
> the price becomes an instalment plan against a fee head of the course's own, so six batches are six
> lines of the ledger, and the seat is handed over by `payment.received` when the first taka actually
> arrives — a centre that enrols on the promise spends the term teaching people who never paid. Selling
> the same batch to the same student twice is refused, and the course certificate waits for the last
> instalment, billed or not. A nightly job chases a light semester exactly one week in, which is late
> enough that the stragglers have had their chance and early enough that the timetable has not been
> built around the wrong numbers — and firing on one day is what stops it messaging the same family
> twenty times without a column to remember that it did. New table: `course_registrations`.
> `tests/college.test.mjs` is the exit criterion.
> Not yet: a console page (the API is `/api/college/*`), electives a student picks from a basket rather
> than the whole class-subject list, an overload a registrar can approve above the ceiling, and a
> transcript PDF.
### Advanced LMS and adaptive learning — shipped
> **Status (7 Sep 2026): implemented.** Video progress that means something: the player sends a
> heartbeat, a beat may add at most three minutes, the total can never exceed the lesson's own
> running time, and dragging the needle to the end moves only where the student resumes from — so a
> lesson counts as done at 85% because 85% of it actually went past, not because somebody scrubbed to
> the credits for the certificate. A lesson with no running time says it cannot be measured instead
> of inventing a percentage. Discussion threads on a course or a lesson, replies flattened one level
> so a thread stays readable on a phone, the asker told when somebody answers, and the same rule the
> rest of the app uses: a student — or the guardian reading for them — sees their own course's
> threads and nobody else's; a reply takes its course from the post it answers, so a thread cannot be
> dragged into another class. Similarity between text answers is word-shingle Jaccard, computed here
> with no service and no model, working the same in Bangla as in English: answers under forty words
> are not compared at all, because a percentage over "the mitochondrion is the powerhouse of the
> cell" measures the language and not the student. It reports "these two are 78% alike, and here is
> the wording they share" to the teacher who set the work, stores the number beside the submission,
> and does nothing else — no mark moves, no status changes, and no guardian hears about it.
> Adaptive learning turns the competency ratings into a revision plan: the indicators still to meet,
> weakest first, each with the lessons, quizzes and materials published on that syllabus unit and
> whether the child can open them and has already been through them. Where nothing covers an
> indicator the plan says so by name — the teacher's list of what to write next — rather than sending
> a child to the nearest chapter it could find. The same question asked of a class-subject gives the
> teacher the indicator most of the room is stuck on. A weekly job pushes the top three home, once,
> to the child and their guardians. Nothing is stored: a plan is derived from ratings that change and
> lessons published this afternoon, so it is built when it is asked for.
> API: `apps/server/src/routes/phase15.ts`, including `/portal/lessons/:id/watch`,
> `/portal/discussions` and `/portal/revision/:studentId`. Exit criterion:
> `tests/lms-advanced.test.mjs` (12 tests).
> Not yet: a console page for threads and the watch report (both live at `/api/lms/*`), similarity
> against last year's submissions rather than only within one assignment, and a plan that also reads
> exam marks rather than competency ratings alone.

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
