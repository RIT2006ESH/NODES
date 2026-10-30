# Status - Mumbai Network Garden

**Mode:** deadline build (3 days), owner directive of 2026-10-26
**Current state:** playable V1 with consent-first links, server-authoritative movement, player search and a contribution leaderboard
**Last updated:** 2026-10-27
**Owner:** Ritesh Singh
**Prepared by:** build session

### 2026-10-27 Render port-binding configuration (VERIFIED)

- The production Docker path is `CMD ["npm", "start"]`, which runs
  `apps/server/src/main.ts`; that entry point calls `createGameServer()` from
  `apps/server/src/app.ts`. There is one HTTP listener only. `main.ts` does not
  create a second listener; it only reports the configured port if binding
  fails.
- The server default port is now `10000`, while an explicit `PORT` environment
  variable and test `GameServerOptions.port` overrides remain supported.
- The single HTTP/WebSocket listener now binds explicitly to `0.0.0.0`.
  The Dockerfile declares `EXPOSE 10000` and sets its default `PORT=10000`,
  matching Render's web-service port convention.
- Existing `/`, `/screen`, `/healthz`, `/metrics`, `/ws`, and admin HTTP
  routing remain attached to that same listener. Post-change validation:
  `npm run typecheck` passed; `npm exec vitest run
  apps/server/test/server.test.ts` passed with 37/37 tests; `npm test` passed
  with 123/123 tests across 13 files; and `npm run build` passed with the
  production client bundle generated successfully.

### 2026-10-27 final deployment-readiness check (PARTIAL — NOT RELEASE READY)

- **Configured platform:** none is selected in the repository. The only runtime
  artifact is `Dockerfile`, whose `CMD ["npm", "start"]` launches one Node
  process and whose `EXPOSE 10000` documents the HTTP/WebSocket port. No Render,
  Fly, Railway, Kubernetes, Compose, replica, or volume manifest is present.
- **Storage:** `DATA_DIR` defaults to `./data`, which is `/app/data` in the
  image. The README's Docker example mounts `mng-data:/app/data`; the Dockerfile
  itself does not create or declare that volume. Persistence across redeploys is
  therefore **NOT VERIFIED** and depends on the operator attaching durable
  storage and setting one replica.
- **Runtime wiring:** `PORT`, `SEED`, `ADMIN_SECRET`, and `DATA_DIR` are read
  from the environment. `/healthz` and `/metrics` are implemented in the HTTP
  server; WebSocket traffic uses `/ws`; SIGINT/SIGTERM and `GameServer.close()`
  save the JSON files. A reverse proxy must preserve WebSocket upgrade to the
  same process. No hosting shutdown or proxy behavior was executable here.
- **Persistence policy:** the five-minute `LineHost.load()` cutoff remains. A
  fresh or 4:59 snapshot restores; an older snapshot is intentionally rejected,
  so valid progress can be lost after more than five minutes of downtime.
  Individual JSON files are atomically replaced, but the three files are not a
  transaction. Malformed/partial files are ignored or structurally filtered;
  mixed-generation files may lose the newest cross-file combination but do not
  intentionally create duplicate teams or invalid accepted edges.
- **Browser QA:** **NOT VERIFIED**. Browser tooling remains unavailable in this
  environment. Owner manual checklist: test desktop plus 360x800, 390x844 and
  430x932; join/reconnect two sessions; request/accept/decline; drag/keyboard
  movement; outage/repair/result; scoring; team naming/leaderboard; Surprise
  Zone entry; Packet Run; all education/search/dialog buttons; console errors;
  overflow and 44px touch targets.
- **Assessment:** persistence implementation and automated checks are **PASS**;
  deployment durability and browser/mobile verification are **NOT VERIFIED**.
  Overall release status remains **PARTIAL / NOT RELEASE READY**.

### 2026-10-27 persistence safety audit (PASS / PARTIAL)

- `LineHost.load()` rejects snapshots whose persisted `state.now` is more than
  five minutes old. This intentionally avoids reviving a phase/timer snapshot
  that could be hours stale; it also means valid progress is discarded after a
  downtime longer than five minutes and the server starts a fresh Line.
- Normal operation saves `line.json` every 10 seconds and again during
  `GameServer.close()`/SIGTERM shutdown. Fresh and 4:59 snapshots restore;
  snapshots older than five minutes are rejected. Focused regression coverage is
  in `apps/server/test/persistence.test.ts` (4 tests).
- `line.json`, `line.sessions.json`, and `line.teams.json` are now each written
  with temporary-file replacement. This prevents a single truncated JSON file,
  but the three files are not one transaction: a crash between replacements can
  leave mixed save generations. Startup safely filters sessions and team members
  against the loaded Line, ignores malformed/schema-invalid files, deduplicates
  members, and only accepts valid areas/qualification values. The remaining
  operational risk is loss of the newest cross-file combination, not duplicate
  authoritative teams from malformed input.
- The Dockerfile starts exactly one `npm start` process and exposes one port; it
  does not declare a persistent volume. Deployment operators must mount a durable
  volume at `DATA_DIR` and configure one replica/process. This environment cannot
  verify the hosting provider's volume or replica policy, so deployment durability
  is **NOT VERIFIED**. Horizontal scaling remains unsupported.
- Pending connection requests, terminal request cache, Packet Run mission state,
  rate-limit windows, active sockets, event replay buffer, repair baseline, and
  process metrics intentionally do not survive restart. Accepted edges, nodes,
  scores/history, sessions, team identity/membership/name, and area assignments
  do survive when the Line snapshot and sidecars are valid, recent, and stored on
  the same durable volume.
- Safety audit checks: focused persistence/server tests **41/41 passed**, full
  suite **123/123 passed**, `npm run typecheck` **PASS**, `npm run build` **PASS**,
  and `git diff --check` **PASS**.

### 2026-10-27 release-candidate verification (PARTIAL — NOT RELEASE READY)

| Requirement | Status | Evidence / remaining gap |
|---|---|---|
| Surprise Zone restart persistence | **PASS** | `apps/server/test/server.test.ts`: 37 server tests pass. The lifecycle regression qualifies a three-member team, closes and recreates the server with the same persisted files, reconnects by token, verifies the same team ID/member set and `surprise` area, then repeats resync and a second reconnect to prove one `entered` team and no duplicate transition. |
| Join, requests, acceptance/decline, movement, accepted edges | **PASS (automated)** | Server integration coverage includes join/reconnect, request lifecycle and idempotence, decline/expiry, movement bounds/rate limits, late snapshots, and persistent accepted edges. |
| Outages, repairs, phases, scoring | **PASS (automated)** | Engine rules/scoring/strike/property tests and server phase/repair integration coverage pass. |
| Team formation, naming, merge behavior, metrics, qualification, Surprise Zone | **PARTIAL** | Authoritative server tests cover formation, naming, connected teams, qualification, area assignment, reconnect and restart. Merge/split edge cases and complete multi-client browser presentation are not visually verified. |
| Packet Run and all important buttons | **PARTIAL** | Source and automated render/community coverage exist; no browser session was available to click through Packet Run, education, request, search, leaderboard, movement and team controls. |
| Mobile visual QA (360/390/430) and desktop visual QA | **NOT VERIFIED** | Browser tooling is unavailable in this environment. Owner must manually check those viewports, touch targets, overflow, dialogs, canvas gestures, console errors and two-session sync. |
| Release integrity and configuration | **PASS / PARTIAL** | `main` is one commit ahead of `origin/main`; remote is configured; no tracked `.env` or credential-like files were found; `/healthz` and `/metrics` respond on the running server. Deployment itself was not performed. Local JSON persistence is atomic for the team sidecar but remains best-effort and single-process. |
| Capacity claim | **NOT CLAIMED** | Existing load evidence is 50 clients only; no 10,000-client claim is made. |

Release checks for this audit: `npm test` **119/119 passed**, `npm run typecheck` **passed**, `npm run build` **passed**, server restart regression **37/37 passed**, and `git diff --check` **passed**. The working tree contains only the scoped persistence hardening, regression assertion, and this status update. V1 release remains blocked by missing visual/browser verification and undeployed-environment verification.

### 2026-10-27 Surprise Zone persistence blocker closed (VERIFIED / PARTIAL)

- Added a small versioned JSON sidecar at `<persistPath>.teams.json` for
  server-authoritative team records and per-node `main`/`surprise` area
  assignments. It uses the existing filesystem persistence approach; no new
  infrastructure dependency or sensitive session data is stored.
- Team state is loaded only when `version === 1`, references existing nodes,
  deduplicates member IDs, validates area/qualification values, bounds names,
  and safely ignores missing, malformed, stale-schema, or unknown-node data.
- Team names, Surprise Zone transitions, normal save intervals, and shutdown
  now persist the sidecar. Existing phase-edge transition logic remains
  idempotent, so recovery does not create duplicate teams or re-enter the zone.
- Added a restart regression using the real server lifecycle: qualify a
  three-member team, stop the server, restart with the same line/session files,
  reconnect by token, and verify the same team ID, members, `entered` state,
  `surprise` area, and exactly one restored Surprise Zone team.
- Restart regression: server tests **37/37 passed**. Full suite: `npx vitest
  run` **119/119 passed** across 12 files. `npx tsc --noEmit` **PASS**;
  `npm run build` **PASS** (49.44 kB JS / 16.37 kB gzip, 28.50 kB CSS /
  6.46 kB gzip, 17.49 kB HTML / 5.49 kB gzip); `git diff --check` **PASS**.
- Limitation: persistence remains best-effort JSON filesystem storage. A
  failed write is intentionally non-fatal; team sidecar replacement is atomic,
  but multi-process/shared-storage coordination is not provided. Browser/mobile verification remains
  **NOT VERIFIED** because no supported browser executable is installed.

### 2026-10-27 final implementation pass (IMPLEMENTED / PARTIAL)

- Git boundary was verified before isolation: the parent resolved to
  `C:/Users/Asus/Desktop` with prefix `nodes/`. Because the project was wholly
  untracked and Git identity was configured, a project-local repository was
  safely initialized in `C:/Users/Asus/Desktop/nodes` and committed without
  staging, moving, resetting, or committing unrelated Desktop files. Final
  project root is `C:/Users/Asus/Desktop/nodes`, branch `main`, initial commit
  `71a06f2`.
- Added authoritative team fields to `TeamView`: area, qualification,
  recovery count, and active-link count. Team ranking now puts qualified teams
  first, then member count, recoveries, active links, and stable team ID.
- Added server-owned `main`/`surprise` area state. At the Repair-to-Result
  transition, teams with at least three members qualify when the scored Line
  reaches 90% connectivity or a member made a Repair restored route. The top
  qualifying team moves all current members together; the transition is
  idempotent because only the phase edge performs it. Links and Packet Run
  routes cannot cross areas. Reconnects in the same process receive the area in
  snapshots; restart persistence is not implemented.
- The team leaderboard now displays qualification/Surprise Zone status and
  uses the authoritative recovery/link fields. Existing network score logic is
  unchanged.
- `apps/server/src/view.ts` includes area in node snapshots and filters
  cross-area links; `apps/web/src/main.ts` renders qualification status.
- Browser tooling remains unavailable: Chrome, Edge, Chromium, and Firefox
  were all absent from PATH. Requested viewport, touch, modal, and graphical
  two-session checks are **NOT VERIFIED**.
- Checks run after implementation: `npx tsc --noEmit` **PASS**;
  `npx vitest run apps/server/test/server.test.ts` **36/36 PASS**;
  `npx vitest run` **118/118 PASS** across 12 files; `npm run build` **PASS**
  (49.44 kB JS / 16.37 kB gzip, 28.50 kB CSS / 6.46 kB gzip, 17.49 kB HTML /
  5.49 kB gzip); and `git diff --check` **PASS**.

### 2026-10-27 V1 gap-closure follow-up (BLOCKED / VERIFIED CHECKS)

- Browser verification was attempted first. `where chrome`, `where msedge`,
  `where chromium`, and `where firefox` found no browser executable. Therefore
  360×800, 390×844, 430×932, tablet, desktop visual QA, touch QA, screenshots,
  browser console inspection, and separate graphical-session verification remain
  **NOT VERIFIED**; none is being claimed as passed.
- Current Git inspection: branch is `main`, latest parent-repository commit is
  `e29ff4f Initial SentinelScan Android project scaffold`, and the `nodes`
  project appears as `?? ./` inside the unrelated Desktop repository. Project
  commit provenance remains a release blocker; no reset, commit, or unrelated
  parent change was altered.
- Confirmed source-level mobile fix from this pass: `.teamRow` and
  `#searchClear` now guarantee 44px touch targets and manipulation touch
  behavior in `apps/web/src/style.css`.
- Team foundation remains authoritative but incomplete: `currentTeams()` in
  `apps/server/src/app.ts` derives active components, `team_name` is validated
  and synchronized, and `TeamView` drives the team leaderboard. Qualification,
  a resilience objective, a distinct authoritative area/room, group transition,
  duplicate transition idempotency, and reconnect-in-zone behavior do not exist.
  Implementing those requires a product/architecture decision beyond the
  current one-Line protocol; no decorative client-only Surprise Zone was added.
- Packet Run source safeguards remain present (`activeRoute()` BFS,
  `packetNextAt`, `packetCardKey`, `packetAnnouncementKey`), but dedicated route
  and duplicate regression tests are still absent.
- Executed checks after the mobile touch-target fix:
  `npx tsc --noEmit` **PASS**; `npx vitest run` **117/117 PASS** across 12
  files; `npm run build` **PASS** (49.24 kB JS / 16.31 kB gzip, 28.50 kB CSS /
  6.46 kB gzip, 17.49 kB HTML / 5.50 kB gzip); `git diff --check` **PASS**.
- Executed current isolated load test:
  `npm run loadtest:isolated` **PASS for 50 clients / 45 seconds** — 50 joined,
  0 failed, 2,362/2,362 actions answered, p95 2.3 ms, p99 9 ms, 0 errors.
  This is not evidence for production deployment or 10,000-client capacity.

#### Gap-closure status

| Requirement | Result |
|---|---|
| Browser/mobile viewport and touch verification | **NOT VERIFIED** — browser runtime unavailable |
| Core gameplay and consent-first multiplayer | **PASS automated** |
| Team formation, naming, active-group leaderboard | **PARTIAL** — authoritative foundation and tests exist |
| Team qualification and resilience conditions | **NOT IMPLEMENTED** |
| Surprise Zone authoritative transition/reconnect | **NOT IMPLEMENTED** |
| Packet Run reliability verification | **PARTIAL** — source safeguards, no dedicated integration suite |
| Production deployment / 10,000-client support | **NOT VERIFIED** |
| Git release provenance | **FAIL as a release process** — project is untracked inside parent Desktop repo |

No additional feature implementation was performed after the confirmed mobile
touch-target fix. Further team qualification/area work should wait for an
explicit decision defining the authoritative room model and qualification
thresholds; otherwise it would risk changing the approved game architecture.

### 2026-10-27 final V1 audit: mobile, gameplay, teams, release (VERIFIED / PARTIAL)

No optional gameplay was added. One confirmed mobile accessibility defect was
fixed: `.teamRow` and `#searchClear` now have 44px minimum touch targets and
`touch-action: manipulation` in `apps/web/src/style.css`.

| Area | Result | Evidence |
|---|---|---|
| Core gameplay, spawning, consent requests | **PASS** | `packages/engine/src/engine.ts`, `apps/server/src/app.ts`, protocol v2, and 18 request tests in `apps/server/test/server.test.ts` cover isolated joins, pending requests, explicit acceptance, decline, expiry, duplicate handling, and server revalidation. |
| Movement, edges, outages, repairs, phases, scoring | **PASS automated / PARTIAL manual** | Engine movement/strike/rules/scoring/appendix/property tests pass; `apps/web/test/render.test.ts` covers endpoint rendering. A prior six-client live smoke passed the phase loop. No fresh graphical browser outage walkthrough was possible. |
| Existing actions and controls | **PARTIAL** | Handlers exist in `apps/web/src/main.ts` for request/accept/decline/cancel, failure preview/restore, pulse/dismiss, Learn/close, Find My Node, search, leaderboard, team naming, join, and drag. Automated coverage passes, but browser console/touch/click verification is unavailable. |
| Mobile layout/touch | **PARTIAL / NOT VERIFIED at requested viewports** | Responsive CSS includes viewport-fit, safe-area offsets, mobile drawers, mobile cards, scrollable education, Canvas `touch-action:none`, pointer capture, and now 44px team/search targets. 360×800, 390×844, 430×932, tablet, and desktop rendered checks were not executable because no supported browser is installed. |
| Search/player info/leaderboards | **PASS source/tests / NOT VERIFIED visually** | `apps/web/src/community.ts`, `main.ts`, and `view.ts` use authoritative nodes, links, requests, presence, and join metadata; 9 community tests pass. Individual and team rows focus actual nodes; no browser interaction test exists. |
| Packet Run | **PARTIAL** | `apps/server/src/app.ts` uses BFS over active uncut links and `packetNextAt` cooldown; `main.ts` uses `packetCardKey`/`packetAnnouncementKey`. No dedicated route/outage/cooldown integration test or visual animation verification exists. |
| Educational panel | **PASS in source / NOT VERIFIED visually** | `apps/web/index.html` documents the actual TypeScript/Vite, Canvas 2D, Node HTTP + `ws`, engine, persistence, and test stack and labels unsupported libp2p concepts accurately. Mobile scrolling/layout remains unverified. |
| Team formation/naming/merge/split | **PARTIAL** | Server `currentTeams()` derives active connected components; `team_name` is authoritative and synchronized; deterministic inheritance is implemented. Tests cover pending-no-team, accepted naming, and a five-node connected chain. Outage split/repair merge, equal-size tie, simultaneous naming, and persistence/reconnect cases lack dedicated tests; records are in-memory. |
| Team leaderboard/metrics | **PARTIAL** | `main.ts` renders real `TeamView` membership, active links, repair contributions, deterministic order, and numeric active-group count. There is intentionally no team score or qualification model; D-31 documents that boundary. |
| Qualification/Surprise Zone | **NOT IMPLEMENTED** | No qualification fields/events, area/room state, transition, group movement, or reconnect-in-zone logic exists. This is documented in D-31 and remains the largest requested-scope gap. |
| Network Pulse/failure preview | **PARTIAL** | `startNetworkPulse()` and `simulateFailure()` use current active graph state without WebSocket/gameplay mutation. Only renderer coverage exists; dedicated behavior and browser tests are absent. |
| Automated checks/build | **PASS** | `npx tsc --noEmit` clean; `npx vitest run` **117/117 passed**, 12 files; `npm run build` successful: 49.24 kB JS (16.31 kB gzip), 28.50 kB CSS (6.46 kB gzip), 17.49 kB HTML (5.50 kB gzip); `git diff --check` clean. |
| Load/deployment evidence | **PARTIAL** | `npm run loadtest:isolated` executed current code with 50 clients for 45s: 50/50 joined, 0 failures, 2,362/2,362 actions answered, p95 action latency 2.3ms, p99 9ms, 0 errors. This does not establish production deployment or 10,000-client capacity. |

#### Final blockers and dependencies

1. **Release blocker:** no browser executable is available for the requested
   mobile viewport, touch, modal, two-session, team, Packet Run, or educational
   panel verification.
2. **Scope blocker:** team qualification and a real authoritative Surprise Zone
   remain absent; do not claim the team extension complete.
3. Add Packet Run integration tests and team merge/split/persistence tests.
4. Add browser-level pulse/failure/modal/touch coverage when tooling exists.
5. Git provenance remains unresolved: `nodes` is untracked inside the parent
   Desktop repository; no production deployment evidence is present.

**Readiness assessment:** core V1 gameplay and server/engine correctness are
strongly supported by automated tests and a 50-client isolated load run, but
the application is **not fully V1 release-ready** under the requested bar due
to missing browser evidence, incomplete Packet Run/team integration coverage,
and the unimplemented Surprise Zone/qualification scope.

### 2026-10-27 leaderboard metrics audit and fix (VERIFIED)

- Audited the displayed values end-to-end. Individual leaderboard REP came
  from `NodeView.restoredRoutes` in `apps/web/src/community.ts` and was rendered
  by `apps/web/src/main.ts`; the authoritative engine increments that field
  only when an accepted Repair-phase `create_link` joins two different active
  components (`packages/engine/src/engine.ts`, `restoredRoute`, `byNodeId`).
  Therefore REP = 0 is correct when no qualifying repair has occurred; clicks,
  requests, ordinary links, and starter links do not award it.
- The apparent team score was not a score at all. `teamMetrics().restored`
  summed member `restoredRoutes`, and `teamRowCount` displayed that number.
  The approved team decision D-31 defines a separate deterministic contribution
  ranking, not a new team score. The UI now labels this value **repairs** and
  explicitly says **no separate team score** rather than presenting an
  ambiguous zero.
- The server already derived active connected groups in `currentTeams()` in
  `apps/server/src/app.ts`: BFS over active nodes and uncut active links,
  retaining only components with at least two members. Pending requests are not
  links; inactive outage edges do not count. The UI previously rendered the
  teams but omitted the numeric count. It now displays the authoritative
  `teamGroupCount` as `N active groups` in `apps/web/index.html` and
  `apps/web/src/main.ts`.
- Active links remain independently derived from `LinkView.active` and active
  endpoints. A five-member connected chain is represented as one team even if
  it has multiple links; link count alone is not used as a connectivity claim.
- Added a server regression test for a five-node accepted chain and corrected
  its assertion to wait for the snapshot containing all five members rather
  than an earlier intermediate team snapshot.
- Focused checks: server + community tests **44 passed / 44**.
- Full suite: `npx vitest run` **117 passed / 117**, 12 files.
- `npx tsc --noEmit`: **VERIFIED clean**.
- `npm run build`: **VERIFIED successful**, 49.24 kB JS (16.31 kB gzip),
  28.40 kB CSS (6.45 kB gzip), 17.49 kB HTML (5.50 kB gzip).
- `git diff --check`: **VERIFIED clean**.
- Separate graphical browser-session verification and real outage/repair
  leaderboard observation remain **UNVERIFIED** because browser tooling is
  unavailable. No fabricated team score was added.

### 2026-10-27 complete implementation-status audit (READ-ONLY)

No feature code was changed during this audit. Findings below are based on
source inspection plus checks executed in this session.

| Requirement | Result | Evidence and blockers |
|---|---|---|
| 1. Core gameplay, spawning, requests, acceptance | **PASS** | `packages/engine/src/engine.ts`, `graph.ts`, `apps/server/src/app.ts`, and protocol v2 implement authoritative nodes, tokens, validation, request lifecycle, and explicit acceptance. `apps/server/test/server.test.ts` has 17 request tests, including pending-without-edge, acceptance, decline, expiry, duplicates, and phase rejection. |
| 2. Movement, edges, outages, repairs, phases, scoring | **PASS** | `packages/engine/src/movement.ts`, `outage.ts`, `scoring.ts`, `graph.ts`, and `engine.ts` implement the rules; `movement`, `strikes`, `rules`, `appendix-b`, `scoring`, `join-mesh`, and property tests pass. A prior live six-client smoke run observed Build → Warning → Outage → Repair → Score → Recovery → Results. Fresh smoke in this audit was **NOT VERIFIED** because the temporary server was not ready before the client connection attempt. |
| 3. Search, player info, leaderboard, controls | **PARTIAL** | Search/ranking helpers are in `apps/web/src/community.ts`; UI handlers and player cards are in `apps/web/src/main.ts`; 9 community tests and renderer tests pass. Controls have source handlers and CSS touch targets, but there is no browser automation or fresh desktop/mobile click verification. |
| 4. Packet Run and repeated-message issue | **PARTIAL** | `apps/server/src/app.ts` `activeRoute()` uses BFS over active, uncut links; `packetNextAt` adds a 30-second terminal cooldown. `apps/web/src/main.ts` uses `packetCardKey` and `packetAnnouncementKey`; `renderPacketMission()` animates the server route. No dedicated Packet Run test, route mutation test, or browser animation verification exists. |
| 5. Technical libp2p education | **PASS in source / NOT VERIFIED visually** | `apps/web/index.html` accurately describes vanilla TypeScript/Vite, Canvas 2D, Node HTTP + `ws`, the pure engine, JSON/session persistence, and Vitest/fast-check. It explicitly marks Peer IDs, discovery, real dialing, streams, protocols, PubSub, relays, NAT traversal, and browser-to-browser transport as analogies/not implemented. Build passes; visual/mobile inspection is unavailable. |
| 6. Mobile layout and touch interactions | **PARTIAL** | `apps/web/src/style.css` has viewport-fit, safe-area offsets, 44px controls, mobile search/leaderboard drawers, mobile request/player panels, Canvas `touch-action:none`, and pointer capture in `main.ts`. No 360px/390px/tablet browser run was possible, and no automated overflow/touch suite exists. |
| 7. Team formation, naming, deterministic merge/split | **PARTIAL** | `apps/server/src/app.ts` `currentTeams()` derives active connected components; `team_name` is server-validated; `TeamView` is synchronized in snapshots/deltas; merge/split name inheritance is deterministic by prior member count, creation time, and team ID. One server test covers pending-no-team and accepted-team naming. Merge tie, outage split, repair merge, simultaneous naming, and persistence/reconnect tests are absent; team records are in-memory. |
| 8. Team leaderboard, ranking, qualification | **PARTIAL** | `apps/web/src/main.ts` renders a real Team Leaderboard from synchronized `TeamView` data; ranking is member count, restored routes, active links, then team ID and is documented in `docs/DECISIONS.md` D-31. Qualification progress, resilience objectives, score threshold, and qualification events are not implemented. |
| 9. Surprise Zone transition with preserved membership | **NOT IMPLEMENTED** | No area/room field, transition message, qualification event, zone assignment, group move, or reconnect-in-zone logic exists in `packages/protocol`, `apps/server`, or the engine. `docs/DECISIONS.md` D-31 explicitly records this architectural gap; no decorative fake transition was added. |
| 10. Network Pulse and read-only failure simulation | **PARTIAL** | `apps/web/src/main.ts` `startNetworkPulse()` computes reachability from active links without server mutation; `simulateFailure()` computes local active-graph components and Restore View clears only preview state. Canvas rendering is covered by `apps/web/test/render.test.ts`, but dedicated pulse/failure behavior tests and browser verification are absent. |
| 11. Tests, build, deployment, load evidence | **PARTIAL** | Executed this audit: `npx tsc --noEmit` clean; `npx vitest run` **116/116 passed** across 12 files; `npm run build` successful (49.05 kB JS, 28.40 kB CSS, 17.44 kB HTML); `git diff --check` clean. `tools/loadtest` exists, and historical D-24/D-17 evidence is limited to 50 clients; no current 10,000-client acceptance run or production deployment evidence exists. |

#### Current Git and state-model findings

- `apps/server/src/app.ts` and `apps/server/src/line.ts` use one authoritative
  in-memory Line with best-effort JSON snapshot/session persistence. There is
  no database, Redis, event log, or multi-room state model in V1.
- The working directory is nested under `C:\Users\Asus\Desktop`. Parent Git
  status reports the project as `?? ./` alongside unrelated Desktop changes;
  normal project-local tracked diffs/commits cannot be established. This is a
  release/provenance blocker, not evidence that the source is cleanly committed.

#### Prioritized gap list

1. **Release blocker:** establish a dedicated Git repository/track the project
   files and make a reproducible release commit.
2. **Release blocker:** run graphical two-session and mobile browser checks for
   consent, controls, team naming/leaderboard, canvas touch, and education.
3. Implement authoritative team qualification and the real Surprise Zone room,
   transition, idempotency, and reconnect model before claiming the requested
   team extension complete.
4. Add Packet Run integration tests for valid routes, outages, terminal state,
   and cooldown/duplicate announcements.
5. Add team merge/split/tie/persistence tests and pulse/failure-preview tests.
6. Run and commit current load/deployment evidence; do not claim 10,000-client
   capacity from the historical 50-client result.

**Audit conclusion:** core V1 gameplay, authoritative consent, engine rules,
scoring, and automated regression checks pass. The repository is **not release
ready for the full requested scope** because Surprise Zone and qualification
are absent, browser/mobile evidence is unavailable, Packet Run coverage is
incomplete, and Git provenance/deployment/load evidence remain unresolved.

### 2026-10-27 mobile + team-system extension (PARTIAL / VERIFIED FOUNDATION)

- Added mobile layout improvements in `apps/web/src/style.css`: the search
  panel expands to the phone width, the leaderboard becomes a bounded drawer
  above the action stack, request/player cards move above mobile controls, and
  the existing 44px control targets and safe-area offsets are preserved.
- Added authoritative team projection to `packages/protocol/src/index.ts`,
  `apps/server/src/app.ts`, and `apps/server/src/view.ts`. Teams are connected
  components of active accepted links only. Pending requests, inactive links,
  and isolated players do not create teams.
- Added server-owned team naming via `team_name`, with trimmed 32-character
  input, membership validation, synchronized snapshots/deltas, and deterministic
  merge/split name inheritance. The client prompt is shown once per newly
  observed unnamed team and defers during Warning/Results or incoming requests.
- Added a real `TEAM LEADERBOARD` section to the existing ranking panel. It
  lists actual synchronized teams, member counts, active links, restored-route
  contribution, deterministic ordering, and current-team highlighting. The
  existing individual leaderboard remains available below it.
- Added `apps/server/test/server.test.ts` coverage proving a pending request
  creates no team and an accepted request creates one synchronized team whose
  name can be saved. Server suite now reports **34 tests**.
- Documented the separate team ranking metric and the architectural limitation
  in `docs/DECISIONS.md` as D-31. The current V1 has one Line and no
  authoritative room/area transition protocol, so a fake client-only Surprise
  Zone was deliberately not implemented.
- `npx tsc --noEmit`: **VERIFIED clean**.
- `npx vitest run`: **VERIFIED 116 passed / 116**, 12 files.
- `npm run build`: **VERIFIED successful**, 49.05 kB JS (16.25 kB gzip),
  28.40 kB CSS (6.45 kB gzip), 17.44 kB HTML (5.48 kB gzip).
- `git diff --check`: **VERIFIED clean**.
- Browser verification at 360px/390px/tablet/desktop and multi-session team
  naming/merge flows remains **UNVERIFIED** because no supported browser
  executable is available.

#### Explicitly unfinished from the requested extension

- Team qualification progress and resilience-objective tracking are not yet
  authoritative team fields.
- Surprise Zone entry, distinct area/room state, group transition,
  reconnect-in-zone behavior, and related tests are not implemented. The
  existing architecture must be extended with an authoritative area model
  before those can be added without violating multiplayer integrity.

### 2026-10-27 V1 acceptance freeze audit (VERIFIED / PARTIAL / NOT VERIFIED)

Scope was frozen after the educational panel. No optional features were added.
One release-blocking correctness issue was fixed: `apps/web/src/main.ts`
`updateHud()` now averages `model.history.slice(-10)`, matching the engine's
10-result history and the PRD's Network Health requirement; it previously used
only five results.

| Acceptance area | Result | Evidence and remaining blocker |
|---|---|---|
| Typecheck, automated regression suite, production build | **PASS** | `npx tsc --noEmit` clean; `npx vitest run` **115/115 passed** across 12 files; `npm run build` successful (46.35 kB JS, 25.39 kB CSS, 16.44 kB HTML). |
| Multiplayer synchronization | **PASS / NOT VERIFIED in browsers** | `apps/server/test/server.test.ts` uses real WebSocket clients and covers snapshots, deltas, joins, reconnect, movement, and broadcast. A live isolated six-client smoke run passed Build → Warning → Outage → Repair → Score → Recovery → Results. Separate graphical browser sessions remain unavailable. |
| Explicit connection acceptance | **PASS / NOT VERIFIED in browsers** | Server tests cover pending requests, no edge before acceptance, accept/decline, duplicates, expiry, and phase validation. `apps/server/src/app.ts` creates an edge only after accepted `respond_link` revalidation. Fresh two-browser verification remains blocked by missing browser tooling. |
| Node movement and edge rendering | **PASS** | Engine movement tests enforce bounds/speed and no auto-connect; `apps/web/test/render.test.ts` verifies moved node positions and both edge endpoints are redrawn. Canvas handlers use pointer capture for dragging. |
| Search, leaderboard, and player information | **PARTIAL** | `apps/web/test/community.test.ts` has 9 pure search/ranking/relationship tests; client rendering and server-derived presence/join metadata are implemented in `main.ts`, `community.ts`, and `view.ts`. Fresh browser click/keyboard/responsive inspection is not verified. |
| Phases, outages, repair, and scoring | **PASS** | Engine strike/scoring/rules/appendix tests pass; live smoke observed a real outage, score, recovery, and Results transition. `outage.ts`, `engine.ts`, `scoring.ts`, and `graph.ts` provide authoritative calculations. |
| Repeated Packet Run issue | **PARTIAL** | `apps/server/src/app.ts` uses BFS over active valid links and a 30-second `packetNextAt` quiet window; `main.ts` uses `packetCardKey` and `packetAnnouncementKey` to prevent repeated card/toast work. No dedicated Packet Run regression test or visual animation verification exists. |
| Interactive buttons and modal controls | **PARTIAL** | Source audit confirms handlers for requests, accept/decline/cancel, failure preview/restore, pulse/dismiss, Learn/close/backdrop, Find My Node, search, leaderboard, join, and drag. Automated server/web tests pass, but real desktop/mobile click/touch verification is unavailable. |
| Educational panel accuracy | **PASS in source / NOT VERIFIED visually** | `apps/web/index.html` now describes verified vanilla TypeScript/Vite, Canvas 2D, Node HTTP + `ws`, pure engine, JSON/session persistence, and Vitest/fast-check. It explicitly labels libp2p, PubSub, discovery, streams, relays, and NAT traversal as absent or analogies. Build and tests pass; browser layout/scroll inspection remains unavailable. |
| Git/release provenance | **NOT VERIFIED** | The working directory is nested under `C:\Users\Asus\Desktop`, whose parent Git repository reports the project as untracked (`?? ./`) and shows unrelated parent changes. `git diff --check` is clean, but a project-local committed diff/release commit cannot be established from this workspace. |

#### Remaining blockers

- No supported browser executable/display is available for fresh two-session,
  desktop/mobile, modal, Packet Run, and educational-panel verification.
- Dedicated Packet Run integration tests are absent.
- Search/leaderboard/player-card and local-only button behavior have source and
  unit evidence but no fresh browser-level evidence.
- Project Git provenance is unresolved because `nodes` is untracked inside the
  parent Desktop repository. No production deployment or 10,000-client claim
  is made.

**Release conclusion:** **NOT release-ready based on the requested acceptance
bar**. Core engine/server checks and the live six-client phase smoke test pass,
but browser acceptance evidence, Packet Run integration coverage, and project
Git provenance remain unresolved.

### 2026-10-27 implementation-grounded educational panel (VERIFIED)

- Replaced the repetitive `A little about libp2p` glossary in
  `apps/web/index.html` with `UNDER THE HOOD — MUMBAI NETWORK GARDEN`.
- Section A, **How This Game Actually Works**, now documents verified
  WebSocket snapshots/deltas and event names, application identity/presence,
  consent-first request validation, Canvas graph rendering, BFS Packet Run
  routes, outage types and active-graph reachability, and phase/scoring flow.
- Section B, **The Real libp2p Concepts Behind It**, now uses consistent
  What it is / How real libp2p uses it / Connection to this game / Important
  difference explanations for Peer IDs, discovery, dialing, connections /
  streams / protocols, PubSub, relays/NAT traversal, and resilience.
- Added explicit Used in this game, Simulated, Analogy, Not implemented, and
  Educational only badges. Removed duplicate Connections and Streams &
  Protocols cards and contradictory generic wording.
- Added a compact verified Technology Stack area covering vanilla TypeScript +
  Vite, Canvas 2D, Node HTTP + `ws`, the pure TypeScript engine, JSON/session
  persistence, Vitest, and fast-check. The panel explicitly states that no
  React, libp2p, GossipSub, DHT, relay, NAT traversal, or browser-to-browser
  transport was verified.
- Added responsive collapsible `<details>` cards, section hierarchy, mobile
  single-column layout, readable scrolling, and preserved the existing close,
  backdrop dismissal, and Learn button behavior. The panel remains read-only.
- `npx tsc --noEmit`: **VERIFIED clean**.
- `npx vitest run apps/web/test/community.test.ts apps/web/test/render.test.ts`:
  **VERIFIED 11 passed / 11**.
- `npx vitest run`: **VERIFIED 115 passed / 115**, 12 files.
- `npm run build`: **VERIFIED successful**, 46.35 kB JS (15.52 kB gzip),
  25.39 kB CSS (5.95 kB gzip), 16.44 kB HTML (5.23 kB gzip).
- `git diff --check`: **VERIFIED clean**.
- Browser visual inspection at desktop/mobile sizes remains **UNVERIFIED**
  because no supported browser executable/display is available in this
  environment.

### 2026-10-27 five-feature implementation audit (READ-ONLY)

Audit scope: source, server/engine state transitions, client rendering, and
existing tests. No feature code was changed in this audit.

| Feature | Finding | Evidence |
|---|---|---|
| **Live Network Emergencies** | **Partially implemented** | Authoritative outage rounds are implemented in `packages/engine/src/outage.ts` (`applyStrike`, caps, strike types A/B/C) and `packages/engine/src/engine.ts` (Warning → outage → Repair → score → recovery). `apps/server/src/app.ts` broadcasts snapshots/deltas and `apps/web/src/main.ts` handles `outage.applied` / `round.recovered`, updates node/link availability, flashes the UI, and reports affected nodes. Engine outage and phase tests pass. There is no dedicated end-to-end emergency UI test or fresh manual multi-client outage verification. |
| **Watch a Message Travel / Packet Run** | **Partially implemented** | `apps/server/src/app.ts` `activeRoute()` performs BFS over only uncut active links with active endpoints; `updatePacketMission()` creates a blocked mission, starts it only when a route has at least two nodes, fails when no route remains, and applies a 30-second post-terminal cooldown. `apps/web/src/main.ts` `renderPacketMission()` animates `mission.route`, and `apps/web/src/render.ts` draws only route/pulse segments tied to live links. The previous repeated-message cause is guarded by server `packetNextAt` plus client `packetCardKey` and `packetAnnouncementKey`; no continuous duplicate path is visible in source. However, there are no dedicated Packet Run tests, no browser animation verification, and the client does not independently validate every route hop before rendering the server-provided route. |
| **Collective Connectivity Milestones** | **Not implemented** | Search found no milestone event, threshold state, milestone UI, or milestone test. The current UI has score/health/round feedback and activity messages only (`apps/web/src/main.ts`, `apps/web/index.html`); those are not collective milestone tracking. |
| **Social Connection Requests** | **Fully implemented and tested (automated; browser sessions unverified)** | `apps/server/src/app.ts` stores pending requests separately, sends `request_result: pending`, targets `link_request` to the named peer, revalidates on `respond_link`, and calls engine `create_link` only after explicit acceptance. `apps/web/src/main.ts` renders pending requests as dashed indicators and handles Request/Accept/Decline/Cancel. `apps/server/test/server.test.ts` contains 16 request tests covering pending state, acceptance, decline, expiry, duplicates, invalid requests, phase locking, and no edge before acceptance. Separate fresh browser-session verification could not be run because no supported browser executable is available. |
| **Network Resilience Score** | **Implemented but broken in displayed trend metric** | The authoritative calculation is implemented and tested in `packages/engine/src/scoring.ts` and `packages/engine/src/graph.ts`: largest active component, articulation-point redundancy, repair speed, exact half-up scoring, and void-round handling. `apps/server/src/view.ts` exposes last score/history; `apps/web/src/main.ts` displays last score and Network Health. But `updateHud()` computes Health from `model.history.slice(-5)` (line 1618), while the PRD requires the last 10 rounds; the engine stores up to 10 in `HISTORY_LIMIT`. The score itself is tested, but the displayed Health trend is not PRD-accurate. V1 also runs one Line by decision D-17, so global multi-Line aggregation is not present. |

#### Verification performed

- Targeted feature suites:
  `npx vitest run apps/server/test/server.test.ts packages/engine/test/strikes.test.ts packages/engine/test/scoring.test.ts packages/engine/test/appendix-b.test.ts packages/engine/test/rules.test.ts apps/web/test/render.test.ts apps/web/test/community.test.ts` — **88 passed / 88**, 7 files.
- Full suite: `npx vitest run` — **115 passed / 115**, 12 files.
- `npx tsc --noEmit` — **VERIFIED clean**.
- `npm run build` — **VERIFIED successful**, 46.35 kB JS (15.52 kB gzip),
  22.59 kB CSS (5.35 kB gzip), 7.90 kB HTML (2.68 kB gzip).
- No files were modified except this audit record.

#### Gap report

1. Add dedicated Packet Run route/terminal/cooldown regression tests and browser animation verification.
2. Add collective milestone state, events, UI, and tests only if this feature is approved for V1.
3. Correct Network Health display to use the authoritative ten-round history (and define multi-Line aggregation before claiming a global metric).
4. Run two fresh browser sessions for request → pending → accept/decline and a multi-client outage/emergency sequence when browser tooling is available.

### 2026-10-27 final action-button audit (VERIFIED targeted client/server lifecycle fix)

- Audited the visible action paths in `apps/web/src/main.ts`: player cards and
  node selection, Request Connection/Cancel, incoming Accept/Decline, search
  input/clear/keyboard/results, leaderboard toggle/rows, Simulate Failure and
  Restore View, Ping Network/result dismissal, Learn libp2p/close/backdrop,
  Find My Node, join, movement/dragging, and phase-driven action availability.
- Confirmed the authoritative server path in `apps/server/src/app.ts`: request
  creation sends `request_result: pending`, acceptance revalidates the current
  graph and phase, and only a successful accepted response creates an edge.
  Pending requests are never active links.
- Root cause fixed: the client treated a request as sending even when the
  WebSocket was not open, then cleared the selected target, leaving no retry
  path. `send()` now reports delivery; failed sends restore the action and show
  reconnect feedback. The request timeout retains the target and provides an
  error instead of silently expiring.
- Root cause fixed: incoming Accept/Decline controls could remain disabled if
  their response was lost. Response IDs now have an 8-second pending guard and
  recovery timer; successful/failed server results clear the guard, while a
  lost response re-renders the request and permits retry.
- Preserved read-only failure simulation: it derives components from active
  nodes and active links only, changes no server state, and Restore view only
  clears local preview state. Ping reachability likewise reads active links and
  prevents concurrent pulses. Learn and Find handlers were present and remain
  unchanged.
- Existing server regression coverage includes duplicate pending requests,
  expiry, acceptance/decline, phase validation, degree limits, and no implicit
  auto-connect behavior.
- `npx tsc --noEmit`: **VERIFIED clean**.
- `npx vitest run`: **VERIFIED 115 passed / 115**, 12 files.
- `npm run build`: **VERIFIED successful**, 46.35 kB JS (15.52 kB gzip),
  22.59 kB CSS (5.35 kB gzip), 7.90 kB HTML (2.68 kB gzip).
- Browser-level two-session action verification remains **UNVERIFIED** because
  no supported browser executable/CLI display is available in this environment.

### 2026-10-27 bottom-right controls layout cleanup (VERIFIED)

- Removed the conflicting individual fixed-position and mobile offset rules for
  `Find my node`, `PING NETWORK`, and `Learn libp2p`.
- The existing `.gameControls` wrapper is now the sole positioning context: a
  bottom-right column with 10px gaps, a bounded responsive width, safe-area
  offsets, and 44px minimum button heights. The controls remain above the
  canvas and separate from the shared-world status labels.
- The whole control group is hidden in the pre-join screen instead of leaving
  the Ping/Learn siblings visible around the join overlay.
- Existing handlers were preserved: Find my node focuses the current node;
  Ping Network prevents overlapping pulses and restores its enabled state;
  Learn libp2p opens the existing panel, whose close button and backdrop
  dismissal remain active.
- `npx tsc --noEmit`: **VERIFIED clean**.
- `npx vitest run apps/web/test/render.test.ts apps/web/test/community.test.ts`:
  **VERIFIED 11 passed / 11**.
- `npm run build`: **VERIFIED successful**, 45.63 kB JS (15.34 kB gzip),
  22.58 kB CSS (5.35 kB gzip), 7.90 kB HTML (2.69 kB gzip).
- Browser screenshot/click inspection remains **UNVERIFIED** because no Chrome
  or supported CLI browser is available in this environment; the local Vite
  server did start successfully on `http://127.0.0.1:4179/`.

### 2026-10-27 global interaction audit (VERIFIED targeted checks)

- Audited all current DOM controls and handlers: join, search/clear/results,
  leaderboard toggle/rows, player-card actions, request modal, incoming
  Accept/Decline, Cancel, Ping Network/result dismiss, Learn libp2p/panel,
  Find My Node, failure-preview restore, and Canvas node drag/tap.
- Root causes addressed: the bottom-right controls were previously at risk of
  legacy sibling fixed-position rules (now grouped in `.gameControls`), and the
  request modal was below newer transient overlays and had undersized hit
  targets. The request modal now has an explicit high interaction layer,
  pointer/touch handling, and 44px button targets.
- Results-phase `Linking Locked` remains intentionally disabled by the existing
  authoritative `PHASE_LOCKED` validation. Cancel remains available and does
  not modify graph state.
- No handlers were replaced with mocks; connection acceptance, movement,
  search, leaderboard, pulse, education, and preview behavior remain unchanged.
- `npx tsc --noEmit`: **VERIFIED clean**.
- Targeted regression tests:
  `npx vitest run apps/server/test/server.test.ts apps/web/test/community.test.ts apps/web/test/render.test.ts` — **44 passed / 44**.
- `npm run build`: **VERIFIED successful**, 45.63 kB JS (15.34 kB gzip),
  22.99 kB CSS (5.43 kB gzip), 7.90 kB HTML (2.69 kB gzip).
- `git diff --check`: **VERIFIED clean**.
- Real browser click/touch verification remains **UNVERIFIED** because the
  Windows CLI browser display is unavailable.

### 2026-10-27 bottom-right control stack fix (VERIFIED)

- Root cause: `PING NETWORK`, `Learn libp2p`, and `Find my node` were each
  independently fixed to the viewport with separate bottom offsets. Their
  clickable rectangles could overlap as viewport sizing and mobile overrides
  changed.
- Grouped the three existing controls into one bottom-right flex-column stack
  ordered as Ping Network, Learn libp2p, Find my node. No control or handler was
  removed or changed.
- Added consistent gaps, widths, minimum touch heights, safe-area offsets, and
  mobile sizing. Higher-specificity stack rules reset the old individual fixed
  positioning so each control owns its own hit area.
- `npx tsc --noEmit`: **VERIFIED clean**.
- `npx vitest run apps/web/test/render.test.ts apps/web/test/community.test.ts`:
  **VERIFIED 11 passed / 11**.
- `npm run build`: **VERIFIED successful**, 45.63 kB JS (15.34 kB gzip),
  22.60 kB CSS (5.35 kB gzip), 7.90 kB HTML (2.69 kB gzip).
- Browser screenshot inspection at desktop and narrow widths remains
  **UNVERIFIED** because the Windows CLI browser display is unavailable; the
  DOM structure and responsive CSS are in place.

### 2026-10-27 contextual libp2p concept mapping (VERIFIED build/tests)

- Extended the existing educational popup/panel without changing networking
  architecture. The app uses ordinary WebSockets and a simulated graph; no
  genuine libp2p implementation was found, so every explanation labels its
  relationship as illustrative rather than implemented.
- Added contextual mappings for peer identity/discovery on join, dialing on a
  successfully submitted request, peer connections on acceptance, routing /
  streams / protocols on simulated Packet Run delivery, and resilience /
  connectivity on a genuine outage event.
- Added reference-panel entries for identity/discovery, peer connections,
  streams/protocols, resilience, and PubSub/GossipSub. PubSub, relays, and NAT
  traversal are explicitly described as real-world concepts not used by this
  game.
- Full explanations use the consistent `WHAT JUST HAPPENED`, `LIBP2P CONCEPT`,
  `HOW IT WORKS IN REAL LIBP2P`, and `IN THIS GAME` structure. Per-session
  guards, compact repeat notices, dismissal, and Learn more prevent repeated
  interruptions; failed actions do not trigger success education.
- `npx tsc --noEmit`: **VERIFIED clean**.
- `npx vitest run`: **VERIFIED 115 passed / 115**, 12 files.
- `npm run build`: **VERIFIED successful**, 45.63 kB JS (15.34 kB gzip),
  21.35 kB CSS (5.17 kB gzip), 7.82 kB HTML (2.66 kB gzip).
- Browser popup-by-popup inspection remains **UNVERIFIED** because the Windows
  CLI browser display is unavailable; automated multiplayer regression tests
  remain green.

### 2026-10-27 final V1 release-hardening verification (VERIFIED / BLOCKED)

- No additional feature work was added during this pass. The current approved
  implementation was audited for join isolation, consent-first linking,
  movement, authoritative edges, search, leaderboard, phases/outages/repair,
  scoring, Packet Run safeguards, player cards, Network Pulse, and local
  failure preview.
- `npx tsc --noEmit`: **VERIFIED clean**.
- `npx vitest run`: **VERIFIED 115 passed / 115**, 12 files, 6.36 s.
- `npm run build`: **VERIFIED successful**, 43.09 kB JS (14.61 kB gzip),
  21.35 kB CSS (5.17 kB gzip), 6.95 kB HTML (2.40 kB gzip).
- Fresh isolated server check using `PORT=8098` and a temporary `DATA_DIR`:
  `/healthz` returned 200 with `phase: seeding`, `roundNo: 0`, `nodes: 0`;
  `/` and `/screen` both returned 200.
- Existing browser evidence verifies two-session consent/movement and
  three-session search/leaderboard/reconnect/responsive flows. No duplicate
  node or unwanted edge behavior is covered by the existing server and engine
  suites.
- **Release blockers remain:** the Windows CLI environment cannot provide the
  browser display needed for fresh visual or five-client manual verification;
  dedicated integration tests for the newest local-only visual interactions
  are not present. Production deployment and the PRD's 10,000-client capacity
  target are not verified and are not claimed.

### 2026-10-27 final engagement-polish verification (VERIFIED checks)

Final scope is implemented; no additional feature work was added in this
verification pass.

- Packet Run duplicate root cause remains fixed: the server-owned mission
  state has a 30-second post-terminal quiet window, and the client updates only
  the countdown instead of rebuilding the mission card every render tick.
- Player info cards, server-derived presence/join data, contextual Dialing
  education, read-only failure preview, Network Pulse, accepted-edge pulses,
  outage/recovery feedback, activity feed, and first-join guidance are present
  in the existing client architecture.
- `npx tsc --noEmit`: **VERIFIED clean**.
- `npx vitest run`: **VERIFIED 115 passed / 115**, 12 files.
- `npm run build`: **VERIFIED successful**, 43.09 kB JS (14.61 kB gzip),
  21.35 kB CSS (5.17 kB gzip), 6.95 kB HTML (2.40 kB gzip).
- Source inspection confirmed the relevant safeguards: `packetNextAt`,
  `packetCardKey`, server-confirmed `showDialingEducation`, one-shot
  `startNetworkPulse`, local `simulateFailure`, and authoritative pulse route
  checks.
- Dedicated browser visual verification of every final interaction remains
  **UNVERIFIED** because the Windows CLI browser display tool is unavailable.
  Existing two-/three-session browser evidence covers the core consent,
  movement, search, leaderboard, reconnect, and responsive flows. Five-client
  outage verification and dedicated integration tests for the newest local-only
  visual features remain outstanding.

### 2026-10-27 local failure simulation (VERIFIED build/tests)

- Added `Simulate failure` to eligible active peer info cards. It computes a
  read-only preview from the current active accepted graph using breadth-first
  connected components.
- The preview dims the selected node and all incident edges, subtly outlines
  resulting components, and reports whether the network stays connected,
  splits into groups, and how many peers become unreachable from the local
  node. Inactive links, disabled nodes, isolated nodes, redundant paths, and
  already-disconnected graphs are handled from current state rather than fixed
  examples.
- `Restore view` immediately exits the preview. No WebSocket message, node/link
  mutation, outage, score, token, request, or broadcast is performed.
- `npx tsc --noEmit`: **VERIFIED clean**.
- `npx vitest run apps/web/test/render.test.ts`: **VERIFIED 2 passed / 2**.
- `npx vitest run` before the final renderer-only adjustment: **VERIFIED 115
  passed / 115**, 12 files. `npm run build` after the adjustment: **VERIFIED
  successful**, 43.09 kB JS (14.61 kB gzip), 21.35 kB CSS (5.17 kB gzip),
  6.95 kB HTML (2.40 kB gzip).
- Browser visual verification of all graph shapes remains **UNVERIFIED** in
  this Windows CLI environment because the browser display tool is unavailable.

### 2026-10-27 Network Pulse (VERIFIED build/tests)

- Added a compact `PING NETWORK` control for the current player. It is one-shot
  and user-triggered; it sends no WebSocket action and does not alter nodes,
  links, tokens, scores, requests, or server state.
- Reachability is calculated from the client’s current authoritative snapshot:
  active accepted links only, with disabled endpoints excluded. A breadth-first
  tree produces the actual signal sequence; no path or edge is fabricated.
- Added a short Canvas pulse animation along live edges, arrival halos on
  reachable nodes, and dashed highlights for unreachable nodes. If an outage
  invalidates a segment during the animation, that segment is skipped.
- Added a dismissible result showing real reachable and unreachable counts,
  including the isolated-player and disconnected-component cases. The control
  is disabled during the bounded run to prevent overlapping pulses.
- Labeling remains simulated visualization; no libp2p API or traffic is claimed.
- `npx tsc --noEmit`: **VERIFIED clean**.
- `npx vitest run`: **VERIFIED 115 passed / 115**, 12 files.
- `npm run build`: **VERIFIED successful**, 41.29 kB JS (14.05 kB gzip),
  20.37 kB CSS (5.02 kB gzip), 6.85 kB HTML (2.38 kB gzip).
- Dedicated browser interaction inspection remains **UNVERIFIED** because the
  Windows CLI browser display is unavailable; automated renderer, engine, and
  server suites remain green.

### 2026-10-27 contextual libp2p learning popup (VERIFIED build/tests)

- Added `Behind the Network` popup at the existing server-confirmed outgoing
  request result (`status: pending`) boundary. Selection, button press, and
  failed validation do not trigger it.
- The first successful request in a browser session receives the detailed
  Dialing explanation; later successful requests receive a compact notice.
  Both have Dismiss and Learn more actions, auto-dismiss, and do not block the
  target player's independent Accept/Decline card.
- Copy explicitly describes `libp2p.dial(peerId)` as a real libp2p concept and
  distinguishes it from this game's application-level request/accept workflow.
  No libp2p API, Peer ID, edge, or network state is fabricated.
- `npx tsc --noEmit`: **VERIFIED clean**.
- `npx vitest run`: **VERIFIED 115 passed / 115**, 12 files.
- `npm run build`: **VERIFIED successful**, 38.88 kB JS (13.36 kB gzip),
  19.46 kB CSS (4.87 kB gzip), 6.66 kB HTML (2.33 kB gzip).
- Dedicated browser popup interaction verification remains **UNVERIFIED** in
  this Windows CLI environment because the browser display tool is unavailable;
  request lifecycle and rejection behavior remain covered by the existing
  automated server suite.

### 2026-10-27 game-feel pass (VERIFIED build/tests)

- Added a restrained, event-driven energy pulse that travels once along each
  actually accepted edge when `link.created` is received. Pulse state is keyed
  by authoritative link ID and expires from the client map, so it does not
  animate pending or fabricated connections and cannot grow without bound.
- Added short visual escalation for the existing Warning and Results phases and
  a brief outage vignette when the authoritative `outage.applied` event arrives.
  A recovery event receives a shorter acknowledgement pulse. Phase durations,
  outage targeting, scoring, tokens, and connection validation were unchanged.
- Existing smooth endpoint interpolation remains the movement/edge behavior;
  Packet Run remains secondary and retains its mission-ID/card stability and
  server cooldown safeguards.
- `npx tsc --noEmit`: **VERIFIED clean**.
- `npx vitest run`: **VERIFIED 115 passed / 115**, 12 files.
- `npm run build`: **VERIFIED successful**, 37.05 kB JS (12.80 kB gzip),
  18.10 kB CSS (4.64 kB gzip), 6.33 kB HTML (2.22 kB gzip).
- Live browser visual inspection remains **UNVERIFIED** because the Windows
  CLI browser display is unavailable. No new gameplay or capacity claims are
  made from this pass.

### 2026-10-27 V1 release acceptance verification (VERIFIED / UNVERIFIED)

Scope was frozen for this pass; no new feature work was added.

| Acceptance item | Result | Evidence / limitation |
|---|---|---|
| Join live game and see peers | VERIFIED | Existing two-/three-session browser evidence and server handshake tests |
| Distinct isolated nodes | VERIFIED | Engine join tests, server tests, and consent browser evidence |
| Explicit request acceptance | VERIFIED | 16 connection-request server tests plus 31/31 browser checks |
| Movement and persistent accepted edges | VERIFIED | Movement server tests, renderer tests, and browser evidence |
| Search, player info, leaderboard use real state | VERIFIED | Community tests and 44/44 three-session browser checks; player-info presence is server-derived |
| Phases, outages, repairs, scoring | VERIFIED in automated coverage | Engine rule/strike/scoring tests and server round coverage; five-client visual outage run remains unverified |
| Multiplayer consistency | VERIFIED for tested sessions | Two-/three-session browser evidence and WebSocket server tests; five-client run remains unverified |
| Build and server boot | VERIFIED | `npx tsc --noEmit`, `npm run build`, and fresh isolated server on port 8099: `/healthz` 200, `/` 200, `/screen` 200 |
| Core flow regression checks | VERIFIED for available checks | `npx vitest run`: **115/115 passed**, 12 files |
| Deployment/capacity claims | NOT VERIFIED | Existing 50-client load evidence is recorded; PRD 10,000-user acceptance and production deployment are not claimed |

**Release blockers / limitations:** browser display inspection is unavailable in
this Windows CLI session; a dedicated five-browser join → consent → outage →
results → reconnect run is still outstanding. No 10,000-client capacity or
production deployment claim is made.

### 2026-10-27 Packet Run duplicate-trigger fix (VERIFIED build/tests)

- **Root cause identified:** the server cleared a delivered/failed Packet Run
  and allowed `updatePacketMission()` to create a replacement on the very next
  5 Hz tick. This made recurring missions appear as duplicate messages and
  animations without an intentional transition. The client also rebuilt the
  entire mission card with `innerHTML` every 100 ms, retriggering its DOM
  content even when the mission identity and status had not changed.
- Added a server-owned 30-second quiet window after a mission completes,
  fails, or expires. Mission creation remains one controlled server tick event;
  no client timer, React effect, or additional interval was added.
- Added client mission identity/status keys. The card shell is rebuilt only
  when the mission or status changes; only its countdown text is updated during
  the render loop. The packet dot continues to follow the authoritative route
  without restarting the mission.
- Success/failure notifications are guarded by mission ID/status, so each
  terminal result produces one message.
- `npx tsc --noEmit`: **VERIFIED clean**.
- `npx vitest run`: **VERIFIED 115 passed / 115**, 12 files.
- `npm run build`: **VERIFIED successful**, 36.58 kB JS (12.61 kB gzip),
  17.78 kB CSS (4.55 kB gzip), 6.33 kB HTML (2.22 kB gzip).
- Browser visual inspection and a dedicated Packet Run integration test remain
  **UNVERIFIED** because the Windows browser display is unavailable. Existing
  automated server/client suites remain green.

### 2026-10-27 core gameplay engagement pass (VERIFIED build/tests)

- Added a one-time, contextual first-join instruction: `Find a peer and
  request a connection to start building the network.` It expires automatically
  and does not block the board or alter gameplay.
- Added a compact live activity feed sourced from authoritative join, accepted
  link, outage, recovery, score, disconnect, and reconnect state. It does not
  fabricate players or graph events.
- Added clearer feedback for accepted connections, outage response guidance,
  recovery, and actual round scores. Existing request/accept/decline/expiry
  behavior remains server-authoritative and unchanged.
- Added initial peer-join activity and explicit connection-success teaching so
  the intended loop is visible: join, discover, request, accept, then build
  redundancy before an outage.
- `npx tsc --noEmit`: **VERIFIED clean**.
- `npx vitest run`: **VERIFIED 115 passed / 115**, 12 files.
- `npm run build`: **VERIFIED successful**, 36.18 kB JS (12.48 kB gzip),
  17.78 kB CSS (4.55 kB gzip), 6.33 kB HTML (2.22 kB gzip).
- Five-browser manual gameplay verification and screenshot review remain
  **UNVERIFIED** in this CLI environment because the Windows browser display
  tool is unavailable. Existing two-/three-session browser evidence covers the
  consent, movement, search, leaderboard, reconnect, and responsive flows;
  a dedicated five-client outage run remains outstanding.

### 2026-10-27 Packet Run (VERIFIED build/tests)

- Added an authoritative, lightweight packet mission to the existing snapshot
  flow. With at least two players, the server selects a source and destination
  from real Line nodes and reports `blocked`, `in_transit`, `delivered`, or
  `failed` state.
- Routes are computed server-side from active accepted links only; disabled
  endpoints and cut links are excluded. Pending, declined, expired, or failed
  requests cannot create a route, and no connection is created automatically.
- Added a compact simulated Packet Run card and a glowing packet animation that
  follows the reported node sequence and current Canvas camera. Outage route
  loss is shown as `Route interrupted`; the mission can clear and start again
  without resetting the Line.
- `npx tsc --noEmit`: **VERIFIED clean**.
- `npx vitest run`: **VERIFIED 115 passed / 115**, 12 files.
- `npm run build`: **VERIFIED successful**, 34.80 kB JS (12.05 kB gzip),
  17.13 kB CSS (4.40 kB gzip), 6.14 kB HTML (2.16 kB gzip).
- Multi-browser mission delivery and outage screenshot verification remains
  **UNVERIFIED** in this CLI environment; the existing browser display tool is
  unavailable. The route and protocol behavior is covered by the authoritative
  implementation and existing server regression suite, but dedicated Packet
  Run integration tests are still a limitation.

### 2026-10-27 interactive node info and libp2p education (VERIFIED)

- Added server-authoritative `joinedAt` and `presence` metadata to node views;
  presence is derived from currently ready WebSocket sessions, not graph degree.
  Disconnects broadcast updated snapshots and reconnects reuse the existing
  persisted session/node identity.
- Added compact hover/touch player cards with application player ID, presence,
  relative join time, accepted active-link count, separate pending-request and
  outage wording, and an eligible request action. Cards do not create links by
  themselves and self-connection is not offered.
- Added offline node marker and a responsive, dismissible `Learn libp2p` guide.
  The guide explicitly distinguishes the simulated graph and Application
  Player ID from real libp2p peers, Peer IDs, streams, discovery, relays, and
  NAT traversal.
- `npx tsc --noEmit`: **VERIFIED clean**.
- `npx vitest run`: **VERIFIED 115 passed / 115**, 12 files.
- `npm run build`: **VERIFIED successful**, 33.38 kB JS (11.56 kB gzip),
  15.71 kB CSS (4.13 kB gzip), 5.98 kB HTML (2.13 kB gzip).
- Real two-browser presence/disconnect visual verification remains **UNVERIFIED**
  in this CLI environment because the Windows computer-use display is unavailable.

### 2026-10-27 UI redesign increment (VERIFIED)

- Redesigned the existing client presentation in `apps/web/index.html` and
  `apps/web/src/style.css` with a premium dark sci-fi HUD, phase-aware status
  treatment, network health meter, token HUD, shared-world indicator, refined
  search/leaderboard surfaces, responsive mobile layout, join card, controls,
  request cards and reduced-motion support.
- Enhanced `apps/web/src/render.ts` with a restrained technical grid, updated
  palette, stronger readable network links, and subtle node rings. Rendering
  still consumes only authoritative node/link state; no mock players or edges
  were introduced.
- Updated `apps/web/src/main.ts` to expose the real node count, phase styling,
  and health-meter width from current model state.
- `npx tsc --noEmit`: **VERIFIED clean**.
- `npx vitest run`: **VERIFIED 115 passed / 115**, 12 files.
- `npm run build`: **VERIFIED successful**, 30.12 kB JS (10.50 kB gzip),
  12.85 kB CSS (3.59 kB gzip), 4.36 kB HTML (1.53 kB gzip).
- Existing server at `http://127.0.0.1:8080/healthz`: **VERIFIED 200**. A second
  `npm start` was not launched because port 8080 was already in use.
- Browser screenshot inspection is **UNVERIFIED** in this CLI environment:
  the computer-use display is unavailable on Windows CLI. Existing browser
  interaction evidence remains valid for gameplay behavior, while this visual
  increment still needs a real browser screenshot pass when a display is
  available.

Labels: **VERIFIED** = observed by running something here. **UNVERIFIED** =
implemented but not observed on the relevant device or at the relevant scale.
**NOT IMPLEMENTED** = absent, listed so it is not mistaken for done.

**PRD override:** `docs/PRD.md` still says automatic starter links (6.2) and
third-party helper links (6.3). The owner overrode both on 2026-10-26. The
authoritative amendment is `docs/PRD_AMENDMENT_2026-10-26.md`; the PRD file was
not edited. Decisions D-26 through D-30 in `docs/DECISIONS.md` record the
implementation consequences.

---

## 1. What actually runs (VERIFIED)

| Check | Command | Result |
|---|---|---|
| Type check | `npx tsc --noEmit` | clean, exit 0 |
| Test suite | `npx vitest run` | **115 passed / 115**, 12 files, 7.0 s |
| Production client build | `npm run build` | 29.51 kB JS (10.31 kB gzip), 13.06 kB CSS (3.46 kB gzip), 3.84 kB HTML (1.36 kB gzip) |
| Server boots and serves the game | `npm start` | `/healthz` 200, board at `/`, `/screen` 200 |
| Live server restart preserves state | stop old process, `npm start` with existing `data/line.json` | 3 nodes (`rino`, `ritesh`, `adarsh`) and 3 links restored; spectator snapshot exposes `restoredRoutes: 0` on each node |
| Two independent browser sessions (consent flow) | two separate headless Chrome profiles over the real client | **31/31 checks passed**, including own-node rejection, join, pending, duplicate click, decline, accept and movement; no console errors |
| Three independent browser sessions (search/leaderboard) | three separate headless Chrome profiles against an isolated server | **44/44 checks passed**, including no-edge search selection, no-result Enter safety, case/partial/no-result search, live cross-session re-ranking, current-player highlight, leaderboard focus, movement persistence, 390x844 layout, reconnect and default-collapsed behavior; no console errors |
| 50-client link/consent load test | `CLIENTS=50 DURATION_MS=20000 npm run loadtest:isolated` | 50/50 joined, 1,129 requests, 123 edges, p99 4.2 ms, 0 errors |
| 50-client movement + consent load test | `CLIENTS=50 DURATION_MS=15000 MOVE_MS=100 npm run loadtest:isolated` | 50/50 joined, 8,357 moves, 118 edges, p99 7.0 ms, 0 errors |

The server is one Node process: HTTP + WebSocket on the same port, authoritative
game state, client served from `apps/web/dist`. No database is required to start.

---

## 2. Consent-first link model (VERIFIED)

### Player flow

1. A joins as an isolated node. No join, spawn proximity, selection or movement
   creates an edge.
2. A taps B and sees a compact panel with B's name, the explanation that no line
   is created until B accepts, and **Request Connection**.
3. A sends a request. A sees `Request sent — awaiting response`; B sees a
   **Connection Request** card with A's name, the unique request ID, and **Accept**
   / **Decline**. Pending is drawn as an amber dashed indicator, never as an
   active edge.
4. Only Accept creates one server-authoritative edge, broadcasts it, and charges
   the token. Decline, expiry, failure or disconnect creates no edge.
5. The requester receives `Pending`, `Accepted`, `Declined`, `Expired` or
   `Failed`; the target receives the same terminal status.
6. Accepted edges stay attached to both current endpoint positions when either
   player moves.

### Server authority

- Requests may connect only the requester's own node to one target. Helper links
  for a third party are impossible.
- Request time and Accept time both validate: node existence, active status,
  session ownership, self-link, duplicate edge, duplicate pending request,
  degree cap, token balance, phase and Line.
- Accept re-runs the engine's normal `create_link` validation against current
  state. A request that was legal when sent can still expire or fail at Accept.
- Only the named target session may respond. Other sessions receive a failure and
  cannot change the request.
- Duplicate pending requests return `REQUEST_PENDING`; an existing edge returns
  `ALREADY_LINKED`.
- The server keeps request state separate from edges. Pending requests are exposed
  in snapshots; accepted, declined, expired and failed records are kept as a
  bounded in-memory history (1,024 records) so a repeated Accept/Decline from a
  second tab or a retry replays the terminal outcome instead of creating a second
  edge.
- Requests expire after `links.requestTtlMs` (default 30,000 ms). Expiry is
  checked on the 5 Hz tick and when a response arrives.
- Tokens are charged only when Accept successfully creates the edge. Pending,
  declined, expired and duplicate attempts cost no token.
- Pending requests and terminal request history are server memory. Pending
  requests survive a target reconnect through the snapshot, but neither survives
  a server restart. Accepted edges, sessions and positions keep the normal
  persisted-state behavior.

### Protocol v2

`create_link` is removed from the supported client protocol. Clients use
`request_link` and `respond_link`; the server sends `link_request` and
`request_result`. Snapshots include incoming and outgoing requests.
`PROTOCOL_VERSION = 2`. The server rejects a raw legacy `create_link` command
(covered by a real-WebSocket test).

---

## 3. What was removed or fixed

- **Automatic starter link removed.** Engine join no longer creates or defers an
  edge. `JoinResult` still carries `starterLinkId: null` and
  `starterDeferred: false`, and legacy persisted `starter`/`pendingStarter` fields
  remain loadable but inert. New joins always write them as false.
- **Direct client edge creation removed.** The browser has no local edge-create
  path; the server has no `create_link` message handler. The engine's internal
  `create_link` remains the validation/creation primitive used by Accept.
- **Stale demo state removed.** The pre-change `data/line.json` contained a
  historical starter edge. The loader intentionally does not delete saved edges,
  so that state was backed up outside the repo and removed before acceptance.
  Old pre-consent snapshots must not be reused for acceptance testing.
- **Selection semantics changed.** Your node is always the requester. Tapping
  another node selects a target; there is no third-party source. Structurally
  unavailable nodes (offline/full) are dimmed; connected and pending nodes stay
  vivid.
- **Earlier dense-mesh cause, for the record.** The large dense board reported
  before this change came from persisted bot/smoke state, not from a mesh join
  algorithm. Independent regression tests still pin join isolation in addition to
  the consent rule.

---

## 4. Required test coverage

| Requirement | Test/evidence |
|---|---|
| Zero auto-edges on join | `packages/engine/test/join-mesh.test.ts` (12 and 30 joins, zero links; Result join creates nothing later); `rules.test.ts` (eligible/full/Result cases); server handshake test |
| Unconnected players stay visible | `apps/server/test/server.test.ts` joins two players and asserts two nodes, zero links, and both visible; browser check "A sees B while unconnected" |
| Pending creates no edge | Server pending test plus metrics/edge assertions; browser pending check in both clients |
| Multiple pending requests kept | Server test sends two requesters to one target, then asserts both survive a `resync` snapshot; browser renders every card |
| Accept creates one broadcast edge | Server test (one `link.created`, both clients receive it); browser accept check in both clients and `/metrics` |
| Decline creates no edge | Server test; browser decline check in both clients |
| Expiry creates no edge and reports both sides | Server test with short TTL; both sides receive `expired`, no edge |
| Duplicates prevented | Server: duplicate pending `REQUEST_PENDING`, duplicate accepted edge `ALREADY_LINKED`, repeated Acceptance replays `accepted` without a second edge; browser repeat-click check; engine graph invariant |
| Invalid/unauthorized rejected | Server: self-link, third-party accept, client-supplied source ignored, bad/unknown request, capacity, phase/token revalidation |
| No direct client edge creation | Server raw `create_link` rejection test; protocol v2 type contract |
| Edges persist when endpoints move | `packages/engine/test/movement.test.ts`; server movement/late-join/degree tests; browser movement check preserves both edges and the ranking |
| Accepted edge follows both endpoints | `apps/web/test/geometry.test.ts` and `render.test.ts`; browser screenshots before/after move |
| Search exact/partial/case/no-result | `apps/web/test/community.test.ts`; 3-profile browser exact-uppercase, partial, empty and no-result checks, including Enter on no results |
| Search selection locates but never links | Browser check: `canvas[data-focus-node]`, target panel, unchanged `/metrics` requests/links and zero `link.created` |
| Leaderboard order and ties | `apps/web/test/community.test.ts` (including endpoint-disabled outages); server restored-route snapshot/event test; 3-profile browser live re-rank B(2), A(1), C(1) |
| Current player highlight | All three browser sessions assert exactly one accented local row before and after re-rank |
| Leaderboard row focuses correct node | Browser check for C in A and connected A in B; duplicate action disabled |
| Search/leaderboard live consistency | Three independent browser sessions observed the same order change without reload |
| Desktop and mobile widths | Desktop 1280x800 and 390x844 emulated browser layout checks; mobile reload resumed the same node and defaulted the leaderboard to collapsed; real phone remains unverified |

Full suite: **115 tests, 12 files, 115 passed**.

---

## 5. Two-session browser verification (VERIFIED)

Method: two independent Google Chrome User Data directories (separate
`localStorage` and session cookies), both loading the production build from
`http://127.0.0.1:8080/`. A throwaway CDP script drove the real join form, real
Canvas hit-testing and the real Accept/Decline buttons; it did not call server
APIs to create edges. Chrome was `--headless=new`, viewport 1280x800.

Verified sequence:

1. Two fresh identities join alongside two already-present, unconnected players.
   Each browser sees every player and zero edges.
2. Asha taps her own node; the client refuses to open a request and sends nothing.
3. Asha taps Ravi and sees the target panel with Ravi's name, the explanation,
   and **Request Connection**.
4. Asha requests; Asha sees `Request sent — awaiting response` for Ravi. Ravi sees
   a **Connection Request** card with Asha's name and the unique request ID.
   `/metrics` and both client states still report zero edges. Tapping Ravi again
   does not create a duplicate request.
5. Ravi declines; both see `Declined`; zero edges.
6. Asha requests again; Ravi accepts; both receive one `link.created`; `/metrics`
   reports exactly one edge and both client states contain that same edge.
7. Asha moves with the right-arrow key; Ravi receives the authoritative position
   and the accepted edge remains, attached to the new endpoint position.
8. No uncaught browser exceptions and no console errors.

Screenshots, the check log and the throwaway CDP script are in
`reports/ui-consent-2026-10-26/` (ignored local evidence): unconnected, pending,
incoming request, declined, accepted and moved states for both players. This pass
verifies desktop headless Chrome and actual Canvas output. It does **not** verify
phone touch, real mobile Safari/Chrome, latency over a public network, or
projector rendering.

---

## 6. Player search and contribution leaderboard (VERIFIED)

### Search

The upper game area now has a case-insensitive search input with keyboard
navigation and Escape-to-close. It searches every node in the current Line by
username or node ID, including partial matches and players outside the current
viewport. Each result shows the player name, node status, the viewer's connection
relationship (`Connected`, `Request pending`, `Incoming request`, `Not
connected`, or `You`) and active link count. Empty, loading and no-result states
are explicit.

Selecting a result pans the camera to the node, rings it for 3.4 s, opens the
existing target panel with the player's status, and leaves the existing
**Request Connection** action as the only way to send a request. Search selection
never sends `request_link` and never creates an edge.

### Contribution leaderboard

The collapsible right-side **Leaderboard** ranks every player in the Line by:

1. `restoredRoutes` descending — the PRD 6.6.1 Repair-phase metric for an
   accepted link that merged two disconnected components.
2. Active accepted non-starter links descending — current network contribution,
   derived from the broadcast graph.
3. Player name ascending, then node ID ascending.

The two values display as **REP** and **LINKS**; first/second/third places use
gold/silver/bronze rank badges. The local player's row is accented. The team
round score, Last Score and Network Health displays are unchanged. The PRD calls
restored routes a pride metric, not a ranking, and FR-34 describes no persistent
ranking; this owner-requested panel is a display-only V1 extension. The full
formula, its PRD relationship and rationale are D-30 in `docs/DECISIONS.md`.

`NodeView.restoredRoutes` is included in snapshots. `link.created` now carries
`byNodeId` and `restoredRoute`, so every client increments the same per-player
counter live. Active link counts update from the same `link.created`, outage and
recovery events on every client; a link contributes only while both endpoints are
active, mirroring the server's `isLinkActive`. The UI derives the ranking from
authoritative snapshot/delta state; there is no separate frontend score, mock
player list or hardcoded ranking.

### Browser evidence (44/44 checks)

Method: three independent Google Chrome User Data directories (separate
`localStorage` and sessions), all loading the production build from an isolated
server at `http://127.0.0.1:8090/`. A throwaway CDP script drove the real DOM
search, request cards, leaderboard rows and keyboard movement; it did not create
edges through server APIs. Desktop viewport was 1280x800, with a 390x844 emulated
mobile viewport for layout checks.

Observed:

1. Three players joined isolated; every client saw all three nodes, zero links
   and zero edges at `/metrics`. The initial ranking used the deterministic name
   tie-break, with gold/silver/bronze rank 1/2/3 and the correct current-player
   row highlighted in each session.
2. Exact uppercase, partial and node-ID matches worked; no-result and empty-query
   states were distinct; ArrowDown/Enter and Escape worked. Pressing Enter on a
   no-result search focused nothing (no stale hidden match).
3. Selecting a search result focused the correct node, opened the request panel
   with `Active · Not connected · 0 active links`, and created neither an edge nor
   a request.
4. A request was sent through the panel; search showed `Request pending` with
   zero edges, then B accepted and exactly one edge appeared in all three
   sessions. Search then showed `Connected · 1 link`.
5. A second consent edge from B to C changed the live ranking to B (2 links),
   A (1), C (1) in both A and C without a reload. The current-player accent
   survived the re-rank.
6. Clicking C's leaderboard row focused C and offered the request action;
   clicking an already-connected A row in B disabled the duplicate action as
   **Connected**. Neither click created an edge.
7. Right-arrow movement was received by both peers and both accepted edges
   survived; the ranking stayed B, A, C.
8. At 390x844, search, the rank toggle, the open leaderboard and the search
   dropdown stayed inside the viewport; the leaderboard collapsed to its title
   bar and expanded without horizontal overflow.
9. Reloading the mobile profile resumed the same node and two edges, and the
   leaderboard defaulted to collapsed; its toggle expanded and collapsed it again.
   Search rows and rank rows use at least 42–44 px touch targets at this width.
10. No uncaught browser exceptions and no console errors in any profile.

Screenshots, the check log and the throwaway CDP script are in
`reports/ui-search-leaderboard-2026-10-27/` (ignored local evidence).

**Limit of this pass:** the isolated browser run stayed in seeding (three nodes,
no round), so the browser observed live **active-link** re-ranking, not a live
Repair-phase `restoredRoutes` change. The restored-route path is covered by
`apps/web/test/community.test.ts` and the server test
`broadcasts restored-route contribution and includes it in snapshots`. Real
phone/touch, online-presence/rename and public-network latency remain unverified.

---

## 7. Movement and persistent edge geometry (VERIFIED)

- `LineNode.x/y` are deterministic at creation, then server-authoritative and
  mutable. `LineLink` contains only identity and endpoints, no distance.
- Move validation: session ownership, finite values, active node, 25 msg/s rate
  limit, circular world radius (1400), and a speed budget (5000 units/s with a
  250 ms maximum elapsed allowance).
- Accepted moves are coalesced to one `node.moved` per node per 5 Hz tick.
- Clients predict their own node, ease remote display positions, freeze the camera
  during a drag, and fit all display positions otherwise.
- Rendering recomputes both edge endpoints from current positions every frame.
  Distance never creates, cuts, deletes or deactivates an edge.
- Late joiners receive current positions and accepted edges in their snapshot.
- Strike C's "nearest by layout distance" uses current authoritative positions at
  the outage instant; movement can therefore change spatial clustering (D-22).

**Not verified:** touch drag feel, phone keyboard behavior, mobile GPU
performance, and long-session interpolation under real network jitter.

---

## 8. Implemented elsewhere

### Client
- Join overlay, token in `localStorage`, reconnect with backoff and read-only mode.
- Canvas 2D board: nodes, active/cut links, component colours, disabled nodes,
  "You" ring, "Find me", target ring, target-name request panel, incoming
  Connection Request cards with unique IDs, outgoing awaiting-response cards,
  dashed pending indicator, toasts, HUD and contextual hint.
- Player search: upper-area input, case-insensitive partial name/node-ID match,
  dropdown with node/relationship/degree status, keyboard navigation, Escape,
  empty/loading/no-result states, camera pan and temporary node highlight.
- Contribution leaderboard: collapsible right panel, REP/LINKS metrics,
  gold/silver/bronze top three, current-player accent, live updates and
  click-to-focus. The shared team score is unchanged.
- `/screen` read-only projection view; search and leaderboard are hidden there.

### Server
- Sessions, reconnect tokens, request rate limit (2/s/session), name sanitisation,
  profanity fallback, session ban.
- Authoritative `reduce()` per action; 5 Hz tick for phases, tokens, request expiry
  and coalesced moves.
- Snapshot on connect, event deltas afterwards, per-client `you` block and request
  arrays.
- Global pause/resume, reset with seed, session ban behind `x-admin-secret`.
- Best-effort persistence every 10 s + shutdown.
- `GET /healthz`, `GET /metrics` (counters, no player data).

### Rules
- Phase machine seeding -> build -> warning -> repair -> result (40/5/35/10 s).
- 5-link cap, 3 tokens, one token per 20 s.
- A/B/C outages with absolute caps (D-R1); recovery at Result start.
- Exact integer half-up scoring; 9/9 Appendix B golden cases pass.
- No automatic starter link; links only through the consent flow.

---

## 9. Measured load evidence

Both runs used `npm run loadtest:isolated` (throwaway server + temp `DATA_DIR`),
so they did not add bots or edges to the demo Line. Bots send `request_link` and
auto-accept incoming requests, so this exercises the real two-message consent path.

### 9.1 Link/consent, 50 clients, 20 s

Raw data: `reports/loadtest-2026-10-26T17-55-29-329Z.json`.

| Metric | Value |
|---|---|
| Joined / requested | 50 / 50 |
| Handshake p50 / p95 / max | 4.6 / 6.4 / 13.2 ms |
| Requests sent / answered | 1,129 / 1,129 |
| Accepted edges | 123 |
| Rejections | NODE_FULL 865, ALREADY_LINKED 96, NO_TOKENS 45 |
| Action latency p50 / p95 / p99 / max | 1.1 / 2.4 / 4.2 / 7.4 ms |
| Throughput | 56.4 request actions/s |
| Traffic per client | 3,951 B/s |
| Server tick time (last) | 1 ms |
| Links in final server state | 123 |
| Errors | 0 |

### 9.2 Movement + consent, 50 clients, 15 s, every 100 ms

Raw data: `reports/loadtest-2026-10-26T17-57-22-535Z.json`.

| Metric | Value |
|---|---|
| Joined / requested | 50 / 50 |
| Movements sent / server moves | 8,357 / 8,357 |
| Requests sent / answered | 878 / 878 |
| Accepted edges | 118 |
| Rejections | NODE_FULL 636, ALREADY_LINKED 85, NO_TOKENS 41 |
| Request latency p50 / p95 / p99 / max | 1.0 / 5.4 / 7.0 / 8.4 ms |
| Traffic per client | **32,077 B/s** |
| Server tick time (last) | 2 ms |
| Errors | 0 |

Movement traffic is high because every mover is fanned out to every client: one
coalesced position per moving node per 5 Hz tick. It is acceptable at 50 moving
clients on loopback, but it is the clear next bottleneck at larger counts.

No capacity claim is made beyond 50 clients. The build has **not** been
load-tested at 10,000 concurrent users and does not claim that capacity.

---

## 10. Not done / deviations (honest list)

| Area | State | Why / impact |
|---|---|---|
| Phone/touch browser QA | **UNVERIFIED** | Desktop headless Chrome was verified; the 390x844 pass used emulation only, not a real phone. Touch drag, touch targets and mobile Safari/Chrome still need a manual pass |
| Public latency/TLS | **UNVERIFIED** | All measurements are loopback |
| 10,000 concurrent users | **UNVERIFIED / NOT CLAIMED** | Only 50 clients measured; movement fan-out is the known bottleneck |
| Multi-process / Redis / sharding | **NOT IMPLEMENTED** | One Line per process; capacity 400; a second process needs routing/ownership |
| Postgres, event log, analytics | **NOT IMPLEMENTED** | JSON snapshots only |
| 5 s durability bound (C-04) | **NOT MET** | 10 s snapshot + shutdown save; worst case 10 s after `kill -9` |
| Request state across restart | **NOT PERSISTED** | Intentional 30 s ephemeral TTL; terminal records are bounded retry history. Accepted edges/sessions persist |
| Old historical starter edges | **NOT AUTO-REMOVED** | Loader preserves saved edges; delete/reset pre-consent `data/` |
| Device motion | **NOT IMPLEMENTED** | Pointer/keyboard are the supported fallbacks |
| Pinch-zoom / pan / double-tap zoom | **NOT IMPLEMENTED** | Auto-fit camera; frozen during drag; Find me pulses |
| Keyboard-only linking | **NOT IMPLEMENTED** | Movement and search are keyboard-accessible; the final Request Connection action is pointer/touch |
| Online presence / leave / rename | **NOT IMPLEMENTED** | A disconnected session reconnects to the same node; V1 has no leave or rename command. Search shows node status and the viewer relationship, not a live online flag |
| Cumulative individual score | **NOT IMPLEMENTED** | The leaderboard uses the PRD 6.6.1 restored-route metric plus current active links; it does not invent or reinterpret the shared round score |
| Chat, profiles, timelapse, i18n | **NOT IMPLEMENTED** | Out of V1 scope |
| Ban semantics | **Session ban only** | Node remains until reset; no IP ban (conference NAT) |
| Docker image | **UNVERIFIED** | Dockerfile exists; daemon unavailable here, so no image was built/run |
| Public deployment | **NOT DONE** | Host/region/credentials not chosen |
| Paused-line movement | Allowed | Movement changes no links or phase state; not mobile-QA'd |

---

## 11. Blockers / next actions

1. **Hosting not chosen.** Needs host, Mumbai region, TLS, `ADMIN_SECRET`, and a
   volume for `DATA_DIR` if restart survival matters.
2. **Phone/laptop manual pass.** Join, touch drag, keyboard, selection,
   request/decline/accept, outage, reload/reconnect on real devices.
3. **Docker image unbuilt.** Run `docker build -t mumbai-garden .` on the deploy
   machine; the Node build/start path is the documented fallback.
4. **Then, and only then, test deployed capacity.** Repeat the link and movement
   load tests against the deployed URL; do not extrapolate from 50 clients.
5. **Movement fan-out.** If more than ~50 simultaneous movers are required, use a
   compact positions array or interest management, then measure again.
6. **Search/leaderboard device pass.** Repeat the 390x844 emulated checks on a
   phone (touch scroll, keyboard, collapse/expand) and confirm the right panel
   never blocks node selection at the venues/projector resolutions.

---

## 12. Files changed in this increment

| File | Change |
|---|---|
| `packages/protocol/src/index.ts` | `NodeView.restoredRoutes` added to snapshots/deltas vocabulary |
| `packages/engine/src/types.ts` | `link.created` carries `byNodeId` for cross-client ranking |
| `packages/engine/src/engine.ts` | Emits `byNodeId` on accepted links |
| `apps/server/src/view.ts` | `toNodes` exposes `restoredRoutes` |
| `apps/web/src/community.ts` | **new** pure search/ranking helpers and documented formula |
| `apps/web/src/main.ts` | Search state/UI, keyboard navigation, camera focus/highlight, leaderboard rendering/updates, target status line |
| `apps/web/index.html` | Search control, results listbox, collapsible leaderboard, request status |
| `apps/web/src/style.css` | Dark-theme search/leaderboard styling, rank badges, mobile layout |
| `apps/web/src/render.ts` | Search/focus highlight ring |
| `apps/web/test/community.test.ts` | **new** 9 search/ranking/relationship tests |
| `apps/web/test/geometry.test.ts`, `render.test.ts` | `NodeView.restoredRoutes` fixtures and draw options |
| `apps/server/test/server.test.ts` | Restored-route event/snapshot integration test |
| `reports/ui-search-leaderboard-2026-10-27/verify-ui.mjs` | **new** three-profile CDP verification |
| `reports/ui-search-leaderboard-2026-10-27/evidence/` | Check log, JSON and screenshots (ignored local evidence) |
| `docs/DECISIONS.md` | D-30 contribution formula and authority |
| `docs/ARCHITECTURE_V1.md` | Search/leaderboard architecture and evidence |
| `docs/STATUS.md` | This status update |
| `README.md` | Feature and test-count update |
