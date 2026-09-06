# Zero-touch install on cPanel (Namecheap shared hosting)

Goal: **upload one zip to `public_html`, extract it, open the domain.** Nothing else is typed
by a human. The installer detects what the host offers and configures itself; where the host
cannot be automated, the app falls back to a mode that needs no configuration.

---

## 1. What the zip contains

```
public_html/
  .htaccess                 → Passenger directives written by install.php (Node app root, startup file)
  index.php, install.php    → PHP bootstrap (PHP is always present on cPanel); both deleted when setup completes
  app/                      → server.js (Passenger startup), dist/ (Express 5 + React Router SSR handler),
                              web-build/ (client + server bundles), node_modules/ (pure JS, prebuilt, fonts included), tmp/restart.txt
  uploads/                  → files (never in the DB), generated PDFs, backups/ staging, logs/, installer/state.json
  storage/sqlite/           → the SQLite fallback database when no MySQL could be created
  db/                       → mysql/ sqlite/ postgres/ schema.sql, migrations/<engine>/, seeds/*.json, schema.json
  .env (written by install.php) · .env.example · VERSION · README.txt
```
Built by `pnpm release:cpanel` (`scripts/build-release.mjs`), which runs `pnpm deploy` for the server so the
workspace packages are real directories, copies the web build, `db/` and the installer, then zips.
The release pipeline builds the zip with `node_modules` already installed for Linux x64 and
Node 22 (`/opt/alt/alt-nodejs22`). Only pure-JS packages (bcryptjs, jimp, pdf-lib, mysql2,
xlsx) — no compiler, no npm on the server. Migrations run automatically when the app boots.

---

## 2. What happens when the domain is opened the first time

```
 browser → /  ── Apache ──► install.php (no .htaccess yet, so PHP answers)
   1. Detect Node binaries   /opt/alt/alt-nodejs{20,18}/root/usr/bin/node, ~/nodevenv, `which node`
   2. Detect database
        a. try  uapi Mysql create_database / create_user / set_privileges   (works when exec() allowed)
        b. else read cPanel MySQL creds from ~/.my.cnf or existing app DB in .env
        c. else  → SQLite at storage/sqlite/pathshala.db  (zero-config; migrate to MySQL later in Settings)
   3. Write .env             APP_KEY (random), DB_*, ADAPTERS=db,inprocess,local,pdfmake,sse, APP_URL
   4. Write .htaccess        PassengerEnabled On · PassengerAppRoot app/ · PassengerStartupFile server.js
                             PassengerNodejs <detected node> · PassengerAppType node · rewrite /install → node
   5. Cron
        a. try  uapi Cron add_line "* * * * * curl -s $APP_URL/cron/tick?key=$CRON_KEY"
        b. else mark CRON_MODE=heartbeat  (request-driven scheduler; PWA background sync + optional pinger)
   6. Redirect to /install (now served by the Node app through Passenger)
 Node installer
   7. Apply db/<engine>/schema.sql (idempotent), run seeds: BD chart of accounts, GPA 5.0 scale,
      Fri/Sat weekend, leave types, fee heads, notification templates (bn/en), 42 automation rules,
      28 scheduled jobs, document templates, roles & permissions
   8. Create the first school + admin from the one form the owner fills (school name, phone, OTP)
   9. Self-test: write file, send test SMS/email (if keys given later), run scheduler tick, queue a PDF
  10. Mark installer_state = done; delete install.php; show the dashboard
```
Every step writes to `installer_state`; re-opening `/install` resumes from the failed step.

---

## 3. Fallback matrix (what if the host is restrictive?)

| Host capability | Detected how | If missing, the app… |
|---|---|---|
| Node.js via Passenger | `.htaccess` + probe `/_health` | Shows a one-line guide to enable "Setup Node.js App" (the only manual step possible on hosts without Passenger) |
| `exec()`/`uapi` from PHP | `function_exists('exec')` + running `uapi --version` | Uses SQLite and heartbeat cron; both are upgradeable from Settings → Hosting later |
| MySQL database | step 2 | SQLite (WAL mode) — fine up to ~3,000 students; "Migrate to MySQL" button copies data |
| Cron | step 5 | Heartbeat: every request runs due jobs behind a DB lock; the guardian PWA pings `/cron/tick` on open |
| Outbound HTTPS | probe to SMS/FCM endpoints | Notifications queue with a visible "provider unreachable" health warning |
| Disk quota | `disk_free_space` | Keeps uploads under quota, warns at 80%, backups go to Google Drive/Dropbox |
| Memory limit (Passenger) | `/proc/self/status` | Lowers queue concurrency, chunks batch jobs |

---

## 4. Moving to a VPS later (no code change)

1. `docker compose up` on the VPS (Postgres, Redis, MinIO, Gotenberg, api, web).
2. Settings → Hosting → **Export**: dumps DB + files to one archive.
3. **Import** on the VPS; `.env` changes: `DB_URL=postgres://…`, `ADAPTERS=bullmq,cron,s3,chromium,websocket`.
4. Point DNS. Guardians’ PWA keeps working (same domain).

The schema generator already emits Postgres-compatible types through Drizzle; the v1 Postgres
DDL in `db/postgres/` documents the RLS/exclusion-constraint extras used on VPS.

---

## 5. Updates

Settings → Hosting → **Update** downloads the next release zip, verifies its signature, swaps
`app/` atomically, runs migrations, restarts Passenger (`tmp/restart.txt`). Rollback keeps the
previous `app/` for 7 days. Schools never touch cPanel again.
