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
    'nav.academic': 'Academic', 'nav.students': 'Students', 'nav.staff': 'Staff', 'nav.import': 'Import', 'nav.timetable': 'Timetable', 'nav.syllabus': 'Syllabus', 'nav.calendar': 'Calendar', 'nav.website': 'Website',
    'common.new': 'New', 'common.save': 'Save', 'common.cancel': 'Cancel', 'common.search': 'Search', 'common.actions': 'Actions', 'common.none': 'None', 'common.loading': 'Loading…', 'common.saved': 'Saved', 'common.year': 'Academic year', 'common.class': 'Class', 'common.section': 'Section', 'common.subject': 'Subject', 'common.name': 'Name', 'common.phone': 'Phone', 'common.status': 'Status', 'common.date': 'Date', 'common.download': 'Download',
    'acad.years': 'Years', 'acad.classes': 'Classes', 'acad.subjects': 'Subjects', 'acad.sections': 'Sections', 'acad.matrix': 'Class subjects', 'acad.periods': 'Periods', 'acad.rooms': 'Rooms', 'acad.newYear': 'New academic year', 'acad.setCurrent': 'Make current', 'acad.preset': 'Add default classes & subjects', 'acad.capacity': 'Capacity', 'acad.enrolled': 'Enrolled', 'acad.weeklyPeriods': 'Periods / week', 'acad.level': 'Level',
    'stu.title': 'Students', 'stu.new': 'Admit student', 'stu.admissionNo': 'Admission no', 'stu.roll': 'Roll', 'stu.guardian': 'Guardian', 'stu.dob': 'Date of birth', 'stu.gender': 'Gender', 'stu.firstName': 'First name', 'stu.lastName': 'Last name', 'stu.nameBn': 'Name (Bangla)', 'stu.guardianName': 'Guardian name', 'stu.guardianPhone': 'Guardian mobile', 'stu.relation': 'Relation', 'stu.siblings': 'Siblings', 'stu.profile': 'Student profile',
    'staff.title': 'Staff', 'staff.new': 'Add staff', 'staff.employeeNo': 'Employee no', 'staff.category': 'Category', 'staff.designation': 'Designation', 'staff.subjects': 'Subjects taught', 'staff.joinDate': 'Join date',
    'imp.title': 'Import students from Excel', 'imp.purpose': 'Upload the template; rows with problems come back in an error file you can fix and re-upload.', 'imp.template': 'Download template', 'imp.upload': 'Upload .xlsx', 'imp.running': 'Importing…', 'imp.done': 'Import finished', 'imp.valid': 'valid rows', 'imp.invalid': 'rows with problems', 'imp.errorFile': 'Download error file', 'imp.history': 'Previous imports',
    'tt.title': 'Timetable', 'tt.purpose': 'Generate a clash-free timetable, adjust by hand, publish for teachers and guardians.', 'tt.generate': 'Generate', 'tt.publish': 'Publish', 'tt.versions': 'Versions', 'tt.clashes': 'Clashes', 'tt.placed': 'placed', 'tt.unplaced': 'unplaced', 'tt.published': 'Published', 'tt.draft': 'Draft', 'tt.substitutions': 'Substitutions', 'tt.suggest': 'Suggest substitutes', 'tt.teacherAbsent': 'Absent teacher',
    'syl.title': 'Syllabus & lesson plans', 'syl.new': 'New syllabus', 'syl.units': 'Units', 'syl.progress': 'Progress', 'syl.plan': 'Plan a lesson', 'syl.taught': 'Mark taught', 'syl.topic': 'Topic',
    'cal.title': 'Calendar', 'cal.new': 'Add event', 'cal.weekend': 'Weekly off days', 'cal.holiday': 'Holiday',
    'web.title': 'Website', 'web.purpose': 'The school site guardians and applicants see. Notices you publish here also go to the portal.', 'web.pages': 'Pages', 'web.notices': 'Notices', 'web.enquiries': 'Admission enquiries', 'web.newNotice': 'Publish notice', 'web.view': 'View site',
    'portal.children': 'My children', 'portal.notices': 'Notices', 'portal.timetable': 'Timetable', 'portal.events': 'Upcoming', 'portal.classTeacher': 'Class teacher', 'portal.today': 'Today',
    'site.admission': 'Admission enquiry', 'site.studentName': 'Student name', 'site.guardianName': 'Guardian name', 'site.send': 'Send', 'site.sent': 'Thank you — the admissions desk will call you.', 'site.contact': 'Contact', 'site.message': 'Message', 'site.classApplying': 'Class applying for',
    'day.0': 'Sun', 'day.1': 'Mon', 'day.2': 'Tue', 'day.3': 'Wed', 'day.4': 'Thu', 'day.5': 'Fri', 'day.6': 'Sat',
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
    'nav.academic': 'একাডেমিক', 'nav.students': 'শিক্ষার্থী', 'nav.staff': 'স্টাফ', 'nav.import': 'ইমপোর্ট', 'nav.timetable': 'রুটিন', 'nav.syllabus': 'সিলেবাস', 'nav.calendar': 'ক্যালেন্ডার', 'nav.website': 'ওয়েবসাইট',
    'common.new': 'নতুন', 'common.save': 'সংরক্ষণ', 'common.cancel': 'বাতিল', 'common.search': 'খুঁজুন', 'common.actions': 'কাজ', 'common.none': 'নেই', 'common.loading': 'লোড হচ্ছে…', 'common.saved': 'সংরক্ষিত', 'common.year': 'শিক্ষাবর্ষ', 'common.class': 'শ্রেণি', 'common.section': 'শাখা', 'common.subject': 'বিষয়', 'common.name': 'নাম', 'common.phone': 'মোবাইল', 'common.status': 'অবস্থা', 'common.date': 'তারিখ', 'common.download': 'ডাউনলোড',
    'acad.years': 'শিক্ষাবর্ষ', 'acad.classes': 'শ্রেণি', 'acad.subjects': 'বিষয়', 'acad.sections': 'শাখা', 'acad.matrix': 'শ্রেণিভিত্তিক বিষয়', 'acad.periods': 'পিরিয়ড', 'acad.rooms': 'কক্ষ', 'acad.newYear': 'নতুন শিক্ষাবর্ষ', 'acad.setCurrent': 'চলতি করুন', 'acad.preset': 'ডিফল্ট শ্রেণি ও বিষয় যোগ করুন', 'acad.capacity': 'ধারণক্ষমতা', 'acad.enrolled': 'ভর্তি', 'acad.weeklyPeriods': 'সাপ্তাহিক পিরিয়ড', 'acad.level': 'স্তর',
    'stu.title': 'শিক্ষার্থী', 'stu.new': 'শিক্ষার্থী ভর্তি', 'stu.admissionNo': 'ভর্তি নং', 'stu.roll': 'রোল', 'stu.guardian': 'অভিভাবক', 'stu.dob': 'জন্ম তারিখ', 'stu.gender': 'লিঙ্গ', 'stu.firstName': 'নাম', 'stu.lastName': 'পদবি', 'stu.nameBn': 'নাম (বাংলা)', 'stu.guardianName': 'অভিভাবকের নাম', 'stu.guardianPhone': 'অভিভাবকের মোবাইল', 'stu.relation': 'সম্পর্ক', 'stu.siblings': 'ভাইবোন', 'stu.profile': 'শিক্ষার্থীর প্রোফাইল',
    'staff.title': 'স্টাফ', 'staff.new': 'স্টাফ যোগ', 'staff.employeeNo': 'কর্মী নং', 'staff.category': 'ধরন', 'staff.designation': 'পদবি', 'staff.subjects': 'পড়ান যে বিষয়', 'staff.joinDate': 'যোগদান',
    'imp.title': 'এক্সেল থেকে শিক্ষার্থী ইমপোর্ট', 'imp.purpose': 'টেমপ্লেট আপলোড করুন; সমস্যাযুক্ত সারি এরর ফাইলে ফেরত আসবে, ঠিক করে আবার আপলোড করুন।', 'imp.template': 'টেমপ্লেট ডাউনলোড', 'imp.upload': '.xlsx আপলোড', 'imp.running': 'ইমপোর্ট চলছে…', 'imp.done': 'ইমপোর্ট শেষ', 'imp.valid': 'সঠিক সারি', 'imp.invalid': 'সমস্যাযুক্ত সারি', 'imp.errorFile': 'এরর ফাইল ডাউনলোড', 'imp.history': 'আগের ইমপোর্ট',
    'tt.title': 'রুটিন', 'tt.purpose': 'ক্ল্যাশমুক্ত রুটিন তৈরি করুন, হাতে ঠিক করুন, শিক্ষক ও অভিভাবকের জন্য প্রকাশ করুন।', 'tt.generate': 'তৈরি করুন', 'tt.publish': 'প্রকাশ', 'tt.versions': 'সংস্করণ', 'tt.clashes': 'ক্ল্যাশ', 'tt.placed': 'বসানো', 'tt.unplaced': 'বাকি', 'tt.published': 'প্রকাশিত', 'tt.draft': 'খসড়া', 'tt.substitutions': 'বদলি শিক্ষক', 'tt.suggest': 'বদলি প্রস্তাব', 'tt.teacherAbsent': 'অনুপস্থিত শিক্ষক',
    'syl.title': 'সিলেবাস ও পাঠ পরিকল্পনা', 'syl.new': 'নতুন সিলেবাস', 'syl.units': 'অধ্যায়', 'syl.progress': 'অগ্রগতি', 'syl.plan': 'পাঠ পরিকল্পনা', 'syl.taught': 'পড়ানো হয়েছে', 'syl.topic': 'বিষয়বস্তু',
    'cal.title': 'ক্যালেন্ডার', 'cal.new': 'ইভেন্ট যোগ', 'cal.weekend': 'সাপ্তাহিক ছুটি', 'cal.holiday': 'ছুটি',
    'web.title': 'ওয়েবসাইট', 'web.purpose': 'অভিভাবক ও আবেদনকারীরা যে সাইট দেখে। এখানে প্রকাশিত নোটিশ পোর্টালেও যায়।', 'web.pages': 'পেজ', 'web.notices': 'নোটিশ', 'web.enquiries': 'ভর্তির খোঁজ', 'web.newNotice': 'নোটিশ প্রকাশ', 'web.view': 'সাইট দেখুন',
    'portal.children': 'আমার সন্তান', 'portal.notices': 'নোটিশ', 'portal.timetable': 'রুটিন', 'portal.events': 'আসছে', 'portal.classTeacher': 'শ্রেণি শিক্ষক', 'portal.today': 'আজ',
    'site.admission': 'ভর্তির খোঁজ', 'site.studentName': 'শিক্ষার্থীর নাম', 'site.guardianName': 'অভিভাবকের নাম', 'site.send': 'পাঠান', 'site.sent': 'ধন্যবাদ — ভর্তি ডেস্ক আপনাকে ফোন করবে।', 'site.contact': 'যোগাযোগ', 'site.message': 'বার্তা', 'site.classApplying': 'কোন শ্রেণিতে',
    'day.0': 'রবি', 'day.1': 'সোম', 'day.2': 'মঙ্গল', 'day.3': 'বুধ', 'day.4': 'বৃহঃ', 'day.5': 'শুক্র', 'day.6': 'শনি',
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
