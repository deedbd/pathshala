export type Locale = 'bn' | 'en';

const dict = {
  en: {
    'app.name': 'Pathshala',
    'nav.dashboard': 'Dashboard', 'nav.automation': 'Automation', 'nav.settings': 'Settings', 'nav.logout': 'Sign out',
    'login.title': 'Sign in', 'login.identifier': 'Phone, email or username', 'login.password': 'Password', 'login.submit': 'Sign in', 'login.otp': 'Sign in with a code instead', 'login.totp': 'Authenticator code', 'login.failed': 'Wrong phone/email or password',
    'install.title': 'Set up Pathshala', 'install.subtitle': 'One form. Everything else is automatic.', 'install.preparing': 'Preparing the database…', 'install.schema': 'Database schema', 'install.seeds': 'Default data', 'install.school': 'School & admin', 'install.selftest': 'Self-test', 'install.done': 'Finish',
    'install.schoolName': 'School name', 'install.schoolNameBn': 'School name (Bangla)', 'install.type': 'Institution type', 'install.adminName': 'Your name', 'install.adminPhone': 'Your mobile', 'install.adminEmail': 'Email (optional)', 'install.adminPassword': 'Password', 'install.create': 'Create school', 'install.runSelfTest': 'Run self-test', 'install.finish': 'Open dashboard', 'install.locale': 'Default language',
    'dash.welcome': 'Welcome', 'dash.students': 'Students', 'dash.openTasks': 'Open tasks', 'dash.pendingApprovals': 'Pending approvals', 'dash.automationRuns': 'Automation runs (24h)', 'dash.recent': 'Recent automation activity', 'dash.empty': 'Nothing has happened yet. When people or rules act, it shows here.',
    'auto.title': 'Automation', 'auto.purpose': 'What the system did on its own, and what it will do next.', 'auto.runs': 'Rule runs', 'auto.jobs': 'Background jobs', 'auto.scheduled': 'Scheduled jobs', 'auto.rules': 'Rules', 'auto.mode': 'Scheduler mode', 'auto.tick': 'Run due jobs now', 'auto.nextRun': 'Next run', 'auto.lastRun': 'Last run', 'auto.status': 'Status',
    'status.success': 'success', 'status.failed': 'failed', 'status.pending': 'pending', 'status.running': 'running', 'status.skipped': 'skipped', 'status.preview': 'preview', 'status.done': 'done',
    'lang.switch': 'বাংলা',
  },
  bn: {
    'app.name': 'পাঠশালা',
    'nav.dashboard': 'ড্যাশবোর্ড', 'nav.automation': 'অটোমেশন', 'nav.settings': 'সেটিংস', 'nav.logout': 'সাইন আউট',
    'login.title': 'সাইন ইন', 'login.identifier': 'মোবাইল, ইমেইল বা ইউজারনেম', 'login.password': 'পাসওয়ার্ড', 'login.submit': 'সাইন ইন', 'login.otp': 'কোড দিয়ে সাইন ইন করুন', 'login.totp': 'অথেনটিকেটর কোড', 'login.failed': 'মোবাইল/ইমেইল বা পাসওয়ার্ড ভুল',
    'install.title': 'পাঠশালা সেটআপ', 'install.subtitle': 'একটি ফর্ম। বাকি সব স্বয়ংক্রিয়।', 'install.preparing': 'ডেটাবেজ তৈরি হচ্ছে…', 'install.schema': 'ডেটাবেজ স্কিমা', 'install.seeds': 'ডিফল্ট ডেটা', 'install.school': 'স্কুল ও অ্যাডমিন', 'install.selftest': 'সেলফ-টেস্ট', 'install.done': 'শেষ',
    'install.schoolName': 'স্কুলের নাম', 'install.schoolNameBn': 'স্কুলের নাম (বাংলা)', 'install.type': 'প্রতিষ্ঠানের ধরন', 'install.adminName': 'আপনার নাম', 'install.adminPhone': 'আপনার মোবাইল', 'install.adminEmail': 'ইমেইল (ঐচ্ছিক)', 'install.adminPassword': 'পাসওয়ার্ড', 'install.create': 'স্কুল তৈরি করুন', 'install.runSelfTest': 'সেলফ-টেস্ট চালান', 'install.finish': 'ড্যাশবোর্ড খুলুন', 'install.locale': 'ডিফল্ট ভাষা',
    'dash.welcome': 'স্বাগতম', 'dash.students': 'শিক্ষার্থী', 'dash.openTasks': 'খোলা কাজ', 'dash.pendingApprovals': 'অনুমোদন বাকি', 'dash.automationRuns': 'অটোমেশন রান (২৪ ঘণ্টা)', 'dash.recent': 'সাম্প্রতিক অটোমেশন', 'dash.empty': 'এখনও কিছু ঘটেনি। কেউ বা কোনো রুল কাজ করলে এখানে দেখা যাবে।',
    'auto.title': 'অটোমেশন', 'auto.purpose': 'সিস্টেম নিজে কী করেছে, আর পরে কী করবে।', 'auto.runs': 'রুল রান', 'auto.jobs': 'ব্যাকগ্রাউন্ড জব', 'auto.scheduled': 'নির্ধারিত জব', 'auto.rules': 'রুল', 'auto.mode': 'শিডিউলার মোড', 'auto.tick': 'বকেয়া জব এখন চালান', 'auto.nextRun': 'পরবর্তী রান', 'auto.lastRun': 'শেষ রান', 'auto.status': 'অবস্থা',
    'status.success': 'সফল', 'status.failed': 'ব্যর্থ', 'status.pending': 'অপেক্ষমাণ', 'status.running': 'চলছে', 'status.skipped': 'বাদ', 'status.preview': 'প্রিভিউ', 'status.done': 'সম্পন্ন',
    'lang.switch': 'English',
  },
} as const;

export type MessageKey = keyof typeof dict.en;

export function t(key: MessageKey, locale: Locale = 'bn', vars?: Record<string, string | number>): string {
  let s: string = (dict[locale] as Record<string, string>)[key] ?? dict.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(new RegExp(`{${k}}`, 'g'), String(v));
  return s;
}
export const messages = dict;

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
export function formatNumber(n: number | string, locale: Locale = 'bn', numerals: 'bn' | 'en' = locale): string {
  const s = typeof n === 'number' ? n.toLocaleString('en-IN') : String(n);
  return numerals === 'bn' ? s.replace(/\d/g, d => BN_DIGITS[Number(d)]) : s;
}
export function formatMoney(n: number, locale: Locale = 'bn', numerals: 'bn' | 'en' = locale): string {
  return '৳' + formatNumber(Math.round(n * 100) / 100, locale, numerals);
}
export function formatDate(d: Date | string | null | undefined, locale: Locale = 'bn', opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d.includes('T') || d.endsWith('Z') ? d : d.replace(' ', 'T') + 'Z') : d;
  if (Number.isNaN(date.getTime())) return String(d);
  return new Intl.DateTimeFormat(locale === 'bn' ? 'bn-BD' : 'en-GB', { timeZone: 'Asia/Dhaka', ...opts }).format(date);
}
export function formatDateTime(d: Date | string | null | undefined, locale: Locale = 'bn'): string {
  return formatDate(d, locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
