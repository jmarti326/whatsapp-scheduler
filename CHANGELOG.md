# Changelog

All notable changes to the WhatsApp Team Scheduler (codename **Project Levitas**) are documented here.

The project has two runtime roles that share one codebase and a Postgres (Neon) database:

- **`APP_ROLE=worker`** — runs on Azure Container Apps (`team-scheduler-worker`, resource group `rg-ipr-church-scheduler`). Holds the WhatsApp (Baileys) connection, runs the cron scheduler, and drains the send queue.
- **`APP_ROLE=api`** — the Vercel portal (`ipr-church-scheduler.vercel.app`). Manages schedules/teams and enqueues "send now" requests. It has **no** WhatsApp connection.

The `pending_sends` table is the bridge between the two: the portal writes a row, the worker sends the message.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). Dates are the merge/commit date. PR numbers link to GitHub.

---

## 2026-07-15 — Reliability & cost hardening

This day fixed the long-standing "false 3 PM reminder" bug at its true root and cut database cost dramatically.

### Fixed
- **False 3 PM poll reminders — reconnect dropped the vote listener (#23).** The `messages.update` handler that records poll votes was bound **once** at startup. Every WhatsApp reconnect (frequent code-428 flaps) created a **new** socket with **no** listener, so *all* votes were silently dropped. At 3 PM, `remindNonResponders` therefore saw everyone as a non-responder and messaged people who *had* voted. Fixed by wiring the poll-vote listener onto **every** socket as it is created (`wirePollListener` in `src/connection-manager.js`, called both at initial connect and on every reconnect). Root cause was verified against Azure Log Analytics: **0 "Vote received" events in a full month** despite active polls.

### Performance
- **Neon Postgres compute cut so the database can scale to zero (#24).** The worker was keeping Neon awake 24/7 and had burned ~179 CU-hrs in 15 days (free tier is ~100–190/mo). Causes and fixes:
  - `processPendingSends` polled every 10 s → made the interval configurable (`PENDING_SENDS_POLL_MS`) and later disabled by default.
  - `syncAccountGroups` ran a full DELETE + ~100 INSERTs on **every** reconnect → throttled to at most once per hour (`GROUP_SYNC_MIN_INTERVAL_MS`).
  - `persistAggregateStatus` wrote on every connect/disconnect → de-duplicated to skip no-op writes.

### Added
- **On-demand push trigger replaces DB polling (#25).** The portal now calls the worker's new `POST /internal/drain` endpoint (Bearer `WORKER_TRIGGER_SECRET`) right after enqueuing, so "send now" fires in seconds with **zero polling**. The worker exposes a minimal HTTP server (`src/trigger.js`): `GET /health` + `POST /internal/drain`, behind Azure external ingress on port 3000.
  - `processPendingSends` gained an **overlap guard** so the trigger and the safety-net poll can never double-send.
  - Reconnect status writes are **debounced** (`STATUS_WRITE_DEBOUNCE_MS`, default 20 s) so connection flaps collapse into a single DB write.
  - Polling is now **off by default** (`PENDING_SENDS_POLL_MS=0`); production runs an **hourly safety-net** (`PENDING_SENDS_POLL_MS=3600000`) to self-heal any lost trigger call.

> **Note:** Scheduled 8 AM / 3 PM sends were never affected by any of the queue/polling changes — they run via in-process `cron.schedule` and call the send functions directly.

---

## 2026-07-09 — Build hardening & dependencies

### Changed
- **Multi-stage Docker build (`6ef09c9`).** The builder stage installs `python3 make g++` so `better-sqlite3` compiles from source when no prebuilt binary matches the runtime, then copies `node_modules` into a slim final image.

### Dependencies (Dependabot)
- Bump `better-sqlite3` 12.9.0 → 12.11.1 (#17)
- Bump `pg` 8.21.0 → 8.22.0 (#21)
- Bump `node-cron` 4.2.1 → 4.6.0 (#22)
- Bump `ws` 8.20.0 → 8.21.0 (#7)
- Bump `qs` 6.15.1 → 6.15.2 (#5)
- Bump `ip-address` and `express-rate-limit` (#4)
- Bump `actions/checkout` 4 → 6 (#9)

---

## 2026-07-08 — First pass at the reminder bug + engineering guardrails

### Fixed
- **False poll reminders from unnormalized voter JIDs (`60cf78e`).** Baileys 7 reports voter/participant JIDs in device-suffixed (`user:12@s.whatsapp.net`) or LID (`x@lid`) form. String-stripping `@s.whatsapp.net` failed to match stored phone numbers, so genuine voters looked like non-responders. Fixed with proper normalization (`jidToPhone`/`resolveVoterPhone`) to digits-only. *(This removed one cause of the false-reminder symptom; the deeper reconnect-listener cause was fixed on 2026-07-15 in #23.)*
- **Idempotent, dialect-portable vote UPSERT (`baa274a`).** Poll-vote recording rewritten as an explicit `INSERT … ON CONFLICT (…) DO UPDATE` so it is idempotent (Baileys can emit `messages.update` more than once) and works on both SQLite and Postgres.

### Added
- **CI workflow (`811127d`).** Runs `npm test` (`node --test`) on every push and PR.
- **Unit tests for voter JID normalization (`3d3c58d`).**
- **Deploy concurrency guard (`504b62a`).** Serializes deploys so overlapping runs don't race on the Container App.

---

## 2026-06-23 — Multi-account polish & Postgres compatibility

### Fixed
- **Postgres-compatible DDL in `initPollTracking` (`e6535fd`).** Poll-tracking schema setup used SQLite-only DDL that failed on Neon.
- **Persist aggregate `bot_status` to `app_settings` on connection changes (`07a383f`).** So the portal can reflect live connection state across both roles.

### Added
- **Show phone number in the WhatsApp accounts list (`f53ccb8`).**

---

## 2026-06-22 — Multi-account failover & security

### Added
- **Multi-account WhatsApp failover for delivery redundancy (`059851e`, issue #19).** If the primary WhatsApp account can't deliver (safe-to-failover errors only), the message is retried on a secondary account.

### Security
- **Upgrade Baileys and protobufjs (`2eaef5d`)** to resolve known vulnerabilities.

---

## 2026-05-31 — Scheduling automation ("Levitas" feature set)

### Added
- **3 PM non-responder reminders (`eeaec17`, issue #15).** Primaries who haven't answered the day's poll get a reminder at 3 PM AST.
- **Auto-notify backup when a primary votes "No puedo" (`4a3d45d`, issue #13).**
- **Auto-infer day type from the selected date in the schedule form (`41bf3c0`, issue #14).**
- **Project codename "Project Levitas" (`8f460a2`).**

### Fixed
- **Server-side validation rejects non-Thursday/Sunday schedule entries (`0ce7e42`).**

---

## 2026-05-24 — UI/UX overhaul

### Added
- **Friendly, mobile-first dashboard** with bottom navigation and admin-only Settings (`46311cb`, `6e60c76`, `9955faf`), church-attendance light theme (`3e6be75`), and 8 AM AST send + automatic personal DMs to primaries/backups (`30f0510`).

### Fixed
- Read `group_jid` from the DB in API-only (Vercel) mode (`01eb359`).
- Show group name on the dashboard instead of "Not configured" (`a5f4e52`).
- Dashboard loading race condition + error handling (`bd5ec01`).
- Mobile nav breakpoints and duplicate-template-literal JS break (`4cdfc61`, `34c4efb`, `7c88651`).
- Resolve all moderate npm vulnerabilities (`9e9659d`).

### Changed
- CI only builds the Docker image when worker-relevant files change (`a28c142`).

---

## Foundation (2026-04-30 → 2026-05-01)

- Session-based authentication with user management (#3).
- Monthly calendar view for schedule visualization (#1).
- Rebrand from "AV Scheduler" to "Team Scheduler Bot" (#2), later `whatsapp-scheduler` (`b04da96`).

---

## Operational reference

| Setting | Where | Value / purpose |
| --- | --- | --- |
| Scheduled sends | in-process cron | 8 AM AST (Mon/Wed/Thu/Sat) + 3 PM AST reminders (Thu/Sat), `America/Puerto_Rico` |
| `WORKER_TRIGGER_URL` | Vercel env | Worker FQDN the portal calls to drain the queue |
| `WORKER_TRIGGER_SECRET` | Vercel + Azure + GitHub secret | Shared bearer token for `POST /internal/drain` |
| `PENDING_SENDS_POLL_MS` | Worker env | `0` = push-only; prod = `3600000` (hourly safety-net) |
| `GROUP_SYNC_MIN_INTERVAL_MS` | Worker env | Minimum gap between group re-syncs (default 1 h) |
| `STATUS_WRITE_DEBOUNCE_MS` | Worker env | Collapses reconnect status writes (default 20 s) |
