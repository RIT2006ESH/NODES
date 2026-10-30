# Decisions — Mumbai Network Garden

**Phase:** 0 (Greenfield Readiness Review)
**Last updated:** 2026-10-26
**Status legend:** PROPOSED = recommendation, not in force · BLOCKED = owner ruling required · VERIFIED = observed fact · UNKNOWN = not established

> Nothing in this file is final. Per PRD Section 16 item 6, no unapproved decision is presented as settled. Defaults in PRD Section 22 continue to apply until the owner changes them.

---

## 0. Gate record

| Item | Value |
|---|---|
| Phase 0 report issued | 2026-10-26 |
| Owner written approval | **GIVEN 2026-10-26** — owner selected "Approve — adopt the proposed rulings (Recommended)" |
| Implementation authorized | **YES — Phase 1 only** |
| Approved rulings | D-R1 (caps absolute; difficulty does not add strike targets) · D-R2 (6.2 L99 governs starter links; **superseded for V1 by D-26**) · D-R3 (N = 0…3 are defensive guards, tested by state injection) · D-02 (TypeScript end-to-end) · D-03/D-04/D-05/D-06/D-10/D-11 as proposed |
| NOT approved | D-R4…D-R13 (Phase 2+), D-07/D-08/D-09/D-12…D-16 (Phase 2+ surfaces), D-R10 (PRD canonicalization — still outstanding) |
| Next permitted action | Phase 1: rules engine, config, golden tests, property tests, bot simulation. No server, no UI, no database. |

*(When the owner approves, append a dated line here quoting the approval message verbatim. Do not paraphrase an approval.)*

---

## 1. Decisions requested from the owner (blocking)

| ID | Decision needed | Why it blocks | Proposed default (PROPOSED) |
|---|---|---|---|
| **D-R1** | Difficulty vs. outage cap (C-01) | Strike/scoring engine cannot be written two ways | Caps are absolute; difficulty escalates the *mix and frequency* of strikes, not the node count |
| **D-R2** | Canonical starter-link rule (C-02) | Starter-link tests and join behaviour | 6.2 line 99 governs; fix the 6.5 cross-reference to point at the degree cap (6.3), not "low-degree". **Superseded for V1 by D-26.** |
| **D-R3** | Policy for unreachable scoring states (C-03) | Phase 1 test plan and "every case covered" gate | Treat N = 0/1/2/3 as defensive guards, unit-tested by direct state injection, not reachable by play; keep Appendix B as the play-reachable set |
| **D-R4** | Timelapse scope (C-05) | Phase 3 vs Phase 2 backlog | Phase 2 candidate, as Section 4 says; strike FR-20 from the MVP table |
| **D-R5** | Community-score weighting (A-03) | Aggregation is testable behaviour | Weight = active nodes at round start, per Line; Lines with no completed round excluded; paused Lines keep last score at frozen weight |
| **D-R6** | Line capacity accounting and exhaustion (A-05) | Join/assignment logic, load model | Capacity counts nodes (not sessions); "open" = `status = 'active'` and below capacity; new Line created while any active Line ≥ 90% full; hard ceiling of 40 Lines, then join fails with an explicit code (see D-R13) |
| **D-R7** | Durability target for the event log (C-04) | Persistence design and the 5 s claim | Event log flushed ≤ 1 s (group commit); snapshots stay at 10 s; the 5 s bound is then met by the log, not the snapshot |
| **D-R8** | Hardware/hosting/budget ceiling (D-16) | PRD decision 5; Phase 4 cannot start | Unknown — requires owner quote/ceiling; see report Section 10 |
| **D-R9** | Join bot challenge (A-11) | Join UX, latency, abuse posture | Provider-agnostic: server-issued signed challenge with a 2 s difficulty budget, no third-party widget, no per-IP blocking |
| **D-R10** | PRD canonicalization (C-09) | Section 0 rule 5 and Section 23 both reference `docs/PRD.md` | Move the PRD to `docs/PRD.md` verbatim, keep the versioned copy, give the project its own git repository |
| **D-R11** | Ban semantics (A-15) | Reconnect, moderation, data model | Ban hides the session, marks the node inactive-forever, drops the socket, and refuses resume with a dedicated code; node is removed at the next snapshot |
| **D-R12** | Retention vs. snapshot export (A-13) | Privacy statement, Phase 6 | Snapshot export strips display names, or is owner-only and deleted with the dataset |
| **D-R13** | Closed rejection-code list (G-01, A-05) | Protocol version / maintenance / banned / Line-full have no code today | Add `PROTOCOL_UNSUPPORTED`, `MAINTENANCE`, `SESSION_BANNED`, `LINE_FULL`; widen FR-32 from "rejection reasons" to "stable codes" |

---

## 2. Proposed technical decisions (not final)

### D-01 — Project home and PRD canonical path
**Status:** PROPOSED, blocked on D-R10.
**Proposal:** Dedicated git repository rooted at this folder; PRD at `docs/PRD.md`; versioned snapshot retained as `docs/PRD_v1.4.md`; `STATUS.md` and `DECISIONS.md` committed alongside.
**Rationale:** PRD Section 0 rule 5 and Section 23 assume this path; today the file sits at the repository root and the folder is untracked inside an unrelated Desktop git root (VERIFIED).
**Alternatives:** (a) keep the root filename and amend the PRD's own references; (b) keep both, with `docs/PRD.md` as the single editable copy.
**Rejected:** editing the PRD now — Phase 0 forbids changing it.

### D-02 — Technology stack
**Status:** PROPOSED. Owner ruling pending (affects Phase 1 packaging and Phase 2 start).
**Proposal:** TypeScript end to end. `packages/engine` is pure TS with zero I/O; frontend React + TypeScript + Vite with a hand-written Canvas 2D renderer; backend Node.js (Fastify + `ws`/uWebSockets.js) as the authoritative host.
**Rationale:** Section 9 permits "FastAPI **or another justified server**" and a "TypeScript **or** Python" engine. One language lets the *same* pure engine drive FR-27 previews (glow/dim) while the server stays authoritative — no second implementation of the rules in JS, which is the main failure mode of a Python-backend + TS-frontend split. One toolchain for Appendix B golden tests, property tests and the bot simulator. Lowest iteration cost for one developer.
**Alternatives:** (a) FastAPI + Python engine — strongest if the owner prefers Python; costs a duplicate JS rules port or server-provided preview hints, and two test toolchains. (b) Hybrid: TS engine on the server, Python analytics offline.
**Rejected:** any client-authoritative or CRDT design — violates Section 8 (server authoritative) and Section 6.6.1 determinism.
**Deviation notice:** this is a deviation from the *candidate* stack in Section 9, to be recorded if accepted.

### D-03 — Monorepo layout
**Status:** PROPOSED.
**Proposal:** pnpm workspace: `apps/web`, `apps/server`, `packages/{engine,protocol,config,testing}`, plus `docs/`, `infra/`, `tools/`, `tests/`. See report Section 7 for the full tree.
**Rationale:** the engine must be importable by both server and client, and by tests, without copy-paste. Single lockfile keeps the dependency surface auditable (Section 12 requires dependency scanning).
**Alternatives:** (a) two repos (server/client) with a published engine package — overhead with no benefit at this size; (b) single package — muddles the pure/impure boundary that Section 9 demands.

### D-04 — Engine purity and determinism contract
**Status:** PROPOSED.
**Proposal:** `reduce(state, action, config, seedSource) -> { state, events }` as a pure function. No `Date.now()`, no `Math.random()`, no network, no DB, no `console`. Time and randomness enter only as explicit inputs. A `stateHash(state)` enables replay equality tests. Enforce with a lint rule that bans those globals inside `packages/engine`.
**Rationale:** Section 9 ("pure, deterministic... takes (state, action) and returns (newState, events)"); Section 6.6.1 determinism; Section 14 requires determinism tests. Making the ban mechanical prevents silent drift.
**Alternatives:** class-based engine with injected clock/PRNG — workable but easier to leak state between Lines.

### D-05 — Scoring arithmetic
**Status:** PROPOSED.
**Proposal:** compute the round score as one exact rational and round once, half-up. With `C = c/N`, `B = (n − ap)/n`, `S = s2/2` (s2 ∈ {0,1,2}), use the common denominator `D = 2·N·n`: `num = 120·c·n + 60·(n−ap)·N + 20·s2·N·n`, then `score = floor((2·num + D) / (2·D))`. All integers.
**Rationale:** 6.6.1 forbids floating point and requires a single half-up rounding; B6 (92.5 → 93) is exactly the case that catches banker's rounding. This representation makes the golden tests exact by construction.
**Alternatives:** float + epsilon — rejected; rational library (bigint) — unnecessary, values stay small.

### D-06 — Seeded randomness derivation
**Status:** PROPOSED, pending D-R2.
**Proposal:** per-Line base seed stored in `lines.seed`. Derive independent streams by purpose: `stream = hash(lineSeed, roundNo, purpose)` for `purpose ∈ {strike.type, strike.target, strike.tie, starter.tie, layout.jitter, link.jitter}`; PRNG is a fixed 32-bit generator with rejection sampling to avoid modulo bias; outputs are integers.
**Rationale:** one shared stream makes outcomes order-dependent (a starter link would shift the next strike); purpose-tagged streams make each decision reproducible in isolation and make A-02 answerable.
**Note:** the *round number used for a starter-link tie-break* is still an open ambiguity (A-02) — proposal: the round in progress, or `round_no + 1` if the attempt is deferred to the next Build.

### D-07 — Process model: single writer now, owners later
**Status:** PROPOSED.
**Proposal:** Phase 2 runs **all** Lines in one server process, each Line behind a serialized action queue (an in-memory actor). Define the seam now as a `LineHost` interface (`submit(action) -> result`, `subscribe(cb)`, `snapshot()`, `tick()`). Phase 4 moves `LineHost` behind the Redis lease + Streams transport without touching engine or protocol code.
**Rationale:** Section 9's Redis lease/Streams design is explicitly "a hypothesis" for Phase 4 to benchmark. Building it in Phase 2 would spend the MVP budget on unproven infrastructure and make the Phase 4 benchmark meaningless (no baseline to compare). Serialized single-writer per Line also gives the "exactly one valid result" guarantee in Section 14's concurrency test for free.
**Alternatives:** (a) Redis lease from day 1 — premature; (b) sticky routing per Line — must remain a candidate in the Phase 4 benchmark (Section 9 requirement).

### D-08 — Persistence from Phase 2, Redis deferred
**Status:** PROPOSED, pending D-R7.
**Proposal:** Postgres holds `snapshots` (every 10 s per Line) and an append-only `events` log with group-commit ≤ 1 s; hot state lives in process memory in Phase 2, in Redis from Phase 4. Restart = load latest snapshot + replay log tail.
**Rationale:** FR-13 (M) requires restart survival in the MVP; Section 9 already specifies the snapshot + event-log shape; adding Redis only when there is more than one process avoids a single-Redis dependency in the demo phase.
**Alternatives:** Redis from Phase 2 — acceptable, but then the 5 s loss bound is bounded by Redis persistence settings, not by our log flush, which weakens the test.
**Open:** the exact "max state loss" proof method belongs in the Phase 2 gate artifact.

### D-09 — Transport and sync
**Status:** PROPOSED.
**Proposal:** WebSocket, JSON, protocol `v` in every message. On connect: `snapshot(seq, state)`. Afterwards: one batched `delta(seq, events[])` per Line per tick (default 5 Hz, config-driven). Per-Line ring buffer of the last 500 events; if a reconnecting client's `last_seq` is older, send a fresh snapshot. `action_result(request_id, ok, reason)` per accepted/rejected action.
**Rationale:** Section 9 (batched deltas, 5 Hz, 500-event buffer, snapshot fallback); Section 11 message set. Batching is what keeps Section 15's 56k msg/s fan-out from becoming per-action fan-out.
**Alternatives:** per-action broadcast (rejected: fan-out explosion); binary encoding (deferred: the 1 KB message cap makes JSON adequate; revisit only if Phase 5 measures a problem).

### D-10 — Layout algorithm
**Status:** SUPERSEDED by D-22 for the immutability clause; the spiral layout remains the initial placement. UX sign-off A-08 still open.
**Proposal:** deterministic server-side placement — golden-angle spiral inside the Line's ring, radius by insertion order, small seeded jitter for organic feel; coordinates are **immutable after creation** (except organizer reset). Strike C's "nearest by layout distance" is then well-defined forever.
**Rationale:** 6.2 requires server-computed positions; 6.5 strike C depends on layout distance; 13's aesthetic wants a non-grid look. Immutability removes a whole class of ambiguity and makes replay exact.
**Alternatives:** force-directed at join — rejected (nondeterministic, moves nodes under the player's finger, breaks strike distances); pre-authored train-map geometry — attractive for the Mumbai theme, but needs a designer and does not scale to 400 nodes/Lines.
**Risk:** spiral packing may read as a "hairball" earlier than the PRD's risk table assumes; Phase 3 playtest decides.

### D-11 — Config format
**Status:** PROPOSED.
**Proposal:** one JSON file validated by a schema at boot (fail fast), plus typed defaults in `packages/config`. Server sends the subset the client needs (durations, caps, token regen) inside the snapshot so the HUD cannot drift from authority. No tunable constant in code.
**Rationale:** Section 0 rule 6 ("Tunable numbers live in one config file") and Section 24 (defaults).
**Alternatives:** YAML (nice comments, worse tooling); TS module (no validation, and the client would import server logic).

### D-12 — Admin and spectator surfaces
**Status:** PROPOSED.
**Proposal:** same web app, separate routes: `/screen` (read-only WS subscription, no auth) and `/admin` (server-validated secret in `Authorization` header, session cookie, confirmation dialogs). Admin actions are appended to an `admin_audit` table.
**Rationale:** FR-17 requires `/screen`, FR-18 requires a secret-protected panel; one deployable front end keeps the bundle and the design system shared. Section 12 requires the secret never ship in the client bundle.
**Alternatives:** separate admin app — more isolation, more build/deploy overhead for one event.

### D-13 — Idempotency store
**Status:** PROPOSED (fills a data-model gap).
**Proposal:** `actions(request_id PK, session_id, line_id, type, result, reason, created_at)`; in-memory map for hot lookup, Postgres for resume after restart; retention ≥ the session token TTL and ≥ the 500-event window; cap of 32 pending `request_id`s per session.
**Rationale:** Section 11 ("duplicate request_id values must not create duplicate links"), FR-29/FR-33, and Section 10 currently has nowhere to store them.
**Alternatives:** rely on the unique `(node_a, node_b)` link pair only — insufficient, because a retried *rejected* action must return the same rejection, and a retried action that has since become legal must not silently succeed.

### D-14 — Observability
**Status:** PROPOSED.
**Proposal:** `/healthz` (liveness + lease/DB checks), `/metrics` (Prometheus: connections, actions/s, p95/p99 action latency, error rate, Line occupancy, phase, RSS, CPU), structured JSON logs with correlation ids. Alert thresholds are **UNKNOWN** until baseline measurement; they will be set from Phase 2 data and recorded here.
**Rationale:** Section 18 lists exactly these metrics but no requirement owns them.
**Alternatives:** hosted APM — fine, but vendor cost is part of D-R8.

### D-15 — Load-test tooling
**Status:** PROPOSED.
**Proposal:** k6 with the WebSocket extension, one script per Section 15 scenario (a)–(i), plus a shared scenarios file. Raw results, scripts, environment description and the written report are committed under `tools/loadtest/results/<date>/`.
**Rationale:** Section 15 requires committed scripts and exact environment; scenario (i) (reconnect storm during simultaneous repairs) needs scripted coordination.
**Alternatives:** Artillery (weaker WS control); custom Node bots (allowed as a second harness only if k6 cannot express scenario (i)).

### D-16 — Hosting and budget
**Status:** BLOCKED — owner decision D-R8. **UNKNOWN today.**
**Shape (PROPOSED, unverified):** region `ap-south-1` (Mumbai) for venue latency; Phase 2–3 single app node + managed Postgres; Phase 4 two app nodes + managed Redis + managed Postgres; static assets on a CDN; WebSocket egress dominates cost at Section 15 volumes.
**Constraint from the PRD:** must be stated before Phase 4 (Section 22 decision 5, Section 16 item 5). No cost figure is claimed here — none has been quoted.

---

## 3. Rejected options (recorded to prevent re-litigation)

| Option | Why rejected |
|---|---|
| Redis lease + Streams in Phase 2 | Section 9 calls it a hypothesis; building it before the baseline removes the Phase 4 comparison and burns MVP time |
| Client-side score computation | Section 8: server authoritative |
| One WS message per action | Section 9 requires batched 5 Hz deltas; Section 15 fan-out would be 8–16× larger |
| WebGL first | 400 nodes is Canvas 2D territory; WebGL only if Phase 3 misses 30 fps |
| Separate Python rules service | Duplicate rules = drift, and 6.6.1 exactness makes drift unacceptable |
| Per-IP blocking at join | Section 12 warns explicitly about conference NAT |
| Floating-point scoring | 6.6.1 forbids it; B6 is the trap |

---

## 4. Append log

### D-31 — V1 team projection and ranking (2026-10-27)

**Status:** IMPLEMENTED FOUNDATION; Surprise Zone transition remains open.

For the team-system extension, team membership is derived only from connected
components of active accepted links within the authoritative Line. Pending
requests and inactive links do not contribute. Team leaderboard ordering is
deterministic: member count descending, then aggregate restored routes,
aggregate active non-starter links, then stable team ID. This is a separate
contribution metric and does not modify the engine's network resilience score.
Team names are server-owned, trimmed to 32 characters, and inherited on merges
from the larger prior group; equal-size merges use earlier creation time and
then stable ID. Team state is synchronized in snapshots and deltas.

The existing V1 architecture has one Line and no room/area or transition
protocol. A decorative client-only Surprise Zone would violate server
authority, so no fake zone transition is being claimed. A real zone requires an
authoritative area/room model, qualification event, reconnect semantics, and
tests before implementation.

| Date | Entry | By |
|---|---|---|
| 2026-10-26 | Phase 0 review opened. PRD read from `C:\Users\Asus\Desktop\nodes\Mumbai_Network_Garden_PRD_v1.4.md` (no `docs/PRD.md`). 10 contradictions, 16 ambiguities, 12 gaps recorded. No code, no dependencies, no PRD edits. | Technical lead |
| 2026-10-26 | D-R1 … D-R13 issued for owner ruling. Phase 0 gate pending. | Technical lead |
| 2026-10-26 | Owner instructed "start building" (×2). Logged as a directive, not as gate approval: it does not name accepted rulings for C-01/C-02/C-03 or the stack (D-02). No code, scaffold or dependency created. Gate remains pending. | Technical lead |
| 2026-10-26 | **Phase 0 gate APPROVED.** Owner selected "Approve — adopt the proposed rulings (Recommended)". Adopted: D-R1 (caps absolute; difficulty never adds strike targets), D-R2 (6.2 L99 governs starter links), D-R3 (N=0…3 defensive guards, tested by state injection), D-02 (TypeScript end-to-end). Phase 1 authorized. | Owner |
| 2026-10-26 | Phase 1 started: engine package, config, golden fixtures, property tests, bot simulator. No server, UI or database. | Technical lead |
| 2026-10-26 | **Owner switched to deadline mode** (2–3 days to a deployable game). Phase-gate sequencing superseded by that directive. Scope decisions for V1 recorded below. | Owner |
| 2026-10-26 | `docs/PRD.md` created as a byte-identical copy of `Mumbai_Network_Garden_PRD_v1.4.md` (SHA-256 compared before/after). Original untouched. This resolves the path used by PRD Section 0 rule 5 without editing the PRD. | Build session |
| 2026-10-26 | **D-17 (V1):** one Line per process, capacity 400. Multi-Line routing, Redis and Postgres are explicitly out of V1. **D-18:** vanilla TypeScript + Canvas 2D client (no React) to keep the build small and the 3-day path short. **D-19:** restart recovery via JSON snapshots (state every 10 s + shutdown, session tokens alongside) instead of an event log; the 5 s loss bound is therefore not met. **D-20:** session token in the WebSocket URL, served same-origin behind TLS; origin checks and httpOnly cookies are not implemented. **D-21:** moderation = name sanitisation + 2 link attempts/s/session + session ban; no bot challenge, no IP bans. | Build session |
| 2026-10-26 | Phase 1 acceptance evidence restated: `tsc --noEmit` clean, 53 engine/protocol tests green. Phase 1 gate report not issued separately because the owner directive replaced the gate process. | Build session |
| 2026-10-26 | V1 server + client integration: 68 tests green (15 new real-WebSocket protocol tests, incl. resume across restart). 50-client load test: 6305 actions, p95 15.5 ms, p99 19.8 ms, 0 errors, 647.9 B/s per client, tick 2 ms. No claim beyond 50 clients. | Build session |
| 2026-10-26 | Open and unchanged: D-R4–D-R13, D-07/D-08/D-09, D-12–D-16 (hosting/budget still UNKNOWN). The PRD was not edited; canonicalisation decisions remain with the owner. | Build session |

### D-32 — Authoritative team qualification and Surprise Zone (2026-10-27)

**Status:** IMPLEMENTED MINIMAL V1 EXTENSION.

Teams remain active connected components of the single Line. A team is
qualified only at the Repair-to-Result transition when it has at least three
members and either the scored Line connectivity is at least 90% or a member
created a qualifying restored route during Repair. The ranked qualifying team
with the most members, recoveries, active links, then stable team ID enters the
Surprise Zone. The zone is represented by a server-owned per-node area (`main`
or `surprise`) in the same authoritative process; no client-only overlay or
second game mode is introduced. Zone entry is performed once per transition,
preserves the team ID/name/member set, and active links/routes cannot cross
areas. Reconnecting sessions receive the same area in the authoritative
snapshot for the lifetime of the process. Area persistence across process
restart remains outside this minimal extension and is a release blocker.


---

## 5. Post-deadline decisions (movement increment)

### D-22 - Player movement and persistent edge geometry
**Status:** VERIFIED. Owner directive 2026-10-26. Supersedes D-10's immutability clause.

**Decision:** every node has a server-authoritative mutable `(x, y)`. The deterministic spiral is only the initial placement. Players move their own node by pointer drag or WASD/arrow keys. The server validates ownership (from the session, never from the message), finite values, active-node status, a 25 msg/s rate limit, the circular world radius (1400) and a speed budget (5000 units/s, 250 ms maximum elapsed allowance). Accepted moves are coalesced to one event per node per 5 Hz tick. Clients predict their own node and ease remote display positions.

**Rationale:** owner requirement for live movement; the PRD only mandates a server-computed starting position, so movement is an extension rather than a PRD rewrite. Keeping connectivity in `LineLink { id, a, b }` and positions in `LineNode` guarantees distance cannot break an edge.

**Consequences:**
- Strike C's "nearest by layout distance" uses current authoritative positions at the outage instant; moving can change spatial clustering.
- A disabled node cannot move (PRD 6.6: disabled nodes cannot be changed). Its owner can still link other active nodes.
- Movement remains available while an organizer pause is active; it changes no links or phase state.
- Rendering uses display positions for camera fit and hit-testing; the camera freezes during a drag to keep the world stable under the finger.

### D-23 - Historical starter edges are visible
**Status:** VERIFIED, narrowed by D-26. `LinkView.starter` is emitted in snapshots/deltas and the canvas draws a small midpoint dot on starter links. New joins never create starter links (D-26); the marker remains only so an older saved Line can distinguish its historical assistance edges from player-created edges.

### D-24 - Benchmarks never pollute the demo Line
**Status:** VERIFIED. Added `DATA_DIR`, `npm run state:reset`, and `npm run loadtest:isolated` (throwaway server + temp data directory). The earlier dense-mesh report was traced to persisted bot state, not join logic; benchmarks now run outside the demo state.

### D-25 - Client link-target selection
**Status:** VERIFIED, amended by D-26. Your node is always the requester; there is no third-party source selection. Tap another node to choose a target, then use **Request Connection**. Structurally unavailable targets (offline or full) are dimmed client-side; already-linked and pending targets stay vivid because they are connected/awaiting consent, not absent. The server remains authoritative.

### D-26 - Consent-first linking replaces automatic starter links
**Status:** VERIFIED. Owner override 2026-10-26, recorded in `docs/PRD_AMENDMENT_2026-10-26.md`.

**Decision:** every newcomer joins isolated. An edge exists only after the target player explicitly accepts a request from the owner of the other endpoint. Requests may name only the requester's own node and one target; helper links for a third party are forbidden. Protocol v2 replaces `create_link` with `request_link` / `respond_link`.

**Validation:** request time and Accept time both check node existence, active status, ownership, self-link, duplicates, the 5-link degree cap, tokens, phase and Line. Accept re-runs the engine's normal `create_link` validation against current state. Only the named target may respond.

**Tokens and status:** tokens are charged only when Accept creates the edge. The requester sees `Pending`, `Accepted`, `Declined`, `Expired` or `Failed`. Pending requests are never active edges and are drawn amber/dashed. Duplicate pending requests are rejected with `REQUEST_PENDING`.

**Why:** the PRD's starter/helper rules produced edges without consent and allowed one player to attach a third party. The owner required an explicit opt-in edge for every connection.

### D-27 - Pending requests are ephemeral
**Status:** VERIFIED. Requests expire after `links.requestTtlMs` (default 30 s), are checked on the tick and on response, and live only in server memory. They survive a target reconnect through the snapshot, but not a server restart. Accepted edges, sessions and positions keep the normal persisted-state guarantees.

**Rationale:** a stale request must not outlive the phase or token state under which it was made, and persisting consent prompts across a restart adds state without improving the demo. Expiry before Accept is always safe; Accept always revalidates current state.

### D-28 - Stale demo state must be cleared after the rule change
**Status:** VERIFIED. The pre-change `data/line.json` contained a historical starter edge. The loader intentionally does not delete saved edges, so the demo data was backed up and removed before acceptance. New joins are isolated; old starter edges would remain visible if an old snapshot were restored. Do not reuse pre-consent state for acceptance testing.

### D-29 - Request lifecycle records are separate from edges and make retries idempotent
**Status:** VERIFIED. Complements D-26 and D-27.

**Decision:** the server keeps one request record per request with an explicit lifecycle: `pending`, `accepted`, `declined`, `expired` or `failed`. Pending records are the only ones exposed in snapshots and rendered as dashed indicators. Terminal records remain in a bounded in-memory history (1,024 records) with their reason, retry hint or accepted link ID. A repeated `respond_link` from the target replays the stored terminal status. It never creates a second edge.

**Why:** two tabs, a double-click or a retry after a lost response are normal browser failure modes. Treating the second response as an unknown request loses the outcome and can look like an edge was created twice; deleting all record of the request also makes "declined/expired/failed" impossible to distinguish after the fact and blurs the required separation between requests and edges.

**Consequences:**
- `requests` and `edges` remain separate server structures. An accepted request points at a `linkId`; the edge lives only in the engine's link map.
- Terminal history is bounded and evicted oldest-resolved first. Pending records are never evicted.
- History is memory-only, like pending requests. A server restart loses it; accepted edges and sessions remain persisted.
- Reset clears request history alongside pending requests.

### D-30 - Player search and a contribution leaderboard use authoritative state only
**Status:** VERIFIED. UI extension requested by the owner on 2026-10-27. It does
not change the shared round score, resilience rules, strike rules, link consent
or token economy.

**Decision:** add a search control in the upper game area and a collapsible
right-side **Leaderboard** panel. Search matches the current Line's node names
and node IDs, case-insensitively, using partial substrings. Selecting a result
pans the camera, briefly highlights the node, opens the existing target panel,
and does **not** send a request or create an edge. The leaderboard ranks players
by:

1. `restoredRoutes` descending - the PRD 6.6.1 per-player pride metric. The
   engine increments it only for an accepted Repair-phase link that merged two
   disconnected components.
2. Active accepted links descending - currently active edges where
   `link.active && !link.starter`, counted at each endpoint. This is live network
   contribution; it is not a cumulative score and it falls when outages cut
   links.
3. Player name ascending (case-insensitive).
4. Node ID ascending.

The first two values are displayed as **REP** and **LINKS**. The current player's
row is accented. The ranking is a read-only projection of server state, not a
frontend-only score: snapshots carry `NodeView.restoredRoutes`, and live
`link.created` events carry `byNodeId` so every client increments the same
restored-route counter. Active link counts are derived from the same broadcast
graph in every client.

**Why:** the PRD defines only a shared network score. Reusing that as an
individual score would be false. `restoredRoutes` is already authoritative and
player-owned; active accepted links are the other existing player action that can
be observed without inventing points. Request sends, clicks, joins and movement
award nothing. The PRD calls restored routes a pride metric, not a ranking
(6.6.1), and FR-34 describes only an optional callout with no persistent ranking.
This owner-requested panel is therefore a display-only V1 extension; it does not
change the PRD, the shared round score, resilience rules or link incentives.

**Consequences:**
- The team score, Last Score and Network Health displays are untouched.
- Leaderboard ties are deterministic; there is no random or clock-based order.
- Search covers every node in the current single Line, not just the viewport.
  There is no cross-Line visibility because V1 has one Line.
- Selecting a player only focuses/selects; the existing Request Connection action
  and consent flow remain the only path to an edge.
- V1 has no leave or rename command, and a disconnected session reconnects to the
  same node. Search therefore shows node status (`active` / `disabled until
  results`) and the viewer's relationship (`Connected`, `Request pending`,
  `Incoming request`, `Not connected`, or `You`) rather than a separate online
  presence flag.

## 6. Late append log

| Date | Entry | By |
|---|---|---|
| 2026-10-26 | Movement increment implemented and verified: 98 tests in 11 files, `tsc --noEmit` clean, production build 18.26 kB JS (7.14 kB gzip). 3-client live process check observed a moved node and its persistent active edge in both a peer resync and a late-join snapshot. | Build session |
| 2026-10-26 | 50-client movement load test (30 s, move every 100 ms): 15,695 moves, 1,623 link actions, p95 26.8 ms, p99 37.6 ms, 27,368 B/s per client, tick 2 ms, 0 errors. Link-only 50-client baseline (90 s): 4,594 actions, p95 44.5 ms, p99 57.2 ms, 829.2 B/s per client, 0 errors. No capacity claim beyond 50 clients. | Build session |
| 2026-10-26 | Not verified: actual browser Canvas drag/touch/keyboard and interpolation (no attached browser, no Playwright/Puppeteer). Browser QA remains a release blocker; see `docs/STATUS.md`. | Build session |
| 2026-10-26 | **Owner override:** remove the automatic starter link (PRD 6.2) and require consent for every edge (PRD 6.3). Protocol v2 (`request_link` / `respond_link`), 30 s request TTL, server-owned pending requests, Accept-time revalidation. `docs/PRD.md` unchanged; amendment in `docs/PRD_AMENDMENT_2026-10-26.md`. | Owner + build session |
| 2026-10-26 | Consent flow verified: 103/103 tests, `tsc --noEmit` clean, production build 20.72 kB JS (7.80 kB gzip), two independent Chrome profiles completed join -> pending -> decline -> accept -> move with one edge and zero browser errors. Updated 50-client link/movement load tests: 123 and 118 accepted edges, p99 4.2 / 7.0 ms, 0 errors. Screenshots and check log in `reports/ui-consent-2026-10-26/` (ignored evidence). | Build session |
| 2026-10-27 | Request lifecycle hardened and UI clarified: pending/accepted/declined/expired/failed request records are separate from edges; terminal outcomes are bounded and replay idempotently on repeated Accept/Decline. Target panel shows the player's name and "no line until accepted"; incoming cards show the unique request ID; outgoing card shows `Request sent — awaiting response`. 105/105 tests (including multiple incoming requests on resync), `tsc --noEmit` clean, production build 21.33 kB JS (7.95 kB gzip), 31/31 two-profile browser checks including own-node rejection and duplicate-click prevention. | Build session |
| 2026-10-27 | **D-30:** added player search and a collapsible contribution leaderboard. Primary metric is the PRD 6.6.1 `restoredRoutes`; secondary is active accepted links; deterministic name/node-ID tie-break. `NodeView.restoredRoutes` and `link.created.byNodeId` make the ranking live across clients without a frontend-only score. Three independent Chrome profiles passed 44/44 checks, including no-edge search selection, no-result Enter safety, request consent, live re-ranking in all sessions, movement persistence, 390 px layout and reconnect/default-collapsed behaviour. 115/115 tests; `tsc --noEmit` clean; production build 29.51 kB JS (10.31 kB gzip). | Build session |
