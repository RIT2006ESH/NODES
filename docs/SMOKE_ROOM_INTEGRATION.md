# Smoke Room integration

NODES exposes a stable `roomId` on every authoritative `TeamView`; it is the
mesh/team ID and remains stable across leader succession and restarts.

The Smoke repository now contains a persistent local Node/SQLite service
implementing the V1 contract in the separate repository. NODES exposes:

`POST /api/integration/rooms/authorize`

It accepts a NODES session token as `Authorization: Bearer ...`, validates active
membership server-side, and returns a five-minute Ed25519 JWT for Smoke. The web
leaderboard uses this endpoint before opening `SMOKE_BASE_URL/?roomId=...&token=...`.

When configured with `SMOKE_BASE_URL` and `SMOKE_INTERNAL_API_SECRET`, NODES also
pushes authoritative revocation, leader-role, and team-name updates to Smoke.
The private key is never sent to the browser.

Required NODES environment:

```text
NODES_JWT_PRIVATE_KEY=<Ed25519 PKCS8 PEM>
# Or local development: NODES_JWT_PRIVATE_KEY_FILE=./data/smoke-nodes-private.pem
NODES_JWT_ISSUER=nodes
NODES_JWT_AUDIENCE=smoke-room
SMOKE_BASE_URL=http://localhost:10001
SMOKE_INTERNAL_API_SECRET=<server-only shared secret>
VITE_SMOKE_BASE_URL=http://localhost:10001
```

For local development, run Smoke on `http://localhost:10001`; the deployed
Vercel page is intentionally unchanged. Cross-user realtime verification uses
the local SQLite database and WebSocket service.

The NODES dashboard always renders a Smoke Room status panel. It reports
`NO_ACTIVE_TEAM`, `MEMBERSHIP_REQUIRED`, `NODE DISCONNECTED`, or
`ROOM AVAILABLE`; the access button remains disabled until the authoritative
TeamView contains the current node and the node has a live network session.
Game repair status is separate from network presence, so a connected node
under repair retains its team and room membership.
# Shared Supabase persistence

Both backends can persist the authoritative identity, team, membership, room,
and message records to the same Supabase project when `SUPABASE_URL` and
`SUPABASE_SECRET_KEY` are set in the server environments. The secret key is
backend-only; the browser never receives it. Apply
`supabase/migrations/20261031000000_shared_nodes_smoke.sql` before enabling the
integration.

NODES exposes the authenticated profile endpoints:

- `GET /api/profile/availability?username=<name>`
- `POST /api/profile/register`
- `POST /api/profile/update`

Registration and updates use the NODES session bearer token to derive the
`node_id`; clients cannot choose another identity. Database uniqueness remains
the final authority for concurrent requests.

Supabase synchronization is optional and non-blocking for local-only
development. Without the environment variables, the existing JSON/SQLite
stores and local WebSocket transport remain active.
