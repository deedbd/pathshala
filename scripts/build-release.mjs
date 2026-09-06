#!/usr/bin/env node
/**
 * Builds the cPanel release: a self-contained directory (and zip) that the owner uploads to public_html.
 *   node scripts/build-release.mjs [--out release] [--no-zip]
 * Requires `pnpm build` first. Layout (docs/HOSTING-CPANEL.md §1):
 *   .htaccess (written later by install.php) · index.php · install.php · .env.example
 *   app/        server.js, dist/, web-build/, node_modules/ (pure JS, prebuilt, workspace packages copied in), tmp/
 *   db/         mysql/ sqlite/ postgres/ migrations/ seeds/*.json schema.json
 *   uploads/    storage/   (empty, created so permissions are right)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'release';
const out = path.resolve(root, outArg);
const zip = !args.includes('--no-zip');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const sha = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(); } catch { return 'nogit'; } })();
const version = `${pkg.version}+${sha}`;
const log = m => console.log(`[release] ${m}`);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'app'), { recursive: true });

// 1. server + production node_modules with workspace packages physically copied (pnpm deploy)
log('pnpm deploy @pathshala/server → app/');
const deployDir = path.join(out, 'app');
try { execSync(`pnpm --filter @pathshala/server deploy --prod --legacy "${deployDir}"`, { cwd: root, stdio: 'inherit' }); }
catch { execSync(`pnpm --filter @pathshala/server deploy --prod "${deployDir}"`, { cwd: root, stdio: 'inherit' }); }
for (const f of ['tsconfig.json', 'src']) fs.rmSync(path.join(deployDir, f), { recursive: true, force: true });
fs.mkdirSync(path.join(deployDir, 'tmp'), { recursive: true });
fs.writeFileSync(path.join(deployDir, 'tmp', '.gitkeep'), '');

// 2. web build (React Router client + server bundles)
const webBuild = path.join(root, 'apps', 'web', 'build');
if (!fs.existsSync(path.join(webBuild, 'server', 'index.js'))) throw new Error('apps/web/build missing — run pnpm build first');
fs.cpSync(webBuild, path.join(deployDir, 'web-build'), { recursive: true });
log('web build copied');

// 3. db: generated schemas, migrations, seed json, model
for (const d of ['mysql', 'sqlite', 'postgres', 'migrations']) if (fs.existsSync(path.join(root, 'db', d))) fs.cpSync(path.join(root, 'db', d), path.join(out, 'db', d), { recursive: true, filter: s => !s.endsWith('.sh') && !/postgres[\\/]schema$/.test(s) });
fs.mkdirSync(path.join(out, 'db', 'seeds'), { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'db', 'seeds'))) if (f.endsWith('.json')) fs.copyFileSync(path.join(root, 'db', 'seeds', f), path.join(out, 'db', 'seeds', f));
fs.copyFileSync(path.join(root, 'db', 'schema.json'), path.join(out, 'db', 'schema.json'));

// 4. installer + env template + empty dirs
for (const f of ['install.php', 'index.php']) fs.copyFileSync(path.join(root, 'apps', 'installer', f), path.join(out, f));
if (fs.existsSync(path.join(root, '.env.example'))) fs.copyFileSync(path.join(root, '.env.example'), path.join(out, '.env.example'));
for (const d of ['uploads/logs', 'uploads/installer', 'uploads/backups', 'storage/sqlite']) { fs.mkdirSync(path.join(out, d), { recursive: true }); fs.writeFileSync(path.join(out, d, '.gitkeep'), ''); }
fs.writeFileSync(path.join(out, 'VERSION'), `${version}\n`);
fs.writeFileSync(path.join(out, 'README.txt'), `Pathshala ${version}\n\nUpload this folder's contents to public_html on cPanel, then open your domain.\nThe installer configures Node (Passenger), the database, cron and the first school by itself.\nSee docs/HOSTING-CPANEL.md in the repository for the fallback matrix.\n`);

// 5. sanity: no native packages
execSync(`node "${path.join(root, 'scripts', 'check-native.mjs')}" "${deployDir}"`, { stdio: 'inherit' });

// 6. zip
if (zip) {
  const zipName = `pathshala-${version.replace('+', '-')}-cpanel.zip`;
  const zipPath = path.join(path.dirname(out), zipName);
  const archiver = (await import('archiver')).default;
  await new Promise((resolve, reject) => {
    const outStream = fs.createWriteStream(zipPath);
    const a = archiver('zip', { zlib: { level: 9 } });
    outStream.on('close', resolve); a.on('error', reject);
    a.pipe(outStream);
    a.directory(out, false);
    a.finalize();
  });
  log(`zip: ${zipPath} (${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB)`);
  fs.renameSync(zipPath, path.join(out, zipName));
}
// 7. `pnpm deploy --legacy` rewrites the workspace's node_modules and drops the .bin shims (tsc, react-router…); restore them.
try { execSync('pnpm install --prefer-offline', { cwd: root, stdio: 'ignore' }); } catch { log('warning: pnpm install after deploy failed — run it by hand before building again'); }
log(`done → ${out} (version ${version})`);
