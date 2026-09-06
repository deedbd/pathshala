#!/usr/bin/env node
/**
 * Boots the built release exactly as cPanel would (`node app/server.js` with APP_ROOT at the release
 * root) and drives the installer through it, so the zip is proven to run — not just to build.
 * Catches the failures a source-tree test cannot see: a runtime dependency missing from the flat
 * node_modules, a symlink cPanel would drop, a file the release script forgot to copy.
 *   node scripts/verify-release.mjs [release]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = path.resolve(root, process.argv[2] || 'release');
const port = 3399 + (process.pid % 100);
const log = m => console.log(`[verify] ${m}`);
const fail = m => { console.error(`[verify] ✖ ${m}`); process.exitCode = 1; throw new Error(m); };

if (!fs.existsSync(path.join(built, 'app', 'server.js'))) fail(`no release at ${built} — run pnpm release:cpanel first`);
// Work on a copy: a successful install rewrites .env, .htaccess and deletes install.php, and the
// built artifact must stay exactly as it will be zipped and uploaded.
const rel = path.join(root, 'tests', '.release-verify');
fs.rmSync(rel, { recursive: true, force: true });
fs.cpSync(built, rel, { recursive: true, filter: s => !/[\\/]pathshala-[^\\/]*\.zip$/.test(s) });
log(`verifying a copy of ${path.relative(root, built)} (as an extracted zip would be)`);
for (const f of ['install.php', 'index.php', 'db/schema.json', 'db/sqlite/schema.sql', 'db/mysql/schema.sql', 'db/seeds/automation_rules.json', 'app/web-build/server/index.js', 'app/dist/index.js', 'VERSION']) {
  if (!fs.existsSync(path.join(rel, f))) fail(`missing from the release: ${f}`);
}
fs.rmSync(path.join(rel, 'storage', 'sqlite'), { recursive: true, force: true });
fs.mkdirSync(path.join(rel, 'storage', 'sqlite'), { recursive: true });
fs.writeFileSync(path.join(rel, '.env'), [
  'APP_ENV=test', `APP_URL=http://127.0.0.1:${port}`, `PORT=${port}`, 'DB_ENGINE=sqlite', 'SQLITE_PATH=storage/sqlite/verify.db',
  'FONTS_DIR=app/node_modules/@pathshala/adapters/fonts', 'CRON_MODE=inprocess', 'LOG_LEVEL=warn', 'CRON_KEY=verify',
].join('\n') + '\n');

const child = spawn(process.execPath, ['app/server.js'], { cwd: rel, env: { ...process.env, APP_ROOT: rel }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
const base = `http://127.0.0.1:${port}`;
const api = async (p, body, method = body ? 'POST' : 'GET', cookie) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { fail(`${method} ${p} → ${r.status} non-JSON: ${text.slice(0, 160)}`); }
  if (!r.ok) fail(`${method} ${p} → ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return { j, r };
};

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { up = (await (await fetch(base + '/_health')).json()).ok; } catch { await new Promise(r => setTimeout(r, 500)); } }
  if (!up) fail(`the release did not start:\n${output.slice(0, 2000)}`);
  log(`booted from ${rel}/app/server.js on :${port}`);

  await api('/api/install/prepare', {});
  let steps = null;
  for (let i = 0; i < 90; i++) { steps = (await api('/api/install/status')).j.steps; if (steps.find(s => s.step === 'seeds')?.status === 'done') break; if (steps.some(s => s.status === 'failed')) fail(`installer step failed: ${JSON.stringify(steps)}`); await new Promise(r => setTimeout(r, 1000)); }
  if (steps.find(s => s.step === 'seeds')?.status !== 'done') fail(`schema/seeds did not finish: ${JSON.stringify(steps)}`);
  log('schema + seeds applied');

  const school = await api('/api/install/school', { schoolName: 'Release Verification', institutionType: 'school', locale: 'bn', adminName: 'Owner', adminPhone: '01799999999', adminEmail: 'owner@verify.test', adminPassword: 'verify-pass-1' });
  const cookie = school.r.headers.get('set-cookie')?.split(';')[0];
  if (!school.j.schoolId || !cookie) fail('school creation did not return a session');
  log(`school created (bcryptjs, numbering, presets, website): ${school.j.schoolId}`);

  // self-test exercises storage, scheduler, the automation relay and a real pdfmake render with the bundled Bangla font
  const self = await api('/api/install/selftest', {}, 'POST', cookie);
  if (!self.j.ok) fail(`self-test failed: ${JSON.stringify(self.j.checks)}`);
  log(`self-test passed: ${Object.keys(self.j.checks).join(', ')}`);

  // SheetJS must resolve from the flat tree and produce a real workbook
  const tpl = await fetch(base + '/api/import/template', { headers: { cookie } });
  const buf = Buffer.from(await tpl.arrayBuffer());
  if (tpl.status !== 200 || buf.subarray(0, 2).toString() !== 'PK' || buf.length < 4000) fail(`import template is not an xlsx (${tpl.status}, ${buf.length} bytes)`);
  log(`Excel template rendered (${buf.length} bytes)`);

  // the public website and the SSR console must render from web-build/
  for (const p of ['/site', '/login']) { const r = await fetch(base + p); const html = await r.text(); if (r.status !== 200 || !html.includes('<!DOCTYPE html>')) fail(`${p} → ${r.status} (${html.slice(0, 120)})`); }
  log('SSR pages render (/site, /login)');

  await api('/api/install/finish', {}, 'POST', cookie);
  log('installer finished · the zip is deployable');
} finally {
  const exited = new Promise(r => child.once('exit', r));
  child.kill();
  await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);   // Windows keeps the SQLite file locked until the child is gone
  try { fs.rmSync(rel, { recursive: true, force: true }); } catch { /* Windows may still hold the SQLite file; the next run replaces it */ }
  if (process.exitCode) console.error(output.slice(-4000));
}
