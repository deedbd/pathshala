# Console gap — `docs/console.html` prototype vs. the shipped console

Audit date: 2026-09-08. Method: every one of the prototype's 103 screen keys was read in
`docs/console.html` (the `page(...)` registry, the drawers, the forms and the action handlers), then
every file under `apps/web/app/routes/` and `apps/web/app/routes.ts` was read in full, then — for
each gap — the owning service in `packages/core/src/modules/` (or `packages/core/src/*.ts`) and the
matching route in `apps/server/src/routes/` were checked to see whether the data and the API already
exist. Nothing here is inferred from a file name.

## Summary

Of the prototype's **103 screens**: **19 shipped**, **41 partial**, **41 missing**, **2 superseded**.
The headline is that almost nothing is missing because the *data* is missing — of the 41 missing
screens, **28 already have both the tables and a working HTTP endpoint** and need only a console page;
another 9 have the tables and a service method but no `GET` route (an hour of routing each); only 4
(school profile editing, users, the roles matrix, notification templates/providers) need genuinely new
API surface, and even those write to tables that already exist and are already seeded. The single
biggest hole is **Settings**: all six of its screens are absent, there is no `/settings` route and no
`/api/settings*`, `/api/roles*`, `/api/users*`, `/api/audit*` or `/api/sequences*` endpoint anywhere,
so a school cannot see its own audit log, cannot edit the automation thresholds the prototype
promises are editable, and cannot manage operator logins from the console. The second is the
**shell**: the shipped console has no top bar at all — no global search, no academic-year selector, no
role switcher, no notifications bell, no theme toggle, no breadcrumbs, and no way to change language
once signed in. The third is that four whole modules of screens (Welfare health/clinic/counselling,
Communication log/templates/providers, Automation approvals/tasks, and the operational detail pages
for hostel beds, transport vehicles/boardings, library members/reservations and inventory
movements/assets/requests) are behind APIs that already work and are exercised by the test suites.

---

## Screen-by-screen mapping

| Prototype screen | Verdict | Shipped page · tab | What is missing |
|---|---|---|---|
| `home/index` Dashboard | partial | `/dashboard` | 4 of 8 KPI tiles (collected this month, outstanding dues, staff present, buses running); the 30-day attendance bar chart; the monthly fee-collection chart and its "invoices for September were generated automatically on 1 Sep 06:00 (batch of N)" line; the "Today" schedule list; the "Waiting for you" approvals list with per-row Review; the "Open tasks" tick-list; the per-section attendance table with fill bars. Shipped adds an onboarding checklist and a system-health card the prototype has not got. |
| `admissions/campaigns` | partial | `/admissions` header + action bar | Seats-per-class table (Class/Seats/Applied/Shortlist/Fill bar); the funnel chart (Enquiries→Applications→Paid→Tested→Shortlisted→Offered→Enrolled) and its conversion %; the campaign detail card (window, form fee, entrance-test format, "Merit list: automatic on results entry", "Offers: auto-issue top-N, valid 7 days"); the "sibling priority applied to 31 applicants" line; the previous-campaign summary card. |
| `admissions/enquiries` | partial | `/admissions` · Enquiries | Enquiry ID, child's class and assigned counsellor columns; the status filter; the enquiry drawer (follow-up timeline, add-note box, "Convert to application"). "Log a call" is shipped but writes a canned note. |
| `admissions/applications` | partial | `/admissions` · Applications | Sibling chip, applied-date column, status filter; the applicant drawer with the submitted→tested→shortlisted→offered→enrolled pipeline and its stage buttons. |
| `admissions/merit` | partial | `/admissions` action bar (Compute merit list, Merit list PDF) | The per-class merit screen itself: the entrance-test card (held on, components, seats, results entered) and the ranked candidate table with sibling-priority column. Merit rank is only a column on the applications table. |
| `admissions/offers` | partial | `/admissions` · Offers | Class and admission-fee columns; "Record fee → enrol" is on the Applications tab instead. |
| `academic/years` | **shipped** | `/academic` · Years (+ clone-from-year on create) | — |
| `academic/classes` | partial | `/academic` · Sections | Shift, room and class-teacher columns (they are set on create but never shown); the fill bar; the section drawer with the roster and "Mark attendance" link. |
| `academic/subjects` | partial | `/academic` · Subjects + Class subjects | Theory/practical mark split, credit weight and the assigned teacher per class-subject; pass marks are set but not displayed; no per-class picker view. |
| `academic/calendar` | partial | `/calendar` | The month grid itself (the shipped page is a list plus weekend-day toggles); weekend shading; the "N holidays this month" count. |
| `academic/timetable` | partial | `/timetable` | The teacher-load panel (periods/week per teacher, e.g. 18/24) and the substitution-count link. Clash rejection is shipped and better (validated before publish, publish disabled while clashes exist). |
| `attendance/today` | **missing** | — | The whole screen. `attendance.summary()` is already called by the `/attendance` loader and **never rendered**. Missing: Present/Late/Absent/On-leave KPIs, check-in timeline chart, device-health card, per-section table with %. |
| `attendance/mark` | **shipped** | `/attendance` · Section | — (shipped adds half-day and excused, and an "on leave" badge) |
| `attendance/staff` | partial | `/attendance` · Staff | Department, designation and "lates this month" columns; the status filter. |
| `attendance/leave` | partial | `/diary` · Leave | Nothing links it to substitution suggestions; no leave-balance context; lives under Diary, not Attendance. |
| `attendance/devices` | **shipped** | `/attendance` · Devices | — (shipped adds the device-key reveal and documents the punch API) |
| `attendance/policies` | partial | `/attendance` · Policies | The policy is read-only except for a `prompt()` that sets the auto-absent time. Not editable: late-after minutes, half-day minutes, notify-on-arrival/late/absent channels, consecutive-absence threshold, minimum attendance %, block-admit-card, and the whole staff policy card (late-after, 3 lates = 1 LOP day, overtime after, notify HR on 3rd late). |
| `exams/list` | partial | `/exams` header + KPIs | The exam list table (type, start, end, grading scale, status) — exams are only a dropdown; the "Run pre-exam prep" / "Schedule" row actions; the BD Board GPA 5.0 grade-band table. |
| `exams/schedule` | partial | `/exams` · Subjects + Seat plan | Exam time, rooms and invigilator columns on the routine; the room seat-map; a "Print admit cards" button (admit cards are issued by `buildSeatPlan` but nothing offers the PDF). |
| `exams/marks` | **shipped** | `/exams` · Marks | — (shipped adds Excel import, verify, lock/unlock and a marks-sheet download) |
| `exams/results` | partial | `/exams` · Results | Pass-rate and section-average-GPA KPIs; the grade-distribution chart; attendance column; section selector; the tabulation-sheet download; the report-card drawer (the PDF opens instead). |
| `exams/promotion` | **missing** | — | `POST /api/exams/annual/promote` and `GET /api/exams/annual` exist; there is no button and no preview table anywhere. |
| `exams/questions` | **missing** | — | `GET/POST /api/questions` and `POST /api/questions/papers` exist; no page. |
| `exams/online` | **missing** | — | `POST /api/exams/online` and `POST /api/exams/online/:id/submit` exist; there is no list endpoint and no page. |
| `lms/assignments` | partial | `/learning` · Assignments | The submissions drawer (per-student submitted/late/marks) and the "Remind pending" button — `GET /api/lms/assignments/:id/submissions` exists. Shipped adds the similarity check. |
| `lms/materials` | **missing** | — | `GET/POST /api/lms/materials` exist; no page. |
| `lms/online` (classes) | **shipped** | `/learning` · Courses → Live classes | — |
| `students/list` | partial | `/students` | Attendance %, last GPA and guardian-name columns; the 360° drawer's Attendance / Fees / Results / Documents tabs (the shipped drawer has guardians, enrolment history and siblings only). |
| `students/guardians` | **missing** | — | No guardian directory keyed by phone (children per guardian, app-installed). `people.childrenOfPhone` exists but there is no listing endpoint. |
| `students/import` | partial | `/import` | Guardians, Marks and Library-books importers (students, staff and attendance are shipped). |
| `staff/list` | **shipped** | `/staff` | — |
| `staff/departments` | **missing** | — | `people.departments` / `people.createDepartment` exist and `college.departments` has a full API, but no page shows staff departments with head, headcount and on-leave counts. |
| `fees/overview` | partial | `/fees` header + KPIs + ageing chips | Collection-by-method chart; the ageing bars (shipped as a plain chip row); the top-defaulters table with per-row "Send reminder" and "Call task"; the rule line ("generated on the 1st, reminders at −3/0/+7/+15/+30, fines once, every payment posts to the ledger"). |
| `fees/structures` | partial | `/fees` · Fee structures | The per-head columns (tuition/admission/session/exam/transport/hostel/late-fine) and the student count per class; the row-click edit. |
| `fees/invoices` | partial | `/fees` · Invoices | Status filter; the invoice drawer (items, discount and fine lines, payments, Record payment, PDF, Send reminder). |
| `fees/payments` | partial | `/fees` · Payments | Method filter; invoice, reference and received-by columns. Receipt PDF is shipped. |
| `fees/discounts` | partial | `/fees` · Discounts | The scheme catalogue (Sibling 20%, Merit 50%, Staff child 30%, Need-based, Early payment 2% — with rule and auto/manual mode). Per-student approve/reject is shipped. |
| `fees/reminders` | **missing** | — | The ladder-stage table (last run, result, status) and the delivery log. `fee_reminders` rows are written by `runReminders`; there is no `GET`. |
| `fees/cash` | partial | `/fees` · Payments toolbar | Session KPIs (open since, receipts count, cashier), opening float, yesterday's variance, and the cash-receipts-today table. Open/close and the variance number are shipped (as a `prompt()`). |
| `accounting/coa` | **missing** | — | `GET /api/accounting/accounts` exists and is used only to fill dropdowns. No account tree with balances, no fee-head → income-account auto-posting map. |
| `accounting/journal` | partial | `/accounts` · Journal entries | Source filter; a "posted by automation vs manual" column. The detail drawer and Reverse are shipped. |
| `accounting/expenses` | partial | `/accounts` · Expenses | Vendor column; the status filter; the Approve and Mark-paid buttons (`accounting.payExpense` exists, nothing calls it from the UI). |
| `accounting/bank` | **missing** | — | `POST /api/accounting/bank/import` and `accounting.reconcile` exist and `GET /api/accounting/overview` already returns `bankAccounts`; there is no page — no account balance tiles, no statement lines, no match/unmatched task. |
| `accounting/budgets` | **shipped** | `/accounts` · Budgets | — |
| `accounting/trial` | **shipped** | `/accounts` · Trial balance | — (shipped adds a live balanced/unbalanced chip) |
| `hr/payroll` | **shipped** | `/hr` header + action bar | — (shipped adds MPO return, per-bank files and MPO reconciliation) |
| `hr/payslips` | **shipped** | `/hr` · Payslips | — |
| `hr/salary` | partial | `/hr` · Salary structures | The component catalogue as a table (type / calculation / value) — it is squeezed into one line of muted text in the drawer. |
| `hr/leave` (balances) | **missing** | — | `leave_balances` is written by `hr.accrueLeave` and decremented on approval; nothing reads it back. No endpoint, no page. |
| `hr/appraisals` | **missing** | — | `GET /api/hr/appraisals`, `POST /api/hr/appraisals/cycles`, `/:id`, `/:id/finalise` all exist, and `hr.autoMetrics` pre-fills attendance/syllabus/result. No page. |
| `hr/expiry` (contracts) | **missing** | — | `GET/POST /api/hr/contracts` exist and the `hr.expiry_alerts` job runs nightly; no page shows what is about to expire. |
| `library/catalogue` | **shipped** | `/operations` · Library → Catalogue | — |
| `library/issues` | **shipped** | `/operations` · Library | Renew (`POST /api/library/issues/:id/renew` exists) has no button — everything else is there. |
| `library/members` | **missing** | — | `GET/POST /api/library/members` exist; no page. |
| `library/reservations` | **missing** | — | `POST /api/library/reservations` exists and `offerToNextInQueue` sets the 48-hour hold; there is no `GET` and no page. |
| `transport/live` | **missing** | — | `POST /api/transport/gps` ingests packets and pushes "bus approaching"; nothing reads positions back. No map, no per-route progress. |
| `transport/routes` | partial | `/operations` · Transport → Routes | The stop list with pickup times and the driver (`GET /api/transport/routes/:id/stops` exists). |
| `transport/vehicles` | **missing** | — | `GET/POST /api/transport/vehicles` exist and `transport.document_expiry` runs nightly; no page shows fitness/insurance/tax-token dates or odometer. |
| `transport/trips` | **shipped** | `/operations` · Transport | — |
| `transport/boardings` | **missing** | — | `POST /api/transport/board` writes `transport_boardings` and notifies the guardian; there is no `GET` and no page. |
| `hostel/overview` | partial | `/operations` · Hostel | Occupancy %, warden, monthly fee, the curfew-alert line, and the out-passes / complaints summary cards. |
| `hostel/beds` | **missing** | — | `GET /api/hostel/:id/rooms` already returns rooms **and** vacant beds; there is no room/bed grid and no bed drawer. |
| `hostel/outpass` | **shipped** | `/operations` · Hostel → Outpasses | — |
| `hostel/rollcall` | **missing** | — | `POST /api/hostel/roll-call` exists and `hostel.night_watch` runs; no roster screen to tick. |
| `hostel/mess` | **missing** | — | `GET/POST /api/hostel/:id/menu` exist; only "Bill the mess" is shipped. No weekly menu grid. |
| `inventory/items` | **shipped** | `/operations` · Stores → Stock | — |
| `inventory/pos` | partial | `/operations` · Stores → Purchase orders | Approve and Receive buttons (`POST /api/inventory/purchase-orders/:id/receive` exists); the automation/manual origin chip is shipped. |
| `inventory/movements` | **missing** | — | `POST /api/inventory/movements` and `inventory.movements()` exist; there is no `GET` route and no page. |
| `inventory/assets` | **missing** | — | `GET /api/inventory/assets` exists (plus assign/service); no page. |
| `inventory/requests` | **missing** | — | `POST /api/inventory/issues` and `/requisitions` exist; there is no `GET` and no page. |
| `communication/notices` | partial | `/website` · Notices | Audience, channels (push / push+SMS), read counts, a "Publish now" action and the notice drawer. The shipped page is the public-site notice board with scheduling and pinning; the console-side notice with SMS fan-out is not there. |
| `communication/messages` | **shipped** | `/chat` | — (shipped adds live SSE updates) |
| `communication/notifications` | **missing** | — | Every send is written to `notifications`; `NotificationService` only exposes `recentFor(user)`. No school-wide log, no delivered/failed/cost KPIs, no channel filter, no endpoint. |
| `communication/templates` | **missing** | — | `notification_templates` exists and is read on every send; there is no API and no editor. |
| `communication/providers` | **missing** | — | `messaging_providers` exists and the `comms.provider_balance` job reads it hourly; there is no API and no page, so a school cannot see its SMS balance or switch the default. |
| `communication/events` (Events & PTM) | partial | `/learning` · Surveys & events | The PTM slot board — `GET /api/ptm/slots`, `POST /api/ptm/slots`, `POST /api/ptm/slots/:id/book`, `GET /api/ptm/bookings` all exist and nothing in the console calls them. Events are shipped (with announce). |
| `welfare/behaviour` | **shipped** | `/learning` · Behaviour & welfare | — |
| `welfare/rules` | **missing** | — | The `welfare.behaviour_rules` job runs nightly on point thresholds, but the thresholds are not visible or editable anywhere. |
| `welfare/health` | **missing** | — | `GET /api/welfare/health/:studentId`, `POST /api/welfare/health`, `POST /api/welfare/vaccinations` all exist; no page. |
| `welfare/clinic` | **missing** | — | `POST /api/welfare/clinic` exists (and deducts medicines from stock); there is no `GET` and no page. |
| `welfare/counselling` | **missing** | — | `GET /api/welfare/counselling` and `/:id/notes` exist, with the encryption rule already enforced; no page. |
| `documents/requests` | **shipped** | `/admissions` · Documents | — (shipped shows the blockers verbatim, which is better than the prototype's chip row) |
| `documents/issued` | **missing** | — | `GET /api/documents/issued`, `/issued/:id`, `POST /issued/:id/revoke` and the public `GET /api/public/verify/:code` all exist; no page. |
| `documents/templates` | **missing** | — | `GET/POST /api/documents/templates` exist; no page. |
| `documents/idcards` | partial | `/admissions` · Documents → ID cards drawer | The card list (card no, RFID, valid-to, lost/active) and the reissue action that revokes the old RFID and adds the ৳200 fee. |
| `frontoffice/visitors` | **shipped** | `/operations` · Front office | — |
| `frontoffice/complaints` | partial | `/operations` · Front office → Tickets | Assigned-to column; a separate SLA breached/on-time chip; the ticket drawer with the update timeline and the "add update" box. |
| `frontoffice/calls` (Calls & postal) | partial | `/operations` · IVR → Calls | The IVR tab shows inbound automated calls only. `GET/POST /api/frontoffice/calls` and `/api/frontoffice/post` exist for hand-logged calls and the postal register; neither has a page. Gate passes and lost-and-found (also fully routed) have no page either. |
| `frontoffice/alumni` | **shipped** | `/community` · Alumni | — (shipped adds mentorships and the job board) |
| `automation/rules` | partial | `/automation` · Rules | The "Then" action text, runs-in-30-days, last-run, the sys/rule/cron filter, and the rule drawer (conditions, actions, cooldown, preview mode, "Test with sample event"). On/off toggle is shipped. |
| `automation/activity` | partial | `/automation` · Rule runs | The four KPIs (runs today, failed, median latency, queue depth) and "Retry failed". |
| `automation/jobs` | partial | `/automation` · Scheduled jobs | "Run now" per job (only a global "Run due jobs now" exists) and the duration column. |
| `automation/approvals` | **missing** | — | `ApprovalService.pending()` and `.decide()` exist and every module routes through them; there is no `/api/approvals` endpoint and no inbox. The dashboard counts pending approvals and links nowhere. |
| `automation/tasks` | **missing** | — | `TaskService.open()` / `.ensure()` / `.complete()` exist and dozens of jobs raise tasks; there is no endpoint and no task list. The dashboard counts open tasks and links nowhere. |
| `automation/integrations` | partial | `/platform` · Apps & API | Plugins, template packs and OAuth clients are shipped and better. Missing: the outgoing-webhook table with delivery rate (`webhooks` / `webhook_deliveries` exist) and the connected-service list (Zoom, Google, ZKTeco, GPS vendor, SSLCommerz, bKash, Nagad) with a reconnect action. |
| `settings/profile` | **missing** | — | No page and no endpoint to edit the school row, campuses or shifts (`academic.shifts` and `mainCampus` exist read-only). |
| `settings/users` | **missing** | — | `users`, `user_roles` exist; `RbacService.assignRole` exists; no listing endpoint, no invite, no 2FA state, no password-reset action. |
| `settings/roles` | **missing** | — | `roles`, `permissions`, `role_permissions` exist and are enforced on every route; there is no way to see or change the matrix. |
| `settings/policies` | **missing** | — | `SettingsService.all()` exists; there is no `/api/settings` route. Every typed key the automation reads (`attendance.auto_absent_at`, `fees.reminder_stages`, `notifications.quiet_hours`, `documents.tc_requires_clearance` …) is invisible and uneditable from the console. |
| `settings/sequences` | **missing** | — | `number_sequences` and `NumberingService.next()` exist; no page shows prefix/padding/reset/next value. |
| `settings/audit` | **missing** | — | `audit_logs` is written on every mutation and `AuditService.recent()` exists; there is no endpoint and no page. |
| `portals/guardian` | **superseded** | `/portal`, `/portal/child/:id` | The shipped guardian PWA is the real thing rather than a phone mock-up, and carries more (results, homework, library, transport, hostel, documents, timetable accordion, events). |
| `portals/teacher` | **superseded** | `/teach` | Same: a real teacher PWA with today's periods, attendance marking, homework and assigned substitutions, service-worker registered. |

---

## Ready to build — the data and the API already exist

Ordered by how much a school would notice it missing.

1. **Attendance → Today** (`/attendance`, new tab). `attendance.summary()` is *already fetched by the
   loader and thrown away*. Present/late/absent/on-leave counts, per-section table, device health from
   `d.devices`. Endpoint: `GET /api/attendance/summary`. This is the head teacher's first screen every
   morning and it is one afternoon of JSX.
2. **Approvals inbox and Tasks** (`/automation`, two new tabs). `ApprovalService.pending/decide` and
   `TaskService.open/complete` exist; only two thin routes are needed. The dashboard already counts
   both and links nowhere, so today a pending leave request is invisible.
3. **Fees → Reminders, Cash counter, and the overview's defaulter table.** `runReminders` writes
   `fee_reminders`, `dayEndSummary` and `ageing`/`ageingReport` already compute what the charts need,
   `openSessionFor`/`closeCashSession` are routed. Only a `GET` for `fee_reminders` is new.
4. **Welfare → Health, Counselling.** `GET /api/welfare/health/:studentId` and
   `GET /api/welfare/counselling` (+ `/:id/notes`, already gated) are live. Clinic needs one `GET`.
5. **Communication → PTM slot board.** `GET /api/ptm/slots`, `POST /api/ptm/slots`,
   `POST /api/ptm/slots/:id/book`, `GET /api/ptm/bookings` are all routed and unused by the console —
   the guardian can be sent to a PTM the office cannot see.
6. **Exams → Promotion, Question bank.** `POST /api/exams/annual/compute`, `/promote`,
   `GET /api/exams/annual`, `GET/POST /api/questions`, `POST /api/questions/papers` all exist.
7. **HR → Appraisals, Contracts & expiry.** `GET /api/hr/appraisals`, `/api/hr/contracts` exist and
   the nightly expiry job is already alerting about rows nobody can look at.
8. **Documents → Issued documents, Templates.** `GET /api/documents/issued` and
   `GET /api/documents/templates` exist; the QR verify page is already public.
9. **Operations detail pages** — all routed, none rendered: hostel beds (`GET /api/hostel/:id/rooms`
   returns rooms *and* vacant beds), hostel mess menu (`GET /api/hostel/:id/menu`), roll call
   (`POST /api/hostel/roll-call`), transport vehicles (`GET /api/transport/vehicles`), library members
   (`GET /api/library/members`), inventory assets (`GET /api/inventory/assets`).
10. **Accounting → Chart of accounts and Bank reconciliation.** `GET /api/accounting/accounts` is
    already called for dropdowns; `GET /api/accounting/overview` already returns `bankAccounts`;
    `POST /api/accounting/bank/import` and `accounting.reconcile` are live but unreachable.
11. **LMS → Study materials** (`GET/POST /api/lms/materials`) and the **assignment submissions drawer**
    (`GET /api/lms/assignments/:id/submissions`).
12. **Row actions that exist server-side and have no button**: library renew
    (`POST /api/library/issues/:id/renew`), PO receive (`POST /api/inventory/purchase-orders/:id/receive`),
    expense pay (`accounting.payExpense`), admit-card PDF (issued by `buildSeatPlan`, never offered).

## Needs new data or new API surface

| Gap | What it needs |
|---|---|
| `settings/policies` | `GET/PUT /api/settings` over `SettingsService.all/set` — the `settings` table is already seeded and read by every job. No new tables. |
| `settings/audit` | `GET /api/audit` over `AuditService.recent()`. Table `audit_logs` already written. |
| `settings/sequences` | `GET/PATCH /api/sequences` over `number_sequences`. `NumberingService` owns the row; the API is new. |
| `settings/users` | `GET /api/users` (+ invite, reset, 2FA state) over `users` / `user_roles`. `RbacService.assignRole` exists; listing and invite are new. |
| `settings/roles` | `GET/PUT /api/roles` over `roles` / `permissions` / `role_permissions`, plus `rbac.invalidate()` on save. Tables and enforcement exist; the matrix API is new. |
| `settings/profile` | `PATCH /api/school` over the `schools` row, plus campuses and shifts. Read paths exist (`academic.shifts`, `mainCampus`); no writer outside the installer. |
| `communication/notifications` | `GET /api/notifications` over the `notifications` table (channel filter, delivery status, cost). Rows exist; the service only exposes `recentFor(userId)`. |
| `communication/templates` | CRUD over `notification_templates` (key × channel × locale, active flag). Table exists and is read on every send. |
| `communication/providers` | CRUD over `messaging_providers` + a balance sync surface. The `comms.provider_balance` job already reads and switches; the console cannot see the balance. |
| `welfare/clinic` | `GET /api/welfare/clinic` — `clinic_visits` rows are written by `welfare.clinicVisit`; there is no list method or route. |
| `welfare/rules` | A settings surface for the behaviour thresholds the `welfare.behaviour_rules` job applies (−10 in 30 days, −20 in 60 days, +15 in a term). Thresholds are in code, not in a row a school can change. |
| `hr/leave` (balances) | `GET /api/hr/leave-balances` over `leave_balances`. Rows are accrued and decremented; nothing reads them. |
| `library/reservations` | `GET /api/library/reservations`. `library_reservations` rows and the 48-hour hold already work. |
| `transport/boardings` | `GET /api/transport/boardings` over `transport_boardings`. |
| `transport/live` | `GET /api/transport/positions` (last GPS fix per trip) plus the map. `gps_positions` rows are ingested; nothing reads them. |
| `inventory/movements` | `GET /api/inventory/movements` over `stock_movements` (`inventory.movements()` exists). |
| `inventory/requests` | `GET /api/inventory/issues` and `/requisitions` over the existing tables. |
| `exams/online` | `GET /api/exams/online` list (the create and submit routes exist). |
| `fees/reminders` | `GET /api/fees/reminders` over `fee_reminders`. |
| `students/guardians` | A guardian-directory endpoint (group by phone, children, portal-account state). All the rows exist; the query is new. |
| `staff/departments` | Staff-department grouping with head/headcount. `people.departments`/`setDepartmentHead` exist; the aggregate view is new. |
| `automation/integrations` | A webhook list/registration surface over `webhooks` / `webhook_deliveries`, and a connected-service registry. The plugin half is shipped via `/platform`. |
| `students/import` extras | Guardians, marks and library-book importers — `ImportService` handles students, staff and attendance only. |

---

## Shell

The prototype's chrome is a two-row app frame; the shipped console has one sidebar and nothing else.

| Prototype shell element | Shipped |
|---|---|
| Top bar (brand, search, right-hand controls) | **Absent.** `apps/web/app/routes/console.tsx` renders a sidebar and `<Outlet/>` only. The owner console (`owner.tsx`) has a title bar, the school console has none. |
| Global search (`#gsearch`) over students, staff, invoices and books, with a `/` keyboard shortcut and a results popover that opens the matching drawer | **Absent.** No search anywhere outside per-table `DataTable` search. |
| Academic-year selector (`#yearsel`) | **Absent from the shell.** Year pickers are page-local (`/academic?yearId=`, `/exams`, `/college`); everything else silently uses `academic.currentYear()`. |
| Role switcher (`#rolesel`: Admin / Teacher / Accountant / Guardian) that re-filters the sidebar via `ROLE_NAV` and redirects a guardian to the portal | **Absent.** The sidebar shows a static `roles[0] ?? user_type` label. `/insights` has a page-local "Seen as: role" link that only changes which analytics dashboard is computed — it is not a role switch. The real console filters one item only: `/automation` is hidden without `platform.view`. |
| Notifications bell (`#bellbtn`) with a popover of recent notifications, each linking to its screen | **Absent.** There is no in-app notification surface at all; notifications leave by SMS/push/email only. |
| Theme toggle (`#themebtn`, persisted to `localStorage`) | **Absent.** No light/dark toggle in any route or in `packages/ui`. |
| Language toggle | **Absent from the console.** A `lang.switch` link exists on `/login` (sets the `ps_locale` cookie) and `/install`, and `/site` takes `?locale=`; once signed in there is no way to change language. |
| Breadcrumbs (`Home › Module › Page`) | **Absent** everywhere. |
| Sidebar grouped into Overview / Academics / People / Finance / Operations / Engagement / Platform, with a two-letter module glyph and a sub-page list under the open module | **Flat.** 26 links in one ungrouped list, no glyphs, no sub-navigation — the shipped console folds ~5 prototype screens into each page's tab bar instead. |
| Sidebar count badges (new applications, absent today, pending approvals, open complaints) | **Absent.** |
| Avatar / signed-in identity | Present as a text line at the bottom of the sidebar (name · role, engine · mode, Sign out). |
| Toasts, drawers, modals, `Esc` to close | Drawers are shipped (`Drawer`, closes on Esc and backdrop). There is no toast system — every result is a `Banner` at the top of the page, and several confirmations use `window.prompt()`. |

Two loaders fetch data that is never rendered, which is a shell-level bug rather than a design gap:
`attendance.tsx` loads `summary` and shows nothing; `learning.tsx` loads `engagement.newsletters` and
`engagement.clubs` and renders neither.

---

## Rules the prototype states — and whether the shipped code does them

Checked against the owning service, not assumed.

**Fees**

| Rule in the prototype's copy | Shipped? |
|---|---|
| "Invoices are generated on the 1st" (06:00, batch) | **Yes** — `fees.generate_invoices` cron seed, `FeesService.generateBatch/runBatch`. |
| "Reminders escalate at −3, 0, +7, +15, +30 days" | **Partly.** `REMINDER_LADDER` in `fees.ts` is `−3, 0, +3, +7, +15`. There is **no +30 stage**. |
| "call task at +30" (rule F3) | **No.** Nothing raises a call task at day 30; `fees.money_watch` raises tasks for other conditions. |
| "fines apply once" | **Yes** — `applyOverdueAndFines` writes the fine line once per invoice. |
| "Every payment: allocated oldest-first, receipt PDF, thank-you SMS, journal entry — automatically" | **Yes** — `recordPayment` allocates oldest-first, leaves an advance, issues the receipt, notifies and posts through `AccountingService.post()`. The console repeats the allocation sentence in the collect drawer. |
| "Late fine ৳100 flat after 5 days" | **Yes as a mechanism** — `ensureFineRule` + `late_fine_rule_id` per structure item; the amount and grace are the school's, not hard-coded. |
| "Cash sessions close with a count; variance is flagged to the principal in the day-end summary" | **Yes** — `closeCashSession` returns the variance; `fees.day_end_summary` runs at 18:00. |
| "payment.received & no overdue left → lift admit-card / document blocks" (F6) | **Yes** — rule `F6` is seeded and the exam eligibility check re-reads dues. |
| "Sibling and merit discounts are proposed by automation and wait for approval" | **Yes** — `A9` proposes the sibling discount on enrolment, `F11` routes it to the principal, `D8` proposes the merit scholarship on publish. |
| "Early payment 2% — auto-applied" | **No.** `early_payment` is a valid `discount_kind` but nothing applies it automatically. |
| "Quiet hours 21:00–07:00 are respected" | **Yes** — `NotificationService` reads `notifications.quiet_hours` and defers to `nextLocalTime`. |
| "invoices for September were generated automatically on 1 Sep 06:00 (batch of N)" (dashboard copy) | The behaviour is shipped; **the sentence is not shown anywhere in the console.** |

**Attendance**

| Rule | Shipped? |
|---|---|
| "unmarked students became absent at 10:30 and guardians were notified" | **Yes** — `attendance.auto_absent` cron + `policy.auto_absent_at`, then `notifyAbsentBatch`. |
| "3 lates = 1 LOP day, and flows into payroll" | **Yes** — `late_count_to_lop` on the staff policy is read by `HrService` when building the payslip. |
| "Consecutive absences → class teacher task (3)" | **Yes** — `consecutive_absent_alert` on the policy + rule `C5`. |
| "Minimum attendance 75%" / "Block admit card below minimum" | **Yes** — `min_attendance_pct` and `block_exam_below_min` on the policy; `assessment.eligibility` refuses the seat with a named reason and tells the guardian what to clear. |
| "Holidays automatically mark attendance as holiday" (B5) | **Yes** — rule `B5` + `attendance.applyHoliday`; the register returns `holiday` and Save is disabled. |
| "…and pause reminders" (B5) | **No.** Nothing suppresses the fee-reminder ladder on a holiday. |
| "Approving a teacher's leave marks the days excused, deducts the balance and suggests substitutes" | **Yes** — `onLeaveApproved` marks excused, increments `leave_balances.used`, and emits `leave.approved`, which `timetable.suggestSubstitutes` / the `timetable.cover_today` job act on. |
| "Changing a value here changes what the automation does tomorrow" (policies page) | **Half true today** — the policies are read from the row on every run, but only the auto-absent time can be changed from the console. |

**Admissions**

| Rule | Shipped? |
|---|---|
| "Every new enquiry is assigned round-robin and gets a follow-up task in 48 hours" | **Yes** — rule `A1` + `admissions.assignCounsellor`; `admissions.followup_reminders` chases. |
| "Ranked by score, sibling priority, then date of birth. Top-N by seats are shortlisted; the rest are waitlisted" | **Yes** — `computeMerit` ranks by score, then sibling, then age, and waitlists the remainder in the same order. |
| "An offer expires unpaid → revoked and the next waitlisted applicant is promoted, hourly" | **Yes** — `admissions.offer_expiry` cron + `promoteWaitlist`. |
| "Seats per class drive shortlist and waitlist automatically" | **Yes** — `freeSeats` per campaign class. |
| "payment.received (admission fee) → enrol: student, guardians, accounts, section, ID card, library card, welcome SMS" (A8) | **Yes** — `onPaymentReceived` → `enrol`, which creates the student, the guardian account, allocates the section by capacity and queues the cards. |
| "Merit list: automatic on results entry" | **Yes** — `readyForMerit` waits for the *last* mark before ranking, and never re-ranks an applicant already holding an offer. |

**Exams**

| Rule | Shipped? |
|---|---|
| "Seat plans alternate sections in each room; invigilators are load-balanced" | **Partly** — `buildSeatPlan` alternates sections across room seats; there is no invigilator roster at all. |
| "admit cards only if fee-clear & eligible" (D2) | **Yes** — `require_fee_clearance` and `min_attendance_pct` per exam, with the reason recorded on the seat row. |
| "Grade and grade point update instantly from the grading bands" | **Yes server-side** (`gradeFor`); the shipped marks grid shows the grade after save, not while typing. |
| "Submit sends them for verification and locks after the deadline" | **Yes** — verify / lock / unlock routes, plus `exams.marks_deadline_reminders`. |
| "Computed by the result engine when all papers lock: credit-weighted GPA, pass/fail, rank in section and class" | **Yes** — `computeResults` with `rank_scope` and `tie_rule` on the exam row; `exams.auto_compute` triggers it. |
| "Publish → report card PDFs, SMS with GPA & rank" (D6) | **Yes** — rule `D6` + `renderReportCards` in 25-student slices. |
| "GPA drop ≥ 1.0 → refer to counsellor" (D7) | **Yes** — rule `D7` seeded on `result.published`. |
| "GPA ≥ 5.0 → propose merit scholarship for approval" (D8) | **Yes** — rule `D8` seeded. |
| "Year-end: promote / retain / graduate from weighted annual GPA and attendance. Preview before applying" | **Yes in the service** — `promote(..., { apply })` previews then applies, `exams.year_end` prepares it; **there is no console button**. |
| "MCQ auto-graded at close; linked papers sync into marks" | **Yes** — `createOnlineExam({ autoGrade })` + `submitAttempt`; no console page. |

**Timetable / academic**

| Rule | Shipped? |
|---|---|
| "The database rejects a teacher or room booked twice in the same period (exclusion constraint)" | **Behaviour yes, mechanism no.** MySQL and SQLite have no exclusion constraints, so `timetable.findClash` enforces the three clash rules in the service and `publish` refuses while `validate()` returns any clash. The prototype's "rejected by database" demo is not literally true on the shipped engines. |
| "Creating 2027 will clone class-subjects, fee structures, grading scales and leave types from 2026 (rule B1)" | **Yes** — rule `B1` + `academic.cloneYear`, offered as "Clone structure from" on the new-year form. |
| "Syllabus-behind alert to teacher + HOD" (B6) | **Yes** — `academic.syllabus_lag` cron + `curriculum.syllabusLagCheck`, de-duplicated by `toldRecently`. |
| "Capacity and gender policy drive automatic section allocation at enrolment" | **Yes** — `people.autoSection` uses capacity; the section carries `gender_policy`. |
| "Substitution suggestions: free, qualified, lowest load" (B3) | **Yes** — `suggestSubstitutes`, and it says "nobody free" rather than guessing. |

**Operations**

| Rule | Shipped? |
|---|---|
| "Overdue fines accrue daily and land on the next fee invoice when the book is returned" | **Yes** — `library.due_and_fines` cron + `billFine` on return. |
| "When a copy comes back, the next member is notified and gets a 48-hour hold" (I4) | **Yes** — `offerToNextInQueue` sets `expires_at` to +48 h and notifies. |
| "Entering a stop geofence pushes 'bus approaching' to that stop's guardians" (J2) | **Yes** — `transport.ingestGps` fires one push per stop per trip. |
| "RFID taps confirm boarding" / "each tap notifies the guardian and feeds the school check-in" (J3) | **Yes** — `transport.board` notifies and marks the child present. |
| "Trip late by 10 min: alert manager & route guardians" (J4) | **Yes** — `transport.delay_watch` every 5 minutes. |
| "Fitness, insurance, tax token and route permit expiries raise tasks 30 days ahead" | **Yes** — `transport.document_expiry` nightly. |
| "Allocation ranges cannot overlap on a bed (database exclusion constraint)" | **Behaviour yes, mechanism no** — enforced in `hostel.allocate`, not by a constraint. |
| "Guardian consents in the app, warden approves, QR pass issued; late return alerts warden and guardian" | **Yes** — `guardianConsent` → `approveOutpass` (the console's Approve button only appears once consent is recorded) → `hostel.curfew_watch` every 15 min. |
| "Absent without an out-pass alerts warden and guardian immediately" (roll call) | **Yes** — `hostel.rollCall` + `hostel.night_watch`; no console screen to take the roll. |
| "Stock below reorder level drafts a purchase order with the preferred vendor" (L1) | **Yes** — `inventory.checkReorder` + the `inventory.reorder_sweep` job write a PO with `is_auto = 1` in `pending_approval`. |
| "PO received: stock-in posted, expense created, journal posted" (L2) | **Yes** — `inventory.receive`; the console has no Receive button. |
| "Staff request consumables; approval creates the stock-out movement" (L3) | **Yes** — `issueRequest` / `issueApproved`; no console page. |
| "Ticket, auto-assignment by category, SLA by priority, escalation on breach, satisfaction survey on close" (N8) | **Yes** — `raiseComplaint` sets `sla_due_at` by priority and auto-assigns; `frontoffice.sla_escalation` sets `escalated_at`; `rateComplaint` exists. The console shows the SLA date but not the assignee. |

**Documents, welfare, platform**

| Rule | Shipped? |
|---|---|
| "A TC needs dues, library, hostel and discipline clear. Blocked requests tell the guardian exactly what to clear" | **Yes** — `documents.eligibility` returns four typed blockers with the amount/count in the text; the console prints them and disables Issue when blocked. |
| "Every document carries a QR code; the public verify page confirms it without login" | **Yes** — `documents.issue` writes the verify code, `GET /api/public/verify/:code` is unauthenticated. |
| "Lost cards are cancelled and the RFID tag revoked" (+ ৳200 to the next invoice) | **Partly** — `documents.revoke` exists; nothing revokes the RFID or adds the reissue fee. |
| "Notes are encrypted and visible only to the counsellor role" | **Yes** — `counsellingNotes(schoolId, id, staffId)` decrypts only for the owning counsellor; the list endpoint strips the ciphertext. |
| "Negative incidents notify guardians; thresholds propose actions for approval" (N1, N2) | **Yes** — rule `N1` on `incident.reported`, `welfare.behaviour_rules` nightly proposing actions that wait for approval. |
| "Due vaccinations remind guardians 7 days ahead" | **Partly** — `recordVaccination` stores `next_due_on`; no job chases it. |
| "SMS balance low: alert admin, switch provider" (M3) | **Yes** — `comms.provider_balance` hourly job. |
| "Scheduled notices publish themselves" (M2) | **Yes** — `cms.scheduled_publish` job; the website page offers the go-live datetime. |
| "Weekly digest to guardians" (M5) | **Yes** — `comms.weekly_digest`, Saturday 18:00. |
| "Cron in Asia/Dhaka with a leader lock, so only one worker runs each job" | **Yes** — the scheduler takes a lock; 72 scheduled jobs are seeded and `ensureAutomationCatalogue()` back-fills them into already-installed schools at boot. |
| "System handlers are always on. Rules are seeded defaults you can switch off" | **Yes** — 30 `automation_rules` rows seeded, toggled from `/automation`. |
| "A changed rule runs in preview for 48 hours" | **No.** `automation_rules.preview_until` exists as a column and is read by the loader, but nothing sets it when a rule is toggled. |
| "Failures notify an admin after three attempts" | **Yes** — rule `N11` on `rule.failed`, plus `platform.watchdog`, which also reads a backup back before believing it. |
| "Append-only audit log. Every change with before/after, actor, IP" | **Yes in the table** — `audit_logs` is written on every mutation with before/after; **nothing in the console can read it.** |
| "Typed settings keys the automation reads. Change a value, the next run uses it" | **True of the engine, false of the console** — the jobs read `settings` live, but there is no settings API or page. |
| "Click a cell to cycle none → view → edit. Permission keys look like fees.invoice.create" | **Enforcement yes, editing no** — every route calls `requirePerm('module.action')` and `role_permissions` drives it, but the matrix cannot be seen or changed. |

---

## The ten things to build first

1. **Attendance → Today** — the data is already in the loader and discarded.
2. **Settings → Policies + Audit log** (`GET/PUT /api/settings`, `GET /api/audit`) — a school cannot
   currently change the thresholds the automation is documented to read, or see who changed what.
3. **Automation → Approvals inbox and Tasks** — two routes over services that already exist; the
   dashboard counts them and links nowhere.
4. **Fees → the defaulters table, the reminders page and a proper cash-counter screen.**
5. **Communication → Notification log, Templates, Providers** — without the provider page nobody can
   see the SMS balance the hourly job is already watching.
6. **Welfare → Health, Clinic, Counselling** — three list pages over routed endpoints.
7. **Home dashboard** — the eight KPIs, the two charts, today's schedule, approvals and tasks.
8. **Exams → Promotion, Question bank, Online exams** — the year-end pass is built and unreachable.
9. **Settings → Users and the roles matrix** — the only way to onboard a second operator today is the
   installer or the owner console.
10. **The shell** — top bar with global search (`/`), academic-year selector, notifications bell,
    theme and language toggles, breadcrumbs, and the grouped sidebar with count badges.

Nothing was committed or pushed; this file is the only change.

## Closed since this audit

This section is appended as items are built, so the table above stays the record of what the audit
found rather than being quietly rewritten.

- **The shell, the dashboard, and the console build-out** — item 10 and item 7, plus the pages listed
  in items 1–9: shipped in the prototype-parity wave (top bar with search, year chip, live clock,
  bell, theme and language toggles; the eight KPIs and both charts).
- **The invigilator roster** (rows 53 and 283) — `AssessmentService.rosterInvigilators` builds it,
  refuses a teacher who is teaching that period, and the room it cannot staff raises a task naming
  the room. It now runs inside `exams.pre_exam_prep`, so an exam nobody touched is staffed a week
  out rather than waiting for somebody to press the button.
- **Where a book is kept** — `library_book_copies.rack`/`shelf` were written null for ever. The
  catalogue column, the add-a-book form and `POST /api/library/shelve` (one copy by accession, or
  every copy of a title) now carry the shelfmark.
- **Reissue a lost ID card** — `POST /api/documents/id-cards/:id/reissue` existed with nothing to
  press; the card list has the button.
- **Preview a document template** — `POST /api/documents/templates/preview` renders the draft in the
  editor with sample values, through the same page furniture a real certificate gets. Nothing is
  recorded: no document number is taken and no `issued_documents` row is written.
