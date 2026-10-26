# V1 architecture - deadline build (3 days)

**PRD status:** `docs/PRD.md` is a byte-identical copy of
`Mumbai_Network_Garden_PRD_v1.4.md` (hash checked). The original is untouched.
The owner overrode PRD 6.2 (starter links) and 6.3 (helper links) on 2026-10-26;
`docs/PRD_AMENDMENT_2026-10-26.md` is authoritative for V1. V1 divergences and
unimplemented items are listed in `docs/STATUS.md`; nothing is silently dropped.

**Constraint:** a working, deployable game matters more than breadth.

## Shape

```text
Browser (Canvas 2D, vanilla TS)
  |  WebSocket JSON v2: join, request_link, respond_link, move, resync, ping
  |  snapshot on connect; 5 Hz event deltas; request statuses
  v
Node process (single)
  |- HTTP: static client, /healthz, /metrics, /admin/*
  |- LineHost: one authoritative Line, serialized actions
  |- packages/engine: deterministic rules engine (rules, strikes, scoring)
  `- data/line.json: snapshot every 10 s + shutdown (best effort)
```

One process, one Line, no database. No Redis, no Postgres, no containers required
to run.

## Why this shape

| Decision | Reason |
|---|---|
| Vanilla TS + Canvas instead of React | one small build, no render framework on a 3-day clock |
| Engine reused, not rewritten | it already implements 6.2-6.6.1 with Appendix B golden tests; 6.2 starter links are overridden by the owner amendment |
| Single Line (400 nodes) | matches the PRD shard size; a second Line is a router problem, not an engine change |
| 5 Hz tick, event deltas + snapshot | PRD Section 9 shape; cheap to implement correctly |
| In-memory state + JSON snapshots | restart recovery only; durability is 10 s, not the PRD's 5 s |
| Token in `localStorage`, sent in WS URL | no cookie/CORS surface for single-origin; documented trade-off |

## Movement and edge model

Positions and connectivity are deliberately separate:

```text
LineNode { id, x, y, status, tokens, ... }     position is mutable
LineLink { id, a, b, cut, starter, ... }       connectivity; no length
```

- The engine gives every node a deterministic initial layout position
  (`positionFor`, golden-angle spiral). The server then treats `x/y` as an
  authoritative, mutable attribute.
- A move message is validated by the server (session owns the node, finite values,
  active node, rate, world radius, speed budget), then applied by
  `moveNode` in `packages/engine/src/movement.ts`. That hot-path function changes
  only `x`, `y`, `now` and `seq`; it never touches links or player resources.
- Move events are coalesced per node and broadcast on the next 5 Hz tick. This
  keeps 25 Hz input from becoming 25 Hz fan-out.
- Clients send at most every 45 ms, predict their own node locally, and ease
  remote display positions toward the authoritative values. Camera fit uses the
  display positions; the camera is frozen while dragging, then eases back.
- Edges are rendered from the current display positions of both endpoints. There
  is no distance threshold for deletion, cutting or disabling. Only an outage,
  repair, reset or other PRD-authorized rule changes link state.
- Strike C resolves "nearest by layout distance" from the current authoritative
  positions at outage time. Movement can alter spatial clustering; this is an
  explicit consequence of the owner's movement requirement.

## Consent-first link flow (protocol v2)

Owner amendment A-1/A-2 (`docs/PRD_AMENDMENT_2026-10-26.md`) removes the PRD
starter link and third-party helper links. **Joining creates no edge.** An edge
exists only after the target explicitly accepts a request from the owner of the
other endpoint.

1. `join` -> engine creates an isolated node at the next layout position and
   tokens; server sends `welcome` + full `snapshot`. No starter link, no deferred
   starter action.
2. `request_link { targetNodeId }` -> server derives the requester node from the
   session, validates both nodes, ownership, self-link, duplicate edge, duplicate
   pending request, degree cap, tokens, phase and Line. It stores a pending
   request with a TTL, sends `request_result(pending)` to the requester and
   `link_request` to the target. **No edge is created.**
3. `respond_link { requestId, accept }` -> only the named target session may
   respond. Decline resolves the request to `declined` and sends that status to
   both sides. Accept re-runs the engine's normal link validation against current
   state; only a successful result creates one edge and broadcasts `link.created`.
   A repeated response replays the stored terminal outcome and never creates a
   second edge.
4. Expiry -> the 5 Hz tick (and a late response) checks TTL. The request resolves
   to `expired`; both sides receive that status; no edge or token change.
5. `move` -> server validates and mutates position; event is queued; next tick
   sends one `node.moved` per moved node inside the normal delta.
6. Tick -> phase transitions, token regeneration, request expiry, coalesced moves.
   Snapshots are written every 10 s and on shutdown.
7. Reconnect -> token resolves to the same node; a fresh snapshot carries current
   positions, accepted edges, phase, score and any pending incoming/outgoing
   requests. Pending requests do not survive a server restart.

`create_link` is not a client message. The engine still exports a validated
`createLink` primitive used internally by Accept. Server-owned request records are
kept separate from edges: pending requests appear in snapshots; terminal
accepted/declined/expired/failed records are a bounded in-memory history used to
make retries idempotent. Request records are cleared on reset; expiry, accepts,
declines and failures are counted in `/metrics`.

## Player discovery and contribution leaderboard

Search and ranking are read-only views over the same authoritative Line state.
There is no second score store and no client-to-server search endpoint.

- **Search** scans every node in the current Line (not just the viewport), matches
  names and node IDs case-insensitively, and shows node status plus the viewer's
  relationship (`Connected`, `Request pending`, `Incoming request`, `Not
  connected`, or `You`) and active degree. Selecting a result pans the camera,
  rings the node, and opens the existing target panel. It never sends
  `request_link`; only the panel's explicit **Request Connection** button does.
  Search is keyboard navigable and Escape closes it.
- **Leaderboard** orders all players by `restoredRoutes` descending (the PRD
  6.6.1 Repair metric), then active accepted non-starter links descending, then
  case-insensitive name and node ID. The two columns are shown as **REP** and
  **LINKS**. The panel is collapsible, updates from snapshot/delta events, and
  highlights the local player. Selection focuses the same node as search.
- **Authority:** `NodeView.restoredRoutes` is included in snapshots and a
  `node.joined` delta initializes it to zero. A successful Repair link emits
  `link.created` with `byNodeId` (the requester's node) and `restoredRoute`;
  every client increments the same counter. Active degree is derived from the
  broadcast `LinkView` graph, counting a link only while both endpoints are
  active and it is not a starter edge, so outage, recovery, accept and movement
  events produce the same ranking on every client. The shared team round score
  is untouched.

`apps/web/src/community.ts` contains the pure ranking/search functions; tests are
in `apps/web/test/community.test.ts`. The UI is in `apps/web/src/main.ts`, with
markup in `apps/web/index.html` and styling in `apps/web/src/style.css`.

## Tests and evidence

- `packages/engine/test`: rules, strikes, scoring, Appendix B, join isolation
  (zero auto-edges, including joins during Result), movement semantics.
- `apps/web/test/geometry.test.ts`: pure node/edge geometry and fitted-viewport
  checks. `apps/web/test/render.test.ts` calls the real `drawBoard` with a
  recording canvas context and asserts moved-node arcs and endpoint segments.
- `apps/web/test/community.test.ts`: case-insensitive exact/partial search,
  no-result behaviour, ranking order, active-link filtering, deterministic ties,
  current-player marking and relationship state.
- `apps/server/test/server.test.ts`: real HTTP/WebSocket clients, including zero
  edges on join, unconnected visibility, pending no-edge, multiple simultaneous
  incoming requests, Accept broadcast, Decline, expiry, duplicate prevention,
  repeated-accept idempotency, unauthorized responses, legacy `create_link`
  rejection, movement broadcast, late join, overlap not auto-connecting,
  speed/world clamps and degree cap after movement.
- Browser evidence: two independent Chrome profiles completed an own-node check,
  join -> selection -> pending -> duplicate-click check -> decline -> accept ->
  movement with exactly one edge and no console errors (31/31 checks).
  Screenshots and check log are in `reports/ui-consent-2026-10-26/` (ignored).
- Search/leaderboard browser evidence: three independent Chrome profiles against
  an isolated server passed 44/44 checks. Search selection created no edge or
  request, the consent flow created exactly one edge per Accept, both connected
  clients re-ranked live after the second edge, leaderboard rows focused the
  correct nodes, movement preserved both edges, and a 390x844 emulated viewport
  kept both panels inside the viewport. Script and screenshots are in
  `reports/ui-search-leaderboard-2026-10-27/`.
- `docs/STATUS.md` records the 115-test run, the independent browser sessions,
  the 50-client consent and movement load tests, and the remaining limits.

## Out of scope for V1 (explicit)

Multiple Lines/sharding, Redis ownership, Postgres/event log, profiles, chat,
timelapse, i18n, pinch-zoom, device-motion controls, admin UI beyond HTTP
endpoints, online-presence tracking/rename, and any capacity claim above
measured load. Search and the contribution leaderboard are included as read-only
V1 views; they do not change team scoring. Each exclusion is either a PRD Phase 4
item or a documented deviation in `docs/STATUS.md`.
