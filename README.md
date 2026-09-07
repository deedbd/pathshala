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

**All nine phases of `docs/PLAN.md` are implemented.** Each phase carries a status paragraph in the
plan saying what shipped and what did not, and each has a test suite that proves its exit criterion
on SQLite, MySQL 8 and Postgres 16:

| Phase | What it covers | Proven by |
|---|---|---|
| 0 | Monorepo, adapters, zero-touch installer, auth, tenancy, RBAC, automation core, notifications, release pipeline | zip → dashboard with no cPanel clicks; rule → SMS + PDF |
| 1 | Academic structure, people, Excel import, timetable, curriculum, website, guardian PWA | 1,500 students imported in seconds; 40 sections timetabled with no clashes |
| 2 | Attendance with device ingestion, leave, chat, PTM, diary, teacher PWA | absent SMS inside the five-minute window for every section |
| 3 | Fees, gateways, counter cash, accounting | a month closes with a balanced trial balance and no hand-written fee journal |
| 4 | Exams, marks with lock, the result engine, report cards, promotion, question bank | 1,500 report cards published in ~40 s, in chunks |
| 5 | HR from vacancy to exit, payroll, payslips, bank file | 151 staff drafted, approved, paid and journaled in one pass |
| 6 | Admissions from campaign to enrolment; documents with QR verification | 500 applications → 200 seats in strict merit order → enrolment on payment |
| 7 | Library, transport, hostel, stores and assets, front office | fines reach the invoice, the bus tells the right guardians, a delivery becomes stock and a tagged asset |
| 8 | Behaviour, health and the clinic, counselling and safeguarding, LMS, surveys, events | points propose an action; confidential notes stay encrypted |
| 9 | Hardening: the security review as a test, backup and restore, the engine move, the load run | 5 schools × 1,500 students in one database; a request answers in 0.36 s with 11,800 events still queued |

**Years 2 and 3 of `docs/ROADMAP-5Y.md` are being built on top of those nine phases**, in the same
way — a module, its automation rows, its API, a console page, and a test that proves the exit
criterion on all three engines:

| Area | What it covers | Proven by |
|---|---|---|
| Wallet & shop | A card instead of cash, a top-up that is a liability until something is sold, a daily limit refused at the till, orders from the app | `tests/year2a.test.mjs` |
| Scholarships & giving | Funds that cannot promise more than they hold, awards that become fee discounts, appeals with a public page, receipts with a verification code | `tests/year2a.test.mjs` |
| Alumni | A directory written the day a class graduates, mentorship capped at three, a job board that closes its own expired posts | `tests/year2a.test.mjs` |
| Facilities | Bookings the timetable wins, work orders whose deadline comes from their priority, meters that only count up | `tests/year2b.test.mjs` |
| Governance | Resolutions that become tasks with owners, policies that name who has not read them, a secret ballot | `tests/year2b.test.mjs` |
| Compliance | The BANBEIS census built from the register, stipends, consent as an append-only history, retention that reports and never deletes | `tests/year2b.test.mjs` |
| Analytics | Metrics from the register, anomalies against the school's own median, risk scores that carry their reasons, cohort benchmarks | `tests/year2c.test.mjs` |
| Communication+ | WhatsApp and voice calls beside SMS; one broadcast to an audience resolved from the school's own records | `tests/year2c.test.mjs` |
| Assessment+ | Competency assessment beside marks, OMR a person checks when the machine is unsure, board registration and results | `tests/year2c.test.mjs` |
| SaaS & marketplace | Plans and resellers where an unpaid bill stops new work and never locks a school out; plugins behind signed webhooks; a scoped public API at `/api/v1` | `tests/year3a.test.mjs` |
| Assistant | Data questions answered by code from the school's own rows; drafting needs a provider and is always a draft somebody applies | `tests/year3a.test.mjs` |

What is left needs a real school and a real host rather than more code: a run on an actual Namecheap
account, a pilot school live with a real SMS gateway and payment merchant, and the smaller gaps each
phase lists under "Not yet".

## Layout

```
apps/
  server/       Express 5 host (Passenger startup file server.js): SSR, /api, /install, /cron/tick, /events, loops
  web/          React Router app: install wizard, login, the console (academic, students, staff, attendance,
                timetable, exams, fees, accounts, hr, admissions, operations, learning, diary, chat, website),
                the guardian and student PWA at /portal, the teacher PWA at /teach, the public site at /site
  installer/    install.php + index.php — the PHP bootstrap that runs when the domain is first opened
packages/
  db/           engine adapters (mysql2 · node:sqlite · pg), boot-time migrations, seeds, generated Drizzle schema
  core/         domain services: auth, tenancy context, RBAC, audit, settings, files, custom fields,
                automation (outbox, relay, rule engine, jobs), notifications, tasks, approvals, installer,
                and one module per domain in core/src/modules: academic, people, importer, timetable,
                curriculum, cms, portal, attendance, communication, accounting, fees, assessment, hr,
                admissions, documents, library, transport, hostel, inventory, frontoffice, welfare, lms,
                engagement, platform
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
                verify-release.mjs (boots the built zip) · migrate-db.mjs (SQLite → MySQL) · update.mjs (update + rollback)
tests/          smoke.test.mjs plus phase1–9.test.mjs — every exit criterion, run on SQLite, MySQL and Postgres in CI
docs/           ARCHITECTURE · HOSTING-CPANEL · ROADMAP-5Y · DESIGN-SYSTEM · AUTOMATION · PLAN · MANUAL-bn (for the head teacher)
                masterplan.html · console.html
```

## Develop

```bash
pnpm install
pnpm db:generate      # regenerate SQL, schema.json, seeds JSON and Drizzle tables after editing db/schema/*.def.mjs
pnpm build            # all packages + the web app
pnpm typecheck
pnpm smoke            # every phase suite on SQLite: installer, academics, attendance, fees, exams, HR,
                      # admissions, operations, learning, hardening
TEST_DB_URL=mysql://root:root@127.0.0.1:3306/pathshala pnpm smoke     # the same suites on MySQL (or postgres://…)
PHASE4_BIG=1 pnpm test:phase4    # the 1,500-student report-card run instead of the 120-student default
PHASE9_LOAD=1 pnpm test:phase9   # the 5 schools × 1,500 students load run
```

Run it locally (SQLite, no configuration): copy `.env.example` to `.env`, set `DB_ENGINE=sqlite`,
then `node apps/server/server.js` and open <http://localhost:3000> — you land in the install wizard.

## Release

```bash
pnpm build && pnpm release:cpanel   # → release/pathshala-<version>-cpanel.zip (node_modules baked in, pure JS)
docker compose up -d                # same commit on Postgres; open http://localhost:3000/install
```

GitHub Actions builds the zip and the Docker image from every push to `main`, runs every phase suite
against SQLite, MySQL 8 and Postgres 16, boots the built zip to prove it deploys, and attaches the zip
to tagged releases.

Updating a school that is already live:

```bash
node scripts/update.mjs --zip pathshala-<version>-cpanel.zip --root /home/user/public_html
node scripts/update.mjs --rollback          # if the new one misbehaves
```

It backs up the database first, keeps the running release beside it, extracts over the top without
touching `.env`, `uploads/` or `storage/`, boots the result and restores the old one if it does not
answer. Moving a school off SQLite when it outgrows it:

```bash
node scripts/migrate-db.mjs --from sqlite:storage/pathshala.db --to "mysql://user:pass@localhost/school"
```

## Regenerate the schema

`db/schema/*.def.mjs` is the only hand-written schema. `node db/generate.mjs` emits the SQL for
all three engines plus `schema.json`/`SCHEMA.md`; `node db/verify.mjs` applies the SQLite schema in
memory and smoke-tests it; `node packages/db/scripts/gen-drizzle.mjs` regenerates the typed Drizzle
tables. CI fails when the generated files are stale.
