# Runbook & Troubleshooting

Operational procedures for the WhatsApp Team Scheduler (**Project Levitas**).

- **Worker** — Azure Container App `team-scheduler-worker` (resource group `rg-ipr-church-scheduler`, env `team-scheduler-env`). Holds the WhatsApp/Baileys connection, runs cron, drains the send queue.
- **Portal** — Vercel project `ipr-church-scheduler` (`APP_ROLE=api`). No WhatsApp connection; enqueues "send now" to `pending_sends`.
- **Database** — Neon Postgres (free tier, autosuspends after ~5 min idle).
- **WhatsApp auth** — persisted on an Azure Files share (`teamschedulerstor` / share `auth-info`) mounted at `/app/data/auth_info/<accountId>`.

> All times are AST (`America/Puerto_Rico`) unless a log timestamp is shown (logs are UTC).

---

## 1. WhatsApp re-pairing / `pairing code → 401` loop

**Symptom.** In worker logs, every few seconds:

```
[CONN-MGR] 📱 Account "Primary Account" pairing code: XXXXXXXX
[CONN-MGR] ⚠️ "Primary Account" disconnected (code: 401, reason: Connection Failure)
```

The code changes on each attempt and the account never connects. The portal shows the account as `waiting_for_pairing` or `pairing_failed`.

**Root cause.** The account was logged out (`creds.registered = false`), but a **previous** session left `creds.json` + signal/pre-keys on the auth volume. Baileys loads those partial credentials and attempts a (failing) login instead of a clean registration → instant 401. Restarting alone does **not** help because the stale files persist on the Azure Files volume. Repeated deploy/restart churn makes it worse (each spawns a new failing pairing attempt).

**Fix — wipe the account's auth folder, then pair fresh.**

1. Find the account id (visible in logs, e.g. `Synced … for account df0059b8-…` or `Failed to sync groups for <id>`).
2. Get the storage key and delete everything under that account's auth folder:
   ```powershell
   $key = az storage account keys list -g rg-ipr-church-scheduler -n teamschedulerstor --query "[0].value" -o tsv
   az storage file delete-batch --account-name teamschedulerstor --account-key $key `
     --source auth-info --pattern "<accountId>/*"
   # verify empty:
   az storage file list --account-name teamschedulerstor --account-key $key --share-name auth-info --path "<accountId>" -o json
   ```
3. Restart the worker so it mounts the now-empty folder and registers cleanly:
   ```powershell
   az containerapp revision restart -n team-scheduler-worker -g rg-ipr-church-scheduler --revision <latest-revision>
   ```
4. Grab the fresh code (from the **portal** account page — zero lag — or from the logs) and enter it on the phone **within ~2 minutes**:
   **WhatsApp → Settings → Linked Devices → Link a device → "Link with phone number instead"** → type the 8-character code.

**Success looks like:**
```
disconnected (code: 515, reason: Stream Errored (restart required))   ← pairing accepted, normal
✅ "Primary Account" connected (priority 1)
📋 Synced 101 groups for account <id>
```

**Gotchas.**
- The code expires fast. If you see `code: 408, reason: QR refs attempts ended`, the code timed out **before** it was entered — the next reconnect will write partial creds and the 401 loop returns. **Re-wipe** and try again, entering the code immediately.
- `code: 515` after entering the code is **success**, not a failure — it's Baileys restarting the stream to reconnect with the new credentials.
- Do **not** keep restarting hoping it self-heals; that only generates more doomed codes. Wipe first.
- The portal's "remove account" deletes the DB row too (phone, label, priority). Prefer the surgical volume wipe above to keep the account config.

---

## 2. Neon Postgres compute quota exhausted

**Symptom.** Neon dashboard shows CU-hours climbing far faster than expected (free tier ≈ 100–190 CU-hr/month); logs may show `compute quota exceeded` fatals and frequent code-428 reconnects.

**Root cause.** Anything that touches the DB on a short, constant cadence prevents Neon from autosuspending (scale-to-zero), so it bills ~24/7. Historic offenders (all fixed):
- `processPendingSends` polling every 10 s.
- `syncAccountGroups` running a full DELETE + ~100 INSERTs on **every** reconnect.
- `persistAggregateStatus` writing on every connect/disconnect flap.

**Current design (keep it this way).**
- Queue draining is **push-based** — the portal calls `POST /internal/drain`; polling is off by default (`PENDING_SENDS_POLL_MS=0`). Production sets an **hourly** safety-net (`PENDING_SENDS_POLL_MS=3600000`).
- Group re-sync is throttled (`GROUP_SYNC_MIN_INTERVAL_MS`, default 1 h).
- Reconnect status writes are debounced (`STATUS_WRITE_DEBOUNCE_MS`, default 20 s) and de-duplicated.

**If it recurs:** check for any new per-reconnect or short-interval DB write, and confirm `PENDING_SENDS_POLL_MS` is `0` or a large value on the worker.

---

## 3. Portal "send now" didn't fire immediately

**Flow.** Portal writes a `pending_sends` row → calls the worker's `POST /internal/drain` (Bearer `WORKER_TRIGGER_SECRET`) → worker drains and sends.

**Checks.**
1. Worker health: `GET https://<worker-fqdn>/health` should return `{"ok":true,"role":"worker"}`.
2. Env parity: `WORKER_TRIGGER_URL` (Vercel) points at the worker FQDN, and `WORKER_TRIGGER_SECRET` matches across **Vercel, the Azure Container App, and the GitHub repo secret**.
3. The trigger is best-effort (4 s timeout). If it fails, the row stays in `pending_sends` and is picked up by the hourly safety-net poll. Trigger it manually:
   ```powershell
   curl -X POST https://<worker-fqdn>/internal/drain -H "Authorization: Bearer <secret>"
   ```

---

## 4. False 3 PM poll reminders (already fixed — for reference)

**Symptom.** At 3 PM, members who **already voted** get "you haven't answered the poll."

**Two root causes, both fixed:**
1. **Unnormalized voter JIDs** — Baileys 7 reports JIDs as `user:12@s.whatsapp.net` or `x@lid`; naive string-stripping failed to match stored phone numbers, so real voters looked like non-responders. Fixed with `jidToPhone`/`resolveVoterPhone` normalization to digits (`60cf78e`).
2. **Vote listener dropped on reconnect** — the `messages.update` handler was bound once at startup; every reconnect created a new socket with no listener, so **all** votes were silently dropped. Fixed by wiring the listener per-socket (`wirePollListener`, PR #23).

**If it recurs:** confirm `[POLL-HANDLER] 🗳️ Vote received` lines appear when someone votes. Zero vote-received events over a period with active polls indicates the listener is not attached to the live socket.

---

## 5. Scoping which groups are tracked (`GROUP_ALLOWLIST`)

**Goal.** Only track specific groups (e.g. `Audio Visual - IPR`, `Test Group Chat`) instead of all ~100 participating chats, so the portal's group picker stays clean.

**Set it.**
```powershell
az containerapp update -n team-scheduler-worker -g rg-ipr-church-scheduler `
  --set-env-vars 'GROUP_ALLOWLIST=Audio Visual - IPR,Test Group Chat'
```

**Verify.** After the new revision starts, the next group sync logs:
```
[CONN-MGR] 📋 Synced 2 of N participating groups for account <id> (allowlist active)
```
If an entry matched nothing you'll see `⚠️ GROUP_ALLOWLIST entries matched no group: <entry>` — the WhatsApp subject differs; copy the exact name from the sync (or `SELECT group_name FROM wa_account_groups`) and update the env var. Matching is case-insensitive and tolerant of extra whitespace and dash variants, so only real wording differences need fixing.

**Notes.** Group sync is throttled by `GROUP_SYNC_MIN_INTERVAL_MS` (default 1h), so a changed allowlist may take up to an hour to re-sync unless the worker reconnects. Unset/empty `GROUP_ALLOWLIST` reverts to tracking all groups. Scheduled sends are unaffected — they target a specific `group_jid` from `app_settings`, not the cache.

---

## Useful commands

```powershell
# Latest revision + health
az containerapp show -n team-scheduler-worker -g rg-ipr-church-scheduler `
  --query "{rev:properties.latestRevisionName, fqdn:properties.configuration.ingress.fqdn}" -o json

# Tail worker console logs
az containerapp logs show -n team-scheduler-worker -g rg-ipr-church-scheduler `
  --revision <rev> --type console --tail 50

# Watch the deploy pipeline
gh run watch <run-id> --exit-status
```
