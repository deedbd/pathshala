import { z } from 'zod';

// ---- primitives ----
export const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'invalid id');
export const localeSchema = z.enum(['bn', 'en']);
/** Bangladesh mobile: 01XXXXXXXXX, +8801XXXXXXXXX, 8801XXXXXXXXX → normalised to +8801XXXXXXXXX */
export const bdPhoneSchema = z.string().trim().transform(v => v.replace(/[\s-]/g, '')).pipe(z.string().regex(/^(\+?88)?01[3-9]\d{8}$/, 'invalid Bangladesh mobile number')).transform(v => '+88' + v.replace(/^\+?88/, ''));
export const emailSchema = z.string().trim().toLowerCase().email();
export const passwordSchema = z.string().min(8, 'at least 8 characters').max(128);
export const cronSchema = z.string().regex(/^(\S+\s+){4}\S+$/, 'cron needs 5 fields');

// ---- installer ----
export const installSchoolSchema = z.object({
  schoolName: z.string().trim().min(2).max(160),
  schoolNameBn: z.string().trim().max(160).optional().or(z.literal('')),
  schoolCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,12}$/, '2–12 letters or digits').optional().or(z.literal('')),
  institutionType: z.enum(['school', 'college', 'school_college', 'madrasa', 'kindergarten', 'coaching', 'university']).default('school'),
  locale: localeSchema.default('bn'),
  adminName: z.string().trim().min(2).max(160),
  adminPhone: bdPhoneSchema,
  adminEmail: emailSchema.optional().or(z.literal('')),
  adminPassword: passwordSchema,
});
export type InstallSchoolInput = z.infer<typeof installSchoolSchema>;

// ---- auth ----
export const loginSchema = z.object({
  identifier: z.string().trim().min(3).max(160),   // phone, email or username
  password: z.string().min(1).max(128),
  remember: z.coerce.boolean().optional(),
  totp: z.string().trim().regex(/^\d{6}$/).optional().or(z.literal('')),
  turnstile: z.string().optional(),
});
export const otpRequestSchema = z.object({
  target: z.string().trim().min(3).max(160),
  channel: z.enum(['sms', 'email']).default('sms'),
  purpose: z.enum(['login', 'verify', 'reset', 'invite', 'consent']).default('login'),
  turnstile: z.string().optional(),
});
export const otpVerifySchema = z.object({
  target: z.string().trim().min(3).max(160),
  code: z.string().trim().regex(/^\d{4,8}$/),
  purpose: z.enum(['login', 'verify', 'reset', 'invite', 'consent']).default('login'),
});

// ---- settings / custom fields ----
export const settingWriteSchema = z.object({ key: z.string().regex(/^[a-z0-9_.]{3,120}$/), value: z.unknown() });
export const customFieldSchema = z.object({
  entityType: z.string().regex(/^[a-z_]{2,60}$/),
  fieldKey: z.string().regex(/^[a-z0-9_]{2,60}$/),
  label: z.string().min(1).max(120),
  labelBn: z.string().max(120).optional(),
  fieldType: z.enum(['text', 'number', 'date', 'select', 'multiselect', 'bool', 'file', 'phone']),
  options: z.array(z.string()).optional(),
  isRequired: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  showInList: z.boolean().default(false),
});

// ---- automation ----
export const ruleActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('notify'), channel: z.enum(['sms', 'email', 'push', 'in_app']).optional(), to: z.enum(['actor', 'admins', 'role', 'user', 'guardians']).default('admins'), role: z.string().optional(), userId: ulidSchema.optional(), eventKey: z.string().optional(), title: z.string().optional(), body: z.string().optional(), note: z.string().optional() }),
  z.object({ type: z.literal('task'), title: z.string(), assignedRole: z.string().optional(), assignedTo: ulidSchema.optional(), dueInHours: z.number().optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), note: z.string().optional() }),
  z.object({ type: z.literal('job'), name: z.string(), queue: z.string().default('default'), payload: z.record(z.string(), z.unknown()).optional(), note: z.string().optional() }),
  z.object({ type: z.literal('webhook'), url: z.string().url(), note: z.string().optional() }),
  z.object({ type: z.literal('approval'), entityType: z.string(), workflowId: ulidSchema.optional(), note: z.string().optional() }),
  z.object({ type: z.literal('emit'), eventType: z.string(), payload: z.record(z.string(), z.unknown()).optional(), note: z.string().optional() }),
  z.object({ type: z.literal('document'), template: z.string(), note: z.string().optional() }),
]);
export const ruleSchema = z.object({
  name: z.string().min(2).max(160),
  module: z.string().max(40),
  description: z.string().optional(),
  triggerKind: z.enum(['event', 'schedule', 'threshold', 'manual']),
  eventType: z.string().max(80).optional().nullable(),
  cronExpr: cronSchema.optional().nullable(),
  conditions: z.unknown().optional().nullable(),   // JSONLogic
  actions: z.array(ruleActionSchema),
  isActive: z.boolean().default(true),
  priority: z.number().int().default(100),
  cooldownMinutes: z.number().int().min(0).optional().nullable(),
});
export type RuleAction = z.infer<typeof ruleActionSchema>;
export type RuleInput = z.infer<typeof ruleSchema>;

// ---- notifications ----
export const notifySchema = z.object({
  userId: ulidSchema.optional(),
  address: z.string().optional(),
  channels: z.array(z.enum(['sms', 'email', 'push', 'in_app'])).min(1),
  eventKey: z.string().max(80),
  data: z.record(z.string(), z.unknown()).default({}),
  title: z.string().max(200).optional(),
  body: z.string().optional(),
  entityType: z.string().optional(),
  entityId: ulidSchema.optional(),
  respectQuietHours: z.boolean().default(true),
});

// ---- phase 1: academic / people / timetable / cms ----
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const timeSchema = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'HH:MM');
const optionalText = (max = 160) => z.string().trim().max(max).optional().nullable().transform(v => v || null);
export const yearSchema = z.object({ name: z.string().trim().min(2).max(20), startDate: dateSchema, endDate: dateSchema, setCurrent: z.coerce.boolean().optional(), cloneFromYearId: ulidSchema.optional().nullable() });
export const classSchema = z.object({ name: z.string().trim().min(1).max(60), nameBn: optionalText(60), numericLevel: z.coerce.number().int().min(-5).max(20), stream: optionalText(40), programId: ulidSchema.optional().nullable() });
export const subjectSchema = z.object({ name: z.string().trim().min(1).max(120), nameBn: optionalText(120), code: z.string().trim().min(1).max(20), subjectType: z.enum(['theory', 'practical', 'both', 'activity']).optional(), isOptional: z.coerce.boolean().optional() });
export const sectionSchema = z.object({ academicYearId: ulidSchema, classId: ulidSchema, name: z.string().trim().min(1).max(40), capacity: z.coerce.number().int().min(1).max(500).optional(), shiftId: ulidSchema.optional().nullable(), roomId: ulidSchema.optional().nullable(), classTeacherId: ulidSchema.optional().nullable(), genderPolicy: z.enum(['mixed', 'boys', 'girls']).optional(), medium: z.enum(['bangla', 'english', 'arabic']).optional() });
export const classSubjectSchema = z.object({ academicYearId: ulidSchema, classId: ulidSchema, subjectId: ulidSchema, isCompulsory: z.coerce.boolean().optional(), fullMarks: z.coerce.number().optional(), passMarks: z.coerce.number().optional(), weeklyPeriods: z.coerce.number().int().min(0).max(20).optional(), sortOrder: z.coerce.number().int().optional() });
export const periodSchema = z.object({ name: z.string().trim().min(1).max(30), sequence: z.coerce.number().int().min(1), startTime: timeSchema, endTime: timeSchema, isBreak: z.coerce.boolean().optional() });
export const calendarEventSchema = z.object({ academicYearId: ulidSchema.optional().nullable(), title: z.string().trim().min(1).max(200), eventType: z.enum(['holiday', 'vacation', 'exam', 'event', 'ptm', 'deadline', 'meeting']), startDate: dateSchema, endDate: dateSchema, isHoliday: z.coerce.boolean().optional(), description: optionalText(2000) });
export const guardianSchema = z.object({ fullName: z.string().trim().min(2).max(160), phone: bdPhoneSchema, relation: z.enum(['father', 'mother', 'grandparent', 'sibling', 'uncle', 'aunt', 'legal_guardian', 'other']), email: optionalText(160), occupation: optionalText(80), isPrimary: z.coerce.boolean().optional(), paysFees: z.coerce.boolean().optional(), altPhone: optionalText(20), nidNo: optionalText(30) });
export const studentSchema = z.object({
  firstName: z.string().trim().min(1).max(80), lastName: optionalText(80), nameBn: optionalText(160), gender: z.enum(['male', 'female', 'other']), dateOfBirth: dateSchema,
  admissionNo: optionalText(30), admissionDate: dateSchema.optional(), academicYearId: ulidSchema.optional().nullable(), classId: ulidSchema, sectionId: ulidSchema.optional().nullable().or(z.literal('')).transform(v => v || null), rollNo: optionalText(10),
  bloodGroup: optionalText(5), religion: optionalText(30), birthCertificateNo: optionalText(30), presentAddress: z.unknown().optional(), previousSchool: z.unknown().optional(),
  guardians: z.array(guardianSchema).max(4).optional(), createAccounts: z.coerce.boolean().optional(),
});
export const staffSchema = z.object({
  firstName: z.string().trim().min(1).max(80), lastName: optionalText(80), nameBn: optionalText(160), gender: z.enum(['male', 'female', 'other']).optional().nullable(), dateOfBirth: dateSchema.optional().nullable(), phone: optionalText(20), email: optionalText(160),
  employeeNo: optionalText(30), joinDate: dateSchema.optional(), designationId: ulidSchema.optional().nullable(), departmentId: ulidSchema.optional().nullable(), staffCategory: z.enum(['teaching', 'non_teaching', 'admin', 'support']).optional(), employmentType: z.enum(['permanent', 'contract', 'part_time', 'intern', 'volunteer', 'mpo']).optional(),
  subjectIds: z.array(ulidSchema).optional(), createAccount: z.coerce.boolean().optional(), role: z.string().max(60).optional(),
});
export const slotSchema = z.object({ sectionId: ulidSchema, dayOfWeek: z.coerce.number().int().min(0).max(6), periodId: ulidSchema, classSubjectId: ulidSchema.optional().nullable(), teacherId: ulidSchema.optional().nullable(), roomId: ulidSchema.optional().nullable() });
export const generateSchema = z.object({ academicYearId: ulidSchema.optional().nullable(), versionName: z.string().max(80).optional(), days: z.array(z.number().int().min(0).max(6)).optional(), maxSamePerDay: z.number().int().min(1).max(4).optional(), seed: z.number().int().optional(), sectionIds: z.array(ulidSchema).optional() });
export const syllabusSchema = z.object({ classSubjectId: ulidSchema, title: z.string().trim().min(1).max(200), termId: ulidSchema.optional().nullable(), units: z.array(z.object({ title: z.string().trim().min(1).max(200), plannedPeriods: z.coerce.number().int().min(1).optional(), plannedEndDate: dateSchema.optional().nullable() })).min(1) });
export const lessonPlanSchema = z.object({ teacherId: ulidSchema, sectionId: ulidSchema, classSubjectId: ulidSchema, unitId: ulidSchema.optional().nullable(), planDate: dateSchema, topic: z.string().trim().min(1).max(200), objectives: optionalText(2000), activities: optionalText(4000), homework: optionalText(2000) });
export const pageBlockSchema = z.object({ type: z.enum(['hero', 'text', 'notices', 'admission_cta', 'gallery', 'contact', 'stats', 'results_lookup']), title: z.string().max(200).optional(), titleBn: z.string().max(200).optional(), body: z.string().max(20000).optional(), bodyBn: z.string().max(20000).optional(), image: z.string().max(500).optional().nullable(), cta: z.object({ label: z.string().max(80), labelBn: z.string().max(80).optional(), href: z.string().max(300) }).optional().nullable(), limit: z.number().int().min(1).max(50).optional() });
export const pageSchema = z.object({ title: z.string().trim().min(1).max(200), slug: z.string().max(120).optional(), locale: localeSchema.optional(), blocks: z.array(pageBlockSchema), seo: z.object({ description: z.string().max(300).optional(), image: z.string().max(500).optional() }).optional().nullable(), isHome: z.coerce.boolean().optional(), status: z.enum(['draft', 'published']).optional() });
export const noticeSchema = z.object({ title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(50000), noticeType: z.enum(['general', 'academic', 'exam', 'fee', 'holiday', 'urgent', 'event']).optional(), publishAt: z.string().optional().nullable(), expiresAt: z.string().optional().nullable(), isPinned: z.coerce.boolean().optional(), sendPush: z.coerce.boolean().optional() });
export const enquirySchema = z.object({ studentName: z.string().trim().min(2).max(160), guardianName: z.string().trim().min(2).max(160), phone: bdPhoneSchema, email: optionalText(160), classId: ulidSchema.optional().nullable().or(z.literal('')).transform(v => v || null), notes: optionalText(2000), turnstile: z.string().optional() });
export const contactSchema = z.object({ name: z.string().trim().min(2).max(160), phone: optionalText(30), email: optionalText(160), message: z.string().trim().min(5).max(4000), turnstile: z.string().optional() });

export { z };
