#!/usr/bin/env node
/**
 * Builds seed JSON from the documentation so docs stay the source of truth:
 *   docs/AUTOMATION.md  →  db/seeds/automation_rules.json  (every ⚙️ rule row: code, module, trigger, condition, action)
 *                        →  db/seeds/scheduled_jobs.json   (the "Scheduled jobs" table: job_key, cron)
 *   node db/seeds/build-seeds.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const md = fs.readFileSync(path.join(here, '../../docs/AUTOMATION.md'), 'utf8');

const moduleOf = title => {
  const t = title.toLowerCase();
  const map = [['admission', 'admissions'], ['academic', 'academic'], ['timetable', 'curriculum'], ['attendance', 'attendance'], ['leave', 'hr'], ['assessment', 'assessment'], ['exam', 'assessment'], ['lms', 'lms'], ['learning', 'lms'], ['fee', 'fees'], ['account', 'accounting'], ['hr', 'hr'], ['payroll', 'hr'], ['library', 'library'], ['transport', 'transport'], ['hostel', 'hostel'], ['inventory', 'inventory'], ['procure', 'inventory'], ['front', 'frontoffice'], ['communication', 'communication'], ['welfare', 'welfare'], ['document', 'documents'], ['platform', 'platform'], ['diary', 'diary'], ['cms', 'cms'], ['saas', 'saas']];
  for (const [k, v] of map) if (t.includes(k)) return v;
  return 'platform';
};
const clean = s => s.replace(/`/g, '').replace(/\*\*/g, '').trim();

const rules = []; const jobs = [];
let section = ''; let inJobs = false;
for (const line of md.split(/\r?\n/)) {
  const h = line.match(/^##\s+(.*)/);
  if (h) { section = h[1].replace(/^\d+\.\s*/, ''); inJobs = /Scheduled jobs/i.test(section); continue; }
  if (!line.startsWith('|')) continue;
  const cells = line.split('|').slice(1, -1).map(c => c.trim());
  if (inJobs) {
    const m = cells[0]?.match(/^`([a-z_.]+)`$/); const cron = cells[1]?.match(/^`([^`]+)`$/);
    if (m && cron) jobs.push({ job_key: m[1], cron_expr: cron[1], rows: clean(cells[2] || '') });
    continue;
  }
  if (cells.length < 5 || !/^[A-Z]\d+$/.test(cells[0])) continue;
  const [code, trigger, condition, action] = cells;
  if (!trigger.includes('⚙️')) continue; // system handlers live in code; only editable rules are seeded
  const ev = trigger.match(/`([a-z_.]+)`/);
  const cronish = /⏰|hourly|daily|nightly|weekly|monthly/i.test(trigger);
  rules.push({
    code,
    module: moduleOf(section),
    name: clean(action).split(/[;.]/)[0].slice(0, 160),
    description: `${clean(trigger)} · ${clean(condition) || '—'} → ${clean(action)}`,
    trigger_kind: ev ? 'event' : cronish ? 'schedule' : 'threshold',
    event_type: ev ? ev[1] : null,
    condition_text: clean(condition) === '—' ? '' : clean(condition),
    actions: [{ type: 'notify', note: clean(action).slice(0, 300) }],
  });
}
fs.writeFileSync(path.join(here, 'automation_rules.json'), JSON.stringify(rules, null, 2) + '\n');
fs.writeFileSync(path.join(here, 'scheduled_jobs.json'), JSON.stringify(jobs, null, 2) + '\n');
console.log(`seeds: ${rules.length} automation rules, ${jobs.length} scheduled jobs → db/seeds/*.json`);
