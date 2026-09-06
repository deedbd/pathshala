#!/usr/bin/env node
// Injects db/schema.json into docs/masterplan.template.html → docs/masterplan.html
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const tpl = fs.readFileSync(path.join(here, '..', 'docs', 'masterplan.template.html'), 'utf8');
const json = fs.readFileSync(path.join(here, 'schema.json'), 'utf8').replace(/<\/script/gi, '<\\/script');
const out = tpl.replace('/*__SCHEMA_JSON__*/null', json);
const target = process.argv[2] || path.join(here, '..', 'docs', 'masterplan.html');
fs.writeFileSync(target, out);
console.log(`masterplan → ${target} (${(out.length/1024).toFixed(0)} KB)`);
