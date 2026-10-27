# Mumbai Network Garden - V1

Cooperative multiplayer browser game for Devcon 8 Mumbai. One shared network of
nodes and links; keep it connected through outages and score each round.

This is the deadline build: **one Node process, one Line, WebSocket state sync,
Canvas client, optional JSON snapshot persistence.** No Redis, no Postgres.

- Rules source of truth: `docs/PRD.md` (byte-identical copy of
  `Mumbai_Network_Garden_PRD_v1.4.md`; the original is untouched)
- **Owner PRD amendment:** `docs/PRD_AMENDMENT_2026-10-26.md` (removes starter
  links and requires consent for every edge)
- Architecture and scope: `docs/ARCHITECTURE_V1.md`
- Measured status, tests and load numbers: `docs/STATUS.md`
- Decision log: `docs/DECISIONS.md`

## What you can do

- Join with a display name; your token is kept in `localStorage`.
- **Drag your node** with touch or mouse to move it in the shared world.
- **Use WASD or the arrow keys** to move your node continuously.
- **Tap another node** to open a small request panel for that player, then choose
  **Request Connection**. Your node is always the requester; you cannot link two
  other players. Tapping your own node never opens a request.
- The requester sees `Request sent — awaiting response`. The target sees a
  **Connection Request** card with the requester's name and request ID and must
  **Accept** or **Decline**. Only Accept creates an edge. Pending requests are
  amber/dashed, not active links.
- **Search players or nodes** from the upper game area. Matching is
  case-insensitive and supports partial names/IDs. Selecting a result pans to the
  node, highlights it and opens the normal request panel; it never links
  automatically.
- **Open the Leaderboard** on the right to see the current Line ranked by
  restored repair routes and active accepted links. The local player's row is
  accented; selecting a row focuses that player's node.
- Watch other players move in real time; edges stretch between current endpoint
  positions and never break just because players move apart.
- Survive A/B/C outages: disabled nodes and links recover when Result begins.
- Reconnect after a dropped socket; the snapshot restores current positions,
  links and the current phase.

Device-motion controls are intentionally **not** implemented. Pointer drag and
keyboard are the supported movement inputs, so a browser motion-permission prompt
is never required. See `docs/STATUS.md` for what was and was not browser-tested.

## Search and contribution leaderboard

Search covers every node in the current Line, not just the viewport. It shows
node status, your relationship to the player and their active link count. It is
keyboard navigable; Escape closes the dropdown. Search selection is a discovery
action only: the request panel and its **Request Connection** button remain the
only path to an edge.

The leaderboard is a read-only view over authoritative state, not the shared
round score:

1. `restoredRoutes` descending (the PRD 6.6.1 Repair metric).
2. Active accepted non-starter links descending.
3. Case-insensitive player name, then node ID.

`NodeView.restoredRoutes` is in snapshots and `link.created` carries `byNodeId`,
so every client updates the same ranking. Sending requests, clicking and moving
award no contribution points. Full rationale and tie-breaking are D-30 in
`docs/DECISIONS.md`.

## Connection model (owner amendment)

Joining never creates an edge, including for the first node and including a join
during Result. The connection flow is own-node-only and consent-first:

1. A selects B and requests a connection.
2. The server stores the request with a 30 s TTL (`links.requestTtlMs`) and tells
   B who is asking.
3. B accepts or declines. Only Accept creates and broadcasts one edge and spends
   a token.
4. A sees `Pending`, `Accepted`, `Declined`, `Expired` or `Failed`.

The server validates ownership, node status, self-link, duplicates, degree cap,
tokens, phase and Line at request time and again at Accept. Pending requests are
never active edges and are not persisted across a server restart. Protocol v2
removes the old client `create_link` message. The PRD itself is unchanged; see
`docs/PRD_AMENDMENT_2026-10-26.md`.

## Run locally

```bash
npm install
npm run build          # builds the client into apps/web/dist
npm start              # http://localhost:8080
```

Development with reload:

```bash
npm run dev:server     # :8080, restarts on change
npm run dev:web        # :5173, proxies /ws to :8080
```

Open `http://localhost:5173` (dev) or `http://localhost:8080` (built). A full
round starts once at least 5 active nodes are present; below that the Line runs
Build-only seeding cycles.

Screen/projector view: `/screen` (same board, no HUD, read-only).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP + WebSocket port |
| `SEED` | time-based | RNG seed; fixed seed makes strike choice reproducible |
| `ADMIN_SECRET` | unset | Enables `/admin/*`; unset means admin is disabled |
| `DATA_DIR` | `./data` | Directory for `line.json`, `line.sessions.json`, and `line.teams.json` |

Secrets are read from the environment only (there is no dotenv loader).
`.env.example` is documentation; export the variables in the shell or set them in
the platform dashboard. `.env` files are git-ignored.

## Scripts

| Command | What it does |
|---|---|
| `npm test` | 115 tests: engine, golden cases, consent flow, search/ranking, geometry, real-WebSocket server tests |
| `npm run typecheck` | `tsc --noEmit` across engine, protocol, server, client and tools |
| `npm run build` | Production client bundle |
| `npm start` | Production server (serves `apps/web/dist`) |
| `npm run state:reset` | Delete persisted Line and session state (asks nothing; for demos) |
| `npm run loadtest` | Synthetic WebSocket load test against `BASE_URL`; writes `reports/loadtest-*.json` |
| `npm run loadtest:isolated` | Throwaway server + temp `DATA_DIR`, so benchmarks never pollute the demo Line |
| `npm run simulate` | Headless engine bot simulation |
| `npm run smoke` | Live round smoke test against a running server |

Bots use the real consent path: each request is `request_link`, and the target
bot auto-accepts with `respond_link`. `MOVE_MS=100` makes bots send movement
updates every 100 ms; the default `0` keeps a link-only baseline. Other knobs:
`CLIENTS`, `DURATION_MS`, `RAMP_MS`, `THINK_MS`, `BASE_URL`, `NAME_PREFIX`.

## Movement and network contract

- The server starts each node at a deterministic layout position, then owns its
  position for the rest of the Line.
- Clients send `{ type: "move", x, y }` at most every 45 ms. The message never
  names a node: the server derives the node from the session, so a client cannot
  move someone else.
- The server rejects non-finite input, clamps to the circular world
  (`movement.worldRadius`), rate-limits to `movement.maxMessagesPerSecond`, and
  limits displacement by `movement.maxSpeed` and elapsed time. A disabled node
  cannot move (PRD 6.6); its owner can still link other active nodes.
- Accepted moves are coalesced to one event per node per 5 Hz tick, then fanned
  out in the normal delta. Snapshots always contain current positions and real
  edges.
- Client rendering uses eased display positions for remote nodes and local
  prediction for your own node. The camera fits every display position; it is
  frozen while dragging so the world does not move under the finger, then eases
  back to the fit.
- **A link is an ID pair, not a length.** Moving either endpoint redraws it.
  Distance never creates, deletes, cuts or deactivates an edge. Outages and
  recovery are the only normal deactivation/recovery path.
- Strike C uses "nearest by layout distance" at the moment the strike is applied
  (current authoritative positions), per PRD 6.5. Moving can therefore change
  which nodes are spatially clustered.

## Admin API

All admin calls need `x-admin-secret: $ADMIN_SECRET` and are disabled when the
variable is unset.

```bash
curl -X POST -H "x-admin-secret: $ADMIN_SECRET" localhost:8080/admin/pause
curl -X POST -H "x-admin-secret: $ADMIN_SECRET" localhost:8080/admin/resume
curl -X POST -H "x-admin-secret: $ADMIN_SECRET" "localhost:8080/admin/reset?seed=1234"
curl -X POST -H "x-admin-secret: $ADMIN_SECRET" "localhost:8080/admin/ban?session=<sessionId>"
```

Operations: `GET /healthz`, `GET /metrics` (JSON counters, no player data).

## Deploy

### Docker (single container)

```bash
docker build -t mumbai-garden .
docker run -p 8080:8080 -e ADMIN_SECRET=change-me -v mng-data:/app/data mumbai-garden
```

Put one instance behind TLS (Caddy/nginx/Fly/Render). WebSocket upgrade must be
proxied to the same process. No sticky sessions are needed for one process;
horizontal scaling requires the Redis/sharding work that is **not** implemented
(see `docs/STATUS.md`).

### Render / Fly / Railway

- Build: `npm ci && npm run build`
- Start: `npm start`
- Health check: `/healthz`
- Set `ADMIN_SECRET` in the platform dashboard, never in git.
- Set `DATA_DIR` to a mounted volume if restart recovery matters.

The process writes state snapshots every 10 s and on shutdown (best effort). The
JSON files are replaced atomically one at a time; they are not a transaction, so
a crash between file replacements can leave different files from different
save moments. Startup validates each file and ignores malformed or incompatible
records. Pending connection requests and Packet Run runtime state are intentionally
not persisted.
On ephemeral filesystems that file disappears on redeploy; attach a small volume
for restart survival.

## Verified here

`docs/STATUS.md` records the exact commands, the 115-test result, the two-session
consent pass, the three-session search/leaderboard pass, the 50-client consent
and movement load tests, and the remaining limits. Nothing beyond those numbers
is claimed. In particular, this build has **not** been load-tested at 10,000
concurrent users and does not claim that capacity.
