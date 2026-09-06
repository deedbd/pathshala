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

export { z };
