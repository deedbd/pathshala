# Pathshala — project context for Claude Code

Read this first on any machine. Reply to the owner in Banglish (romanized Bengali + English technical terms); keep code and docs in English.

## What this is
School management platform for Bangladesh (and beyond), automation-first, sold to schools that run on cheap cPanel shared hosting. Design is complete (v2); application code starts with Phase 0 in `docs/PLAN.md`.

## Non-negotiables (owner's decisions)
- **Hosting:** Namecheap cPanel shared hosting. The owner only uploads a zip to `public_html` and extracts it. Everything else (Node detection, DB creation or SQLite fallback, `.env`, Passenger `.htaccess`, cron or heartbeat, seeds, self-test) is done by the installer. See `docs/HOSTING-CPANEL.md`.
- **Stack (final, proven in the owner's deedbangladesh project):** React 19 + TypeScript, React Router framework mode (SSR) with Express adapter, Tailwind CSS 4, Vite, Node 22 + Express 5 under Passenger, MySQL (cPanel) + Drizzle ORM with migrations at boot, Zod, bcryptjs + own TOTP 2FA + session epoch, Nodemailer (cPanel SMTP), Web Push first (SMS via BD gateway later), pdf-lib/pdfmake, SheetJS, jimp, Cloudflare free + Turnstile, SSLCommerz/bKash later (no Stripe).
- **cPanel limits:** no npm package needing a native build (no sharp/puppeteer/bcrypt-native); scheduler inside the app, not cPanel cron; no request over ~30 s — chunk long jobs via `background_jobs.cursor`; files in `uploads/`, never in the DB; nightly backups shipped off-site.
- **Portability:** changing hosting later must not require code changes. Hosting-specific code lives only behind adapter interfaces (db, queue, scheduler, storage, pdf, realtime, mail, sms, push).
- **Schema-first:** `db/schema/*.def.mjs` is the single source of truth. Run `node db/generate.mjs` after any change (emits MySQL, SQLite, JSON, Markdown) and `node db/verify.mjs`. Never hand-edit generated SQL.
- **Module boundary:** a module never writes another module's tables; it emits an event (`outbox_events`) and the owning module reacts. Cross-module reads go through services.
- **Every feature** ships with its automation rows (`docs/AUTOMATION.md`), works on SQLite and MySQL, in bn and en, on phone and desktop.
- **Design:** follow `docs/DESIGN-SYSTEM.md` (exercise-book palette, Bricolage Grotesque + IBM Plex, chips by semantic colour, teal only for automation).

## Where things are
- `docs/ARCHITECTURE.md` — stack, monorepo layout, adapters, tenancy, automation engine, module map
- `docs/HOSTING-CPANEL.md` — zero-touch installer flow and fallback matrix
- `docs/ROADMAP-5Y.md` — what ships in years 1–5 (all tables already exist)
- `docs/AUTOMATION.md` — trigger → automated action matrix, cron seed
- `docs/PLAN.md` — 40-week phases, pilot at week 14; every phase carries a status paragraph saying what shipped and what did not
- `docs/MANUAL-bn.md` — the head teacher's manual, in Bangla
- `docs/masterplan.html` — interactive master plan + schema explorer (`node db/build-masterplan.mjs` rebuilds it)
- `docs/console.html` — clickable UI prototype (demo data) used as the UI reference
- `db/mysql/schema.sql`, `db/sqlite/schema.sql`, `db/schema.json`, `db/SCHEMA.md` — generated
- `db/postgres/` and `docs/v1/` — archived v1 (Postgres/NestJS)

## Application code (Phase 0 shipped)
- Monorepo: pnpm 12 + Turborepo. `apps/server` (Express 5, Passenger startup `server.js`), `apps/web` (React Router 7 SSR), `apps/installer` (`install.php`), `packages/db|core|adapters|events|schemas|ui`. See README.md for the layout.
- `pnpm install && pnpm build && pnpm smoke` — the smoke test (`tests/smoke.test.mjs`) is the Phase 0 exit criterion: installer → school → rule → SMS + PDF → scheduler → HTTP API. CI runs it on SQLite, MySQL 8 and Postgres 16.
- After editing `db/schema/*.def.mjs` run `pnpm db:generate` (SQL for 3 engines + schema.json + seeds JSON from docs/AUTOMATION.md + Drizzle tables). CI fails if generated files are stale.
- Updating a live install: `node scripts/update.mjs --zip <release.zip> --root <public_html>` backs up the database, keeps the running `app/`, `db/`, `index.php` and `VERSION`, extracts the new zip over the top (never `.env`, `uploads/` or `storage/`), boots it on a spare port and rolls back if `/_health` does not answer. `--rollback` undoes it later; `--extracted` covers a host with no `unzip`, and says plainly that rollback is then unavailable.
- Release: `pnpm release:cpanel` → `release/pathshala-<ver>-cpanel.zip`, then `pnpm verify:release` (boots the built zip itself and drives the installer through it). `app/node_modules` must stay **flat and symlink-free** — cPanel's File Manager drops symlinks on extract, so pnpm's linked layout ships a broken app; the build fails if a symlink or unresolvable runtime import survives. Never judge a release by booting `apps/server/server.js` with `APP_ROOT` at the release: that uses the source tree's modules. `docker compose up` boots the same build on Postgres.
- Rule of thumb in code: `Db` (packages/db) is dialect-agnostic — `?` placeholders, UTC `'YYYY-MM-DD HH:MM:SS'` strings, JSON columns always hold valid JSON (stringify scalars). Services take `schoolId` explicitly; the request context (`runWithContext`) carries actor/tenant for audit.
- Web routes use typegen types (`import type { Route } from './+types/<name>'`); `context.app` is the `App` from `@pathshala/core`. Body parsers are mounted only under `/api` and `/cron` — React Router actions read the raw stream.

- Phase 1 modules live in `packages/core/src/modules/` (academic, people, importer, timetable, curriculum, cms, portal, numbering) and are wired in `app.ts`; their API is `apps/server/src/routes/phase1.ts`; console pages are `apps/web/app/routes/*.tsx` (loaders call `context.app.*` directly, mutations go through `/api/*` with the `api()` helper from `@pathshala/ui`). Public site: `/site`, guardian PWA: `/portal`. `tests/phase1.test.mjs` is the Phase 1 exit criterion (runs with `pnpm smoke`).
- New module checklist: service in `modules/`, register in `app.ts` (queue/scheduled handlers + system handlers), Zod input in `packages/schemas`, routes in `routes/phase1.ts` (or a new file), console page, i18n keys in `packages/ui/src/i18n.ts`, a test in `tests/`.

- Console API endpoints go through `requirePerm`, which refuses portal accounts (guardian/student/alumni) outright; portal data is served by `/api/portal/*` and `/api/teach/*`, which check the parent-child or staff link instead of a role.
- Timestamps are second-precision on every engine (MySQL DATETIME(0)), so "most recent" ordering must tie-break — see the conversation list query. Postgres sorts NULLs first on DESC; MySQL 8 rejects `CAST(x AS INTEGER)`; `SELECT DISTINCT` + `ORDER BY` needs the sort column in the select list.

- Money: every movement goes through `AccountingService.post()`, which refuses an unbalanced entry. Fees, payments, refunds and expenses each post their own journal, so the trial balance comes from the same rows the modules wrote. Amounts are rounded with `round()` (2 dp) everywhere.
- JSON columns must hold valid JSON on MySQL/Postgres (SQLite is lax): an encrypted secret is stored as `{ enc: "v1..." }`, never as a bare string.
- Express matches routes in order, so a literal path that shares a shape with a parameterised one must be registered first — `/exams/annual/compute` before `/exams/:id/compute`, or `annual` is read as an exam id.
- MySQL reads inside a transaction use REPEATABLE READ, so a plain SELECT cannot see a row another connection committed after the transaction began — it will still collide on the unique key. Where a row is read then created (`NumberingService`), write first (`UPDATE … SET n = n + 1`) and read after: an UPDATE sees the latest committed row and locks it.
- Keep-alive has two halves. The server waits 65 s for a reuse (above the usual 60 s proxy idle), but it advertises `Keep-Alive: timeout=5`, because a client that honours the real number holds the socket for exactly as long as the server does and one of them loses the race with an ECONNRESET. The client must always give up first.
- `node:sqlite` is synchronous, so any long background pass holds the whole event loop and every request behind it. Background work runs in slices: `relay.run(max, budgetMs)` yields between events, the in-process loop takes a budget under its interval, and a request-driven heartbeat gets 2 s and three jobs at most. A load run caught this as a 24.8 s response that should have been 0.36 s.
- Engines list their tables differently (SQLite in creation order, MySQL and Postgres alphabetically), so anything that copies whole tables — backup, restore, the engine move — orders them by `db/schema.json`, which is the order the foreign keys need.
- Confidential text (counselling notes, safeguarding cases) is encrypted with `encryptSecret` and only ever decrypted by the service that owns it, for the person who owns the record. List endpoints strip the ciphertext, and the alert that a case exists never carries what is in it.
- Never read a count on `this.db` to build a number while inserting inside a transaction: that read runs on a different connection and cannot see the rows the transaction is writing (and under MySQL's REPEATABLE READ it cannot see other connections' recent commits either). Document numbers come from `NumberingService`, which takes the transaction.
- A service called from inside another module's transaction must take that transaction, not start its own: on SQLite a second `db.transaction()` on the one connection throws "cannot start a transaction within a transaction", and on MySQL it silently runs on another connection that cannot see the rows still being written. The staff import found both — `HrService.setStructure` now takes an optional `tx`, as `createStudent` and `createStaff` already did.
- Postgres aborts the whole transaction on the first failed statement, so code that *expects* a statement to fail sometimes — a race to insert the same unique row — must fence it: `tx.attempt(fn)` wraps it in a savepoint on all three engines and is a plain call outside a transaction. `NumberingService` creating a sequence is the case that found this, as "current transaction is aborted, commands ignored" from an unrelated statement two calls later.
- A test at the repo root can only import what the **root** `package.json` declares: pnpm's layout does not hoist a workspace package's dependencies to the root `node_modules`. `xlsx` is there for that reason. It resolved locally and not in CI, which is exactly the shape of failure to look for when a suite dies in its `before` hook with no per-test error.
- An automation that fans out from an event must be idempotent and must check its own preconditions: the relay delivers at least once, and several events of the same kind can arrive in a row (three batches of marks → three merit runs). Ranking waits for the last mark, and an applicant already holding an offer is never re-ranked.
- Long fan-out work is a queued job that walks `background_jobs.cursor`: report cards render 25 students per pass, which keeps every request well inside the ~30 s shared-hosting ceiling. 1,500 report cards take about 40 s in total.

## Year 2 (in progress)
`docs/ROADMAP-5Y.md` year 2 is being built on top of the nine phases. Shipped so far: `commerce`
(wallet, canteen and shop), `giving` (scholarship funds, donors, appeals), `alumni` (directory,
mentorship, job board) and the co-curricular half of `engagement` (competitions, event programmes and
volunteers). Also `facilities` (room bookings, work orders with an SLA, cleaning, meters, drills), `governance`
(committees, minutes whose resolutions become tasks, policies with acknowledgements, secret-ballot
elections) and `compliance` (BANBEIS census, stipends, consent, data requests, retention review).
And `analytics` (metrics from the register, anomalies against the school's own median, risk scores
that carry their reasons, cohort benchmarks), broadcasts on every channel — WhatsApp and voice
adapters joined SMS/email/push — and assessment+ (competency scales and outcomes, OMR with a
human check, board registration and result import).
Their API is `apps/server/src/routes/phase10.ts` … `phase12.ts`, the console pages are
`apps/web/app/routes/community.tsx`, `institution.tsx` and `insights.tsx`, and
`tests/year2a.test.mjs` … `year2c.test.mjs` are their exit criteria.

## Year 3 (in progress)
`saas` (plans, subscriptions, metering, invoices, resellers — `saas.*` is super-admin only, and a
past-due school loses new work, never access to its records), `marketplace` (plugins behind signed
webhooks, OAuth2 clients with scopes, template packs) and `ai` (data questions answered by code from
the school's own rows; drafting needs a provider and is always stored as a draft a person applies).
API: `apps/server/src/routes/phase13.ts`, plus the scoped public API at `/api/v1`. Exit criterion:
`tests/year3a.test.mjs`.
And `college` (semester/credit programmes: per-term course registration against a credit ceiling the
programme itself sets, a GPA weighted by credit where a retake replaces the failure it repeats,
department portals, a certificate that waits for the credits, and coaching batches sold on instalments
whose seat is handed over by the payment, not by the plan). It owns `course_registrations` and reaches
every other module through its service — `academic` for programmes and credits, `people` for
departments, `fees` for the plan, `lms` for the seat and its certificate, `assessment` for the grade.
API: `apps/server/src/routes/phase14.ts`. Exit criterion: `tests/college.test.mjs`.

## Next step
All nine phases of `docs/PLAN.md` are implemented and each has a test suite that proves its exit criterion on SQLite, MySQL and Postgres. What is left is the work that needs a real school and a real host, not more code:

1. Run the installer on an actual Namecheap Stellar account and time it end to end (Phase 0's exit criterion has only been proven locally and in CI).
2. Take one pilot school live: Cloudflare and Turnstile against a real site key, a real SMS gateway, a real bKash or SSLCommerz merchant account.
3. Google Drive and S3 backup targets (Dropbox works today).
4. The gaps each phase's status paragraph in `docs/PLAN.md` lists under "Not yet".

`pnpm smoke` runs every phase suite plus `tests/gaps1` and `tests/gaps2` (the Year-1 gaps: staff and attendance imports, marks sheets, receipts, instalments, cheques, MPO, gratuity), on SQLite by default; `TEST_DB_URL` selects MySQL or Postgres. `PHASE4_BIG=1` runs the 1,500-student assessment exit criterion; `PHASE9_LOAD=1` runs the 5 schools × 1,500 students load run.

## Environment notes
- Windows + Git Bash. For files longer than a few dozen lines use the Write tool; large Bash heredocs fail here.
- Neither MySQL nor Docker is installed on this machine. Portable MariaDB and PostgreSQL unpacked into the session scratchpad and started on spare ports (3307 and 5433) run the suites locally before pushing; CI runs them again on MySQL 8 and Postgres 16. `node:sqlite` works in Node 22.13+ (the experimental warning is harmless).
- Multi-line strings with Bengali text break in Git Bash heredocs: write a `.py` file into the scratchpad with the Write tool and run it, rather than piping a heredoc into python.
- pnpm 12: install-script approval lives in `pnpm-workspace.yaml` (`allowBuilds`); `pnpm deploy` needs `--legacy` with the shared lockfile, and it strips the workspace `.bin` shims (tsc disappears) — `scripts/build-release.mjs` runs `pnpm install` afterwards; do the same if you ever run deploy by hand.
