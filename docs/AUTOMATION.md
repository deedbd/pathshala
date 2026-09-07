# Pathshala — Automation Matrix

What the system does **without anyone clicking**. Each row is either a *system handler*
(always on, in code) or a *rule* (seeded in `automation_rules`, school can tune). Cron jobs
live in `scheduled_jobs`. Column "Tables" shows where the effect lands.

Legend: 🔒 system handler · ⚙️ rule (editable) · ⏰ scheduled job

---

## 1. Admissions

| # | Trigger | Condition | Automated action | Tables |
|---|---|---|---|---|
| A1 | ⚙️ `enquiry.created` | — | Assign counsellor round-robin; send acknowledgement SMS; create follow-up task due +48h | `admission_enquiries.assigned_to`, `notifications`, `tasks` |
| A2 | ⏰ daily 09:00 | `next_follow_up_at < now` and status open | Reminder to counsellor; escalate to admissions head after 2 missed follow-ups | `tasks`, `notifications` |
| A3 | 🔒 `application.submitted` | campaign has form fee | Generate `application_no`; create form-fee invoice + payment link; SMS/email applicant | `invoices`, `invoice_items`, `notifications` |
| A4 | 🔒 `payment.received` | invoice is form fee | Application → `submitted`; if test required, allocate test seat & generate admit card PDF | `admission_applications`, `issued_documents` |
| A5 | ⚙️ `test.results_entered` | all results in for class | Compute merit list (score desc, sibling priority, DOB tie-break); shortlist top-N by seats; waitlist rest; notify all | `merit_rank`, `waitlist_position`, `status`, `notifications` |
| A6 | 🔒 `merit_list.generated` | `campaign.auto_offer` | Create offers with `expires_at = now + validity`; admission-fee invoice; offer letter PDF | `admission_offers`, `invoices`, `issued_documents` |
| A7 | ⏰ hourly | offer expired, unpaid | Revoke offer; promote next waitlisted applicant; notify both | `admission_offers`, `admission_applications`, `notifications` |
| A8 | 🔒 `payment.received` | invoice is admission fee | **Enrol**: create `students`, `student_enrollments`, guardians (+ sibling link via phone), user accounts with OTP invite, auto section by capacity/gender/shift, `admission_no`, roll, ID card job, library membership, welcome SMS | `students`, `student_enrollments`, `guardians`, `users`, `id_cards`, `library_members` |
| A9 | ⚙️ `applicant.enrolled` | shared guardian phone with active student | Propose sibling discount for approval | `student_discounts (is_auto)` |

## 2. Academic structure & timetable

| # | Trigger | Condition | Automated action | Tables |
|---|---|---|---|---|
| B1 | ⚙️ `academic_year.created` | — | Clone class-subjects, fee structures, grading scale, leave types, section templates from previous year | `class_subjects`, `fee_structures`, … |
| B2 | 🔒 insert `timetable_slots` | — | DB exclusion constraints reject teacher/room double booking | `timetable_slots` |
| B3 | 🔒 `leave.approved` (staff) | teacher has slots on those dates | Suggest substitutes: free in that period, teaches that subject, lowest load; notify HOD to confirm | `timetable_substitutions (is_auto_suggested)` |
| B4 | ⚙️ `substitution.approved` | — | Notify substitute + section students; update period attendance owner | `notifications` |
| B5 | ⚙️ `calendar.holiday_added` | — | Mark attendance `holiday` for range; skip reminders/notifications on those days; cancel online classes | `student_attendance`, `staff_attendance` |
| B6 | ⏰ weekly Sun 08:00 | unit `planned_end_date` passed, not taught | Syllabus-behind alert to teacher + HOD with % completion | `tasks`, `notifications` |
| B7 | ⚙️ timetable published | school enables auto online class | Create `online_classes` from slots for remote days | `online_classes` |

## 3. Attendance & leave

| # | Trigger | Condition | Automated action | Tables |
|---|---|---|---|---|
| C1 | 🔒 `punch.received` | identifier resolves | Upsert daily attendance: present / late (policy minutes); first punch = check-in, last = check-out | `student_attendance`, `staff_attendance` |
| C2 | ⚙️ `attendance.marked` | status late, `notify_on_late` | SMS/push to guardians: "arrived 08:47, 17 min late" | `notifications` |
| C3 | ⚙️ `attendance.marked` | status present, `notify_on_arrival` | Arrival push (SMS optional) | `notifications` |
| C4 | ⏰ `auto_absent_at` daily | no row for active student, not holiday, no approved leave | Mark `absent` (source system); SMS guardian; stamp `guardian_notified_at` | `student_attendance`, `notifications` |
| C5 | ⚙️ `attendance.absent` | 3rd consecutive absent | Task to class teacher; call-log task for front office | `tasks` |
| C6 | ⏰ monthly 1st | `attendance_pct < min_attendance_pct` | Warning letter (PDF) + SMS to guardian; flag on report card; if `block_exam_below_min`, set seat plan ineligible | `issued_documents`, `exam_seat_plans` |
| C7 | 🔒 staff attendance marked | late count in month ≥ `late_count_to_lop` | Add LOP day to payroll input | `payslips.lop_days` (at run time) |
| C8 | 🔒 `leave.applied` | — | Pick workflow by applicant type/days; create approval request; notify first approver | `approval_requests`, `notifications` |
| C9 | 🔒 `leave.approved` | — | Attendance for range = `excused`; deduct `leave_balances.used`; trigger B3 for teachers; notify applicant/guardian | `student_attendance`, `leave_balances` |
| C10 | ⏰ monthly 1st | `leave_types.accrual = monthly` | Accrue balances; year-end carry-forward capped | `leave_balances` |
| C11 | ⏰ nightly 01:00 | — | Refresh `mv_student_attendance_monthly`; write `kpi_daily.attendance_pct` | views, `kpi_daily` |

## 4. Examinations

| # | Trigger | Condition | Automated action | Tables |
|---|---|---|---|---|
| D1 | 🔒 exam → `scheduled` | — | Generate routine PDF per class; calendar events; notify students/guardians/teachers | `calendar_events`, `issued_documents`, `notifications` |
| D2 | ⚙️ 7 days before exam | — | Seat plan (room capacity, alternate sections), invigilator roster (load-balanced), admit cards **only if** fees clear & attendance OK; list ineligible to accounts | `exam_seat_plans`, `exam_invigilators`, `issued_documents`, `tasks` |
| D3 | ⚙️ marks entry deadline −2d | schedules with missing marks | Reminder to subject teachers; escalation to exam controller at deadline | `notifications`, `tasks` |
| D4 | 🔒 marks `submitted` | — | Validate ranges vs `full_marks`; compute total, grade, GP from `grading_bands`; flag anomalies (e.g. 0 with not absent) | `marks` |
| D5 | 🔒 all schedules `locked` | — | **Result engine**: per student total, %, GPA (credit-weighted, F ⇒ GPA 0 when board rule on), pass/fail, rank in section & class (ties per setting), attendance %; write `exam_results`; tabulation sheet PDF | `exam_results`, `report_snapshots` |
| D6 | ⚙️ `result.computed` | `exams.publish_at` reached or `auto_publish` | Publish; report card PDF per student; SMS "GPA 4.83, rank 5" + app link; teacher remark placeholder tasks before publish | `exam_results.published_at`, `issued_documents`, `notifications` |
| D7 | ⚙️ `result.published` | GPA drop ≥ 1.0 vs previous exam | Refer to counsellor; notify class teacher | `counselling_sessions`, `tasks` |
| D8 | ⚙️ `result.published` | GPA ≥ scheme `auto_rule.min_gpa` | Propose merit scholarship discount | `student_discounts (is_auto)` |
| D9 | 🔒 online exam `ends_at` | — | Auto-submit open attempts; auto-grade MCQ/true-false; queue manual grading for others; sync to `marks` if linked | `online_exam_attempts`, `marks` |
| D10 | ⏰ year-end (year `closed`) | `promotion_rules` | Weighted annual GPA; promote / retain / graduate; create next-year enrollments; graduates → `alumni`; notify guardians; trigger B1 for fees | `promotions`, `student_enrollments`, `alumni` |

## 5. LMS

| # | Trigger | Condition | Automated action | Tables |
|---|---|---|---|---|
| E1 | ⚙️ `assignment.published` | — | Push to students & guardians of the section | `notifications` |
| E2 | ⏰ hourly | `due_at − 24h`, not submitted | Reminder to student; stamp `reminder_sent_at` | `notifications` |
| E3 | 🔒 `due_at` passed | — | Mark late submissions; apply `late_penalty_pct` on grading; grading-pending task for teacher after 3 days | `assignment_submissions.is_late`, `tasks` |
| E4 | ⚙️ `online_class.starting` (−15 min) | — | Push with join link; create meeting via Zoom/Meet API if missing | `online_classes.join_url`, `notifications` |
| E5 | 🔒 platform webhook (participant joined/left) | — | Write `online_class_attendance`; feed period attendance | `online_class_attendance`, `student_period_attendance` |

## 6. Fees & billing

| # | Trigger | Condition | Automated action | Tables |
|---|---|---|---|---|
| F1 | ⏰ `fees.invoice_generation_day` monthly | active enrolment | **Invoice batch**: structure items for month + transport (`student_transport.monthly_fee`) + hostel (`hostel_allocations.monthly_fee`) + pending fines/previous due − approved discounts − overrides; PDF; SMS/push with pay link; batch summary to accountant | `invoice_batches`, `invoices`, `invoice_items`, `notifications` |
| F2 | 🔒 `student.enrolled` mid-month | — | Pro-rata first invoice; admission/one-time heads | `invoices` |
| F3 | ⏰ daily 08:00 | due in 3 days / today / overdue 7, 15, 30 | Escalating reminders per `fees.reminder_stages`; at 30 days create call task for accounts + class teacher note | `fee_reminders`, `tasks` |
| F4 | ⏰ daily 00:30 | past due + grace | Status → `overdue`; apply `late_fine_rules` as fine item (idempotent via `fine_applied_at`); block per policy | `invoices`, `invoice_items` |
| F5 | 🔒 gateway IPN / counter payment | — | Verify; allocate oldest-first; ledger entry; receipt PDF; thank-you SMS; journal (Dr bank/MFS, Cr income heads, Cr fine, Dr gateway fee expense) | `payments`, `payment_allocations`, `student_ledger_entries`, `journal_entries` |
| F6 | ⚙️ `payment.received` | no overdue remains | Lift admit-card / document blocks | `exam_seat_plans`, `document_requests` |
| F7 | ⚙️ `payment.failed` | — | Notify payer with retry link; accounts sees failed list | `notifications` |
| F8 | 🔒 `refund.approved` | — | Gateway refund API or cash-out task; reverse journal; ledger credit | `refunds`, `journal_entries`, `student_ledger_entries` |
| F9 | ⏰ bank statement import | — | Auto-match by amount+reference+date to payments/expenses/payroll; unmatched to task | `bank_statement_lines` |
| F10 | ⏰ daily 18:00 | — | Day-end cash summary to principal & accountant; variance alert if `cash_sessions.variance ≠ 0` | `notifications`, `kpi_daily` |
| F11 | ⚙️ `discount.proposed` | — | Route approval (principal); on approve, re-rate current-month open invoices | `approval_requests`, `invoice_items` |
| F12 | ⚙️ `student.status_changed` → transferred/dropped | — | Stop future invoices; final settlement statement; refund proposal for refundable heads | `invoices`, `refunds` |
| F13 | ⏰ daily 06:00 | instalment falls due today | Raise that instalment's invoice only; the plan closes when the last one is billed | `instalment_plans`, `invoices` |

## 7. Accounting

| # | Trigger | Condition | Automated action | Tables |
|---|---|---|---|---|
| G1 | 🔒 any of: payment, refund, payroll paid, expense paid, PO received, other income | — | Balanced journal entry auto-posted (DB trigger rejects unbalanced) | `journal_entries`, `journal_lines` |
| G2 | 🔒 `expense.requested` | amount > category threshold | Approval workflow; else auto-approve | `approval_requests` |
| G3 | ⚙️ `journal.posted` | spend ≥ `budgets.alert_at_pct` | Budget alert to principal/treasurer | `notifications` |
| G4 | ⏰ monthly 1st | — | Income statement, collection vs budget, receivables ageing PDFs to management | `report_snapshots` |
| G5 | ⏰ fiscal year end | — | Lock period; carry balances; open new fiscal year | `fiscal_years` |

## 8. HR & payroll

| # | Trigger | Condition | Automated action | Tables |
|---|---|---|---|---|
| H1 | ⏰ `payroll.run_day` monthly | — | **Draft payroll**: per staff structure + attendance (present/LOP/lates) + approved leave + loans + tax slab + overtime; totals; approval request | `payroll_runs`, `payslips`, `approval_requests` |
| H2 | 🔒 `payroll.approved` | — | Payslip PDFs; bank bulk-transfer file; journal (Dr salary expense, Cr bank, Cr PF/tax payable); SMS/push to staff; loan balances reduced | `payslips`, `files`, `journal_entries`, `staff_loans` |
| H3 | ⏰ daily | contract `end_date − 30d` / probation end | Alert HR; create appraisal task | `tasks`, `notifications` |
| H4 | ⏰ daily | `staff_documents.expires_at − 30d` | Reminder to staff + HR | `notifications` |
| H5 | 🔒 `staff.joined` | — | User account + role by designation, ID card job, biometric enrol task, salary structure task, welcome email | `users`, `id_cards`, `tasks` |
| H6 | 🔒 `staff.left` | — | Deactivate user, revoke sessions, final settlement (leave encashment, loan recovery), reassign timetable slots → substitution needed | `users`, `auth_sessions`, `timetable_substitutions` |
| H7 | ⚙️ appraisal cycle opens | — | Pre-fill `auto_metrics` (attendance %, syllabus completion, class result average) | `staff_appraisals` |
| H8 | ⏰ daily | birthday / work anniversary | Greeting (staff & students) | `notifications` |

## 9. Library

| # | Trigger | Condition | Automated action | Tables |
|---|---|---|---|---|
| I1 | 🔒 `book.issued` | — | Set `due_at`; copy status; push receipt | `library_issues`, `library_book_copies` |
| I2 | ⏰ daily | due tomorrow / overdue 1, 7 days | Reminders; status `overdue` | `notifications`, `library_issues` |
| I3 | ⏰ daily | overdue | Accrue fine (`fine_per_day`, capped at book price); on return push fine to next invoice as item | `library_issues.fine_amount`, `invoice_items` |
| I4 | 🔒 `book.returned` | reservation waiting | Mark `ready`, notify next member, 48h hold | `library_reservations` |
| I5 | ⚙️ `student.status_changed` → leaving | open issues | Block TC eligibility; task to librarian | `document_requests.eligibility`, `tasks` |
| I6 | ⚙️ issue > 60 days, no response | — | Mark `lost`; charge book price | `library_issues`, `invoice_items` |

## 10. Transport

| # | Trigger | Condition | Automated action | Tables |
|---|---|---|---|---|
| J1 | ⏰ daily 05:00 | routes active | Create today's trips (pickup/drop); driver app checklist | `vehicle_trips` |
| J2 | 🔒 GPS packet | inside stop geofence | `bus.approaching_stop` → push to guardians of that stop (once per trip/stop) | `stop_alerts`, `notifications` |
| J3 | 🔒 RFID / helper tap | — | Boarded / alighted push to guardian; feed `student_attendance` check-in | `transport_boardings`, `student_attendance` |
| J4 | ⏰ every 5 min | trip not started 10 min after schedule | Alert transport manager + guardians on route | `vehicle_trips.delay_alert_sent_at` |
| J5 | 🔒 GPS packet | speed > limit | Over-speed alert to manager; log for driver appraisal | `notifications` |
| J6 | 🔒 drop trip ended | student boarded but not alighted | Critical alert to helper, manager, guardian | `notifications` |
| J7 | ⏰ daily | insurance/fitness/tax/permit expiring in 30d; maintenance due by date/km | Tasks + reminders | `tasks` |
| J8 | 🔒 `student_transport` created | — | Route fee joins monthly invoicing (F1) | `invoice_items` |

## 11. Hostel

| # | Trigger | Condition | Automated action | Tables |
|---|---|---|---|---|
| K1 | 🔒 bed allocated | — | Bed status; hostel fee joins invoicing; guardian notified | `hostel_beds`, `invoice_items` |
| K2 | 🔒 outpass applied | — | Guardian consent request (app) → warden approval; QR pass | `hostel_outpasses`, `approval_requests` |
| K3 | ⏰ every 15 min | `expected_return + curfew_alert_minutes` passed, not back | Alert warden + guardian | `hostel_outpasses.late_alert_sent_at` |
| K4 | ⏰ nightly after roll call | absent in night roll call, no outpass | Alert warden + guardian | `notifications` |
| K5 | ⚙️ complaint logged | category maintenance | Task to maintenance; SLA 48h | `tasks` |
| K6 | ⏰ 1st of the month 03:00 | per-meal billing is on | Bill last month's meals at the rate each was taken at; a student already billed is skipped | `meal_records`, `invoices` |
| L6 | ⏰ daily 09:00 | work order past the deadline its priority set | Chase the assignee and the office; overdue safety drills are named too | `work_orders`, `safety_drills` |
| O1 | ⏰ daily 09:00 | a resolution's due date has passed | Remind its owner (or the office if it has none); an election past its closing time counts itself | `resolutions`, `elections` |
| O2 | ⏰ monthly | records older than a retention rule, or a return generated a fortnight ago and still unsent | Report what retention would touch — never delete — and name the unsent returns | `retention_policies`, `govt_reports` |
| P1 | ⏰ daily 00:30 | a metric departs from this school's own recent median by more than three deviations | One open alert per metric (never a daily duplicate) to the office, with the usual figure beside the actual one | `metric_values`, `kpi_daily`, `anomaly_alerts` |
| P2 | ⏰ weekly | attendance, fees and results together put a student above the risk threshold | Name the student to their class teacher once, with the reasons — not a score on its own | `risk_scores`, `notifications` |
| Q1 | ⏰ daily 02:00 | a subscription is a fortnight from its end, or an invoice is past its due date | Raise the next invoice; mark the overdue ones and pause new students and messages — never access to what the school already has | `saas_invoices`, `saas_subscriptions` |

## 12. Inventory & assets

| # | Trigger | Condition | Automated action | Tables |
|---|---|---|---|---|
| L1 | 🔒 stock movement | qty < `reorder_level` | Draft PO with preferred vendor & `reorder_qty`; notify store keeper | `purchase_orders (is_auto)` |
| L2 | 🔒 PO received | — | Stock-in movements; expense + journal; asset rows for asset categories with QR tags | `stock_movements`, `expenses`, `assets` |
| L3 | 🔒 issue request approved | — | Stock-out movements to staff/room | `stock_movements` |
| L4 | ⏰ daily | maintenance `next_due_date` / warranty expiring | Tasks + reminders | `tasks` |
| L5 | 🔒 clinic visit with medicines | — | Stock-out from clinic store | `stock_movements` |

## 13. Communication

| # | Trigger | Condition | Automated action | Tables |
|---|---|---|---|---|
| M1 | 🔒 any `notify` action | — | Resolve recipients (guardians with `receives_notifications`), preferences, quiet hours, locale template; queue; provider send; retries; delivery status via provider callback; cost recorded | `notifications` |
| M2 | ⏰ every 10 min | notice `publish_at` reached | Publish; push/SMS per audience | `notices`, `notifications` |
| M3 | ⏰ hourly | provider balance < threshold | Alert admin; switch to fallback provider | `messaging_providers` |
| M4 | ⚙️ PTM slot booked | −1 day, −1 hour | Reminders to guardian & teacher | `ptm_bookings.reminder_sent_at` |
| M5 | ⏰ weekly Sat 18:00 | — | Weekly digest to guardians: attendance, homework, dues, upcoming events | `notifications` |
| M6 | ⚙️ message sent in section channel | — | Push to participants, respecting mute | `notifications` |

## 14. Welfare, documents, front office, platform

| # | Trigger | Condition | Automated action | Tables |
|---|---|---|---|---|
| N1 | ⚙️ `incident.reported` | category `notify_guardian` | Guardian notified with description; class teacher copied | `behaviour_incidents.guardian_notified_at` |
| N2 | ⏰ nightly | points in window cross `behaviour_rules.threshold` | Propose disciplinary action / merit certificate; notify roles | `disciplinary_actions (is_auto_proposed)` |
| N3 | ⏰ daily | vaccination `next_due_on − 7d` | Reminder to guardian | `notifications` |
| N4 | 🔒 clinic visit `sent_home` | — | Immediate call+SMS to emergency contact | `notifications` |
| N5 | 🔒 `document.requested` (TC/testimonial) | — | Eligibility: dues = 0, no library issues, no hostel dues, no pending discipline; if blocked, tell requester what to clear; else approval → PDF with QR `verification_code` → public verify page | `document_requests`, `issued_documents` |
| N6 | ⏰ yearly before session | ID cards expiring | Batch new ID cards (students/staff), print job | `id_cards` |
| N7 | 🔒 visitor check-in | `to_meet_staff_id` | Push to host; early-pickup requires `can_pickup` guardian match | `visitor_logs.host_notified_at` |
| N8 | 🔒 complaint created | — | Ticket no; auto-assign by category; SLA by priority; escalate on breach; satisfaction survey on close | `complaints`, `tasks` |
| N9 | ⏰ nightly | — | `kpi_daily` snapshot; anomaly alerts (collection −30% vs 4-week avg, attendance −15%) | `kpi_daily`, `notifications` |
| N10 | ⏰ nightly | — | Backups (PITR + object storage), retention purge of OTPs/expired sessions, outbox archive | — |
| N11 | ⚙️ `rule.failed` ×3 | — | Alert school admin + platform ops | `notifications` |
| N12 | 🔒 `import.finished` | — | Summary with error file link | `import_jobs`, `notifications` |

---

## Scheduled jobs (seed for `scheduled_jobs`)

| job_key | cron (Asia/Dhaka) | Rows above |
|---|---|---|
| `attendance.auto_absent` | `30 10 * * 0-4` | C4 |
| `attendance.refresh_summary` | `0 1 * * *` | C11 |
| `attendance.monthly_threshold` | `0 7 1 * *` | C6 |
| `leave.accrue` | `5 0 1 * *` | C10 |
| `fees.generate_invoices` | `0 6 1 * *` | F1 |
| `fees.reminders` | `0 8 * * *` | F3 |
| `fees.instalments_due` | `0 6 * * *` | F13 |
| `fees.overdue_and_fines` | `30 0 * * *` | F4 |
| `fees.day_end_summary` | `0 18 * * *` | F10 |
| `payroll.draft_run` | `0 9 25 * *` | H1 |
| `hr.expiry_alerts` | `0 8 * * *` | H3, H4 |
| `exams.pre_exam_prep` | `0 7 * * *` | D2 |
| `exams.marks_deadline_reminders` | `0 9 * * *` | D3 |
| `lms.assignment_reminders` | `0 * * * *` | E2 |
| `library.due_and_fines` | `0 7 * * *` | I2, I3 |
| `transport.create_trips` | `0 5 * * 0-4` | J1 |
| `transport.delay_watch` | `*/5 * * * *` | J4 |
| `transport.document_expiry` | `0 8 * * *` | J7 |
| `hostel.curfew_watch` | `*/15 * * * *` | K3 |
| `hostel.mess_billing` | `0 3 1 * *` | K6 |
| `inventory.maintenance_due` | `0 8 * * *` | L4 |
| `frontoffice.sla_escalation` | `0 * * * *` | N8 |
| `facilities.sla_watch` | `0 9 * * *` | L6 |
| `governance.resolution_watch` | `0 9 * * *` | O1 |
| `compliance.review` | `0 4 1 * *` | O2 |
| `analytics.daily` | `30 0 * * *` | P1 |
| `analytics.risk_scores` | `0 5 * * 1` | P2 |
| `forecast.monthly` | `0 3 2 * *` | P24, P25 |
| `forecast.wellbeing` | `0 6 * * 1` | P26 |
| `saas.billing` | `0 2 * * *` | Q1 |
| `comms.publish_scheduled_notices` | `*/10 * * * *` | M2 |
| `comms.provider_balance` | `0 * * * *` | M3 |
| `comms.weekly_digest` | `0 18 * * 6` | M5 |
| `welfare.behaviour_rules` | `0 2 * * *` | N2 |
| `platform.kpi_snapshot` | `0 0 * * *` | N9 |
| `platform.housekeeping` | `0 3 * * *` | N10 |
| `platform.backup` | `0 2 * * *` | N10 |
| `academic.syllabus_lag` | `0 8 * * 0` | B6 |
| `college.registration_watch` | `0 8 * * *` | R1 |
| `admissions.offer_expiry` | `0 * * * *` | A7 |
| `admissions.followup_reminders` | `0 9 * * *` | A2 |

---

## 15. Year-2+ modules (schema already in place)

| # | Module | Trigger | Automated action |
|---|---|---|---|
| P1 | SaaS | ⏰ trial ends −7d / 0d | Reminder to school owner; on expiry switch to read-only plan; usage metering monthly |
| P2 | SaaS | 🔒 subscription invoice paid | Plan features enabled, receipt, partner commission accrued |
| P3 | CMS | 🔒 notice/result/event published | Website sections update; sitemap regenerated; Facebook/WhatsApp share text drafted |
| P4 | Wallet/POS | 🔒 POS sale | Wallet debit, daily-limit check, guardian push with balance, journal (Dr wallet liability, Cr canteen income) |
| P5 | Wallet/POS | ⚙️ wallet balance < ৳100 | Top-up reminder with pay link |
| P6 | Co-curricular | 🔒 competition result entered | House points, achievement row, certificate of merit PDF, website news draft |
| P7 | Scholarships | ⏰ term start | Award instalments applied as discounts; donor impact report emailed |
| P8 | Events | 🔒 ticket paid | QR ticket PDF; check-in list; reminder −1 day; feedback survey after the event |
| P9 | Alumni | ⏰ year closed | Graduates copied to alumni with batch; welcome message; mentor invitation |
| P10 | Facilities | 🔒 work order created | Auto-assign by category; SLA by priority; vendor notified; expense on completion |
| P11 | Facilities | 🔒 room booking requested | Clash check; approval to facility manager; calendar entry |
| P12 | Governance | 🔒 meeting minutes saved | Resolutions become tasks with owners and due dates; reminders |
| P13 | Compliance | ⏰ census window | BANBEIS/board/MPO exports generated from live data; submission checklist tasks |
| P14 | Compliance | 🔒 data delete request | Anonymise per retention policy after approval; audit entry |
| P15 | Analytics | ⏰ weekly | Risk scores (dropout, fee default, result decline) refreshed; counsellor/accounts tasks for high risk |
| P16 | Analytics | ⏰ nightly | Anomaly detection on collection, attendance, SMS volume → alerts |
| P17 | AI | 🔒 marks locked | Draft teacher remarks per student for review; report narrative for principal |
| P18 | AI | 🔒 OCR job done (confidence ≥ 95%) | Marks/answers applied; below threshold → review task |
| P19 | AI | ⚙️ guardian WhatsApp message | Assistant answers from school data (attendance, dues, results) within policy; hands off to staff when unsure |
| P20 | Marketplace | 🔒 plugin installed | Hooks registered; settings validated; per-school billing line |
| P21 | Welfare+ | 🔒 safeguarding case opened | Restricted access, case owner notified, review reminder every 14 days |
| P22 | Assessment+ | 🔒 competency term closed | Competency report cards (NCTB format) rendered; guardians notified |
| P23 | Assessment+ | 🔒 board result imported | Student records updated; school summary; website result lookup enabled |
| P24 | Forecast | ⏰ monthly, after the billing run | Cash-flow projection for the next 3–6 months from this school's own collection rate; a projected shortfall raises a message with its assumptions, never an invoice |
| P25 | Forecast | ⏰ monthly | Staffing forecast from the published timetable and the leavers on record; subjects with periods nobody is timetabled to teach are listed with the count |
| P26 | Forecast | ⏰ weekly | Wellbeing early-warning scores refreshed into `risk_scores`; welfare involvement adds weight but never scores alone, and the alert never says what is in the record |
