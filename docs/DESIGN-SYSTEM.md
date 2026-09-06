# Pathshala — Design system

One visual language across the admin console (desktop/tablet), the portals (guardian, student,
teacher, driver on phones) and the public website. Warm, confident, unmistakably ours; readable
in Bangla and English; usable on a ৳8,000 Android phone in sunlight.

---

## 1. Brand & colour

Concept: **the exercise book** — cool paper, ruled-line blue, margin red — the object every
Bangladeshi student carries. It gives us a neutral ground, one confident accent, and one
semantic red, with teal reserved for automation (things the system did on its own).

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#F2F4F7` | `#0E1418` | page ground |
| `--surface` | `#FFFFFF` | `#161D24` | cards, tables, sheets |
| `--surface-2` | `#EAEEF2` | `#1F2831` | inputs, chips, hover |
| `--ink` | `#17202A` | `#E5EAEF` | text |
| `--muted` | `#5F6C79` | `#97A4B1` | secondary text, labels |
| `--line` | `#D4DBE2` | `#2B3641` | borders, rules |
| `--accent` | `#2B5FA8` (rule blue) | `#86B4F2` | primary actions, links, active nav |
| `--accent-soft` | `#E1EAF7` | `#1B2C44` | selected rows, badges |
| `--auto` | `#147D6F` (teal) | `#4FC4B0` | automation, rules, system-did-this |
| `--cron` | `#8A5A1E` (amber) | `#E0AE68` | scheduled jobs |
| `--ok` | `#1E7F4F` | `#4FC786` | paid, present, approved |
| `--warn` | `#A8651A` | `#E3A85A` | pending, late, partially paid |
| `--bad` | `#B9352F` (margin red) | `#EF7C74` | overdue, absent, rejected |

Rules: semantic colours never double as decoration; accent appears once per view as the primary
action; charts use accent for the main series and muted for context; every colour has a light and
dark value and passes 4.5:1 on its ground. Schools may set their own `--accent` (brand) in
`schools.theme`; everything else stays.

## 2. Typography

| Role | Face | Notes |
|---|---|---|
| Display (page titles, KPI numbers) | **Bricolage Grotesque** 700 | tight tracking, `text-wrap: balance` |
| Body | **IBM Plex Sans** 400/500/600 | 14 px base on desktop, 15–16 px on phones |
| Bangla | **Noto Sans Bengali** (paired by weight) | loaded only when locale is `bn`; line-height 1.6 |
| Data / IDs / money | **IBM Plex Mono** | `font-variant-numeric: tabular-nums`; amounts right-aligned |

Bangla numerals are a per-user preference (`users.preferences.numerals = bn|en`); dates show in
the user’s locale (৬ সেপ্টেম্বর ২০২৬ / 6 Sep 2026); money always `৳` with Indian grouping (১২,৩৪,৫৬৭).

## 3. Layout

* **Console (desktop/tablet):** 54 px top bar (search, year, role, bell, theme) · 236 px sidebar
  grouped by Overview / Academics / People / Finance / Operations / Engagement / Platform, with
  sub-pages under the active module · content area with breadcrumbs → page title + one-line
  purpose → actions on the right. Tablet: sidebar collapses to icons; tables scroll inside cards.
* **Portals (phone):** single column, 16 px gutters, bottom tab bar (5–6 tabs), sticky page
  header, pull-to-refresh, skeleton loading, offline banner. One child per card; switch child
  at the top.
* **Website:** theme-driven blocks (hero, notices, admissions CTA, gallery, results lookup,
  contact), same tokens, school’s accent.

Spacing scale 4 / 8 / 12 / 16 / 24 / 32; radius 6 (controls) / 10 (cards) / 999 (chips);
one shadow level for floating things only (drawers, popovers, toasts).

## 4. Components (packages/ui)

Buttons (primary / secondary / ghost / danger, sizes sm/md) · inputs with labels above and
inline validation · select, date (Bangla calendar aware), phone (BD mask) · chips for status
(dot + label; colour by semantic) · KPI tile (label, number, delta) · data table (search, sort,
filter chips, column picker, pagination, row click → drawer, bulk select) · drawer (right, 560 px)
· modal (form) · tabs · timeline · feed item (system/rule/cron icon) · switch · checkbox ·
bar/spark charts (one scale, labelled) · calendar grid · seat/bed grid · phone frame (preview) ·
empty state (illustration + one action) · toast (2 lines max) · banner (info/warn/bad/ok).

Every list has: search, at least one filter, empty state, loading skeleton, error state with
retry, and a "New" action. Every destructive action confirms and is reversible where possible
(soft delete, undo toast).

## 5. Motion & accessibility

Drawer slide 200 ms, toast rise 200 ms, nothing else animates by default; `prefers-reduced-motion`
disables all. Keyboard: `/` focuses search, `Esc` closes, tables navigable by arrows. Focus rings
visible (2 px accent). Touch targets ≥ 44 px on phones. Colour is never the only signal (chips
carry text). Screen-reader labels on icon buttons. Print stylesheets for report cards, receipts,
admit cards, ID cards (A4/A5/CR80).

## 6. Voice

Write from the user’s side: "Mark attendance", "Record payment", "Publish results". Say what
happened: "Payment recorded · receipt sent". Errors say what to do next. Bangla copy is
natural, not transliterated; keep technical nouns (SMS, PDF, GPA) in Latin.

## 7. Per-platform notes

| Surface | Primary users | Must-haves |
|---|---|---|
| Desktop console | admin, accounts, HR, exam controller | dense tables, keyboard, bulk actions, print |
| Tablet console | principal, coordinators | same app, collapsed nav, touch-friendly rows |
| Teacher PWA | teachers | attendance in 30 s, marks entry with live grades, homework, timetable, substitutions, chat |
| Guardian PWA | parents | child card, today’s status, pay fees (bKash/Nagad), results, homework, bus live, chat, notices, leave request, PTM booking |
| Student PWA | students (6+) | timetable, homework & submissions, materials, results, library, wallet balance, events |
| Driver/helper PWA | transport staff | trip checklist, start/end trip, boarding taps, route map |
