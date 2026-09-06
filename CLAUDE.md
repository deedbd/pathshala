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

## Next step
Phase 0 (`docs/PLAN.md`): pnpm + Turborepo monorepo, `apps/api`, `apps/web`, `apps/portal`, `packages/db|core|events|adapters|ui|api-client`, installer (`install.php` + `/install` wizard), auth/tenancy/RBAC/audit, automation core, notifications, release pipeline producing the cPanel zip and Docker images from one commit. Exit criterion: fresh cPanel account → dashboard in 5 minutes with no cPanel clicks.

## Environment notes
- Windows + Git Bash. For files longer than a few dozen lines use the Write tool; large Bash heredocs fail here.
- XAMPP MariaDB at `C:\xampp\mysql\bin` can be started on a temp port for MySQL verification; `node:sqlite` is available in Node 25 for SQLite verification.
