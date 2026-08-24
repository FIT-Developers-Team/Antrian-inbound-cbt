# Antrian Inbound CBT - Supabase Migration Runbook

## Target architecture

- Vercel serves the existing HTML, CSS, JavaScript, images, and fonts only.
- Supabase Postgres owns operational tickets, PO rows, events, gates, checker master, BA documents, product master, the Google Sheets outbox, and sync metadata.
- Supabase Edge Functions own authenticated API requests and server-side integrations.
- Supabase Cron calls `sync-superset` every five minutes and the Google Sheets outbox worker every minute.
- The browser receives no service-role key, Superset cookie, sync secret, or Google Apps Script secret.

## Deployment order

1. Apply the SQL files under `supabase/migrations` in filename order.
2. Deploy `inbound-api`, `sync-superset`, and `sync-gsheet` with JWT verification disabled; these functions enforce their own signed session or sync secret.
3. Configure Edge Function secrets. Never put secret values in Git or Vercel.
4. Seed `product_master` and `checker_master` with `npm run seed:supabase`.
5. Call the protected `sync-superset?action=configure-cron` action once to install/rotate the Vault-backed cron authorization.
6. Run a manual Superset sync and verify row count, checksum, and freshness before frontend cutover.
7. Deploy the repository to Vercel. `.vercelignore` limits the deployment to the static frontend package.

## Required server-side secrets

- `INBOUND_AUTH_USERS`
- `INBOUND_AUTH_SECRET`
- `SYNC_SECRET`
- `SUPERSET_BASE_URL`
- `SUPERSET_SESSION_COOKIE`
- `GSHEET_SYNC_URL`
- `GSHEET_SYNC_SECRET`
- `GSHEET_SYNC_ENABLED`
- `APP_ORIGINS`

Supabase injects `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` into Edge Functions. They must never be copied into browser code.

## Cutover verification

- `GET inbound-api?action=health` returns HTTP 200 with `backend=supabase`.
- A configured user can login and read `state`.
- A disposable manual ticket can be created, read back, and deleted without leaving rows behind.
- Product and checker counts match the source seed.
- Superset sync returns a non-zero row count and checksum.
- `inbound_superset_freshness()` reports a successful run no older than ten minutes.
- Both rows in `cron.job` are active.
- Every existing UI menu opens without 404 or server errors.
- Vercel deployment contains no `api/`, `supabase/`, `.env*`, or package/runtime backend files.

## Last-valid snapshot and retention

Superset rows first land in `superset_po_stage` in chunks. `inbound_finalize_superset_sync` swaps the public snapshot only after the expected row count and checksum validate. Empty or failed responses leave the last successful snapshot untouched. Sync run metadata older than 30 days is removed after successful syncs.

## Rollback

- Keep the previous Vercel production deployment available until Supabase freshness and UI checks pass.
- If Supabase validation fails, do not promote the static-only deployment.
- If a promoted frontend fails, use Vercel's previous-deployment rollback; the old source/API remains in Git even though `.vercelignore` excludes it from new static deployments.
- Do not delete old Vercel environment variables or disable a still-working legacy scheduler until the replacement is proven fresh.

## Current external blockers (2026-08-24)

- Vercel team `returnbydead's projects` is paused by fair-use enforcement. Support case `#01eVQbbJus1WAFFF` requests unpause after the static-only migration.
- Sensitive Vercel values cannot be revealed after creation. A fresh Superset `session` cookie must be copied directly from the logged-in AstroDash browser session into the Supabase secret `SUPERSET_SESSION_COOKIE`.
- The legacy Google Apps Script URL currently returns HTTP 404. Keep `GSHEET_SYNC_ENABLED=false` until its deployment URL and matching Script Property secret are repaired and verified.

