# Shared Supabase migration deployment guide

This guide prepares the shared NODES + Smoke Room schema. It does not apply
anything automatically.

## Canonical source

Use the migration in
[supabase/migrations/20261031000000_shared_nodes_smoke.sql](../supabase/migrations/20261031000000_shared_nodes_smoke.sql).
The Smoke repository contains an identical review copy. Apply exactly one copy
to the shared Supabase project.

## Required environment

Backend services require:

```text
SUPABASE_URL=https://xusbdawjmbrfztqjfmwh.supabase.co
SUPABASE_SECRET_KEY=<backend-only-secret>
```

The secret key must remain in ignored backend `.env` files. It must not be
placed in `VITE_*` variables, browser code, SQL files, logs, or commits.

Migration execution requires either SQL Editor access to project
`xusbdawjmbrfztqjfmwh`, or Supabase CLI authentication with a Management API
token or database password. The Supabase API secret key is not a CLI
Management API token or database password.

## Production SQL Editor procedure

Use the Supabase Dashboard for project `xusbdawjmbrfztqjfmwh`:

1. Open **SQL Editor** and create a new query.
2. Paste and run the complete
   [preflight_duplicate_report.sql](../supabase/preflight_duplicate_report.sql).
3. Use the `schema_state` result to choose the safe branch:
   - `FRESH_SCHEMA`: confirm all six tables are listed as missing and continue.
   - `SCHEMA_DRIFT`: stop. Do not apply the migration; inspect the listed
     existing/missing tables and resolve the partial-schema situation manually.
   - `EXISTING_SCHEMA`: review every duplicate and integrity result. Continue
     only when all checks are `PASS`.
4. For `FRESH_SCHEMA` or a reviewed `EXISTING_SCHEMA`, open a new SQL Editor
   query and paste the complete canonical migration:
   [20261031000000_shared_nodes_smoke.sql](../supabase/migrations/20261031000000_shared_nodes_smoke.sql).
5. Run that migration exactly once against this shared project.
6. Open a new SQL Editor query and run
   [verify_shared_schema.sql](../supabase/verify_shared_schema.sql).
7. Confirm every result row is `PASS` and the final `overall_status` is `PASS`.
8. Perform non-privileged authenticated RLS checks, then restart NODES and
   Smoke and verify backend RPC operations.

The preflight and verification scripts use session-local temporary tables.
Run each script as one SQL Editor batch; do not copy individual statements
into separate sessions.

## Review and deployment order

1. Run [preflight_duplicate_report.sql](../supabase/preflight_duplicate_report.sql)
   as one batch.
2. If `schema_state = FRESH_SCHEMA`, proceed directly to migration review.
3. If `schema_state = SCHEMA_DRIFT`, stop and investigate; do not make
   automatic schema or data changes.
4. If `schema_state = EXISTING_SCHEMA`, stop on any failed duplicate or
   integrity check. Resolve issues manually while preserving IDs and
   leadership decisions.
5. Review the canonical migration SQL.
6. Apply the NODES migration once. Never apply the Smoke copy separately.
7. Run [verify_shared_schema.sql](../supabase/verify_shared_schema.sql) as one
   batch and require every result to be `PASS`.
8. Verify authenticated RLS behavior with non-privileged test identities.
9. Verify NODES and Smoke backend writes using the backend-only secret.

Do not run the NODES and Smoke copies independently. They target the same
project and would only duplicate deployment attempts.

## Safety properties

- `create table/index if not exists` makes clean reruns safe.
- Existing tables are not assumed to be current: the migration adds only the
  archival columns when absent and adds named constraints only when absent.
  Generated-column or type drift must be reviewed before deployment.
- Existing records are not renamed or deleted.
- Existing schema drift is not silently repaired; inspect verification output.
- Unique indexes enforce normalized username and team-name uniqueness.
- Room/team mapping is enforced by a deferred composite foreign key.
- Leadership is enforced at transaction commit by both a partial unique index
  and a deferred integrity trigger requiring one matching active leader.
- Room and message foreign keys use `RESTRICT`; archive status is used instead
  of deleting rooms or historical messages.
- Transaction functions use `SECURITY DEFINER` with a fixed `search_path` and
  are executable only by `service_role`; browser roles cannot call them.
- RLS is enabled on all six tables.
- `room_events` intentionally has no browser policy; it is backend/service-role
  data only.
- Backend service-role operations bypass RLS and must never reach a browser.

## RLS compatibility note

Policies use `current_setting('request.jwt.claim.sub', true)`. This is only
effective when PostgREST receives a Supabase Auth JWT whose `sub` claim is
mapped into that request setting. NODES Ed25519 tokens are verified by the
NODES and Smoke backends, but Supabase does not automatically trust those
tokens or map their `nodeId` claim. Backend adapters using the service key
remain the supported write path; do not put that key in browser code.

## Transaction requirements

Team creation, leader succession, member removal, and archive operations must
run in one database transaction. A valid active team must commit with:

- exactly one active `team_members` row whose role is `leader`;
- `teams.leader_node_id` equal to that member's `node_id`; and
- a matching active team/room mapping.

The deferred trigger permits intermediate states inside one transaction but
rejects invalid committed states. Backend code must not perform these changes
as unrelated asynchronous writes.

## Installed transaction functions

- `create_team_with_room`
- `add_team_member`
- `transfer_team_leadership`
- `remove_team_member`
- `set_team_member_member`
- `archive_team`
- `rename_team`

NODES calls the create/add/transfer/rename functions during synchronization.
Smoke calls create/add/transfer/remove/rename for room authorization and
internal synchronization. Both use the backend service-role client only.
Functions lock the rows they mutate, reject removing an active leader before a
transfer, and archive teams/rooms without deleting messages or membership
history.
