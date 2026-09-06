# Pathshala — School Management Platform

A complete, automation-first school management system for Bangladesh and beyond:
admissions → academics → attendance → assessment → fees & accounting → HR/payroll → library,
transport, hostel, inventory → communication, welfare, documents, alumni, events → governance,
compliance, analytics, AI, marketplace. Desktop + tablet console, and PWA portals for
guardians, students, teachers and drivers.

**Deployment shape:** one zip uploaded to cPanel shared hosting (Namecheap) that installs
itself; the same build runs on a VPS/Docker later without code changes.

**Stack (final):** React 19 + TypeScript · React Router 7 framework mode (SSR) · Tailwind CSS 4 ·
Vite · Node 22 + Express 5 under Passenger · MySQL (cPanel) + SQLite fallback + Postgres (VPS) ·
Drizzle schema generated from the DSL · Zod · bcryptjs + own TOTP + session epoch · Nodemailer ·
Web Push (SMS via HTTP gateway) · pdfmake with Noto Sans Bengali · SheetJS · jimp · Cloudflare +
Turnstile · SSLCommerz/bKash later. Pure-JS packages only (enforced in CI).

## Status

**Phase 0 (foundation + zero-touch installer) is implemented** — see `docs/PLAN.md`. A fresh
database goes from zip to dashboard through `install.php` → `/install`, with the automation
engine (outbox → relay → rules → queue), scheduler, notifications, auth/RBAC/audit and the
cPanel release pipeline in place. Phase 1 (academic core, people, website) is next.

## Layout

```
apps/
  server/       Express 5 host (Passenger startup file server.js): SSR, /api, /install, /cron/tick, /events, loops
  web/          React Router app: install wizard, login, console (dashboard, automation); portals come in Phase 1
  installer/    install.php + index.php — the PHP bootstrap that runs when the domain is first opened
packages/
  db/           engine adapters (mysql2 · node:sqlite · pg), boot-time migrations, seeds, generated Drizzle schema
  core/         domain services: auth, tenancy context, RBAC, audit, settings, files, custom fields,
                automation (outbox, relay, rule engine, jobs), notifications, tasks, approvals, installer
  adapters/     queue · scheduler · storage · pdf · realtime · mail · sms · push (cPanel impls + VPS stubs), fonts/
  events/       typed event catalogue
  schemas/      Zod schemas shared by API, loaders/actions and forms
  ui/           Tailwind 4 tokens (exercise-book palette), bn/en i18n, formatting helpers
db/
  schema/*.def.mjs   ← the single source of truth (34 modules, 350 tables, compact DSL)
  generate.mjs       → mysql/schema.sql · sqlite/schema.sql · postgres/schema.sql · schema.json · SCHEMA.md
  seeds/             build-seeds.mjs turns docs/AUTOMATION.md into automation_rules.json + scheduled_jobs.json
  migrations/<engine>/  delta migrations applied at boot after the baseline
scripts/        check-native.mjs (no native addons in the server tree) · build-release.mjs (cPanel zip)
tests/          smoke.test.mjs — the Phase 0 exit criterion, run on SQLite, MySQL and Postgres in CI
docs/           ARCHITECTURE · HOSTING-CPANEL · ROADMAP-5Y · DESIGN-SYSTEM · AUTOMATION · PLAN · masterplan.html · console.html
```

## Develop

```bash
pnpm install
pnpm db:generate      # regenerate SQL, schema.json, seeds JSON and Drizzle tables after editing db/schema/*.def.mjs
pnpm build            # all packages + the web app
pnpm typecheck
pnpm smoke            # end-to-end on SQLite: installer → school → rule → SMS + PDF → scheduler → HTTP API
TEST_DB_URL=mysql://root:root@127.0.0.1:3306/pathshala pnpm smoke     # same test on MySQL (or postgres://…)
```

Run it locally (SQLite, no configuration): copy `.env.example` to `.env`, set `DB_ENGINE=sqlite`,
then `node apps/server/server.js` and open <http://localhost:3000> — you land in the install wizard.

## Release

```bash
pnpm build && pnpm release:cpanel   # → release/pathshala-<version>-cpanel.zip (node_modules baked in, pure JS)
docker compose up -d                # same commit on Postgres; open http://localhost:3000/install
```

GitHub Actions builds the zip and the Docker image from every push to `main`, runs the smoke
test against SQLite, MySQL 8 and Postgres 16, and attaches the zip to tagged releases.

## Regenerate the schema

`db/schema/*.def.mjs` is the only hand-written schema. `node db/generate.mjs` emits the SQL for
all three engines plus `schema.json`/`SCHEMA.md`; `node db/verify.mjs` applies the SQLite schema in
memory and smoke-tests it; `node packages/db/scripts/gen-drizzle.mjs` regenerates the typed Drizzle
tables. CI fails when the generated files are stale.
