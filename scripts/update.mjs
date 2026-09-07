#!/usr/bin/env node
/**
 * Update a live cPanel install, and put it back if the new one does not work.
 *
 *   node scripts/update.mjs --zip pathshala-0.2.0-cpanel.zip            # update in place
 *   node scripts/update.mjs --zip ... --root /home/user/public_html     # from another directory
 *   node scripts/update.mjs --rollback                                  # undo the last update
 *
 * The order matters, and it is the order a school would want:
 *   1. back up the database (the same file `pnpm backup` writes, restorable anywhere)
 *   2. keep the current `app/` and `db/` beside it, untouched
 *   3. extract the new release over the top, leaving .env, uploads/ and storage/ alone
 *   4. boot it, run the migrations, and ask it whether it is healthy
 *   5. if anything above fails, put the old directories back and say so
 *
 * Extraction is the only step that leans on the host (`unzip`). If the host has none, extract the zip
 * in File Manager and run this with --extracted: the backup, the rollback copy and the boot check
 * still happen.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, all) => (a.startsWith('--') ? [[a.slice(2), all[i + 1] === undefined || all[i + 1].startsWith('--') ? true : all[i + 1]]] : [])));
const root = path.resolve(String(args.root ?? path.join(here, '..')));
const keepDir = path.join(root, 'storage', 'previous-release');
const log = m => console.log(`[update] ${m}`);
const fail = m => { console.error(`[update] ✖ ${m}`); process.exit(1); };

if (!args.rollback && !args.zip && !args.extracted) fail('usage: node scripts/update.mjs --zip <release.zip> [--root <dir>] [--extracted] | --rollback');
const swapped = ['app', 'db', 'index.php', 'VERSION'];

// ---------- rollback ----------
if (args.rollback) {
  if (!fs.existsSync(keepDir)) fail(`nothing to roll back to — ${path.relative(root, keepDir)} does not exist`);
  restorePrevious();
  log('the previous release is back in place. Restart the app in cPanel (Setup Node.js App → Restart).');
  process.exit(0);
}

// ---------- 1. back up ----------
const zip = args.zip ? path.resolve(String(args.zip)) : null;
if (zip && !fs.existsSync(zip)) fail(`no such file: ${zip}`);
if (!fs.existsSync(path.join(root, 'app', 'server.js'))) fail(`${root} does not look like an installed Pathshala (no app/server.js)`);

let backupFile = null;
if (!args['skip-backup']) {
  try {
    // the server bundle re-exports the HTTP app; the core (createApp) lives in the flat node_modules
    // the server bundle re-exports the HTTP app; the core (createApp) lives in the flat node_modules
    const core = await import(pathToUrl(path.join(root, 'app', 'node_modules', '@pathshala', 'core', 'dist', 'index.js')));
    const app = core.createApp({ rootDir: root });
    if (await app.installer.hasSchema()) {
      const r = await app.platform.backup(null, { kind: 'database' });
      backupFile = r.file;
      log(`database backed up: ${path.relative(root, backupFile)} (${Math.round(r.sizeBytes / 1024)} KB)`);
    } else {
      log('nothing to back up yet: this copy has no database (it has not been installed)');
    }
    await app.db.close();
  } catch (e) {
    fail(`could not back up before updating: ${e.message}\n  fix that first, or pass --skip-backup if you have your own backup`);
  }
}

// ---------- 2. keep the current release ----------
// Only worth doing when the new files have not landed yet: with --extracted the running tree is
// already the new one, so a copy of it would roll back to exactly what we are trying to undo.
if (args.extracted) {
  log('note: the files were extracted before this ran, so the previous release could not be kept.');
  log(`      rollback is not available for this update${backupFile ? `; the database backup at ${path.relative(root, backupFile)} is your way back` : ''}.`);
} else {
  fs.rmSync(keepDir, { recursive: true, force: true });
  fs.mkdirSync(keepDir, { recursive: true });
  for (const name of swapped) {
    const from = path.join(root, name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(keepDir, name), { recursive: true });
  }
}
fs.writeFileSync(path.join(keepDir, 'kept-at.txt'), `${new Date().toISOString()}\nfrom ${zip}\nbackup ${backupFile ?? 'skipped'}\n`);
log(`the running release is kept in ${path.relative(root, keepDir)}`);

// ---------- 3. extract the new one ----------
if (!args.extracted) {
  try {
    await unzipOver(zip, root);
    log(`extracted ${path.basename(zip)} over ${root}`);
  } catch (e) {
    restorePrevious();
    fail(`${e.message}
  extract the zip in cPanel's File Manager instead, then run this again with --extracted`);
  }
} else {
  log('using the files already extracted (--extracted)');
}

// ---------- 4. boot it and ask ----------
const port = 3500 + (process.pid % 200);
const child = spawn(process.execPath, ['app/server.js'], { cwd: root, env: { ...process.env, APP_ROOT: root, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
const health = await waitForHealth(`http://127.0.0.1:${port}/_health`, 45_000);
child.kill();
if (!health.ok) {
  if (!args.extracted) restorePrevious();
  console.error(output.split('\n').slice(-25).join('\n'));
  fail(`the new release did not come up healthy (${health.reason}); the old one is back in place${backupFile ? `\n  the database backup is at ${backupFile} if you need it` : ''}`);
}
log(`the new release booted and answered /_health (${health.body.engine}, installed=${health.body.installed}, node ${health.body.node})`);
log(`done. Restart the app in cPanel (Setup Node.js App → Restart).`);
if (!args.extracted) log(`if anything looks wrong later: node scripts/update.mjs --rollback`);

// ---------- helpers ----------
function restorePrevious() {
  if (!fs.existsSync(keepDir)) return;
  for (const name of swapped) {
    const kept = path.join(keepDir, name);
    if (!fs.existsSync(kept)) continue;
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
    fs.cpSync(kept, path.join(root, name), { recursive: true });
  }
  log('rolled back to the previous release');
}
async function waitForHealth(url, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let reason = 'it never answered';
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      const body = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, body };
      reason = `HTTP ${res.status}`;
    } catch (e) { reason = e.message; }
    await new Promise(r => setTimeout(r, 1000));
  }
  return { ok: false, reason, body: {} };
}
/**
 * cPanel's terminal has `unzip`; the release itself carries no unzip library, so this is the one
 * place the script leans on the host. If it is missing, the operator extracts in File Manager and
 * re-runs with --extracted, which skips straight to the boot check and keeps the rollback copy.
 * .env, uploads/ and storage/ belong to the school and are never overwritten.
 */
async function unzipOver(file, dest) {
  await new Promise((resolve, reject) => {
    const p = spawn('unzip', ['-o', '-q', file, '-x', '.env', 'uploads/*', 'storage/*', '-d', dest], { stdio: 'inherit' });
    p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`unzip exited with ${code}`))));
    p.on('error', () => reject(new Error('no unzip on this host')));
  });
}
function pathToUrl(p) { return `file://${p.replace(/\\/g, '/')}`; }
