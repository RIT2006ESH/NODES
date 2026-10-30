# Mumbai Network Garden — Product Requirements Document

Version 1.4 (draft for approval) · Owner: Ritesh Singh · Event: Devcon 8, Mumbai · Status: not yet implemented · Ready for Phase 0 audit only

Revision 1.4 summary: changed Phase 0 from adapting/auditing NetQuest to a greenfield project-definition and setup plan; clarified that no existing repository is required and that implementation starts only after the Phase 0 gate is approved.  starter-link phase gating clarified for every phase in which link creation is locked; corresponding tests added. Revision 1.2: starter-link phase gating and exact low-degree target selection clarified; corresponding tests added. outage and repair rules clarified (6.4, 6.5); scoring edge cases and seeding mode made exact, with golden test cases (6.6, 6.6.1, Appendix B); multiplayer orientation, rejection codes and recovery detailed (6.9, FR-25 to FR-33, Section 11); scale-out treated as a benchmark target with an added combined scenario (Sections 9, 15, 17); Phase 0 made the only permitted work, with an access check and a written approval gate (Sections 0, 16, 17, Appendix A).

## 0. How to use this document (read first, any AI model or human)

This PRD is the single source of truth for the project. It is written so that any model or contributor can pick up the work at any point and stay on task.

Rules of engagement

Precedence. This PRD overrides chat history, assumptions, and your own preferences. If something conflicts, follow the PRD and flag the conflict.

Do not invent. Never claim a file, module, feature, test result, or performance number exists unless you inspected or measured it. Label everything as VERIFIED (seen or measured), PROPOSED (planned), or UNKNOWN.

Stop and ask when the repository is not accessible, a requirement is ambiguous, or a decision in Section 22 (Open decisions) blocks you. Do not guess silently.

Work in phases (Section 17). Complete one phase, produce its gate artifacts, and stop for approval. Do not start the next phase uninvited.

Session continuity. At the start of every session read this PRD, docs/STATUS.md, and docs/DECISIONS.md. At the end, update STATUS.md (what is done, what is next, what is blocked) and append any decision to DECISIONS.md with date and reason. Create these files in Phase 0 if absent.

Scope discipline. Anything not listed in Section 4 (Scope) is out of scope. Propose additions; do not implement them.

Fixed game design. The game rules in Section 6 are decided defaults. Do not redesign them. Tunable numbers live in one config file (game.config) so they can change without code changes.

Complete file output. When changing a file, output the complete updated file, not partial diffs, unless told otherwise.

Honesty about scale. Never state that the system supports 10,000 concurrent users until a load test meeting Section 15 acceptance criteria has passed and the report is committed.

Starting state: this is a greenfield project being built from scratch. The project may not have a repository yet. Phase 0 is therefore a requirements and implementation-readiness review, not an audit of NetQuest or any other existing codebase. In Phase 0, the only permitted work is to review this PRD, identify contradictions or blocking decisions, propose a minimal architecture and repository structure, and prepare docs/STATUS.md and docs/DECISIONS.md (plus a Phase 0 report). Do not write application/game code, install dependencies, or scaffold the application until the owner approves the Phase 0 report in writing. The report must end with “Awaiting owner approval”, and then the session stops. Approval is an explicit written message from the owner; silence or the model’s own judgment is not approval. Existing repositories may be audited only if the owner later provides one and explicitly asks for that audit.

## 1. Product summary

Mumbai Network Garden is a collaborative multiplayer browser game. Devcon 8 visitors join instantly (no wallet, no account), each adds one glowing node to a shared network, links it to others, and together they keep the network connected while the game periodically knocks out nodes and links. The community score reflects how resilient the shared network is.

One-sentence pitch: A collaborative multiplayer browser game where Devcon visitors build one shared digital network, repair it when parts fail, and feel how decentralized networks stay resilient.

This is a real game with goals, rules, feedback, and scoring. It is not a graph editor, a visualization, or a network simulator.

## 2. Goals and success metrics

The 10,000-concurrent figure is an engineering target, not verified capacity.

## 3. Non-goals

No blockchain transactions, mandatory wallets, NFTs, tokens, or on-chain anything.

No real libp2p or Ethereum networking in the MVP. Nodes are virtual. All UI copy must say “simulated network”.

No user accounts, profiles, chat, or social features.

No competitive per-player leaderboards as the primary goal. The game is cooperative. (A light “top contributor” callout is allowed, see FR-34.)

No lengthy tutorials, configuration panels, or network-engineering jargon in the main UI.

## 4. Scope

In scope (MVP): join flow, shared shards (“Lines”), node placement, link creation under a budget, outage rounds, resilience scoring, live sync, persistence, reconnection, rate limiting, mobile + desktop UI, Mumbai-inspired visual theme, organizer admin tools, tests, load tests, documentation.

Phase 2 candidate (only after MVP is accepted): gossip-propagation challenge, post-event timelapse export, multilingual UI.

Out of scope: everything in Section 3.

## 5. Users and context

Visitor (primary): attends Devcon 8, on a phone (most likely) or laptop, on crowded conference Wi-Fi or mobile data, willing to spend 1–3 minutes, possibly returning several times a day. Mixed technical depth, international, mostly non-Hindi speakers.

Organizer (secondary): needs a big-screen view, controls to pause/reset/ban, and a post-event export.

Big-screen display: a read-only spectator view for venue screens showing the global network and community score.

## 6. Game design specification (fixed defaults)

### 6.1 Terminology

Node: one visitor’s presence in the network.

Link: a connection between two nodes.

Line: a shard. An independent shared network of up to 400 nodes. Named after Mumbai local train lines for flavor (for example Western, Central, Harbour). Additional Lines are created automatically as visitors arrive.

Round: one repeating game cycle inside a Line.

Outage: the server disabling nodes and links.

Resilience score: how well the Line stays connected and redundant.

### 6.2 Joining

Visitor opens the URL. A session token is created and stored locally. No sign-up.

Visitor enters an optional display name (default: a generated friendly name). Names pass a profanity filter.

The server assigns the visitor to the least-full open Line and creates their node at a layout position computed by the server.

To avoid isolated newcomers, the server auto-creates one starter link from the new node to a low-degree active node (defined in 6.5) that has fewer than 5 links. The first node in an empty Line has no starter link. If no eligible node exists, the newcomer starts unlinked and the UI says so.

Starter-link target selection (exact): among eligible active nodes in the same Line with fewer than 5 total links (including inactive links), choose the node with the lowest active degree. If multiple candidates tie, choose among them using the deterministic Line/round seed; if no candidate exists, create no starter link.

Returning with the same session token restores the same node and Line (token valid at least 24 h).

### 6.3 Link rules

Links can only connect two active nodes in the same Line.

No self-links, no duplicate links.

Degree cap: a node may have at most 5 links. This prevents one giant hub and teaches decentralization. Inactive links (see 6.4) still count toward the cap, so a recovering node can never exceed 5 links.

Link budget: each visitor holds up to 3 link tokens. Creating a link spends 1. One token regenerates every 20 s. Visitors may link any two eligible nodes, not only their own (they act as helpful neighbors).

Removing a link is not a player action in the MVP (organizers may remove for moderation).

### 6.4 Round loop (default 90 s per Line, Lines run on independent timers with a small random offset)

Default: difficulty increases slowly, +1 targeted node every 5 rounds up to a cap defined in config.

Phase rules for actions and recovery (exact):

Link creation window. create_link is accepted only in the Build, Warning and Repair phases. During the instant Outage step and the Result phase it is rejected with PHASE_LOCKED. Link tokens keep regenerating in every phase.

What repair means. Disabled nodes and links cannot be linked, repaired or changed by anyone, including their owners, during the outage. Players repair the network by linking active nodes to route around the dark parts. Every disabled node and link recovers automatically at the start of the Result phase, after scoring.

Starter-link phase gating (exact): automatic starter links follow the same phase rules as player-created links. If a visitor joins during the instant Outage step or the Result phase, create the node immediately but defer its starter-link attempt until the next Build phase. In Build, Warning or Repair, the starter-link attempt may run immediately. Whenever the attempt runs, re-evaluate eligibility and the target-selection rule above; if no eligible target exists, leave the node unlinked and explain why. A deferred starter link does not spend the visitor's link token and never counts as a Restored route.

Inactive links. A link attached to a disabled node is inactive while that node is disabled. It still exists, still counts toward the degree cap at both ends, and carries no connectivity in scoring. It becomes active again when the node recovers.

Joining mid-round. A visitor who joins during a round gets an active node and a starter link to an active low-degree node. The node counts in N if it is still active at scoring. Starter links never count as restored routes.

### 6.5 Outage targeting

Strike type A (“Hub strike”): disable the active node with the most active links (ties broken by the round seed).

Strike type B (“Cable cut”): disable 2 random active links plus 1 low-degree active node, within the caps in 6.6.1. Low-degree means in the lowest quarter of active nodes by degree (at least 1 node); the pick within that group is seeded random.

Strike type C (“Regional blackout”): disable up to 5 nodes that are close to each other: pick a seeded random active node as the centre, then add the nearest active nodes by layout distance until 5 nodes or the cap in 6.6.1 is reached.

Round 1 is always type A, where Round 1 means the Line’s first round that has an outage (seeding-mode cycles do not count). Later rounds pick types from a seeded schedule.

Never disable more than the outage cap in 6.6.1: floor(20% of active nodes at round start) nodes, plus a separate cap on directly cut links.

### 6.6 Scoring

At the end of the Repair phase, compute for each Line:

C (connectivity, 0–1): size of the largest connected component of active nodes divided by number of active nodes.

B (redundancy, 0–1): computed on the largest connected component only: 1 minus (articulation points in that component ÷ the component’s node count), or 0 if that component has fewer than 3 nodes. Exact rules are in 6.6.1.

S (speed, 0, 0.5 or 1): 1 if C is at least 0.9 immediately after the outage or reaches 0.9 within the first half of the Repair phase (17.5 s by default), 0.5 if it reaches 0.9 later but before the phase ends, else 0.

Round score = round(60·C + 30·B + 10·S) (0–100), rounded once, half-up.

Community score (global): node-weighted average of the latest round scores across all Lines, plus a running “Network Health” trend of the last 10 rounds. Lifetime stats: total nodes, total links, total rounds survived.

Each player also sees Restored routes: the number of links they created during a Repair phase that merged two disconnected components. This is a pride metric, not a ranking.

### 6.6.1 Scoring edge cases

These rules are exact. The rules engine must implement them as written, and tests must cover each one.

Active node: a node that is not disabled at the moment scoring runs. N = number of active nodes. Only active links between active nodes count. Disabled nodes are excluded from both N and C. Scoring uses the state at the exact end of the Repair phase by server time; later actions are rejected with PHASE_LOCKED. Because everything recovers when Result begins, every node is active at the start of every round.

Seeding mode (fewer than 5 active nodes at round start): the Line runs a Build-only cycle of 40 s with no Warning, Outage, Repair or Result, so there is no outage and no score. The UI says “Grow this Line to 5 nodes”. Players can still link normally. The check repeats at the start of every cycle, and the first time it finds 5 or more active nodes a full round begins. Seeding cycles do not advance the round counter, the difficulty counter or “rounds survived”, and the Line is left out of the community score (it is neither scored 0 nor averaged in). This is why the 20% outage rule can never leave a Line with nothing to disable: any Line that is struck has at least 5 active nodes.

Outage cap: the node cap is floor(N ÷ 5) for N active nodes at round start (integer division, equal to floor(0.2 × N)). The link cap is floor(active links ÷ 5), with a minimum of 1 once the Line has at least 5 active nodes; it applies only to links cut directly (Cable cut), not to links that go inactive because their node was disabled. Strike A disables 1 node. Strike B disables min(2, link cap, active links) links plus 1 node. Strike C disables min(5, node cap) nodes. A Line with 5 to 9 active nodes therefore loses at most 1 node, 10 to 14 at most 2, 15 to 19 at most 3, 20 to 24 at most 4, and 25 or more at most 5.

C: if N = 0 the round is void: no score, not counted in the community score, not counted as survived. Otherwise the largest connected component is computed over active nodes and active links, and C = its size ÷ N. An isolated node is a component of size 1.

B: computed on the largest component only; call its size n. If two components tie for largest, the one with more links wins, then the one containing the lowest node id. If n < 3, B = 0. Otherwise B = 1 − (articulation points in that component ÷ n). Other components do not affect B (they already lower C) and are never merged for this calculation. Articulation points must be found with an iterative algorithm so deep graphs cannot overflow the call stack.

S: evaluated by server time, recomputed after the outage and after every accepted link in the Repair phase. If C is at least 0.9 immediately after the outage, S = 1. Otherwise S = 1 if C first reaches 0.9 within the first half of Repair (17.5 s by default), 0.5 if it first reaches 0.9 later but before Repair ends, and 0 if it never does. Once earned, S is not lost.

Restored routes: only links created during Repair count. Starter links never count. A restored route is a link that, at the moment it is created, joins two different components of the active graph.

Determinism: the round seed is derived from the Line seed and the round number, and ties in strike targeting are broken with it. Scoring uses exact fractions or integer arithmetic (no floating point), and the score is rounded once, at the end, half-up (92.5 becomes 93).

Disabled nodes’ owners: keep their tokens and may link other active nodes, but their own node cannot be a link end until it recovers. Nobody can repair a disabled node during the outage.

Scoring with fewer than 5 active nodes: the 5-node threshold is checked only at round start. A round that started with 5 or more active nodes is always scored, even if 4 or fewer nodes remain active at scoring. For example N = 1 gives C = 1 and B = 0, and N = 2 in two components gives C = 0.5 and B = 0.

### 6.7 Feedback requirements

Instant visual response (under 100 ms locally) to every tap, with rollback if the server rejects the action.

Clear invalid-action feedback: “That node is full (5/5 links)”, “Out of link tokens, next in 12 s”, “Node is offline”. Canonical codes and wording are in FR-32.

Disconnected components are tinted differently so players see what needs connecting.

Result screen explains in one sentence why the score was what it was (for example “Alternate routes kept 92% connected”).

### 6.8 Lifecycle and pruning

A disconnected visitor’s node remains in the network (the shared network persists).

Nodes idle for more than 2 hours may be pruned only when their Line is above 90% capacity, oldest idle first, and never nodes that are the sole connection of another node.

Organizers can pause, reset a Line, or reset everything. Resets always create a snapshot first.

### 6.9 Player orientation, feedback and recovery (mobile first)

FR-25 Find your node. Your node is always larger, with a white ring and a 'You' label. On join the view centers on it with a short pulse. A 'Find me' button re-centers at any time.

FR-26 Quick link. Your node is pre-selected as the link source, so tapping any other node attempts a link from yours to it. Tapping a different node first changes the source. If your node is full or offline, the player must choose a source and the UI says so.

FR-27 See what is available. With a source selected, valid targets glow and invalid ones dim. Tapping a dimmed node shows the reason in plain words (for example 'Full, 5 of 5 links', 'Offline', 'Already linked'). The token HUD shows 3 pips and a regeneration ring.

FR-28 Rejected actions are never silent. A new link appears at once as a dashed pending line. The server result either solidifies it or retracts it within 1 s with a short toast giving the reason, also announced to screen readers.

FR-29 Reconnect and recover. A non-blocking 'Reconnecting' banner keeps the last known network visible but dimmed. On resume the client sends its last sequence number and its pending request_ids; the server answers each as confirmed, rejected, or unknown (shown as such, with a retry option); the client re-syncs the countdown from server time, and shows a 3-second 'While you were away' summary (nodes joined, links added, last round score). A mobile tab returning to the foreground resumes automatically. After 30 s without a connection the UI switches to a read-only view with a Retry button.

FR-30 Offline owners. If your node is disabled, a badge explains that it recovers when the Result phase begins, and you can still link other active nodes.

FR-31 Tap precision. Each node has a hit area of at least 44 px, using nearest-node snapping. When several nodes fall under one tap, the view zooms in on that spot rather than guessing. Pinch-zoom, pan and double-tap zoom are supported, and the selected link source stays highlighted while panning.

FR-32 Rejection reasons. Every rejection carries one stable code that the client turns into plain words: NODE_FULL (“Full, 5 of 5 links”), NO_TOKENS (“Out of link tokens, next in N s”), NODE_OFFLINE (“Offline until results”), ALREADY_LINKED (“Already linked”), SELF_LINK (“Pick a different node”), PHASE_LOCKED (“Round results, linking resumes in N s”), RATE_LIMITED (“Slow down a little”), LINE_PAUSED (“Paused by the organizers”), STALE_STATE (“That just changed, try again”), SERVER_ERROR (“Could not confirm, try again”). Codes are part of the protocol (Section 11); wording lives in the language files.

FR-33 Pending actions never hang. A dashed pending link not resolved after 3 s shows a “Confirming” indicator. After 10 s with no result it is retracted with SERVER_ERROR. Tapping the same pair again while it is pending does nothing. After a reconnect, pending actions are resolved by request_id as in FR-29.

## 7. Functional requirements

Priority: M = must, S = should, C = could.

## 8. Non-functional requirements (proposed targets, tune after baseline measurement)

Latency: action-to-other-clients p95 at or below 750 ms and p99 at or below 1500 ms under the Section 15 workload.

Errors: under 1% failed actions (excluding legitimate rule rejections).

Reconnect: at least 99% of clients resume within 10 s after a transient drop. A full reconnect storm of 10,000 clients within 60 s must not crash the system.

Client performance: at least 30 fps with 400 nodes on a mid-range Android phone; initial JS under 250 KB gzipped; interactive in under 3 s on 4G.

Server state: the server is authoritative. Clients never compute scores or decide validity.

Availability during event: no single backend instance failure causes loss of more than 5 s of game state.

Security: see Section 12.

## 9. Architecture (candidate, validate in Phase 0)

These are candidates, not mandates. Inspect the repository first and justify deviations in DECISIONS.md.

Frontend: React + TypeScript. Canvas 2D or WebGL for graph rendering (400 nodes per Line, so no need to render 10,000 at once). Because this is a greenfield build, do not assume any existing code can be reused. If the owner later supplies an existing repository, assess reuse only with explicit approval.

Game engine: a pure, deterministic TypeScript or Python module with no network or database I/O, seeded randomness, and unit tests. It takes (state, action) and returns (newState, events). All rules from Section 6 live here. This isolates the game rules from infrastructure and makes them testable.

Backend: FastAPI (or another justified server), WebSocket gateway, authoritative game service.

Sharding model: each Line has exactly one authoritative owner process at a time. Ownership is assigned through a Redis lease. Gateways accept WebSocket connections from any client, forward actions to the owning process (Redis Streams), and receive state deltas back (Redis pub/sub per Line). Ownership failover must preserve state from the last persisted snapshot plus the event log. This Redis lease and Streams design is a hypothesis: Phase 4 must benchmark it against a simpler alternative (for example sticky routing of each Line to one gateway) and record the choice in DECISIONS.md.

Benchmark requirement: the Redis lease and Streams design, and any simpler alternative, are unproven. Phase 4 must benchmark each candidate under Section 15 scenarios (d) reconnect storm, (h) simultaneous outages in every Line, and (i) both at once, recording p95 and p99 latency, CPU and memory in DECISIONS.md. The 10,000-user figure remains a test target, not a capacity claim, until Phase 5 passes.

Sync strategy: on connect, the client receives a full snapshot with a sequence number. After that, the server sends batched deltas at a fixed tick (default 5 Hz, configurable) rather than one message per action. A client that reconnects sends its last sequence number and receives deltas if still buffered (last 500 events), otherwise a fresh snapshot.

Persistence: Redis holds hot state. PostgreSQL stores periodic snapshots (default every 10 s per Line) and an append-only event log (batched writes). Reset operations always snapshot first.

Deployment: containerized, horizontally scalable gateways, a single Redis and a single PostgreSQL for the MVP, with a documented path to scale. Document the target hosting and cost estimate.

## 10. Data model (proposed)

lines(id, name, capacity, status, round_no, phase, phase_ends_at, seed)

nodes(id, line_id, session_id, display_name, x, y, status, created_at, last_seen_at)

links(id, line_id, node_a, node_b, status, created_by, created_at) with a unique pair constraint

sessions(id, token_hash, node_id, banned, created_at, last_seen_at)

rounds(id, line_id, round_no, strike_type, targets, c, b, s, score, started_at, ended_at)

events(seq, line_id, type, payload, created_at)

snapshots(line_id, seq, state, created_at)

global_stats(updated_at, community_score, total_nodes, total_links, rounds_survived)

## 11. Protocol (proposed)

All messages are JSON with a type, a v (protocol version), and where relevant a client-generated request_id for idempotency.

Client to server: join, resume(last_seq, pending_request_ids), create_link(a, b), ping.

Server to client: snapshot(seq, state), delta(seq, events[]), action_result(request_id, ok, reason), phase_change(phase, ends_at), round_result(score, breakdown), global_stats, error(code).

The server validates every field (types, ranges, ownership, rate limits) and never trusts client timestamps. Duplicate request_id values must not create duplicate links. Rejection reasons use the stable codes in FR-32, and a resume reply reports the status of every pending request_id.

## 12. Security, abuse, and moderation

Rate limits per session: at most 2 link attempts per second, in addition to the token budget. Message-size cap of 1 KB. Maximum 1 node per session.

Conference NAT warning: thousands of visitors may share one public IP. Per-IP limits must be generous (for example hundreds of joins per minute) and paired with a lightweight bot check at join (for example a privacy-friendly challenge or proof-of-work) rather than strict per-IP blocking.

Display names are length-limited, sanitized, and filtered. No user-generated HTML anywhere.

Organizer endpoints require a secret and are not exposed on the public UI.

Ban by session. Pause and reset controls require confirmation.

Origin checks on WebSocket connections, dependency scanning, and no secrets in the client bundle.

Privacy: store the minimum. No personal data beyond the optional display name and a hashed session token. State retention policy and deletion after the event in the README.

## 13. UX and visual direction

Dark, glowing digital-network aesthetic with smooth transitions and clear status indicators. Visual identity is inspired by Mumbai: local train line colors as Line identities, route-map style link rendering, and subtle skyline or signage motifs. The core interaction must make sense to someone who has never been to Mumbai.

Core interaction on mobile: tap your node (highlighted) or any node, tap a second node, and a link animates between them. Desktop: click, or drag from one node to another.

Persistent compact HUD: link tokens, phase and countdown, Line health. No more than one primary call to action visible at a time.

Onboarding: a single 10-second overlay with one animated hint. No multi-step tutorial.

Accessibility per FR-22.

Include sound-free operation by default (venues are loud). Optional haptic feedback on mobile.

## 14. Testing requirements

Game rule unit tests for the engine: link validity, degree cap, token regeneration, strike targeting, never exceeding 20% disabled, scoring math (including articulation points and every Section 6.6.1 edge case (fewer than 5 active nodes, N = 0, disconnected graphs, components under 3 nodes, outage cap rounding)), determinism for a given seed. Also cover: link actions rejected outside Build, Warning and Repair; inactive links counting toward the degree cap; starter links created during Repair, deferred starter links for joins during Outage or Result, and exact low-degree target selection; seeding-mode entry and exit; and every Appendix B case as a golden test.

Property tests or simulated random players to check that invariants always hold (no duplicate links, no links to disabled nodes, degree at most 5).

Concurrency tests: many simultaneous create_link calls on the same nodes; exactly one valid result, no corruption.

Reconnection tests: drop and resume with delta, drop and resume requiring a full snapshot, server restart recovery from Postgres.

Invalid action tests: malformed JSON, oversize messages, wrong types, unknown nodes, replayed request_id, banned sessions, rate-limit enforcement.

End-to-end tests: two or more browser clients see each other’s links and complete a full round.

Accessibility and mobile checks: keyboard and screen-reader smoke test, reduced motion, small-viewport layout.

Multiplayer UX tests: every FR-32 reason code reaches the client and is shown in plain words; pending links confirm or retract within the FR-33 limits; a reconnect reconciles pending request_ids; tap precision (FR-31) is checked on real phones.

## 15. Load testing

Planning assumptions (adjust with real playtest data):

10,000 connected clients with the page open.

Typical: 5% active at any moment (500 players), roughly 1 action per 3 s each, giving about 170 actions per second.

Round-start burst: 20% active (2,000 players), 1 action per 2 s each, giving about 1,000 actions per second.

About 400 clients per Line, about 25–30 Lines. With 5 Hz batched ticks, each Line emits at most 5 broadcasts per second to 400 clients, so about 2,000 messages per second per Line and about 50–60 thousand messages per second in total at peak. Verify these numbers rather than trusting them.

Scenarios: (a) ramp to 10,000 connections over 5 minutes, (b) steady state of 30 minutes with the typical mix, (c) round-start burst, (d) reconnect storm of 10,000 clients within 60 seconds, (e) gateway instance kill during load, (f) slow-client and mobile-throttled sessions, (g) abusive client flooding, (h) worst case where every Line fires its outage in the same second (round-timer staggering disabled). Scenario (i): a reconnect storm that begins while every Line is in its Repair phase after a simultaneous outage (combines d and h).

Acceptance criteria: the targets in Section 8, no state corruption, memory stable over the run, and CPU headroom of at least 30% on each instance at peak. No Section 9 architecture choice is final until scenarios (d), (h) and (i) have been run against it.

Reporting: commit the scripts, the exact environment (instance types, counts), raw results, and a written report. State plainly what was and was not achieved. If only 3,000 users were achieved, document 3,000.

## 16. Phase 0 requirements (greenfield readiness review)

Phase 0 must assume the application is being built from scratch and that no source repository exists yet. Do not search for or require NetQuest.

The Phase 0 report must include:

1. A concise confirmation that the PRD is understood and any genuine contradictions or implementation-blocking ambiguities found.

2. A proposed minimal repository structure for the greenfield project, with the purpose of each top-level folder.

3. A recommended architecture consistent with Section 9, separating confirmed requirements from proposed technology choices.

4. A phase-by-phase implementation plan and the dependencies or risks that could block progress.

5. A list of decisions the owner must make before implementation, including hosting/budget before Phase 4.

6. docs/STATUS.md and docs/DECISIONS.md, with current status set to Phase 0 and no unapproved decisions presented as final.

Do not write application/game code, scaffold the app, install dependencies, or claim any feature is implemented. The Phase 0 report must label statements VERIFIED, PROPOSED, or UNKNOWN where relevant and end with “Awaiting owner approval”. Then stop.

If the owner later identifies an existing repository and explicitly requests an audit, conduct a separate read-only audit of that repository and its licence; do not make this a prerequisite for greenfield work.

## 17. Phases and gates

Each phase ends with a gate. Produce the listed artifacts, update STATUS.md, and wait for approval. Only Phase 0 may start now.

## 18. Operations and event-day plan

Pre-event rehearsal with real devices on a similar network.

Event-day runbook: how to start, pause, reset, ban, view metrics, and roll back to a snapshot.

Monitoring: connections, actions per second, p95 latency, error rate, Line occupancy, memory, and CPU, with alert thresholds.

Fallback for poor Wi-Fi: lightweight payloads, automatic reconnect with backoff and jitter, a visible “reconnecting” state, and graceful read-only mode if the server is unreachable.

Post-event: final snapshot (JSON and image), optional timelapse, and data deletion per the stated retention policy.

## 19. Risks and mitigations

## 20. Definition of Done (MVP)

Multiple visitors can join a shared network without accounts.

Valid links can be created and everyone in the Line sees them in near real time.

A full outage round (Build, Warning, Outage, Repair, Result) completes with a correct, explained score.

A meaningful community score is visible globally and on the spectator screen.

Works on desktop and mobile, and recovers from disconnections.

All Section 14 tests pass, including every Appendix B case.

Load test report is committed with honest results.

Deployment guide, runbook, and limitations are documented.

No unverified claims appear anywhere in the documentation or UI.

## 21. Glossary

Node: a virtual participant. Link: a connection between nodes. Line: a shard of up to 400 nodes. Articulation point: a node whose removal splits a connected network. Authoritative server: the server decides what is valid and what the scores are. Snapshot / delta: a full state versus incremental changes. Fan-out: sending one update to many clients.

## 22. Open decisions (owner to confirm; defaults apply until changed)

## 23. Appendix: starter prompt for any new model or session

You are working on Mumbai Network Garden, a greenfield project being built from scratch. Read docs/PRD.md, docs/STATUS.md, and docs/DECISIONS.md completely before doing anything. The PRD is the source of truth and overrides your assumptions. Work only on the current phase listed in STATUS.md. The project starts in Phase 0: review the PRD for contradictions and blocking ambiguities, propose the minimal architecture and repository structure, prepare docs/STATUS.md and docs/DECISIONS.md, and produce a Phase 0 readiness report. Do not require or assume an existing repository or NetQuest. Do not write game/application code, scaffold the app, or install dependencies until the owner has approved the Phase 0 report in writing. Never claim anything exists or performs unless verified, and label statements VERIFIED, PROPOSED, or UNKNOWN. If a requirement is ambiguous, stop and ask. Output complete files, not partial diffs. When finished, produce the phase gate artifacts, end with “Awaiting owner approval”, and stop.

## 24. Appendix B: worked scoring examples (golden test cases)

These cases are exact. Phase 1 must implement each one as an automated test. They use the default config (Repair 35 s, half-point 17.5 s).

B1 Path of 5, hub strike. The active graph is the path A–B–C–D–E (5 active nodes at round start). Strike A: B, C and D tie on degree 2; assume the seed picks C. The node cap is floor(5 ÷ 5) = 1, so only C is disabled and links B–C and C–D go inactive. Now N = 4 with active links A–B and D–E: two components of size 2, so C = 2/4 = 0.5, and the largest component has fewer than 3 nodes, so B = 0.

B2 No repair. Continuing B1 with no repair links: S = 0 and the score is round(60 × 0.5) = 30.

B3 Repair at 10 s. Continuing B1, a player links B–D at 10 s. It joins two components, so it is a restored route. The active graph is the path A–B–D–E, so C = 1. B and D are articulation points, so B = 1 − 2/4 = 0.5. S = 1. Score = 60 + 15 + 10 = 85.

B4 Repair at 25 s. The same link at 25 s, after the 17.5 s half-point: C reaches 1 later, so S = 0.5 and the score is 60 + 15 + 5 = 80.

B5 Ring of 6, hub strike. Six nodes in a ring A–B–C–D–E–F–A, all degree 2; assume the seed picks A. The cap is 1. The active graph is the path B–C–D–E–F (N = 5), so C = 1 immediately and S = 1. C, D and E are articulation points, so B = 1 − 3/5 = 0.4 and the score is 60 + 12 + 10 = 82. If a player then links B–F, the ring of 5 has no articulation points, B = 1 and the score is 100.

B6 Rounding half-up. After an outage the 4 remaining active nodes form a triangle X–Y–Z with a pendant node W attached to X. C = 1 and S = 1. X is the only articulation point, so B = 1 − 1/4 = 0.75. Score = 60 + 22.5 + 10 = 92.5, which rounds to 93, not 92.

B7 Seeding mode. A Line with 4 active nodes at round start runs a 40 s Build-only cycle: no strike, no score, excluded from the community score, and the UI shows “Grow this Line to 5 nodes”. When a fifth node joins, the next cycle is a full round and its strike is type A.

B8 Caps. Node cap: 9 active nodes gives 1, 10 gives 2, 24 gives 4, 25 gives 5. Link cap: 5 active nodes with 4 active links gives floor(4 ÷ 5) = 0, raised to the minimum of 1.

B9 Phase-gated link. A create_link received during the Result phase, or 1 ms after Repair ends, is rejected with PHASE_LOCKED and changes neither the graph nor the score.



| Goal | Metric (proposed targets) |

| --- | --- |

| Instantly understandable | First-time visitor understands the interaction in about 10 s and makes a first link within 30–60 s (measured in playtests with at least 10 people) |

| Collaborative | Players see each other’s changes in near real time (Section 15 latency targets) |

| Teaches the concepts | In a 3-question post-playtest quiz, at least 70% explain why redundant routes help |

| Reliable at an event | Survives disconnects, bad Wi-Fi, and spam without organizer intervention |

| Honest | Every claim in the README traces to a test, measurement, or a PROPOSED label |





| Phase | Duration | What happens |

| --- | --- | --- |

| Build | 40 s | Calm period. Players add links and grow the network. |

| Warning | 5 s | Banner and pulsing: “Outage incoming”. The server announces the strike type but not the exact targets. |

| Outage | instant | Server disables the targeted nodes and links (see 6.5). Disabled elements dim and flicker. Owners of disabled nodes get a “Your node is offline and recovers when the Result phase begins. You can still link active nodes” message. |

| Repair | 35 s | Players create links between active nodes to reconnect isolated parts. Disabled nodes and links cannot be used or repaired during this phase; they recover when the Result phase begins, after scoring. |

| Result | 10 s | Score shown with a breakdown, the disabled elements recover, and the next Build phase begins. Link creation is locked during this phase. |





| ID | Requirement | Priority |

| --- | --- | --- |

| FR-1 | Join without account or wallet | M |

| FR-2 | Session restore by token | M |

| FR-3 | Server assigns Line and node position | M |

| FR-4 | Starter link on join | M |

| FR-5 | Create link with validation per 6.3 | M |

| FR-6 | Link token budget and regeneration | M |

| FR-7 | Round loop per 6.4 | M |

| FR-8 | Outage strikes per 6.5 | M |

| FR-9 | Scoring per 6.6, computed server-side only | M |

| FR-10 | Near-real-time sync of all changes to all clients in the Line | M |

| FR-11 | Global community score and Line list visible to all | M |

| FR-12 | Reconnect and resume (delta or full snapshot) | M |

| FR-13 | Persistent state survives server restarts | M |

| FR-14 | Rate limiting and input validation | M |

| FR-15 | Mobile and desktop responsive UI | M |

| FR-16 | 10-second onboarding hint (single overlay, dismissible) | M |

| FR-17 | Big-screen spectator mode (read-only, /screen) | M |

| FR-18 | Organizer admin panel (pause, reset, ban session, view metrics) behind a secret | M |

| FR-19 | Final snapshot export (JSON + image) | S |

| FR-20 | Timelapse replay from the event log | C |

| FR-21 | Offline or poor-network indicator and graceful retry | M |

| FR-22 | Accessibility: colorblind-safe palette plus shape or pattern cues, screen-reader labels for status, reduced-motion mode, touch targets of at least 44 px | M |

| FR-23 | UI copy always says “simulated network” where relevant | M |

| FR-24 | Language-ready strings (English at launch; Hindi and Marathi as Phase 2 candidates) | S |

| FR-25 | Find your node: larger, ringed, labelled “You”, auto-centred, Find me button (6.9) | M |

| FR-26 | Quick link: own node pre-selected as source (6.9) | M |

| FR-27 | Show valid and invalid targets with plain-word reasons (6.9) | M |

| FR-28 | Rejected actions are never silent: pending line, then solid or retracted within 1 s (6.9) | M |

| FR-29 | Reconnect and recover: last_seq plus pending request_ids, “While you were away” summary (6.9) | M |

| FR-30 | Offline-owner badge: recovers when Result begins (6.9) | M |

| FR-31 | Tap precision on small screens: 44 px hit area, snapping, zoom (6.9) | M |

| FR-32 | Stable rejection reason codes with plain-word wording (6.9, Section 11) | M |

| FR-33 | Pending actions time out and never hang (6.9) | M |

| FR-34 | Optional “most routes restored” callout, no persistent ranking | C |





| Phase | Work | Gate artifacts |

| --- | --- | --- |

| 0. Audit | Section 16. Create docs/STATUS.md and docs/DECISIONS.md. | Greenfield readiness report, proposed architecture and repository structure, implementation plan, and the owner’s written approval recorded in DECISIONS.md |

| 1. Rules engine | Owner confirms Section 6.6.1 and Appendix B before coding starts. Pure game engine per Section 6, config file, bot simulator, unit and property tests | Passing tests including every Appendix B case, a simulation report showing score distributions with bot players |

| 2. Single-server MVP | One backend instance, WebSocket sync, persistence, join/link/round loop, minimal UI | Working demo with 2+ browsers, concurrency and reconnection tests passing |

| 3. Experience | Final UI, Mumbai theme, mobile, onboarding, accessibility, spectator and admin views | Playtest notes from at least 10 people on real phones, fixes applied |

| 4. Scale-out | Multi-instance with Redis, shard ownership, snapshots and event log, failover; benchmark against sticky routing under scenarios (d), (h) and (i) | Multi-instance tests passing, failover demo; benchmark comparison recorded in DECISIONS.md |

| 5. Load testing | Section 15 | Committed scripts, results, and an honest report |

| 6. Release | Deployment guide, runbook, README with limitations, final snapshot export | Documented deployment, event-day checklist, rehearsal completed |





| Risk | Mitigation |

| --- | --- |

| Graph becomes an unreadable hairball | 400-node Lines, degree cap of 5, server-side layout |

| Fan-out overload at round start | Batched ticks, per-Line ownership, staggered round timers |

| Bots and spam without accounts | Join challenge, token budget, rate limits, admin bans |

| Venue NAT blocks real users | Generous per-IP limits plus bot challenge |

| Game feels trivial or confusing | Playtests in Phase 3, tunable config |

| Scope creep | Section 4 scope plus phase gates |

| Overclaiming scale | Section 0 rule 9 and Section 15 reporting |

| Model drift between sessions | Section 0 rules, STATUS.md, DECISIONS.md |

| Repository missing, or assumed to have features it lacks | Phase 0 access check, VERIFIED/PROPOSED/UNKNOWN labels, stop and ask |

| Redis and sharding design fails under reconnect storms or simultaneous outages | Phase 4 benchmark against sticky routing under scenarios (d), (h), (i) |

| Ambiguous outage or scoring edge cases | Section 6.6.1 plus Appendix B golden tests, owner sign-off before Phase 1 |





| # | Decision | Default |

| --- | --- | --- |

| 1 | Round length and phase durations | 90 s as in 6.4 |

| 2 | Link tokens and degree cap | 3 tokens, 20 s regeneration, cap 5 |

| 3 | Line capacity | 400 nodes |

| 4 | Tech stack | Section 9 candidates, pending the Phase 0 audit |

| 5 | Hosting target and budget | Undecided, must be stated before Phase 4 |

| 6 | Languages at launch | English only |

| 7 | Gossip-propagation challenge | Phase 2 candidate, not MVP |

| 8 | Data retention period after the event | Delete within 30 days, unless the owner decides otherwise |

| 9 | Link actions by phase | Allowed in Build, Warning and Repair; locked during Result |

| 10 | Seeding-mode threshold | 5 active nodes; the Line runs Build-only cycles below it |
