# Mumbai Network Garden (NODES)

Mumbai Network Garden is a cooperative real-time network game. Players join a
shared world, move their nodes, request links from other players, survive
outages, and form private mesh teams. Team membership, leadership, and Smoke
Room authorization are owned by the NODES server.

## Features

- Real-time WebSocket multiplayer.
- Consent-based player-to-player connections.
- Mesh/team creation with stable `teamId`, `meshId`, and `roomId`.
- Leader succession after the configured offline timeout.
- Repair state kept separate from network connectivity.
- Team naming restricted to the authoritative leader.
- Smoke Room authorization using short-lived Ed25519 JWTs.
- Optional shared Supabase persistence for profiles, teams, memberships, rooms,
  messages, and room events.
- Existing Canvas game, rankings, outages, sound, effects, and responsive UI.

## Requirements

- Node.js 24 or newer.
- npm.
- A second browser window/device for multiplayer testing.
- Optional: Supabase project and backend secret key for shared persistence.

## Install

```powershell
cd C:\Users\Asus\Downloads\NODES-main
npm install
```

The server loads `.env` automatically on Node.js 24+. `.env` is ignored by Git.
Never commit private keys, Supabase secret keys, or internal service secrets.

## Local configuration

Copy the documented settings from [.env.example](./.env.example) into `.env`.
The important local integration settings are:

```text
PORT=10000
NODE_OFFLINE_TIMEOUT_MS=10000
NODES_JWT_PRIVATE_KEY_FILE=C:\Users\Asus\Downloads\NODES-main\data\smoke-nodes-private.pem
NODES_JWT_ISSUER=nodes
NODES_JWT_AUDIENCE=smoke-room
SMOKE_BASE_URL=http://localhost:10001
SMOKE_INTERNAL_API_SECRET=local-only-change-me
VITE_SMOKE_BASE_URL=http://localhost:10001
SUPABASE_URL=https://xusbdawjmbrfztqjfmwh.supabase.co
SUPABASE_PUBLISHABLE_KEY=<publishable-key>
SUPABASE_SECRET_KEY=<backend-only-secret-key>
```

`SUPABASE_SECRET_KEY` is only read by the backend. It must never be placed in
Vite variables or browser code. The publishable key is safe for browser use
only with the RLS policies from the migration.

## Start locally

Start Smoke first:

```powershell
cd C:\Users\Asus\Downloads\smoke
npm install
npm start
```

Start NODES in a second PowerShell window:

```powershell
cd C:\Users\Asus\Downloads\NODES-main
npm start
```

Start the Vite dashboard in a third window:

```powershell
cd C:\Users\Asus\Downloads\NODES-main
npm run dev:web
```

Open:

- Dashboard: <http://localhost:5173>
- NODES backend: <http://localhost:10000>
- Smoke Room: <http://localhost:10001>
- Health: <http://localhost:10000/healthz>

Join the dashboard in two browser windows, connect the players, name the team,
and use **OPEN SMOKE ROOM**. Do not open the Smoke URL directly when testing a
private room; it needs the short-lived NODES token.

## Supabase migration

The migration is version-controlled at
[20261031000000_shared_nodes_smoke.sql](./supabase/migrations/20261031000000_shared_nodes_smoke.sql).
Before applying uniqueness constraints, run the read-only duplicate report:

[preflight_duplicate_report.sql](./supabase/preflight_duplicate_report.sql)

Review every returned duplicate manually. The report never renames or deletes
records. Apply the migration in the Supabase SQL Editor or with the Supabase
CLI after authenticating the CLI with a Management API access token. The
Supabase API secret key is not a CLI database password.

The migration creates:

- `player_profiles`
- `teams`
- `team_members`
- `smoke_rooms`
- `messages`
- `room_events`

It also creates case-insensitive uniqueness indexes, a one-active-leader
constraint, foreign keys, message indexes, and RLS policies. The local
application continues using JSON/SQLite fallback storage when Supabase
variables are absent.

## APIs

Authenticated profile endpoints:

- `GET /api/profile/availability?username=<username>`
- `POST /api/profile/register`
- `POST /api/profile/update`

Smoke authorization:

- `POST /api/integration/rooms/authorize`

Profile and room identity are derived from the authenticated NODES session.
Clients cannot register or authorize another `nodeId`.

## Testing

```powershell
cd C:\Users\Asus\Downloads\NODES-main
npm run typecheck
npm test
npm run build
```

The focused integration tests cover username validation, multiplayer consent,
leader succession, persistence, offline handling, room authorization, and
Smoke invite behavior.

For Smoke:

```powershell
cd C:\Users\Asus\Downloads\smoke
node --check server.mjs
npm test
npm audit --omit=dev
```

Live Supabase tests require the migration to be applied and the backend secret
to be configured. Without those prerequisites, local tests intentionally use
isolated JSON/SQLite stores.

## Project layout

- `apps/server/src/app.ts` - authoritative game server and NODES integration.
- `apps/server/src/supabase.ts` - backend-only Supabase adapter.
- `apps/server/src/username.ts` - username validation.
- `apps/web/` - Canvas dashboard and Smoke Room controls.
- `packages/protocol/` - shared WebSocket message types.
- `supabase/migrations/` - version-controlled database schema.
- `data/` - local state and keys; ignored by Git.

## Security

- Never expose `SUPABASE_SECRET_KEY`.
- Never expose `NODES_JWT_PRIVATE_KEY`.
- Do not put secret values in `VITE_*` variables.
- Do not paste secrets into issues, logs, screenshots, or commits.
- Smoke validates JWT issuer, audience, expiry, room, membership, and
  revocation.
- NODES remains authoritative for membership and leadership; Supabase is the
  shared persistence layer, not a client-controlled authority.
