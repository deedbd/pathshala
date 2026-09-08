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
| A10 | ⏰ daily 07:00 | campaign requires a test and an application has no seat | Allocate the test seat and issue the admit card — A4 only fires on a form-fee payment, so a free admission never reached it | `admission_applications`, `issued_documents` |
| A11 | ⏰ daily 07:00 | interview or mixed selection, free slots, applicant with no interview | Book the next free slot and tell the guardian the time; when the slots run out the office is told once | `admission_interviews`, `notifications` |
| A12 | ⏰ daily 07:00 | campaign closed, applicants still unranked | Compute the merit list where the campaign asks for it, otherwise tell the admissions desk it is ready to draw; render the notice-board PDF once per class | `admission_applications`, `files` |
| A13 | ⏰ daily 07:00 | offer unpaid, expires within 2 days | One SMS to the guardian before the place is lost — never a daily one | `notifications` |
| A14 | ⏰ daily 07:00 | offered applicant missing a required document | Tell the office once a week which papers are missing, by name | `notifications` |
| A15 | ⏰ daily 07:00 | shortlisted applicants and the campaign does not offer automatically | Everything around the offer is done — ranked, seats counted, sheet rendered — and the desk is told once that it is one button away. An offer is a promise to a family, so a person makes it | `notifications` |

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
| B8 | ⏰ daily 07:30 | a class-subject with no teacher a week into the year; a clean draft version whose `effective_from` has passed | Assign the empty section-subjects by subject preference then lightest load (never over an existing assignment) and raise a task for what nobody in the school teaches; a clean draft is **prepared, not published** — one task and one message say it is ready | `section_subject_teachers`, `tasks`, `notifications` |
| B9 | ⏰ daily 04:00 | current year ends within 30 days and no later year exists | Create next year (dates shifted by a year, class-subject matrix and section skeletons cloned) as `planned`; which year is *current* stays a person’s decision | `academic_years`, `class_subjects`, `sections` |
| B10 | ⏰ daily 06:30 | a teacher the register marks absent today has periods in the published timetable | Suggest cover for each period (free that period, teaches the subject, lowest load); status stays `suggested` for a person to approve — B3 without a leave form | `timetable_substitutions` |

## 3. Attendance & leave

| # | Trigger | Condition | Automated action | Tables |
|---|---|---|---|---|
| C1 | 🔒 `punch.received` | identifier resolves | Upsert daily attendance: present / late (policy minutes); first punch = check-in, last = check-out | `student_attendance`, `staff_attendance` |
| C2 | ⚙️ `attendance.marked` | status late, `notify_on_late` | SMS/push to guardians: "arrived 08:47, 17 min late" | `notifications` |
| C3 | ⚙️ `attendance.marked` | status present, `notify_on_arrival` | Arrival push (SMS optional) | `notifications` |
| C4 | ⏰ half-hourly | no row for active student, not holiday, no approved leave, **and that child’s own policy cut-off has passed in the school’s timezone** | Mark `absent` (source system); SMS guardian; stamp `guardian_notified_at` | `student_attendance`, `notifications` |
| C4b | 🔒 `calendar.holiday_added` (B5) | the range covers days already marked | Rows the system wrote itself become `holiday`; a mark a teacher made by hand is left alone; scheduled online classes in the range are cancelled | `student_attendance`, `staff_attendance`, `online_classes` |
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
| D2b | ⏰ the night before | seat plan exists; the roll has changed or a blocked candidate has cleared their reason | Top the plan up rather than rebuild it: new students seated, cleared candidates made eligible and their cards issued. Nothing already eligible is withdrawn — turning a child away at the hall door is the office’s decision, with a name on it | `exam_seat_plans`, `issued_documents` |
| D3 | ⚙️ marks entry deadline −2d | schedules with missing marks | Reminder to subject teachers; escalation to exam controller at deadline | `notifications`, `tasks` |
| D3b | ⏰ at `marks_entry_deadline` | every mark of a paper is in | Lock that paper; papers still short go to the office once as a task naming class, subject and the count — not the same message every morning | `marks`, `exam_schedules.marks_entry_locked`, `tasks` |
| D4 | 🔒 marks `submitted` | — | Validate ranges vs `full_marks`; compute total, grade, GP from `grading_bands`; flag anomalies (e.g. 0 with not absent) | `marks` |
| D5 | 🔒 all schedules `locked` | — | **Result engine**: per student total, %, GPA (credit-weighted, F ⇒ GPA 0 when board rule on), pass/fail, rank in section & class (ties per setting), attendance %; write `exam_results`; tabulation sheet PDF | `exam_results`, `report_snapshots` |
| D5b | ⏰ daily 20:00 | exam ended and every paper has a mark for every child on the roll | **Compute** the results. Deterministic and invisible to guardians until somebody publishes, so it needs no confirmation; the exam moves to `processing` | `exam_results` |
| D6 | ⚙️ `result.computed` | `exams.publish_at` reached or `auto_publish` | Publish; report card PDF per student; SMS "GPA 4.83, rank 5" + app link; teacher remark placeholder tasks before publish | `exam_results.published_at`, `issued_documents`, `notifications` |
| D6b | ⏰ daily 20:00 | results computed, nothing published | **Prepared, confirmed by a person**: one task carrying what is still outstanding (papers short of marks, papers not locked, students with no result) and what publishing does — report cards and a GPA in every guardian’s SMS, which cannot be unsent | `tasks`, `notifications` |
| D6c | ⏰ hourly | `exams.publish_at` has arrived, or a published exam has results with no report card | Publish (the date was the person’s decision); re-queue the chunked render for report cards the batch never reached — the renderer skips every result that already has a file | `exam_results.published_at`, `issued_documents`, `notifications` |
| D7 | ⚙️ `result.published` | GPA drop ≥ 1.0 vs previous exam | Refer to counsellor; notify class teacher | `counselling_sessions`, `tasks` |
| D8 | ⚙️ `result.published` | GPA ≥ scheme `auto_rule.min_gpa` | Propose merit scholarship discount | `student_discounts (is_auto)` |
| D9 | 🔒 online exam `ends_at` | — | Auto-submit open attempts; auto-grade MCQ/true-false; queue manual grading for others; sync to `marks` if linked | `online_exam_attempts`, `marks` |
| D10 | ⏰ year-end (year `closed`) | `promotion_rules` | Weighted annual GPA; promote / retain / graduate; create next-year enrollments; graduates → `alumni`; notify guardians; trigger B1 for fees | `promotions`, `student_enrollments`, `alumni` |
| D10b | ⏰ daily 05:00, last 30 days of the year | published exam results exist | Recompute the weighted annual result nightly; **prepare** the promotion as a dry run and raise one task with the promoted/retained counts. Nothing moves until somebody applies it | `annual_results`, `tasks`, `notifications` |

## 5. LMS

| # | Trigger | Condition | Automated action | Tables |
|---|---|---|---|---|
| E1 | ⚙️ `assignment.published` | — | Push to students & guardians of the section | `notifications` |
| E2 | ⏰ hourly | `due_at − 24h`, not submitted | Reminder to student; stamp `reminder_sent_at` | `notifications` |
| E3 | 🔒 `due_at` passed | — | Mark late submissions; apply `late_penalty_pct` on grading; grading-pending task for teacher after 3 days | `assignment_submissions.is_late`, `tasks` |
| E3b | ⏰ daily 09:30 | due 3+ days ago with submissions still ungraded | One task to the teacher who set it, naming the assignment and the count; an assignment that refuses late work is closed, one that allows it stays open | `tasks`, `assignments.status` |
| E4 | ⚙️ `online_class.starting` (−15 min) | — | Push with join link; create meeting via Zoom/Meet API if missing | `online_classes.join_url`, `notifications` |
| E5 | 🔒 platform webhook (participant joined/left) | — | Write `online_class_attendance`; feed period attendance | `online_class_attendance`, `student_period_attendance` |
| E6 | 🔒 player heartbeat on a video lesson | watched ≥ 85% of `duration_min` (a beat may add at most 3 min; seeking never counts) | Complete the lesson; roll the course percentage up; emit `lesson.completed` | `lesson_progress`, `course_enrollments` |
| E7 | 🔒 similarity check on an assignment | ≥ 2 text answers of ≥ 40 words | Word-shingle similarity between every pair; store the highest per submission; ask the teacher to read the closest pairs — never a mark, never a penalty, never a word to a guardian | `assignment_submissions.similarity_pct`, `notifications` |
| E8 | ⏰ weekly | indicators not met this term | Revision plan per child: the indicators still to meet, weakest first, and the lessons/quizzes/materials on that syllabus unit; an indicator nothing covers is named as a gap instead of getting a made-up recommendation | `notifications` |

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
| F14 | ⏰ daily 07:00 | money that has stopped moving | Receipts nobody printed are issued; a cheque past its clearing window becomes one task for accounts (only the bank knows what happened, so a person clears or bounces it); a till left open overnight becomes a task for its cashier (the counted cash is not in the database); an instalment plan whose billed instalment went unpaid becomes a task; a discount whose `valid_to` has passed is expired; a batch nobody finished is re-queued and a month never billed is billed (never on the 1st, never for a school that has not billed before); a fee head with no income account becomes a task | `payments.receipt_file_id`, `tasks`, `student_discounts`, `invoice_batches` |
| F15 | ⏰ monthly 1st 07:00 | — | Receivables ageing (not due / 30 / 60 / 90 / older) to accounts and the head — once a month, whatever the scheduler does | `notifications` |
| F16 | 🔒 cash session closed | `variance ≠ 0` | Say so at the counter, to accounts and the head, the moment it is counted | `notifications` |
| F17 | 🔒 invoice batch finished | — | `invoice.batch_finished`; accounts is told how many invoices and how much, so nobody opens the page to check | `invoice_batches`, `notifications` |

## 7. Accounting

| # | Trigger | Condition | Automated action | Tables |
|---|---|---|---|---|
| G1 | 🔒 any of: payment, refund, payroll paid, expense paid, PO received, other income | — | Balanced journal entry auto-posted (DB trigger rejects unbalanced) | `journal_entries`, `journal_lines` |
| G2 | 🔒 `expense.requested` | amount > category threshold | Approval workflow; else auto-approve | `approval_requests` |
| G3 | ⚙️ `journal.posted` | spend ≥ `budgets.alert_at_pct` | Budget alert to principal/treasurer | `notifications` |
| G4 | ⏰ monthly 1st | — | Trial balance and income statement for the month just ended, kept as a snapshot whose id is derived from the month (a second run finds its own row), and sent to accounts and the head; a trial balance that does not balance says so in the message | `report_snapshots`, `notifications` |
| G5 | ⏰ fiscal year end | — | Lock period; carry balances; open new fiscal year — **prepared only**: the month-end job raises one task when a year's last day has passed, because closing a year cannot be undone | `tasks`, `fiscal_years` |
| G6 | ⏰ daily 07:30 | — | An expense approved but never posted is posted (the approval was the human step); a budget past its alert threshold becomes one task; bank lines are re-matched and whatever is left over becomes one task per account; a posted entry whose sides disagree becomes an urgent task — `post()` cannot make one, so it came from outside the application | `expenses`, `journal_entries`, `bank_statement_lines`, `tasks` |
| G7 | 🔒 `approval.decided` | entity is an expense | Approved expense posts Dr expense, Cr cash/bank at once | `expenses`, `journal_entries` |

## 8. HR & payroll

| # | Trigger | Condition | Automated action | Tables |
|---|---|---|---|---|
| H1 | ⏰ `payroll.run_day` monthly | — | **Draft payroll**: per staff structure + attendance (present/LOP/lates) + approved leave + loans + tax slab + overtime; totals; approval request | `payroll_runs`, `payslips`, `approval_requests` |
| H2 | 🔒 `payroll.approved` | — | Payslip PDFs; bank bulk-transfer file; journal (Dr salary expense, Cr bank, Cr PF/tax payable); SMS/push to staff; loan balances reduced | `payslips`, `files`, `journal_entries`, `staff_loans` |
| H3 | ⏰ daily | contract `end_date − 30d`; probation end reached **or already passed** | Alert HR; one open task per contract or probation, not one a night | `tasks`, `notifications` |
| H4 | ⏰ daily | `staff_documents.expires_at − 30d`, and papers that have already expired | Reminder to the member of staff themselves + one task for HR naming the document | `notifications`, `tasks` |
| H5 | 🔒 `staff.joined` | — | User account + role by designation, ID card job, biometric enrol task, salary structure task, welcome email | `users`, `id_cards`, `tasks` |
| H6 | 🔒 `staff.left` | — | Deactivate user, revoke sessions, final settlement (leave encashment, loan recovery), reassign timetable slots → substitution needed | `users`, `auth_sessions`, `timetable_substitutions` |
| H7 | ⚙️ appraisal cycle opens | — | Pre-fill `auto_metrics` (attendance %, syllabus completion, class result average) | `staff_appraisals` |
| H8 | ⏰ daily | birthday / work anniversary | Greeting (staff & students) | `notifications` |
| H9 | ⏰ daily | run `calculated` and the pay day (`hr.pay_day`, 28th) has passed | **Prepared, confirmed by a person**: the run is complete to the last taka; one task and one message a fortnight name the month, the head count and the net, and approving it is one button. A run stuck in `draft` had its calculation lost and is queued again | `tasks`, `notifications`, `background_jobs` |
| H10 | ⏰ daily | `staff_exits.last_working_day` passed and status ≠ `settled` | **Prepared, confirmed by a person**: leave encashment, provident fund, gratuity and loan recovery are all computed and named in one task with the net. Settling posts the journal and closes the account, so it stays a button | `tasks`, `notifications` |
| H11 | 🔒 `staff.joined` | leave types exist for staff | Accrue this year's leave balances at once, instead of leaving a mid-month joiner with no leave until the 1st | `leave_balances` |

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
| J7 | ⏰ daily | insurance/fitness/tax/permit expiring in 30d; maintenance due by date | One open task per vehicle per paper (not one a night) | `tasks` |
| J8 | 🔒 `student_transport` created | — | Route fee joins monthly invoicing (F1) | `invoice_items` |
| J9 | ⏰ daily 17:00 | tomorrow: an active route with riders whose vehicle has no driver, is off the road, or has expired papers | Name the routes and the reason to the transport manager, once for that date, with a task. Nothing is cancelled and no driver is reassigned — who drives is a decision about people | `tasks`, `notifications` |
| J10 | ⏰ daily | a vehicle paper whose date has **already** passed | Called expired rather than dropping out of the 30-day window; urgent task to renew it or take the vehicle off the road | `tasks` |

## 11. Hostel

| # | Trigger | Condition | Automated action | Tables |
|---|---|---|---|---|
| K1 | 🔒 bed allocated | — | Bed status; hostel fee joins invoicing; guardian notified | `hostel_beds`, `invoice_items` |
| K2 | 🔒 outpass applied | — | Guardian consent request (app) → warden approval; QR pass | `hostel_outpasses`, `approval_requests` |
| K3 | ⏰ every 15 min | `expected_return + curfew_alert_minutes` passed, not back | Alert warden + guardian | `hostel_outpasses.late_alert_sent_at` |
| K4 | ⏰ nightly after roll call | absent in night roll call, no outpass | Alert warden + guardian | `notifications` |
| K5 | ⚙️ complaint logged | category maintenance | Task to maintenance; SLA 48h | `tasks` |
| K6 | ⏰ 1st of the month 03:00 | per-meal billing is on | Bill last month's meals at the rate each was taken at; a student already billed is skipped | `meal_records`, `invoices` |
| K7 | ⏰ nightly 22:30 | a hostel with residents has no `night` roll call marked for today; a room holding more residents than its capacity | Tell the warden and the office once for that night (K4 only fires when the call *is* taken, so a warden who forgets produced no alert at all); over-capacity rooms become one task — nobody is moved automatically | `notifications`, `tasks` |
| L6 | ⏰ daily 09:00 | work order past the deadline its priority set | Chase the person holding it and the office, at most every other day; overdue safety drills are named once a fortnight and become a task | `work_orders`, `safety_drills`, `tasks` |
| L8 | ⏰ daily 09:00 | a cleaning round past its frequency | One open task per area (`cleaningDue` existed and nothing called it); marking the area done closes it | `cleaning_schedules`, `tasks` |
| O1 | ⏰ daily 09:00 | a resolution's due date has passed | Remind its owner (or the office if it has none) once a week; an election past its closing time counts itself | `resolutions`, `elections` |
| O2 | ⏰ monthly | records older than a retention rule, or a return generated a fortnight ago and still unsent | Report what retention would touch — never delete — and name the unsent returns, with a task so it is chased rather than read | `retention_policies`, `govt_reports`, `tasks` |
| O3 | ⏰ daily 09:00 | a meeting held 3 days ago with no minutes; a policy published a fortnight ago that people have not acknowledged | Task to write the minutes up; the people still missing are reminded **by name**, once a fortnight, and the office gets the list | `meetings`, `policy_documents`, `tasks` |
| O4 | ⏰ daily 04:00 | a data request outstanding; consent whose `expires_at` has passed | An **export** is produced entirely by the system and is fulfilled and handed over automatically. A **delete or correct** is escalated on the statutory clock (`compliance.response_days`, 30) and never carried out this way — a school has records it must keep. Expired consent: the guardian is asked once to renew it and the office is told what lapsed | `data_requests`, `consent_records`, `notifications` |
| O5 | ⏰ monthly | the census window (`compliance.census_months`, July) or a stipend period falling due | **Prepared, submitted by a person**: the return is built from the live register and a task names what to check before it goes. Submitting it is on a portal this system does not talk to | `govt_reports`, `tasks` |
| P1 | ⏰ daily 00:30 | a metric departs from this school's own recent median by more than three deviations | One open alert per metric (never a daily duplicate) to the office, with the usual figure beside the actual one | `metric_values`, `kpi_daily`, `anomaly_alerts` |
| P2 | ⏰ weekly | attendance, fees and results together put a student above the risk threshold | Name the student to their class teacher once, with the reasons — not a score on its own | `risk_scores`, `notifications` |
| Q1 | ⏰ daily 02:00 | a subscription is a fortnight from its end, or an invoice is past its due date | Raise the next invoice; mark the overdue ones and pause new students and messages — never access to what the school already has | `saas_invoices`, `saas_subscriptions` |

## 12. Inventory & assets

| # | Trigger | Condition | Automated action | Tables |
|---|---|---|---|---|
| L1 | 🔒 stock movement | qty < `reorder_level` | Draft PO with preferred vendor & `reorder_qty`; notify store keeper | `purchase_orders (is_auto)` |
| L2 | 🔒 PO received | — | Stock-in movements; expense + journal; asset rows for asset categories with QR tags | `stock_movements`, `expenses`, `assets` |
| L3 | 🔒 issue request approved | — | Stock-out movements to staff/room | `stock_movements` |
| L4 | ⏰ daily | maintenance `next_due_date` (including dates already passed) / warranty expiring | One open task per service record, not one a night; an overdue service is called overdue instead of dropping out of the window | `tasks` |
| L5 | 🔒 clinic visit with medicines | — | Stock-out from clinic store | `stock_movements` |
| L7 | ⏰ daily 07:00 | any item at or below its reorder level, whether or not anything moved | The same two roads L1 takes — draft PO with the preferred vendor, or a task naming the shortfall — for the cases L1 misses: a reorder level raised afterwards, an auto order somebody cancelled, an item sitting at zero because nothing has moved it. The draft still waits for approval | `purchase_orders (is_auto)`, `tasks` |

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
| N13 | ⏰ daily 20:00 | a visitor badge with no out time; a gate pass past its `expected_in` with no return | Named to the office once for that day, with a task. **Nothing is closed automatically**: writing an out time the system invented would turn the one record a school produces after a fire into fiction. The guardian is not messaged — the office finds out what happened first | `visitor_logs`, `gate_passes`, `tasks` |
| N14 | ⏰ daily | a safeguarding case open for 14 days | Review reminder to the case owner (the principal when it has none), then every fortnight. It carries the risk level and how long it has been open and **never the category or a word of the case** — the details are encrypted and only the owner decrypts them. The event payload carries the same three facts, for the same reason | `notifications`, `tasks` |
| N15 | ⏰ daily | a counselling follow-up date passed with no later session; a special-needs plan past its review date; an insurance policy inside 30 days of lapsing | One open task each, to the counsellor, the coordinator and the office | `tasks` |
| N13 | ⏰ hourly | a scheduled job failed or is more than 6 h overdue | Name the jobs that have stopped, once every three days — a job that throws otherwise writes `failed` into its own row and tells nobody | `notifications`, `outbox_events` |
| N14 | ⏰ hourly | a job in the seed catalogue has no row for this school | Create it: seeds run when a school is provisioned, so an update would otherwise ship automations nothing ever calls | `scheduled_jobs` |
| N15 | ⏰ hourly | events unpublished for 30 min, or a consumer that gave up after 5 attempts | Say the automation queue has stalled and how many events it is holding | `notifications` |
| N16 | ⏰ hourly | messages queued and unsent for 30 min | Queue them again (a lost delivery job is repaired, not reported); tell the office only when 100+ are stuck | `notifications`, `background_jobs` |
| N17 | ⏰ hourly | uploads over the warning size, or under 200 MB free on the host | One warning before the disk fills — on shared hosting a full disk takes the whole site down | `system_health`, `notifications` |
| N18 | ⏰ nightly 02:00 | the backup ran | Read the file back before trusting it (gunzip, header, row count); a backup that fails is told to the office, and a school with no good backup for 48 h is told again | `backups`, `system_health` |
| N19 | ⏰ daily | a plugin webhook failed 10 times in a row, or a school webhook 20 | Switch it off and say so — never retry somebody else's dead server for ever | `plugin_installs`, `webhooks` |

---

## Scheduled jobs (seed for `scheduled_jobs`)

| job_key | cron (Asia/Dhaka) | Rows above |
|---|---|---|
| `attendance.auto_absent` | `0,30 * * * 0-4` | C4 |
| `attendance.refresh_summary` | `0 1 * * *` | C11 |
| `attendance.monthly_threshold` | `0 7 1 * *` | C6 |
| `leave.accrue` | `5 0 1 * *` | C10 |
| `fees.generate_invoices` | `0 6 1 * *` | F1 |
| `fees.reminders` | `0 8 * * *` | F3 |
| `fees.instalments_due` | `0 6 * * *` | F13 |
| `fees.overdue_and_fines` | `30 0 * * *` | F4 |
| `fees.day_end_summary` | `0 18 * * *` | F10 |
| `fees.money_watch` | `0 7 * * *` | F14 |
| `fees.receivables_ageing` | `0 7 1 * *` | F15 |
| `accounting.daily_watch` | `30 7 * * *` | G6 |
| `accounting.month_end` | `30 3 1 * *` | G4, G5 |
| `commerce.day_close` | `0 19 * * *` | P27 |
| `giving.daily` | `0 8 * * *` | P28 |
| `payroll.draft_run` | `0 9 25 * *` | H1 |
| `hr.expiry_alerts` | `0 8 * * *` | H3, H4 |
| `hr.pending_actions` | `0 10 * * *` | H9, H10 |
| `exams.pre_exam_prep` | `0 7 * * *` | D2 |
| `exams.marks_deadline_reminders` | `0 9 * * *` | D3 |
| `lms.assignment_reminders` | `0 * * * *` | E2 |
| `adaptive.revision_plans` | `0 6 * * 6` | E8 |
| `library.due_and_fines` | `0 7 * * *` | I2, I3 |
| `transport.create_trips` | `0 5 * * 0-4` | J1 |
| `transport.delay_watch` | `*/5 * * * *` | J4 |
| `transport.document_expiry` | `0 8 * * *` | J7, J10 |
| `transport.readiness` | `0 17 * * *` | J9 |
| `hostel.curfew_watch` | `*/15 * * * *` | K3 |
| `hostel.mess_billing` | `0 3 1 * *` | K6 |
| `hostel.night_watch` | `30 22 * * *` | K7 |
| `inventory.maintenance_due` | `0 8 * * *` | L4 |
| `inventory.reorder_sweep` | `0 7 * * *` | L7 |
| `frontoffice.sla_escalation` | `0 * * * *` | N8 |
| `frontoffice.gate_watch` | `0 20 * * *` | N13 |
| `facilities.sla_watch` | `0 9 * * *` | L6, L8 |
| `governance.resolution_watch` | `0 9 * * *` | O1, O3 |
| `compliance.review` | `0 4 1 * *` | O2, O5 |
| `compliance.daily_watch` | `0 4 * * *` | O4 |
| `welfare.followups` | `0 6 * * *` | N14, N15 |
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
| `academic.year_rollover` | `0 4 * * *` | B9 |
| `timetable.cover_today` | `30 6 * * 0-4` | B10 |
| `timetable.watch` | `30 7 * * *` | B8 |
| `exams.auto_compute` | `0 20 * * *` | D5b, D6b |
| `exams.publish_due` | `10 * * * *` | D6c |
| `exams.year_end` | `0 5 * * *` | D10b |
| `lms.marking_backlog` | `30 9 * * *` | E3b |
| `college.registration_watch` | `0 8 * * *` | R1 |
| `college.term_watch` | `0 9 * * *` | R2 |
| `admissions.offer_expiry` | `0 * * * *` | A7 |
| `admissions.followup_reminders` | `0 9 * * *` | A2 |
| `admissions.campaign_watch` | `0 7 * * *` | A10–A15 |
| `platform.watchdog` | `15 * * * *` | N13–N17 |
| `analytics.benchmarks` | `0 4 2 * *` | P28 |
| `groups.consolidate` | `30 1 * * *` | P29 |
| `marketplace.health` | `0 3 * * *` | N19, P31 |
| `ai.budget_watch` | `0 9 * * *` | P32 |
| `ivr.line_watch` | `0 9 * * 6` | P33 |
| `alumni.job_board` | `0 8 * * *` | P34 |
| `cms.scheduled_publish` | `*/10 * * * *` | P35 |
| `platform.domain_watch` | `0 6 * * *` | P36 |

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
| P27 | Wallet/POS | ⏰ daily 19:00 | Each outlet's day book to accounts, once for that outlet and that date; a wallet under the school's low-balance mark tells the guardian at most once a week; an order paid for and still not handed over after three days becomes one task. Nothing tops a wallet up — moving a family's money without them asking is not automation |
| P28 | Scholarships | ⏰ daily 08:00 | An appeal past the closing date the school itself set is closed, and one that reached its goal is reported once; money received with no receipt gets its receipt; a pledge unpaid for 30 days and an award still active after its academic year ended each become one task, because chasing a donor and taking a discount off a child are people's decisions |
| R1 | College | ⏰ a week into every semester | Students carrying less than half a load are chased, once per family per day, whichever run finds them |
| R2 | College | ⏰ daily | A term that closed with registrations still `registered` goes to the registrar by name — nobody may be graded automatically; and a per-term load over the programme's ceiling (the ceiling moved, not the register) is flagged without unwinding anything |
| P27 | Analytics | ⏰ nightly | Days the heartbeat never woke for are computed from the register (up to a fortnight back) before anything is compared against them, and an alert whose metric is back inside the usual range closes itself |
| P28 | Analytics | ⏰ monthly | Cohort benchmark quartiles built for the whole installation by its founding school — they were only ever built when somebody called the endpoint |
| P29 | Groups | ⏰ nightly | Per head school, through the same gate a request goes through: refresh the members' own daily rows, then say which school sent no figures and which currency has no rate. Nothing is recomputed and no total is invented |
| P30 | SaaS | ⏰ daily | A trial with a week left is announced, one that ends moves to `past_due` (new work stops, records never do), an unpaid invoice is chased at 7, 14 and 30 days, a plan at nine tenths of its student or SMS limit is flagged, and a reseller's closed-month commission is put in front of the owner to pay |
| P31 | Marketplace | ⏰ daily | An integration that has stopped working is switched off and named — a plugin after 10 consecutive webhook failures, a school's own webhook after 20 |
| P32 | AI | ⏰ daily | At nine tenths of the monthly cap the school is told once; drafting pauses at the cap, and the questions answered from its own rows keep working |
| P33 | IVR | ⏰ weekly | A configured voice line with no call in seven days is reported once — the guardians who use it are the least likely to ring and say it is broken |
| P34 | Alumni | ⏰ daily | A job post is closed on the date its author set, and they are told three days before rather than discovering it by accident |
| P35 | CMS | ⏰ every 10 min | A page or post whose author set a go-live date is published on it; a website message unanswered for two days, and a custom domain with no certificate after three, are reported once |
| P36 | Tenancy | ⏰ daily | Every school with a web address of its own is looked up: does the hostname resolve, does it reach this installation, is the certificate valid. Only a **change** of state reaches the vendor — a domain that stopped pointing here, one that started, or a certificate that went bad. A domain nobody has pointed yet is not news, and the same finding is never repeated nightly |
