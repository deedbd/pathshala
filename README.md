# Pathshala — School Management Platform (design v2)

A complete, automation-first school management system for Bangladesh and beyond:
admissions → academics → attendance → assessment → fees & accounting → HR/payroll → library,
transport, hostel, inventory → communication, welfare, documents, alumni, events → governance,
compliance, analytics, AI, marketplace. Desktop + tablet console, and PWA portals for
guardians, students, teachers and drivers.

**Deployment shape:** one zip uploaded to cPanel shared hosting (Namecheap) that installs
itself; the same build runs on a VPS/Docker later without code changes.

**Stack (final):** React 19 + TypeScript · React Router framework mode (SSR) · Tailwind CSS 4 ·
Vite · Node 22 + Express 5 under Passenger · MySQL (cPanel) + Drizzle (migrations at boot) ·
Zod · bcryptjs + own TOTP + session epoch · Nodemailer · Web Push (SMS later) · pdf-lib/pdfmake ·
SheetJS · jimp · Cloudflare + Turnstile · SSLCommerz/bKash later. Pure-JS packages only.

```
db/
  schema/*.def.mjs   ← the single source of truth (34 modules, 349 tables, compact DSL)
  generate.mjs       node db/generate.mjs → mysql/schema.sql · sqlite/schema.sql · schema.json · SCHEMA.md
  verify.mjs         applies the SQLite schema in-memory and smoke-tests it (node:sqlite)
  mysql/schema.sql   MySQL 8 / MariaDB 10.6+ (verified on MariaDB 10.4: 349 tables, 1,036 FKs, 478 checks)
  sqlite/schema.sql  zero-config fallback used by the installer
  schema.json        model for the schema explorer, docs and code generators
  SCHEMA.md          human-readable reference of every table and column
  postgres/          v1 Postgres DDL (RLS, exclusion constraints) — used on VPS deployments
docs/
  ARCHITECTURE.md    v2: Node/Express + React, adapters, tenancy, automation engine, module map
  HOSTING-CPANEL.md  zero-touch installer: what happens when the zip is extracted, fallback matrix, VPS move
  ROADMAP-5Y.md      what ships in years 1–5 (all already in the schema)
  DESIGN-SYSTEM.md   colours, type, layout, components, per-platform rules
  AUTOMATION.md      trigger → automated action matrix, cron seed
  PLAN.md            v2 phases (pilot week 14, GA week 40), milestones, risks
  masterplan.html    polished interactive master plan + schema explorer (also published as an Artifact)
  blueprint.html     v1 visual overview (Postgres/NestJS)
  console.html       clickable UI prototype of the console and portals (demo data)
  v1/                archived v1 docs
```

## Regenerate the schema

```bash
node db/generate.mjs
node db/verify.mjs
```

Edit `db/schema/*.def.mjs` (one line per column: `name type flags # description`), re-run, commit
the generated files. Never edit `db/mysql/schema.sql` by hand.

## Module index (schema keys)

core · platform · saas · cms · academic · people · curriculum · admissions · attendance ·
assessment · lms · diary · cocurricular · library · fees · accounting · wallet · hr ·
scholarships · transport · hostel · inventory · facilities · frontoffice · communication ·
welfare · documents · alumni · events · governance · compliance · analytics · ai · marketplace
