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
import { createRequire } from 'node:module';
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

/*
 * 1. app/ = server bundle + a FLAT node_modules.
 * pnpm's own layout is symlink-based and cPanel's File Manager does not restore symlinks when it
 * extracts a zip, so the tree is built with npm (hoisted, no symlinks) from the union of every
 * workspace package's external dependencies; the workspace packages themselves are copied in.
 */
const deployDir = path.join(out, 'app');
const WORKSPACE = ['db', 'events', 'schemas', 'adapters', 'core'];   // runtime packages; ui/web are bundled by Vite
const readPkg = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const serverPkg = readPkg(path.join(root, 'apps', 'server', 'package.json'));
const deps = {};
const addDeps = d => { for (const [name, ver] of Object.entries(d ?? {})) { if (name.startsWith('@pathshala/')) continue; if (deps[name] && deps[name] !== ver) throw new Error(`version conflict for ${name}: ${deps[name]} vs ${ver}`); deps[name] = ver; } };
addDeps(serverPkg.dependencies);
for (const w of WORKSPACE) addDeps(readPkg(path.join(root, 'packages', w, 'package.json')).dependencies);

fs.mkdirSync(deployDir, { recursive: true });
fs.writeFileSync(path.join(deployDir, 'package.json'), JSON.stringify({ name: 'pathshala-app', version: pkg.version, private: true, type: 'module', main: 'server.js', dependencies: Object.fromEntries(Object.entries(deps).sort()) }, null, 2) + '\n');
fs.copyFileSync(path.join(root, 'apps', 'server', 'server.js'), path.join(deployDir, 'server.js'));
fs.cpSync(path.join(root, 'apps', 'server', 'dist'), path.join(deployDir, 'dist'), { recursive: true });
log(`npm install (${Object.keys(deps).length} production packages, flat tree)`);
execSync('npm install --omit=dev --no-audit --no-fund --ignore-scripts --no-package-lock', { cwd: deployDir, stdio: 'inherit' });
// workspace packages: build output + manifest (and the bundled PDF fonts)
for (const w of WORKSPACE) {
  const src = path.join(root, 'packages', w); const dst = path.join(deployDir, 'node_modules', '@pathshala', w);
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(path.join(src, 'dist'), path.join(dst, 'dist'), { recursive: true });
  const m = readPkg(path.join(src, 'package.json'));
  delete m.devDependencies; delete m.scripts;
  m.dependencies = Object.fromEntries(Object.entries(m.dependencies ?? {}).filter(([n]) => !n.startsWith('@pathshala/')));
  fs.writeFileSync(path.join(dst, 'package.json'), JSON.stringify(m, null, 2) + '\n');
  if (fs.existsSync(path.join(src, 'fonts'))) fs.cpSync(path.join(src, 'fonts'), path.join(dst, 'fonts'), { recursive: true });
}
fs.rmSync(path.join(deployDir, 'node_modules', '.bin'), { recursive: true, force: true }); // shims are symlinks and nothing runs them
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

// 5. sanity: no native packages, no symlinks (cPanel's zip extractor drops them), every runtime import resolves
execSync(`node "${path.join(root, 'scripts', 'check-native.mjs')}" "${deployDir}"`, { stdio: 'inherit' });
const links = [];
(function findLinks(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isSymbolicLink()) links.push(path.relative(out, p)); else if (e.isDirectory()) findLinks(p); } })(deployDir);
if (links.length) throw new Error(`${links.length} symlinks in the release (cPanel cannot extract them): ${links.slice(0, 5).join(', ')}`);
const require_ = createRequire(path.join(deployDir, 'server.js'));
for (const [from, mods] of [['@pathshala/core', ['xlsx', 'bcryptjs', 'json-logic-js']], ['@pathshala/adapters', ['pdfmake', 'nodemailer', 'web-push']], ['@pathshala/db', ['mysql2', 'pg']], ['.', ['express', 'react', 'react-router', '@react-router/express']]]) {
  const base = from === '.' ? path.join(deployDir, 'server.js') : path.join(deployDir, 'node_modules', from, 'dist', 'index.js');
  const r = createRequire(base);
  for (const m of mods) { try { r.resolve(m); } catch { throw new Error(`${m} does not resolve from ${from} in the release`); } }
}
void require_;
log(`no symlinks · every runtime dependency resolves`);

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
