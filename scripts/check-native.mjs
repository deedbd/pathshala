#!/usr/bin/env node
/**
 * Fails when any *production* dependency of the server needs a native build step.
 * cPanel shared hosting has no compiler and no npm; the release zip must be pure JS.
 *   node scripts/check-native.mjs [dir]   (default: apps/server or release/app)
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || (fs.existsSync('release/app/node_modules') ? 'release/app' : 'apps/server');
const banned = new Set(['sharp', 'bcrypt', 'puppeteer', 'puppeteer-core', 'better-sqlite3', 'sqlite3', 'canvas', 'node-gyp', 'playwright', 'argon2', 'cpu-features', 'ssh2']);
const problems = [];
const seen = new Set();

function walk(dir) {
  const nm = path.join(dir, 'node_modules');
  if (!fs.existsSync(nm)) return;
  for (const entry of fs.readdirSync(nm)) {
    if (entry.startsWith('.')) continue;
    const pkgDirs = entry.startsWith('@') ? fs.readdirSync(path.join(nm, entry)).map(e => path.join(nm, entry, e)) : [path.join(nm, entry)];
    for (const pkgDir of pkgDirs) {
      let real; try { real = fs.realpathSync(pkgDir); } catch { continue; }
      if (seen.has(real)) continue; seen.add(real);
      const pj = path.join(real, 'package.json'); if (!fs.existsSync(pj)) continue;
      let pkg; try { pkg = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch { continue; }
      const name = pkg.name || entry;
      const scripts = pkg.scripts || {};
      const reasons = [];
      if (banned.has(name)) reasons.push('banned on shared hosting');
      if (scripts.install && /node-gyp|prebuild|cmake|make\b/.test(scripts.install)) reasons.push(`install script: ${scripts.install}`);
      if (pkg.gypfile) reasons.push('gypfile: true');
      if (fs.existsSync(path.join(real, 'binding.gyp'))) reasons.push('binding.gyp present');
      if (reasons.length) problems.push(`${name}@${pkg.version}: ${reasons.join('; ')}`);
      walk(real);
    }
  }
}
walk(path.resolve(root));
if (problems.length) {
  console.error(`✖ native or banned packages found under ${root}:\n  ` + problems.join('\n  '));
  process.exit(1);
}
console.log(`✓ ${seen.size} packages under ${root}: pure JS, no native build steps`);
