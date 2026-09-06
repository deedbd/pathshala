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
- `docs/PLAN.md` — 40-week phases, pilot at week 14
- `docs/masterplan.html` — interactive master plan + schema explorer (`node db/build-masterplan.mjs` rebuilds it)
- `docs/console.html` — clickable UI prototype (demo data) used as the UI reference
- `db/mysql/schema.sql`, `db/sqlite/schema.sql`, `db/schema.json`, `db/SCHEMA.md` — generated
- `db/postgres/` and `docs/v1/` — archived v1 (Postgres/NestJS)

## Application code (Phase 0 shipped)
- Monorepo: pnpm 12 + Turborepo. `apps/server` (Express 5, Passenger startup `server.js`), `apps/web` (React Router 7 SSR), `apps/installer` (`install.php`), `packages/db|core|adapters|events|schemas|ui`. See README.md for the layout.
- `pnpm install && pnpm build && pnpm smoke` — the smoke test (`tests/smoke.test.mjs`) is the Phase 0 exit criterion: installer → school → rule → SMS + PDF → scheduler → HTTP API. CI runs it on SQLite, MySQL 8 and Postgres 16.
- After editing `db/schema/*.def.mjs` run `pnpm db:generate` (SQL for 3 engines + schema.json + seeds JSON from docs/AUTOMATION.md + Drizzle tables). CI fails if generated files are stale.
- Release: `pnpm release:cpanel` → `release/pathshala-<ver>-cpanel.zip` (uses `pnpm deploy --legacy`; `scripts/check-native.mjs` rejects native addons). `docker compose up` boots the same build on Postgres.
- Rule of thumb in code: `Db` (packages/db) is dialect-agnostic — `?` placeholders, UTC `'YYYY-MM-DD HH:MM:SS'` strings, JSON columns always hold valid JSON (stringify scalars). Services take `schoolId` explicitly; the request context (`runWithContext`) carries actor/tenant for audit.
- Web routes use typegen types (`import type { Route } from './+types/<name>'`); `context.app` is the `App` from `@pathshala/core`. Body parsers are mounted only under `/api` and `/cron` — React Router actions read the raw stream.

## Next step
Phase 1 (`docs/PLAN.md`, weeks 4–7): academic structure (school/college/madrasa/coaching modes), students/guardians/staff, enrollments, Excel import with error file, timetable builder + auto-generator v1, substitutions, syllabus & lesson plans, calendar, CMS website with admission form and notices, guardian PWA v0, design-system components in `packages/ui`. Exit: 1,500 students imported in < 2 min; 40-section timetable with zero clashes; school website live.

## Environment notes
- Windows + Git Bash. For files longer than a few dozen lines use the Write tool; large Bash heredocs fail here.
- No MySQL/MariaDB or Docker on this machine (XAMPP is not installed here); MySQL/Postgres verification happens in GitHub Actions. `node:sqlite` works in Node 22.13+ (experimental warning is harmless).
- pnpm 12: install-script approval lives in `pnpm-workspace.yaml` (`allowBuilds`); `pnpm deploy` needs `--legacy` with the shared lockfile, and it strips the workspace `.bin` shims (tsc disappears) — `scripts/build-release.mjs` runs `pnpm install` afterwards; do the same if you ever run deploy by hand.
