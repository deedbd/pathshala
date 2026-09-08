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
Built by `pnpm release:cpanel` (`scripts/build-release.mjs`). `app/node_modules` is a **flat, symlink-free
tree**: cPanel's File Manager does not restore symlinks when it extracts a zip, so pnpm's linked layout
would arrive broken. The script therefore collects the union of every workspace package's production
dependencies, installs them with npm (hoisted, `--ignore-scripts`), copies the workspace packages'
`dist/` in by hand, then fails the build if any symlink or unresolvable runtime import remains.
`pnpm verify:release` boots the result the way Passenger will (`node app/server.js`) and drives the
installer through it — schema, seeds, school, self-test, Excel template, SSR pages — so the zip is
proven to run, not just to build. CI does both on every push.
The release pipeline builds the zip with `node_modules` already installed for Linux x64 and
Node 22 (`/opt/alt/alt-nodejs22`). Only pure-JS packages (bcryptjs, jimp, pdf-lib, mysql2,
xlsx) — no compiler, no npm on the server. Migrations run automatically when the app boots.

---

## 1b. Where it lives: a domain or a subdomain, not a folder

A Pathshala install owns the whole document root it sits in — `https://school.edu.bd` or
`https://pathshala.deedbd.com`. The zip is the same for every customer because every path it emits
starts at `/`: the client bundle asks for `/assets/…`, the console redirects to `/dashboard`, the
session cookie is scoped to `/`, and Passenger is told `PassengerBaseURI "/"` by the installer.

Serving it from a **folder** of an existing site (`https://deedbd.com/pathshala`) is therefore not a
configuration — it is a different build. React Router's basename is fixed when the bundle is built,
so a subdirectory install needs a zip made for that exact path, and a customer who later moves it to
the root needs another one. It also shares cookies with everything else on that hostname. If a
subdirectory install is ever genuinely wanted, the work is: a `basename` in `react-router.config.ts`,
the same prefix as Vite's `base`, the Express app mounted under it, `Path=` on the session cookie,
and `--base` carried through `scripts/build-release.mjs` and `verify-release.mjs`.

On cPanel, give the subdomain a document root **outside** `public_html` (say `/home/<user>/pathshala`)
rather than the default `public_html/pathshala`, or the same files answer on both
`pathshala.deedbd.com` and `deedbd.com/pathshala` — the second of which is the one path the build is
not made for. AutoSSL covers a subdomain like any other host; behind Cloudflare the subdomain needs
its own proxied record.

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
  10. Write OWNER_DOOR into .env (a random path) and show it once — the Pathshala team's own
      console lives behind it and nowhere else; a school's own door never signs an owner in
  11. Mark installer_state = done; delete install.php; show the dashboard
```
Every step writes to `installer_state`; re-opening `/install` resumes from the failed step.

The door is written once and only lives in `.env` on the server afterwards. It is not the security
boundary — the `super_admin` role on the founder school, the password and the second factor are —
but with it unset the vendor console is closed rather than open, and `/owner` and `/api/owner` answer
404 to anyone who has not come through the door, so a school's site carries no trace of it.
`OWNER_IPS` narrows who may reach the door at all. `scripts/update.mjs` never overwrites `.env`, so
an update keeps the door the owner already has.

**Every school has a door of its own too.** `schools.login_door` is twelve characters of the same
alphabet, written when the school is provisioned and back-filled at boot for any school that has
none. A school's console sign-in is served only at `https://pathshala.deedbd.com/<slug>/x/<door>` —
or `https://school.edu.bd/x/<door>` where the school brought its own domain — and it is emailed to
the school (`owner.school_ready`, bn and en) the moment the school is created. **There is no
`/login` on this installation any more**: `/login`, `/<slug>/login` and a wrong door are all 404s,
five wrong tries from one address close a school's door for fifteen minutes, and the page is
noindex and linked from nowhere. The door is not the security boundary — the password, the second
factor, the session and the roles still are — it only keeps a school's sign-in form off the list of
addresses a stranger can find and hammer. The owner console shows the address with a copy button,
resends it, and replaces it in one click (which kills the old address at once and emails the new
one).

The **guardian and student portal stays at the plain address** — `/<slug>/portal`, with its own
sign-in at `/<slug>/portal/login`. An address printed on a card and sent home to five hundred
families is not a secret by the end of the first week, and a guardian who cannot sign in is a school
that stops using the software. That page refuses staff and admin accounts outright, which is what
stops it being a way around the console's door.

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
