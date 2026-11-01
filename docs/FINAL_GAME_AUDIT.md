# Final NODES Game Audit, Bug Fixes & Mobile Optimization Report

## Executive Summary
This document records the full audit, root-cause investigations, bug fixes, mobile optimizations, and verification results across **NODES** (`NODES-main`) and **The Smoking Area** (`smoke`).

---

## 1. Gameplay Workflow Verification (12 Journeys)

| # | Gameplay Workflow Journey | Status | Details & Observations |
|---|---------------------------|--------|------------------------|
| 1 | Game loading, initialization & start screen | **PASS** | Canvas initializes smoothly, public snapshots render correctly, health check `/healthz` and `/api/health` respond 200 OK. |
| 2 | Username registration & uniqueness | **PASS** | Validated client-side and server-side. Case-insensitive conflict prevention with trim support. Ghost node creation on conflict eliminated. |
| 3 | Player connection requests & acceptance | **PASS** | Rate-limited request workflow. Tokens deducted on acceptance. Bidirectional request deadlock resolved. |
| 4 | Mesh formation & leader election | **PASS** | Mesh components derived via BFS. Leader elected deterministically (earliest active member/initiator). |
| 5 | Team creation, unique naming & renaming | **PASS** | Race conditions during asynchronous Supabase lookup resolved; named teams preserved across zero active links; case-insensitive uniqueness enforced across active and dormant teams. |
| 6 | Inviting players & join requests | **PASS** | Link requests and smoke invites routed cleanly; unauthorized invites blocked; UI toasts surface clear error reasons. |
| 7 | Joining existing mesh & inheriting identity | **PASS** | Late joiners connecting to existing components inherit `teamId`, `teamName`, and `roomId`. Area-crossing links cleanly restricted. |
| 8 | Node movement, scoring & progression | **PASS** | World boundary clamping, touch dragging, keyboard controls, and background canvas panning operational. Scored components align with Tarjan/BFS invariants. |
| 9 | Outages, repairs, strikes & recovery | **PASS** | Scheduled strikes simulate hub, cable, and blackout failures. Repair phase preserves team identity even when all edges cut. |
| 10 | Leader disconnect & leadership transfer | **PASS** | Timed-out leader hands off leadership to earliest active successor. Mesh events announce change. Former leaders can rejoin without corrupting timestamps. |
| 11 | Leaderboards, player status & completion | **PASS** | Rankings display player repairs and team scores. Offline status correctly distinguished from disabled. |
| 12 | Refresh, reconnect & server restart persistence | **PASS** | State files `line.json`, `line.sessions.json`, and `line.teams.json` persist sessions, nodes, and team names across restarts. |

---

## 2. Root Cause Analysis & Implemented Bug Fixes

### A. Team Creation & Renaming Failures (Root Cause)
- **Root Cause**: In `apps/server/src/app.ts`, `handleTeamName` was asynchronous (`await supabase.getTeamByName(name)`). During this await, the 200ms `tickTimer` executed `currentTeams(now)`, which cleared `teamRecords` in memory and populated it with new records whose `name` was null. When the promise resolved, the mutation `record.name = name` was applied to an orphaned object, and the next tick broadcast `name: null` ("Unnamed team") to all clients. Furthermore, during outage repair phases, teams with 0 uncut links were dropped from `currentTeams`.
- **Fix**:
  1. Preserved named teams and active teams with 0 active links in `currentTeams(now)`.
  2. In `handleTeamName`, retrieved `liveRecord` directly from `teamRecords` after any async operations and re-keyed both `rawTeamId` and `targetTeamId`.
  3. Added dormant team name uniqueness check across `teamRecords.values()`.
  4. Returned specific error code `NOT_TEAM_LEADER` instead of generic `TEAM_NOT_FOUND`.
  5. In frontend `apps/web/src/main.ts`, fixed `teamNameSave` so `promptedTeamId` takes precedence over `myTeam`, and prevented periodic leaderboard renders from wiping input fields while editing.

### B. Smoke Room Integration & Token Verification
- **Root Cause**:
  1. Popup blocker in desktop/mobile browsers prevented opening Smoke Room because `window.open` was invoked inside an asynchronous `fetch()` promise callback.
  2. In Smoke `server.mjs`, `POST /api/v1/rooms/:roomId/authorize` unconditionally threw an error (`Room membership is revoked`) if `existing?.revoked_at` was set, blocking legitimate re-authorizations when a player rejoined the mesh in NODES with a fresh signed Ed25519 JWT.
  3. WebSocket connection in Smoke lacked a message handler for incoming chat messages.
- **Fix**:
  1. In `apps/web/src/main.ts`, opened `about:blank` window synchronously on user click, redirecting upon token issuance and closing upon error.
  2. In `smoke/server.mjs`, verified token issuance timestamp `claims.iat * 1000 > revokedTime` before enforcing revocation, enabling re-authorization of returned players while blocking old tokens.
  3. Added incoming WebSocket `ws.on("message")` handler in Smoke to persist messages to SQLite and broadcast them to room sockets.
  4. Prevented infinite WebSocket reconnect loops on revoked status (code 4003).

### C. State Inconsistency & Race Conditions
- **Ghost Nodes on Conflict**: In `app.ts:handleJoin`, rolled back `line.state.nodes[joined.nodeId]` and filtered `line.state.nodeOrder` if Supabase returned `USERNAME_TAKEN`.
- **Bidirectional Request Deadlock**: In `app.ts:handleRespondLink`, automatically cancelled inverse pending requests between the same node pair upon acceptance.
- **Area-Crossing Links**: In `app.ts:handleRequestLink`, rejected cross-area link requests (`main` vs `surprise`).

---

## 3. Mobile & Touch Optimization

- **Safe-Area Insets**:
  - Integrated `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)` into `#hud`, `#banner`, and navigation elements to eliminate notch and home-indicator clipping on iPhone and modern Android devices.
- **Input Zoom Prevention**:
  - Enforced `font-size: 16px !important;` on `#playerSearch`, `#join input`, `.teamNameCard input`, and `.teamNameCard textarea` on mobile viewports ($\le 720\text{px}$) to prevent iOS Safari auto-zooming.
- **Minimum 44×44px Touch Targets**:
  - Updated `#requestBar button`, `.smokeRoomActions button`, `.smokeInviteActions button`, `.libp2pPopupActions button`, `.weakChip`, `.panelClose`, `.cardDismiss`, `.teamNameActions button`, `.teamRow`, and `.lbRow` to adhere to WCAG AAA minimum 44×44px touch targets.
- **Virtual Keyboard Usability**:
  - Added `max-height: 88vh; overflow-y: auto; -webkit-overflow-scrolling: touch;` to modal cards to prevent virtual keyboard truncation.
- **Responsive Tablet & Mobile Layouts**:
  - Added dedicated `@media (min-width: 721px) and (max-width: 1024px)` tablet queries.
  - Separated `.playerCard` (`bottom: 226px`) and `#requestBar` (`bottom: 166px`) on mobile viewports to prevent collision.
- **Canvas Touch Panning**:
  - Implemented intuitive background touch panning (`panDrag` with camera `ox`/`oy` translation) on touchscreens.

---

## 4. Test & Build Verification Results

- **NODES Engine, Server & Web Test Suite**:
  - **167 / 167 Tests Passed** (18 test files).
  - TypeScript Typecheck (`tsc --noEmit`): **0 Errors**.
  - Production Web Build (`vite build`): **0 Errors**, clean bundle.
- **The Smoking Area (Smoke) Test Suite**:
  - **22 / 22 Tests Passed** (`node --test test/*.test.mjs`).
  - Ed25519 signature verification, room isolation, WebSocket ticket exchange, and outbox sync verified.

---

## 5. Files Changed

### NODES Repository (`C:\Users\Asus\Downloads\NODES-main`)
- `apps/server/src/app.ts`: Team naming persistence, currentTeams 0-link preservation, `/api/health`, rollback ghost node on conflict, bidirectional deadlock prevention, `NOT_TEAM_LEADER` error code.
- `apps/server/src/supabase.ts`: Error boundaries on Supabase RPC calls.
- `apps/server/test/team-functionality.test.ts`: Added full regression test suite (team creation, duplicate rejection, non-leader rejection, join inheritance, restart persistence).
- `apps/server/test/server.test.ts`: Aligned test assertions with `NOT_TEAM_LEADER`.
- `apps/web/src/main.ts`: Popup blocker fix for Smoke Room, prompted team precedence, dialog input wipe prevention, canvas touch panning, error handling toasts.
- `apps/web/src/style.css`: Safe-area insets, 16px mobile input zoom fix, 44px touch targets, tablet media queries, playerCard/requestBar collision fix.

### Smoke Repository (`C:\Users\Asus\Downloads\smoke`)
- `server.mjs`: Multi-path public key discovery, re-authorization for returned members with fresh tokens, WebSocket message listener and broadcast.
- `index.html`: Handled code 4003 member revocation without reconnect loop.

