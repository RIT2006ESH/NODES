# Phase 5.1 NODES-Smoke Integration Readiness

## Scope and verdict

This audit covers the local NODES and Smoke implementations. It does not
re-run production SQL and does not treat local PostgreSQL tests as proof of
production Supabase correctness.

| Requirement | Status |
|---|---|
| NODES authentication and token issuance | PASS |
| Smoke token verification | PASS |
| Room authorization and isolation | PASS |
| Team/room identity synchronization | PARTIAL |
| Leadership succession | PARTIAL |
| Network-offline timeout separation from repair state | PASS |
| Persistent messaging | PASS locally; production Supabase NOT VERIFIED |
| Supabase adapter RPC compatibility | PASS statically |
| Supabase Realtime integration | NOT IMPLEMENTED |
| Production schema verification | NOT VERIFIED |
| Automated regression tests | PASS |
| Backend-only secret handling | PASS |

## Current architecture

NODES is the authoritative multiplayer server. It owns the Line state,
sessions, connection requests, mesh/team identity, leader selection, heartbeat
timeout, and Ed25519 token issuance.

Smoke is a separate Node HTTP/WebSocket server. It maintains a local SQLite
database for rooms, memberships, messages, revoked tokens, and processed
events. Supabase is an optional backend persistence mirror. Smoke does not use
Supabase Realtime; its live transport is its own `ws` WebSocket server.

NODES synchronizes lifecycle changes to Smoke through an authenticated
`x-smoke-internal-secret` HTTP channel. Smoke validates NODES-issued bearer
tokens before room access and uses short-lived WebSocket tickets for upgrades.

## Authentication and JWT flow

NODES issues Ed25519 JWTs from the backend-only
`NODES_JWT_PRIVATE_KEY` or `NODES_JWT_PRIVATE_KEY_FILE` configuration.
The private key is not included in browser bundles or frontend configuration.

Issued claims include:

- `iss` (default `nodes`)
- `aud` (default `smoke-room`)
- `sub`
- `nodeId`
- `roomId`
- `teamId`
- `teamName`
- `role`
- `iat`
- `exp` (five minutes)
- random `jti`

Smoke imports the NODES Ed25519 public key and validates signature, issuer,
audience, expiry, subject/node identity, room identity, and token revocation.
It also verifies active room membership server-side. Changing a room URL or
request parameter does not bypass the room claim or membership checks.

## Team and room synchronization

The implementation supports:

- First accepted connection request becoming the new mesh/team leader.
- Stable room identity derived from the team identity.
- Leader-only team naming in NODES.
- Case-insensitive team-name lookup and database uniqueness.
- NODES-to-Smoke team-name, role, membership, and revocation events.
- Leader transfer and member removal through transactional Supabase RPCs.
- Ten-second heartbeat-based offline removal.
- Independent repair-state tracking based on repair progress, not heartbeat.

Limitations:

1. NODES `syncTeams` calls several transactional RPCs sequentially. Each RPC
   is atomic, but the complete profile/team/member synchronization is not one
   database transaction.
2. Smoke persists its local SQLite state before/alongside Supabase mirror
   writes. A Supabase failure can leave local SQLite ahead of the mirror.
3. Full production leadership succession and persistence behavior remains
   unverified until the production verification SQL output is reviewed.

## Database and adapter compatibility

The NODES adapter uses:

- `create_team_with_room`
- `add_team_member`
- `transfer_team_leadership`
- `rename_team`

The Smoke adapter uses:

- `create_team_with_room`
- `add_team_member`
- `remove_team_member`
- `transfer_team_leadership`
- `set_team_member_member`
- `rename_team`

Names and argument names match the shared migration statically. The migration
also defines `archive_team`, although the inspected application paths do not
call it directly.

Direct table writes are intentionally limited to:

- Profile registration/upsert.
- Smoke message persistence.
- Smoke local SQLite room/member/message state.

Team creation, membership changes, leadership changes, revocation, and rename
operations use the intended RPCs.

## Smoke Room functionality

| Capability | Status | Evidence |
|---|---|---|
| Authenticated room creation/joining | PASS locally | Smoke authorization path |
| Stable room association | PASS statically | `roomId` and `teamId` checks |
| Membership authorization | PASS locally | `requireMember` |
| Invalid/expired token rejection | PASS | Smoke auth tests |
| Cross-room isolation | PASS | Smoke room tests |
| WebSocket presence/disconnect | PASS locally | Smoke WebSocket server |
| Message history | PASS locally | SQLite history endpoint/tests |
| Member revocation | PASS | Admin/revocation tests |
| Team-name synchronization | PASS statically | Internal team event path |
| Supabase Realtime | NOT IMPLEMENTED | WebSocket transport is local |
| Production persistence | NOT VERIFIED | Production SQL results absent |

## Security and configuration

- Supabase secret keys are read only by backend adapters.
- NODES private signing material is read only by the NODES backend.
- Smoke receives only the public verification key.
- `.env` files are ignored by repository configuration.
- Internal NODES-to-Smoke requests require the configured shared secret and
  use timing-safe comparison.
- Protected Smoke endpoints require a valid bearer token and active membership.
- WebSocket upgrades require a short-lived server-issued ticket.
- No frontend secret-key references were found.
- Error responses expose operational messages but do not intentionally include
  credentials or token contents.

Production RLS, RPC privileges, and table definitions are **NOT VERIFIED**
until the actual Supabase SQL Editor output from
`verify_shared_schema.sql` is reviewed.

## Automated tests

NODES:

- `npm test`
- 16 test files
- 149 tests passed

Smoke:

- `node --check server.mjs`
- `node --check supabase.mjs`
- `npm test`
- 3 tests passed

Covered Smoke contracts include invalid/expired JWTs, authorized room access,
isolated rooms, persistent message history, and member revocation.

## Missing or incomplete functionality

1. Supabase Realtime publication/subscriptions are not configured. Live chat
   and presence currently depend on Smoke's own WebSocket server.
2. Production SQL verification has not been supplied; production schema,
   RLS, RPC permissions, and indexes remain NOT VERIFIED.
3. No end-to-end test currently exercises a real deployed NODES instance,
   deployed Smoke instance, and the production Supabase project together.
4. No failure-reconciliation mechanism exists for a local Smoke write that
   succeeds while its Supabase mirror write fails.
5. NODES team synchronization is a sequence of RPC transactions rather than a
   single cross-entity transaction.

## Recommended next phase

Before application integration testing:

1. Run `verify_shared_schema.sql` in the project SQL Editor and retain the
   complete PASS/FAIL output.
2. Verify production RPC signatures, grants, RLS status, and indexes.
3. Run a non-mutating backend connectivity/read check against production.
4. Add a controlled staging integration test for NODES-to-Smoke
   authorization, leadership transfer, revocation, and message persistence.
5. Decide whether Smoke's local WebSocket transport is the intended production
   realtime transport or whether Supabase Realtime should be added separately.

