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
  'application.submitted': Record<string, unknown>;
  'applicant.enrolled': Record<string, unknown>;
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
  'payroll.approved': Record<string, unknown>;
  'notice.published': { noticeId: string; title: string; audience?: unknown };
  'message.sent': Record<string, unknown>;
  'test.ping': { at: string; note?: string };
}

export type EventType = keyof EventPayloads;

export const EVENT_TYPES = Object.freeze([
  'school.created', 'user.created', 'user.invited', 'user.logged_in', 'user.locked', 'settings.changed', 'file.uploaded', 'installer.completed',
  'rule.failed', 'job.failed', 'task.created', 'approval.requested', 'approval.decided', 'notification.failed', 'backup.finished', 'import.finished',
  'student.created', 'student.enrolled', 'guardian.linked', 'staff.created', 'timetable.published', 'substitution.suggested', 'lesson.taught', 'syllabus.behind', 'page.published', 'contact.received',
  'enquiry.created', 'application.submitted', 'applicant.enrolled', 'academic_year.created', 'calendar.holiday_added', 'leave.approved', 'leave.rejected',
  'attendance.marked', 'attendance.absent', 'leave.applied', 'punches.ingested', 'ptm.booked', 'diary.published', 'substitution.approved', 'marks.locked', 'result.published', 'exam.scheduled', 'promotion.applied', 'invoice.created', 'invoice.batch_finished', 'journal.posted', 'expense.created', 'discount.proposed', 'payment.received', 'payroll.approved', 'notice.published', 'message.sent', 'test.ping',
] as const satisfies readonly EventType[]);

export function isEventType(v: string): v is EventType {
  return (EVENT_TYPES as readonly string[]).includes(v);
}

/** Aggregate naming convention: `<module>.<entity>` for aggregateType (e.g. 'fees.invoice'). */
export const aggregate = (module: string, entity: string) => `${module}.${entity}`;
