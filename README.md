# 📋 Team Scheduler Bot
### Codename: *Project Levitas*

A WhatsApp bot for automating team scheduling reminders and attendance polls using [Baileys](https://github.com/WhiskeySockets/Baileys). Built for any recurring service team — audiovisual, worship, ushers, volunteers, and more.

## Features

- **Automated messages** at 9:05 AM (configurable timezone):
  - **Monday**: Weekly schedule summary with tagged team members
  - **Wednesday**: Friendly reminder for Thursday's team
  - **Thursday**: Attendance poll for that day's team
  - **Saturday**: Sunday reminder + attendance poll
- **Web UI** (Tailwind CSS dark theme):
  - Manage team members (add/edit/remove)
  - Assign monthly schedule (primary + backup roles)
  - Manual send with date simulation for testing
  - Preview messages before sending
  - Message logs and connection status
- **Idempotent sends** — won't double-send if the container restarts
- **Docker ready** with persistent volumes

## Quick Start

### Prerequisites

- Node.js 20+
- A WhatsApp account to link

### Local Setup

```bash
git clone https://github.com/jmarti326/whatsapp-scheduler.git
cd whatsapp-scheduler
npm install
mkdir -p data
node src/index.js
```

1. Enter your phone number when prompted (with country code, e.g., `17871234567`)
2. Enter the pairing code in WhatsApp → Settings → Linked Devices → Link with phone number
3. Open http://localhost:3000

### Docker

```bash
docker compose up --build -d
```

The web UI is available at http://localhost:3000.

## Configuration

On first run, update the **Group JID** in Settings (or directly in the database). You can find your group's JID by checking the bot logs when a message arrives in that group.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Web UI port |
| `TZ` | `America/Puerto_Rico` | Container timezone |
| `SESSION_SECRET` | *(required)* | Random string for signing sessions |
| `ADMIN_USER` / `ADMIN_PASS` | — | Seed initial admin on first boot |
| `DATABASE_URL` | — | Postgres connection string (Neon). Omit to use SQLite |
| `APP_ROLE` | `all` | `all` · `api` (Vercel) · `worker` (Azure Container Apps) |
| `WORKER_TRIGGER_SECRET` | — | Shared bearer secret protecting the worker's `POST /internal/drain` endpoint. Set the **same** value on the worker and the frontend |
| `WORKER_TRIGGER_URL` | — | *(frontend only)* Public base URL of the worker, e.g. `https://team-scheduler-worker.<region>.azurecontainerapps.io`. The frontend calls it to push queued sends on demand |
| `PENDING_SENDS_POLL_MS` | `0` | Optional safety-net poll for queued sends. `0` = disabled (pure push). Set e.g. `900000` (15 min) so a missed trigger self-heals, at the cost of waking the DB on that cadence |
| `GROUP_SYNC_MIN_INTERVAL_MS` | `3600000` | Minimum gap between WhatsApp group re-syncs per account. Prevents rewriting group rows on every reconnect (saves Neon compute) |
| `GROUP_ALLOWLIST` | — | Comma-separated group **names and/or JIDs** to track. Unset/empty = track all participating groups (original behavior). Matching is case-insensitive and tolerant of extra whitespace and dash variants (`–`/`—` → `-`). Only matched groups are written to `wa_account_groups` / `groups_cache`, so the portal's group picker is scoped to these. Example: `Audio Visual - IPR,Test Group Chat` |
| `STATUS_WRITE_DEBOUNCE_MS` | `20000` | Debounce window for persisting connection status. Collapses transient reconnect flaps into a single DB write |

### How queued "send now" works (and why the DB stays cheap)

The scheduled **8:00 AM / 3:00 PM** messages are fired by in-process `cron` inside
the worker and never touch the database queue — their reliability is independent
of any polling.

The `pending_sends` queue exists only because the **portal runs on Vercel**
(`APP_ROLE=api`), which has no WhatsApp connection. When you click "send now":

1. The Vercel API inserts a row into `pending_sends`.
2. It immediately calls `POST /internal/drain` on the **worker** (Azure,
   `APP_ROLE=worker`), authenticated with `WORKER_TRIGGER_SECRET`.
3. The worker drains the queue and sends via WhatsApp — within seconds.

Because this is **push, not poll**, the worker does not query Postgres on a timer,
so Neon can scale to zero between real events. This is what keeps the project
inside (or near) the Neon free-tier compute allowance. `PENDING_SENDS_POLL_MS`
is only an optional fallback for a dropped trigger call.

> The worker Container App must have **external ingress enabled** on its `PORT`
> so Vercel can reach `/internal/drain`. The endpoint only accepts authenticated
> requests and only triggers a queue drain.

## Deployment

GitHub Actions handle the full deploy pipeline automatically on every push to `master`.

### Required GitHub Secrets

Go to **Settings → Secrets and variables → Actions** in your repo and add:

| Secret | Used by | How to get it |
|--------|---------|---------------|
| `AZURE_CREDENTIALS` | Worker deploy | `az ad sp create-for-rbac --name "whatsapp-scheduler-gha" --role contributor --scopes /subscriptions/<sub-id>/resourceGroups/<rg> --sdk-auth` |
| `AZURE_RESOURCE_GROUP` | Worker deploy | Name of your Azure resource group (e.g. `rg-whatsapp-scheduler`) |
| `AZURE_CONTAINER_APP` | Worker deploy | Container App name from Bicep output (e.g. `whatsapp-scheduler-worker`) |
| `DATABASE_URL` | Worker deploy + Migration | Neon pooler connection string |
| `SESSION_SECRET` | Worker deploy | `openssl rand -hex 32` |
| `WORKER_TRIGGER_SECRET` | Worker deploy + Vercel | `openssl rand -hex 32` — same value on both sides |
| `VERCEL_TOKEN` | Vercel deploy | [vercel.com/account/tokens](https://vercel.com/account/tokens) |
| `VERCEL_ORG_ID` | Vercel deploy | Vercel dashboard → Settings → General → "Your ID" |
| `VERCEL_PROJECT_ID` | Vercel deploy | `prj_ImS8xzjL714BVTPq5mTDf4w0eQGq` (visible in project settings) |
| `SQLITE_DB_B64` | Migration only | `base64 -i data/scheduler.db` — paste the output as the secret |

### Vercel Environment Variables

In **Vercel → Project Settings → Environment Variables**, add:

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | Neon pooler connection string |
| `SESSION_SECRET` | Same random secret as above |
| `WORKER_TRIGGER_URL` | Public URL of the Azure worker (e.g. `https://team-scheduler-worker.<region>.azurecontainerapps.io`) |
| `WORKER_TRIGGER_SECRET` | Same value set on the worker |

`APP_ROLE=api` is already baked into `vercel.json`.

### Workflows

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `Build, Push, and Deploy` | Push to `master` | Builds Docker image → GHCR, then updates Azure Container App |
| `Deploy to Vercel` | Push to `master` | Deploys API to Vercel + health-checks `/login` |
| `Migrate SQLite → Neon` | Manual only | Restores SQLite from secret, copies all data to Neon |

### First-time setup order

1. **Provision Azure infra** (one-time):
   ```bash
   az group create --name rg-whatsapp-scheduler --location eastus
   az deployment group create \
     --resource-group rg-whatsapp-scheduler \
     --template-file infra/container-app.bicep \
     --parameters containerImage=ghcr.io/jmarti326/whatsapp-scheduler:latest \
                  databaseUrl="postgresql://..." \
                  sessionSecret="..."
   ```
2. **Add all GitHub secrets** (table above).
3. **Add Vercel env vars** in the Vercel dashboard.
4. **Run the migration** — trigger `Migrate SQLite → Neon` workflow manually (type `migrate` in the confirm field).
5. **Push to `master`** — both deploy workflows run automatically.

### Vercel (API + Web UI)

The `deploy-vercel.yml` workflow deploys the Express app to Vercel with `APP_ROLE=api`. The web UI is fully served from Vercel; the bot/scheduler runs separately on Azure.

### Azure Container Apps (WhatsApp worker)

The `docker-publish.yml` workflow builds and pushes the Docker image to GHCR, then updates the Container App with the new image. The worker runs with `APP_ROLE=worker` and `min replicas=1` so the WhatsApp connection stays live.

### SQLite → Neon migration (manual)

```bash
# Generate the secret value locally
base64 -i data/scheduler.db   # macOS
# base64 data/scheduler.db    # Linux
```

Paste the output as the `SQLITE_DB_B64` secret, then trigger the `Migrate SQLite → Neon` workflow from the Actions tab.

## Usage

1. **Add team members** in the Team tab (name + phone with country code)
2. **Create the monthly schedule** in the Schedule tab — assign 2 primary + optional backup per Thursday/Sunday
3. **Test with Manual Send** — pick a simulated date and preview the message before sending
4. **Let it run** — cron handles the rest automatically

## Project Structure

```
whatsapp-scheduler/
├── src/
│   ├── index.js          # Entry point — respects APP_ROLE env var
│   ├── bot.js            # Baileys connection manager
│   ├── database.js       # Shim → src/db/index.js
│   ├── db/
│   │   ├── index.js      # Adapter selector (SQLite or Postgres)
│   │   ├── sqlite.js     # SQLite adapter (local / Docker)
│   │   └── postgres.js   # Postgres adapter (Neon)
│   ├── messages.js       # Message builders (summary, reminders, polls)
│   ├── routes.js         # Express API routes (all async)
│   ├── auth.js           # Auth helpers (all async)
│   └── scheduler.js      # Cron job definitions (all async)
├── views/
│   └── index.html        # Web UI (Tailwind CSS)
├── data/                  # Runtime data (gitignored)
│   ├── auth_info/        # WhatsApp session credentials
│   └── scheduler.db      # SQLite database (local only)
├── infra/
│   ├── main.bicep        # Azure VM (legacy / fallback)
│   └── container-app.bicep  # Azure Container Apps worker (Phase 4)
├── Dockerfile
├── docker-compose.yml
├── vercel.json           # Vercel deployment config (APP_ROLE=api)
├── migrate.js            # SQLite schema migration helper
└── migrate-sqlite-to-neon.js  # One-shot SQLite → Neon data migration
```

## Disclaimer

This project uses Baileys which is **not affiliated with or endorsed by WhatsApp**. Use at your own discretion and responsibility. Do not use for spam or bulk messaging.

## License

MIT
