# Pathshala — 5-year product roadmap

The schema already contains every table below (349 tables, 34 modules), so adding a feature
later is UI + logic work, never a data-model rewrite. Years are product releases, not
calendar promises; each release ships to existing schools through Settings → Update.

---

## Year 1 · Run the school (launch)

| Module | What ships | Automation highlights |
|---|---|---|
| Core, platform, CMS | Tenancy, OTP login, RBAC, settings, files, audit, custom fields, form builder, automation rules UI, approvals, tasks, imports, backups, public website builder, verification page | Outbox/rules/scheduler, heartbeat cron, nightly backups to Drive/Dropbox |
| Academic, people, curriculum | Years, classes, sections, subjects, calendar, students, guardians, staff, timetable with clash rules, substitution suggestions, syllabus & lesson plans | Auto section allocation, substitution engine, syllabus-lag alerts |
| Admissions | Enquiry CRM, online form (website), form fee, test, merit list, offers, waitlist, enrolment | Round-robin counsellor, auto merit & offers, expiry → waitlist promotion, one-click enrol |
| Attendance | Biometric/RFID ingestion, QR & app marking, policies, leave workflow, balances | Auto-absent cut-off + SMS, consecutive-absence tasks, threshold letters, LOP to payroll |
| Assessment | Marks exams (GPA 5.0), schedules, seat plans, admit cards with eligibility, verification & lock, result engine, report cards, promotion; question bank; online MCQ exams | Result engine, publish-time notifications, merit-discount proposals, counsellor referral on GPA drop |
| Fees & accounting | Structures, discounts, monthly invoice batches, bKash/Nagad/SSLCommerz, counter cash sessions, reminder ladder, fines, refunds, ledger; GL, journals, expenses, bank reconciliation, budgets, trial balance | Every money movement auto-journals; reminders; fines once; reconciliation matching |
| HR & payroll | Staff master, contracts, salary structures, loans, payroll from attendance, payslips, bank file, appraisals, expiry alerts | Payroll draft on the 25th, approval → payslips + journal |
| Library, transport, hostel, inventory | Catalogue & issues with fines to bill; routes, GPS, RFID boarding, guardian push; beds, out-passes, roll call; items, POs, stock ledger, assets | Overdue fines, geofence alerts, curfew alerts, reorder POs |
| Communication, welfare, documents, front office | SMS/push/email providers with fallback, templates bn/en, notices, chat, PTM; behaviour points, health, clinic, counselling; certificates with QR, ID cards; visitors, complaints with SLA | Quiet hours, delivery tracking, SLA escalation, TC eligibility |
| Portals | Guardian PWA (attendance, fees + pay, results, homework, bus, chat), student PWA, teacher PWA (attendance, marks, homework, timetable), driver/helper PWA | Push notifications, offline shell |

## Year 2 · Grow revenue & engagement

| Module | What ships |
|---|---|
| SaaS billing | Plans, subscriptions, invoices to schools, usage metering (students, SMS, storage), resellers & commissions, white-label domains |
| Wallet & POS | Cashless canteen/shop with RFID/QR, guardian top-up, daily limits, product catalogue, shop orders (uniform, books) |
| Co-curricular | Clubs, sports fixtures, competitions, house points, achievements, badges, student portfolio |
| Scholarships & fundraising | Funds, awards linked to discounts, donor CRM, campaigns with public pages, receipts, zakat fund |
| Events & ticketing | Paid/free tickets with QR check-in, volunteers, programme schedules |
| Alumni & career | Directory auto-filled at graduation, mentorship, job board, batch reunions, giving |
| Facilities | Room/hall bookings, work orders with SLA, cleaning schedules, utility readings, safety drills |
| Governance & compliance | Committees, meetings & minutes, resolutions, policy acknowledgements, student elections; BANBEIS census, MPO salary sheets, stipend programmes, consent & data requests, retention |
| Analytics | Role dashboards, metric catalogue, anomaly alerts, dropout / fee-default / result-risk scores, cross-campus benchmarks |
| Communication+ | WhatsApp Business, voice broadcasts (IVR), newsletters, surveys & polls |
| Assessment+ | Competency-based assessment (NCTB 2023 performance indicators) beside marks, question-paper generator with blueprints and A/B sets, OMR scanning, board registration & form fill-up, board result import |

## Year 3 · Platform

| Area | What ships |
|---|---|
| AI assistant | Admin/teacher/guardian assistant over school data (bn/en), remark and question generation, lesson-plan drafts, notice drafting, report narratives, OCR of marks sheets and documents, WhatsApp chatbot, per-school AI budget |
| Marketplace | Plugin system with hooks, per-school installs, OAuth2 for third-party apps, public API with scopes, template packs (boards, countries), theme packs |
| College & coaching modes | Semester/credit programmes, department portals, batch/course selling with instalments, certificates of completion |
| Advanced LMS | Course marketplace, video lessons with progress, discussion threads, plagiarism similarity, certificates |
| Native apps | Expo builds for Android/iOS from the PWA codebase; biometric login; offline attendance sync |

## Year 4 · Scale & ecosystem

* Database-per-tenant for large groups; read replicas; regional hosting.
* Multi-school groups: consolidated finance and academic dashboards, shared HR pool, inter-campus transfers.
* Parent super-app: multiple children across different Pathshala schools in one login.
* Government/board integrations as they open APIs (result sync, registration submission).
* Advanced finance: multi-currency for international schools, VAT returns, consolidated statements, auditor portal.
* Safeguarding & wellbeing analytics, early-warning system fed by attendance, behaviour, results and counselling.

## Year 5 · Intelligence

* Adaptive learning paths from competency data; personalised revision plans pushed to students.
* Predictive timetable and staffing (hiring needs, substitution load), fee forecasting, cash-flow projections.
* Voice-first guardian interactions (IVR + assistant) for low-literacy contexts.
* Marketplace maturity: third-party modules (canteen vendors, book publishers, ed-tech content) billing through the platform.

---

## Guard-rails that keep the 5-year plan cheap

1. **Schema first, generated everywhere** — `db/schema/*.def.mjs` is the only place a table is described; SQL, JSON, docs and Drizzle types derive from it.
2. **Events, not calls, between modules** — new modules subscribe to existing events; nothing old is edited.
3. **Adapters** for anything hosting-specific — cPanel today, VPS/K8s tomorrow, same code.
4. **Custom fields + form builder + workflow builder** absorb per-school requests without schema changes.
5. **Feature flags per plan/school** — ship dark, enable per customer.
