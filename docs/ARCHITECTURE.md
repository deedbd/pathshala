# Pathshala — Architecture v2 (cPanel-first, portable)

**One codebase, two deployment shapes.** Today: a zip uploaded to Namecheap cPanel shared
hosting, self-installing. Tomorrow: the same build on a VPS/Docker/Kubernetes with Postgres,
Redis and S3 — by changing environment variables, not code. Everything that differs between
the two lives behind an adapter.

> v1 (NestJS + Postgres + Redis, VPS-only) is archived in `docs/v1/`. The schema was regenerated
> for MySQL/MariaDB with SQLite fallback and grew from 205 to 349 tables (34 modules) to cover the
> 5-year roadmap. Source of truth: `db/schema/*.def.mjs` → `node db/generate.mjs`.

---

## 1. Stack (final — proven on cPanel in the owner's deedbangladesh project)

| Layer | Choice | Why |
|---|---|---|
| UI | **React 19 + TypeScript** | Stable; runs on cPanel's Node 22 |
| Framework | **React Router (framework mode, SSR)** with the Express adapter | Routing + loaders/actions; SSR for fast first paint on cheap phones; one app for console and portals |
| Styling | **Tailwind CSS 4** + design tokens from `docs/DESIGN-SYSTEM.md` | Fast UI, Bangla fonts easy |
| Build | **Vite** | Upload only `build/`; no native dependencies |
| Server | **Node 22 + Express 5** under Phusion Passenger (cPanel "Setup Node.js App") | Exactly what cPanel runs; long-lived process hosts the scheduler and queue worker |
| Database | **MySQL (cPanel's) + Drizzle ORM**; migrations run automatically at boot; SQLite only as an emergency fallback when no MySQL can be created; Postgres on a VPS later via the same Drizzle schema | `mysqldump` moves data to a VPS later |
| Validation | **Zod** on every loader/action and API route | Form-heavy app |
| Auth | **bcryptjs** (pure JS) + own **TOTP 2FA** + **session epoch** (`users.session_epoch` vs `auth_sessions.epoch` — bump to log out everywhere) | No native bcrypt on shared hosting |
| Email | **Nodemailer** over cPanel SMTP | Free |
| Notifications | **Web Push** (VAPID, free) first — `push_subscriptions`; SMS via BD gateway when the school pays for it; WhatsApp later | Start at zero cost |
| PDF | **pdf-lib / pdfmake** (pure JS, Bangla fonts embedded) | No Chrome/puppeteer on shared hosting |
| Excel | **SheetJS (xlsx)** | Student lists, marks, results import/export |
| Images | **jimp** (pure JS) | No `sharp` |
| Edge | **Cloudflare free** (DNS, TLS, cache) + **Turnstile** on public forms (login, admission, contact) | Bot protection without CAPTCHA friction |
| Payments | **SSLCommerz / bKash** (per school, later); not Stripe | BD market |
| Queue / scheduler | Database queue (`background_jobs`) + **in-app scheduler** with DB lock and request heartbeat; BullMQ/cron adapters for VPS | cPanel cron is not assumed |
| Files | `uploads/` on disk (never in the DB); S3 adapter later | Nightly backup shipped off-site |
| Realtime | Polling + SSE; WebSocket adapter on VPS | Passenger allows SSE |

### cPanel limits baked into the design

1. **No npm package that needs a native build** — jimp not sharp, bcryptjs not bcrypt, pdf-lib/pdfmake not puppeteer, `mysql2` (pure JS) not `mysql-native`, `better-sqlite3` avoided (fallback uses `node:sqlite`).
2. **No cPanel cron** — the scheduler lives inside the app process; a request heartbeat covers process recycles.
3. **No request longer than ~30 s** — every long job (Excel import, invoice batch, result engine, report) is chunked in `background_jobs` with `cursor` / `progress_pct` and resumes; SSR pages never wait on jobs.
4. **Files in `uploads/`**, metadata in `files`; nightly `backups` job dumps DB + uploads and pushes off-site (Google Drive / Dropbox / S3).
5. **Memory** — one Passenger process, ~512 MB budget: queue concurrency limits, streaming Excel/PDF generation, rollup tables instead of heavy queries.

### Monorepo layout

```
apps/
  web/          React Router framework app (SSR): console (desktop/tablet) + portals (guardian, student, teacher, driver)
                routes/ · modules/<module>/{routes,loaders,actions,components}
  server/       Express 5 host: mounts the React Router handler, /api, /install, /cron/tick, scheduler, queue worker
  installer/    install.php bootstrap (see HOSTING-CPANEL.md)
packages/
  db/           Drizzle schema (generated from db/schema/*.def.mjs), drizzle-kit migrations, seeds
  core/         domain services (result engine, fee engine, payroll engine, automation engine…)
  events/       typed event catalogue
  adapters/     db · queue · scheduler · storage · pdf · mail · sms · push · realtime
  ui/           Tailwind 4 design system components, tokens, icons, bn/en i18n
  schemas/      Zod schemas shared by loaders/actions, API and forms
db/             schema definitions + generator + generated SQL/JSON/Markdown
docs/
```
Release = `build/` (client + server bundles) + `node_modules` (pure JS, Linux x64, Node 22) + `install.php` + `db/` zipped by CI.

### Adapter contract (the portability guarantee)

```ts
interface QueueAdapter   { push(job): Promise<void>; work(handler): void; }          // db | bullmq
interface SchedulerAdapter { register(key, cron, fn): void; tick(): Promise<void>; } // inprocess | cron | k8s-cronjob
interface StorageAdapter { put(path, bytes): Promise<Url>; get(path): Promise<Stream>; } // local | s3
interface PdfAdapter     { render(template, data): Promise<Buffer>; }               // pdfmake | chromium
interface RealtimeAdapter{ publish(channel, event): void; }                           // sse | websocket
```
`ADAPTERS=db,inprocess,local,pdfmake,sse` on cPanel → `bullmq,cron,s3,chromium,websocket` on VPS.
Domain code imports only the interfaces.

---

## 2. Multi-tenancy

* Every tenant table carries `school_id` (generated automatically). A Drizzle **global scope**
  injects `WHERE school_id = ?` on every query from the request context; writes are refused
  without a tenant. (Postgres RLS is added on VPS as defence in depth.)
* Single-school self-host = one tenant. SaaS = many tenants in one database. Enterprise =
  database-per-tenant via the same adapter (`DB_URL` resolved per school).
* Per-school numbering in `number_sequences`; per-school policies in `settings`; per-school
  theme, domain and language in `schools`.

---

## 3. The automation engine (unchanged idea, new runtime)

```
request → service (one DB transaction: domain change + outbox_events row)
        → relay (in-process, every 500 ms; or on request heartbeat) → job queue (DB table)
        → consumers: system handlers · rule engine (JSONLogic) · webhooks · KPI
        → actions: notify · task · invoice item · discount · journal · document · status · approval · webhook
        → automation_runs / background_jobs (visible in Admin → Automation)
scheduler (node-cron in the Passenger process, DB lock so only one instance runs a job)
        → emits events (billing.month_started …) and enqueues batch jobs
```

**Why it still works on shared hosting:** Passenger keeps the Node process alive while traffic
arrives; the scheduler runs inside it. If the host recycles idle processes, the next request
(from any user, the PWA’s background sync, or an optional free uptime pinger) runs
`scheduler.tick()` for anything overdue — the WordPress-cron pattern with a DB lock. A real cron
line (`* * * * * curl -s https://school.example/cron/tick?key=…`) upgrades it to exact timing; the
installer adds that line automatically when cPanel’s `uapi` is available.

Guarantees: at-least-once + `event_consumptions` = effectively once; per-rule cooldown; preview
window after edits; failures alert an admin after 3 attempts.

---

## 4. Module map (34 modules, 349 tables)

| Group | Modules (schema key) | Year |
|---|---|---|
| Foundation | core · platform (automation, approvals, forms, workflows, reports, imports, backups) · saas · cms | 1 (saas 2) |
| Academics | academic (school/college/madrasa/coaching modes) · people · curriculum (timetable, outcomes) · admissions · attendance · assessment (marks + competency, OMR, board) · lms · diary (KG daily report) · cocurricular · library | 1 (cocurricular 2) |
| Finance | fees · accounting (GL, AP, assets, statements) · wallet (POS, canteen, shop) · hr (recruitment→exit, payroll, PF, MPO) · scholarships (donations, fundraising) | 1 (wallet, scholarships 2) |
| Operations | transport · hostel · inventory (procurement, assets) · facilities · frontoffice (helpdesk, gate) | 1 (facilities 2) |
| Engagement | communication (SMS/push/email/WhatsApp/voice, chat, PTM, surveys) · welfare (behaviour, health, counselling, safeguarding, SEN) · documents (QR verify, e-sign) · alumni · events (ticketing) | 1 (alumni, events 2) |
| Governance | governance (committee, meetings, policies, elections) · compliance (BANBEIS, MPO, stipends, consent, retention) · analytics (BI, risk scores, anomalies) · ai (assistant, generation, OCR) · marketplace (plugins, OAuth, template packs) | 2–3 |

Module boundary rule is unchanged: a module never writes another module’s tables; it emits an
event and the owner reacts. Cross-module reads go through services.

---

## 5. Security

JWT (15 min) + rotating refresh sessions; OTP rate limits; TOTP for admins; RBAC checked in a
single middleware from `role_permissions`; tenant scope enforced in the data layer; secrets
(gateway, SMS, integrations) envelope-encrypted with `APP_KEY`; counselling/safeguarding notes
encrypted separately; audit log append-only; CSRF for cookie sessions in the web console;
signed URLs for private files; per-school data export/delete (`data_requests`); daily
backups to Google Drive/Dropbox/S3 (`backups`) because shared hosting backups are not yours.

---

## 6. Performance on shared hosting

* Passenger single process, ~512 MB RAM budget: API + scheduler + worker in one, with
  concurrency limits per queue.
* Heavy jobs (invoice batch for 5,000 students, result engine, payroll) run in chunks with
  progress rows so a process recycle resumes rather than restarts.
* Rollup tables (`attendance_monthly_summary`, `fee_collection_daily`, `kpi_daily`,
  `syllabus_progress`) replace materialised views; refreshed by the scheduler.
* High-volume logs (`device_punch_logs`, `vehicle_gps_logs`, `notifications`, `audit_logs`)
  are pruned/archived by `platform.housekeeping`.
* Static React bundles served by Apache with long cache headers; API responses gzip.
