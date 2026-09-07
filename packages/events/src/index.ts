/**
 * Event catalogue. Every domain change that other modules react to is one of these.
 * Producers write an `outbox_events` row in the same transaction as the change; the relay
 * publishes to consumers (system handlers, rule engine, webhooks). See docs/AUTOMATION.md.
 */
export interface EventEnvelope<T extends EventType = EventType> {
  uid: string;                 // outbox_events.event_uid (UUID) — consumers dedupe on it
  type: T;
  schoolId: string;
  aggregateType: string;
  aggregateId: string;
  payload: EventPayloads[T];
  actorUserId?: string | null;
  occurredAt: string;          // 'YYYY-MM-DD HH:MM:SS' UTC
  version: number;
}

export interface EventPayloads {
  // core / platform
  'school.created': { schoolId: string; name: string; code: string };
  'user.created': { userId: string; userType: string; phone?: string | null; email?: string | null; displayName: string };
  'user.invited': { userId: string; channel: 'sms' | 'email'; target: string };
  'user.logged_in': { userId: string; platform?: string | null; ip?: string | null };
  'user.locked': { userId: string; until: string };
  'settings.changed': { key: string; before: unknown; after: unknown };
  'file.uploaded': { fileId: string; entityType?: string | null; entityId?: string | null; purpose?: string | null };
  'installer.completed': { schoolId: string; engine: string; url: string };
  'rule.failed': { ruleId: string; ruleCode: string; attempts: number; error: string };
  'job.failed': { jobId: string; jobName: string; attempts: number; error: string };
  'task.created': { taskId: string; title: string; assignedTo?: string | null; assignedRole?: string | null; dueAt?: string | null };
  'approval.requested': { requestId: string; entityType: string; entityId: string; step: number; summary?: string | null };
  'approval.decided': { requestId: string; decision: 'approved' | 'rejected' | 'escalated' | 'auto_approved'; entityType: string; entityId: string };
  'notification.failed': { notificationId: string; channel: string; error: string };
  'backup.finished': { backupId: string; status: 'success' | 'failed'; sizeBytes?: number | null };
  'import.finished': { importJobId: string; entityType: string; successRows: number; errorRows: number };
  // phase 1: academic core, people, curriculum, cms
  'student.created': { studentId: string; admissionNo: string; classId: string; sectionId: string | null; guardianUserIds: string[] };
  'student.enrolled': { studentId: string; enrollmentId: string; academicYearId: string; classId: string; sectionId: string | null };
  'guardian.linked': { guardianId: string; studentId: string; phone: string; relation: string };
  'staff.created': { staffId: string; employeeNo: string; userId: string | null };
  'timetable.published': { versionId: string; academicYearId: string; slots: number };
  'substitution.suggested': { substitutionId: string; slotId: string; onDate: string; substituteTeacherId: string | null };
  'lesson.taught': { lessonPlanId: string; sectionId: string; classSubjectId: string; unitId: string | null };
  'syllabus.behind': { syllabusId: string; sectionId: string; pct: number; overdueUnits: number };
  'page.published': { pageId: string; slug: string; locale: string };
  'contact.received': { messageId: string; name: string; phone: string | null };
  // year-1 modules (payload shapes are filled in as each module ships; kept loose until then)
  'enquiry.created': { enquiryId: string; studentName: string; guardianName: string; phone: string; classId: string | null; source: string };
  'application.submitted': { applicationId: string; applicationNo: string; campaignId: string; classId: string; formFee: number; invoiceId: string | null };
  'applicant.enrolled': { applicationId: string; studentId: string; admissionNo: string; classId: string; academicYearId: string };
  'campaign.opened': { campaignId: string };
  'test.results_entered': { testId: string; campaignId: string; classId: string; results: number };
  'merit_list.generated': { campaignId: string; classId: string; ranked: number; shortlisted: number; waitlisted: number };
  'offer.made': { offerId: string; applicationId: string; amount: number; expiresAt: string };
  'book.issued': { issueId: string; memberId: string; copyId: string; dueAt: string };
  'book.returned': { issueId: string; bookId: string; fine: number; lost: boolean };
  'transport.assigned': { studentId: string; routeId: string; stopId: string; monthlyFee: number };
  'hostel.allocated': { allocationId: string; studentId: string; bedId: string; monthlyFee: number };
  'outpass.applied': { outpassId: string; studentId: string; expectedReturn: string };
  'po.received': { poId: string; grnId: string; value: number; assets: number };
  'incident.reported': { incidentId: string; studentId: string; points: number; severity: string };
  'course.published': { courseId: string; title: string; enrolled: number };
  'assignment.published': { assignmentId: string; sectionId: string; title: string; dueAt: string };
  'lesson.completed': { lessonId: string; courseId: string; studentId: string; watchedPct: number | null };
  'discussion.replied': { discussionId: string; threadId: string; courseId: string; lessonId: string | null; authorId: string | null };
  'assignment.similarity_flagged': { assignmentId: string; title: string; pairs: number; highestPct: number; checked: number };
  'revision_plan.built': { studentId: string; termId: string; indicators: number; covered: number; uncovered: number };
  'event.created': { eventId: string; title: string; startsAt: string };
  'complaint.created': { complaintId: string; ticketNo: string; category: string; priority: string; slaDueAt: string };
  'document.requested': { requestId: string; docType: string; eligible: boolean; blockers: string[] };
  'document.issued': { documentId: string; docType: string; documentNo: string; verificationCode: string };
  'academic_year.created': { academicYearId: string; previousYearId?: string | null };
  'calendar.holiday_added': { eventId: string; startDate: string; endDate: string };
  'leave.approved': { leaveId: string; applicantType: string; staffId: string | null; studentId: string | null; fromDate: string; toDate: string; dates: string[] };
  'leave.rejected': { leaveId: string };
  'substitution.approved': { substitutionId: string };
  'attendance.marked': { sectionId?: string; onDate: string; counts: Record<string, number>; source?: string };
  'attendance.absent': { studentId: string; date: string; sectionId: string };
  'leave.applied': { leaveId: string; applicantType: string; days: number };
  'punches.ingested': { deviceId: string; stored: number; resolved: number; unknown: number };
  'ptm.booked': { bookingId: string; slotId: string; studentId: string };
  'diary.published': { entryId: string; sectionId: string; entryType: string };
  'marks.locked': { scheduleId: string; examId: string };
  'result.published': { examId: string; name: string; students: number };
  'exam.scheduled': { examId: string; seated: number; ineligible: number };
  'promotion.applied': { fromYearId: string; toYearId: string; promoted: number; retained: number };
  'invoice.created': { invoiceId: string; studentId: string; total: number; dueDate: string };
  'invoice.batch_finished': { batchId: string; billingPeriod: string; invoices: number; total: number };
  'journal.posted': { entryId: string; entryNo: string; sourceType: string | null; total: number };
  'expense.created': { expenseId: string; amount: number; category: string; status: string };
  'discount.proposed': { discountId: string; studentId: string; kind: string };
  'payment.received': { paymentId: string; studentId: string; amount: number; method: string; invoiceIds?: string[] };
  'cheque.received': { paymentId: string; studentId: string; amount: number; reference: string };
  'cheque.cleared': { paymentId: string; amount: number; reference: string };
  'cheque.bounced': { paymentId: string; reason: string };
  'instalment_plan.created': { planId: string; studentId: string; count: number; total: number };
  'wallet.topped_up': { walletId: string; studentId: string; amount: number; balance: number };
  'pos.sold': { saleId: string; saleNo: string; outletId: string; studentId: string; total: number; paidBy: string };
  'shop.ordered': { orderId: string; orderNo: string; studentId: string; total: number };
  'scholarship.awarded': { awardId: string; fundId: string; studentId: string; amount: number; status: string };
  'donation.received': { donationId: string; donorId: string; amount: number; kind: string; campaignId: string };
  'alumni.graduated': { batchId: string; graduationYear: number; classId: string; alumni: number };
  'competition.results_recorded': { competitionId: string; name: string; results: number };
  'work_order.raised': { workOrderId: string; title: string; category: string; priority: string; dueAt: string };
  'work_order.done': { workOrderId: string; cost: number; expenseId: string };
  'meeting.minuted': { meetingId: string; resolutions: number };
  'policy.published': { policyId: string; title: string; version: number };
  'election.closed': { electionId: string; title: string; winners: string; votes: number };
  'govt_report.generated': { reportId: string; reportType: string; period: string };
  'data_request.made': { requestId: string; userId: string; kind: string };
  'anomaly.detected': { metricKey: string; expected: number; actual: number; severity: string };
  'risk.flagged': { studentId: string; riskType: string; score: number; why: string };
  // year 4/5 forecasting — figures for a person to read, never an instruction. `why` on a wellbeing
  // risk carries the measurable reasons only; nothing confidential ever reaches an event payload,
  // because a payload is what a webhook and an automation rule get to see.
  'forecast.cash_projected': { horizonMonths: number; collectionRate: number | null; projectedNet: number; shortfallMonths: number; worstMonth: string | null };
  'forecast.staffing_gap': { asOf: string; subjects: number; uncoveredPeriods: number; teachersNeeded: number };
  'broadcast.sent': { noticeId: string; title: string; recipients: number; channels: string };
  'subscription.changed': { subscriptionId: string; plan: string; status: string; price: number };
  'saas_invoice.raised': { invoiceId: string; invoiceNo: string; total: number; periodStart: string };
  'plugin.installed': { installId: string; slug: string; version: string };
  'group.created': { groupId: string; name: string; schools: number };
  'student.transferred': { transferId: string; studentId: string; fromSchoolId: string; toSchoolId: string; toStudentId: string; admissionNo: string; dues: number };
  'course.registered': { studentId: string; termId: string; programId: string | null; courses: number; credits: number };
  'course.sold': { courseId: string; studentId: string; planId: string; total: number; instalments: number };
  'program.completed': { programId: string; studentId: string; creditsEarned: number; cgpa: number; certificateId: string };
  'ai.generated': { generationId: string; kind: string; cost: number };
  'ivr.call_received': { callId: string; phone: string; known: boolean; children: number };
  'ivr.callback_requested': { callId: string; phone: string; guardianId: string; studentId: string | null };
  'payroll.calculated': { runId: string; month: string; staff: number; gross: number; net: number; approvalStatus: string };
  'payroll.approved': { runId: string; month: string };
  'payroll.paid': { runId: string; amount: number; journalEntryId: string };
  'staff.joined': { staffId: string; userId: string | null };
  'staff.left': { staffId: string; exitId: string; lastWorkingDay: string; settlement?: Record<string, unknown> };
  'application.received': { applicantId: string; postingId: string; title: string; name: string };
  'notice.published': { noticeId: string; title: string; audience?: unknown };
  'message.sent': Record<string, unknown>;
  'test.ping': { at: string; note?: string };
  // operations watches: everything below is raised by a scheduled job that found work nobody had
  // picked up. None of them acts on its own — each says what is waiting and for whom. A payload is
  // what a webhook and an automation rule get to see, so nothing confidential travels in one: the
  // safeguarding row carries the fact of a case and its age, never a word of what is in it.
  'payroll.approval_due': { runId: string; month: string; staff: number; net: number; payDay: string };
  'staff.settlement_due': { staffId: string; exitId: string; lastWorkingDay: string; net: number };
  'meeting.minutes_overdue': { meetingId: string; title: string; heldAt: string };
  'policy.unacknowledged': { policyId: string; title: string; version: number; pending: number };
  'consent.expired': { consentId: string; userId: string; consentType: string; expiredAt: string };
  'safeguarding.review_due': { caseId: string; riskLevel: string; daysOpen: number };
  'vehicle.unfit': { vehicleId: string; registrationNo: string; reasons: string; forDate: string };
  'hostel.rollcall_missing': { hostelId: string; onDate: string; call: string; residents: number };
  'stock.below_reorder': { itemId: string; sku: string; name: string; quantity: number; reorderLevel: number; purchaseOrderId: string | null };
  'gate_pass.outstanding': { passId: string; personType: string; expectedIn: string | null; kind: string };
}

export type EventType = keyof EventPayloads;

export const EVENT_TYPES = Object.freeze([
  'school.created', 'user.created', 'user.invited', 'user.logged_in', 'user.locked', 'settings.changed', 'file.uploaded', 'installer.completed',
  'rule.failed', 'job.failed', 'task.created', 'approval.requested', 'approval.decided', 'notification.failed', 'backup.finished', 'import.finished',
  'student.created', 'student.enrolled', 'guardian.linked', 'staff.created', 'timetable.published', 'substitution.suggested', 'lesson.taught', 'syllabus.behind', 'page.published', 'contact.received',
  'enquiry.created', 'application.submitted', 'applicant.enrolled', 'campaign.opened', 'test.results_entered', 'merit_list.generated', 'offer.made', 'document.requested', 'document.issued', 'book.issued', 'book.returned', 'transport.assigned', 'hostel.allocated', 'outpass.applied', 'po.received', 'complaint.created', 'incident.reported', 'course.published', 'assignment.published', 'event.created', 'academic_year.created', 'calendar.holiday_added', 'leave.approved', 'leave.rejected', 'attendance.marked', 'attendance.absent', 'leave.applied', 'punches.ingested', 'ptm.booked', 'diary.published', 'substitution.approved', 'marks.locked', 'result.published', 'exam.scheduled', 'promotion.applied', 'invoice.created', 'invoice.batch_finished', 'journal.posted', 'expense.created', 'discount.proposed', 'payment.received', 'cheque.received', 'cheque.cleared', 'cheque.bounced', 'instalment_plan.created', 'wallet.topped_up', 'pos.sold', 'shop.ordered', 'scholarship.awarded', 'donation.received', 'alumni.graduated', 'competition.results_recorded', 'work_order.raised', 'work_order.done', 'meeting.minuted', 'policy.published', 'election.closed', 'govt_report.generated', 'data_request.made', 'anomaly.detected', 'risk.flagged', 'broadcast.sent', 'subscription.changed', 'saas_invoice.raised', 'plugin.installed', 'ai.generated', 'group.created', 'student.transferred', 'payroll.calculated', 'payroll.approved', 'payroll.paid', 'staff.joined', 'staff.left', 'application.received', 'notice.published', 'message.sent', 'test.ping', 'forecast.cash_projected', 'forecast.staffing_gap', 'ivr.call_received', 'ivr.callback_requested', 'course.registered', 'course.sold', 'program.completed', 'lesson.completed', 'discussion.replied', 'assignment.similarity_flagged', 'revision_plan.built',
  'payroll.approval_due', 'staff.settlement_due', 'meeting.minutes_overdue', 'policy.unacknowledged', 'consent.expired', 'safeguarding.review_due', 'vehicle.unfit', 'hostel.rollcall_missing', 'stock.below_reorder', 'gate_pass.outstanding',
] as const satisfies readonly EventType[]);

export function isEventType(v: string): v is EventType {
  return (EVENT_TYPES as readonly string[]).includes(v);
}

/** Aggregate naming convention: `<module>.<entity>` for aggregateType (e.g. 'fees.invoice'). */
export const aggregate = (module: string, entity: string) => `${module}.${entity}`;
