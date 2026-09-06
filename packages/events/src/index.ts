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
  // year-1 modules (payload shapes are filled in as each module ships; kept loose until then)
  'enquiry.created': Record<string, unknown>;
  'application.submitted': Record<string, unknown>;
  'applicant.enrolled': Record<string, unknown>;
  'academic_year.created': { academicYearId: string; previousYearId?: string | null };
  'calendar.holiday_added': { eventId: string; startDate: string; endDate: string };
  'leave.approved': Record<string, unknown>;
  'leave.rejected': Record<string, unknown>;
  'attendance.marked': Record<string, unknown>;
  'attendance.absent': { studentId: string; date: string; sectionId: string };
  'marks.locked': Record<string, unknown>;
  'result.published': Record<string, unknown>;
  'invoice.created': { invoiceId: string; studentId: string; total: number; dueDate: string };
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
  'enquiry.created', 'application.submitted', 'applicant.enrolled', 'academic_year.created', 'calendar.holiday_added', 'leave.approved', 'leave.rejected',
  'attendance.marked', 'attendance.absent', 'marks.locked', 'result.published', 'invoice.created', 'payment.received', 'payroll.approved', 'notice.published', 'message.sent', 'test.ping',
] as const satisfies readonly EventType[]);

export function isEventType(v: string): v is EventType {
  return (EVENT_TYPES as readonly string[]).includes(v);
}

/** Aggregate naming convention: `<module>.<entity>` for aggregateType (e.g. 'fees.invoice'). */
export const aggregate = (module: string, entity: string) => `${module}.${entity}`;
