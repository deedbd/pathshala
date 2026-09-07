/**
 * A school on this machine, with enough in it to look at.
 *
 * `pnpm demo` boots the built app against a throwaway SQLite file, installs a school the way the
 * installer would, fills a term's worth of ordinary days — students, staff, fees, attendance, a
 * notice, a few automations having run — and leaves the server up on :3999 with the login printed.
 * Nothing here is a fixture for a test: it exists so a person can open the console and see what the
 * school would see. Delete `storage/demo` and run it again for a clean one.
 *
 *   node scripts/demo.mjs [--port 3999] [--fresh]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const port = Number(arg('port', 3999));
const dir = path.join(root, 'storage', 'demo');
if (process.argv.includes('--fresh')) fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

Object.assign(process.env, {
  APP_ENV: 'development', APP_ROOT: root, APP_URL: `http://127.0.0.1:${port}`,
  APP_KEY: 'demo-key'.padEnd(64, 'd'), CRON_KEY: 'demo-cron',
  DB_ENGINE: 'sqlite', SQLITE_PATH: 'storage/demo/pathshala.db',
  UPLOADS_DIR: 'storage/demo/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse',
  CRON_MODE: 'inprocess', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts',
});
delete process.env.DB_URL;

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

const app = core.createApp({ rootDir: root });
await app.start();

const EMAIL = 'head@demo.school';
const PASSWORD = 'demo-pass-2026';
const day = n => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

// a fresh file has no tables at all, so the question cannot be asked until the schema is there
const installed = await app.installer.hasSchema();
let school = installed ? await app.db.findOne('schools', { code: 'DEMO' }) : null;
if (!school) {
  await app.installer.runPrepare();
  for (let i = 0; i < 120; i++) {
    const steps = (await app.installer.status()).steps;
    if (steps.find(x => x.step === 'seeds')?.status === 'done') break;
    if (steps.some(x => x.status === 'failed')) throw new Error(`installer failed: ${JSON.stringify(steps)}`);
    await new Promise(r => setTimeout(r, 500));
  }
  const made = await app.installer.createSchool({
    schoolName: 'Demo Model School', institutionType: 'school', locale: 'bn',
    adminName: 'Head Teacher', adminPhone: '01700000000', adminEmail: EMAIL, adminPassword: PASSWORD,
  });
  await app.installer.finish(made.schoolId);
  await app.db.execute(`UPDATE schools SET code = 'DEMO' WHERE id = ?`, [made.schoolId]);
  school = await app.db.findOne('schools', { id: made.schoolId });

  const sid = made.schoolId;
  const yearId = String((await app.academic.currentYear(sid)).id);
  const classes = await app.academic.classes(sid);
  const names = [
    ['Rahim', 'Uddin'], ['Karim', 'Hossain'], ['Sumaiya', 'Akter'], ['Nusrat', 'Jahan'], ['Tanvir', 'Ahmed'],
    ['Mim', 'Chowdhury'], ['Sabbir', 'Rahman'], ['Farhana', 'Yasmin'], ['Ishtiaq', 'Alam'], ['Nabila', 'Haque'],
    ['Sadia', 'Islam'], ['Rafi', 'Khan'], ['Jarin', 'Tasnim'], ['Emon', 'Sarker'], ['Lamia', 'Sultana'],
  ];
  const students = [];
  for (const [i, [first, last]] of names.entries()) {
    const cls = classes[3 + (i % 3)];
    students.push(await app.people.createStudent(sid, {
      firstName: first, lastName: last, gender: i % 2 ? 'female' : 'male', dateOfBirth: `201${3 + (i % 3)}-0${1 + (i % 8)}-1${i % 9}`,
      classId: String(cls.id),
      guardians: [{ fullName: `${last} (guardian)`, phone: `0181000${String(1000 + i)}`, relation: i % 3 ? 'father' : 'mother', isPrimary: true }],
    }));
  }
  for (const [i, [first, last]] of [['Mizanur', 'Rahman'], ['Shirin', 'Akter'], ['Kamal', 'Uddin'], ['Rokeya', 'Begum']].entries()) {
    await app.people.createStaff(sid, {
      firstName: first, lastName: last, gender: i % 2 ? 'female' : 'male', dateOfBirth: '1988-04-11',
      phone: `0191000${String(2000 + i)}`, joinDate: '2022-01-01', staffCategory: 'teaching',
    });
  }

  // three weeks of a register, so attendance, the KPI rows and the watch lists all have something real
  const section = (await app.academic.sections(sid, yearId, String(classes[3].id)))[0];
  const mine = students.filter((_, i) => i % 3 === 0);
  for (let back = 20; back >= 1; back--) {
    const on = day(-back);
    if ([5, 6].includes(new Date(`${on}T00:00:00Z`).getUTCDay())) continue;   // Friday and Saturday
    const marks = mine.map((st, i) => ({ studentId: st.id, status: back % 7 === 0 && i === 1 ? 'absent' : back % 5 === 0 && i === 2 ? 'late' : 'present' }));
    await app.attendance.markSection(sid, String(section.id), on, marks, null).catch(() => undefined);
  }

  // fees: a month billed, some of it paid, so neither the collected nor the outstanding figure is zero
  const head = await app.db.findOne('fee_heads', { school_id: sid, code: 'TUITION' });
  for (const cls of classes.slice(3, 6)) {
    await app.fees.createStructure(sid, { academicYearId: yearId, classId: String(cls.id), name: `${cls.name} fees`, items: [{ feeHeadId: String(head.id), amount: 1200, frequency: 'monthly', dueDay: 10 }] }).catch(() => undefined);
  }
  await app.fees.generateBatch(sid, { academicYearId: yearId, billingPeriod: `${day(0).slice(0, 7)}-01` }).catch(() => undefined);
  for (let i = 0; i < 4; i++) await app.tick({ budgetMs: 5000, maxJobs: 20 }).catch(() => undefined);
  const invoices = await app.db.findMany('invoices', { school_id: sid }, { limit: 20 });
  for (const inv of invoices.slice(0, Math.ceil(invoices.length * 0.6))) {
    await app.fees.recordPayment(sid, { studentId: String(inv.student_id), invoiceIds: [String(inv.id)], amount: Number(inv.total), method: 'cash', receivedBy: null }).catch(() => undefined);
  }

  await app.communication.broadcast(sid, { title: 'অভিভাবক সভা', body: 'আগামী বৃহস্পতিবার সকাল ১০টায় অভিভাবক সভা অনুষ্ঠিত হবে।', audience: { guardians: true }, channels: ['in_app'] }).catch(() => undefined);

  // let the automations that run on a tick actually run once, so the dashboard's feed is not empty
  for (let i = 0; i < 3; i++) await app.tick({ budgetMs: 4000, maxJobs: 20 }).catch(() => undefined);
  await app.analytics.computeDay(sid, day(0)).catch(() => undefined);
}

const { server } = await serverMod.createServer(app);
const listener = server.listen(port, '127.0.0.1', () => {
  const line = '─'.repeat(58);
  console.log(`\n${line}\n  Pathshala demo · http://127.0.0.1:${port}\n  sign in: ${EMAIL} / ${PASSWORD}\n  database: storage/demo/pathshala.db (delete it, or pass --fresh)\n${line}\n`);
});
serverMod.tuneKeepAlive(listener);
const stop = async () => { listener.close(); await app.stop(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
