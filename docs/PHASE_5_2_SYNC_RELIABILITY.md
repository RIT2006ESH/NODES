# Phase 5.2 — Reliable SQLite–Supabase Synchronization

---

## 1️⃣ Existing Architecture (Audit Summary)

### NODES — `apps/server/src/supabase.ts`
| Concern | Details |
|---|---|
| **Source of truth** | Supabase tables `player_profiles`, `teams`, plus RPCs `create_team_with_room`, `add_team_member`, `transfer_team_leadership`, `rename_team`. |
| **Local writes** | None — NODES does not maintain a local SQLite cache for profiles or teams. Profile operations and `syncTeams` call Supabase directly. |
| **Remote writes** | Direct Supabase REST/RPC calls during team synchronization and username registration/updates. |
| **Transactionality** | Separate HTTP calls; no distributed transaction. |
| **Error handling** | Errors are propagated to caller without a persistent outbox queue. |
| **Silent divergence risk** | Partial failures during multi-step team creation or leadership transfer leave Supabase in an intermediate state. |

### Smoke — `server.mjs` & `supabase.mjs`
| Concern | Details |
|---|---|
| **Source of truth** | Local SQLite database (`smoke.db` tables: `rooms`, `room_members`, `messages`, `revoked_tokens`, `processed_events`). |
| **Local writes** | All room, member, and message operations write synchronously to local SQLite first. |
| **Remote writes** | Remote mirror writes are dispatched to Supabase when `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are configured. |
| **Initial problem identified (Phase 5.2A)** | In previous edits, `upsertRoom()` called an undefined method `this._insertOutbox()`. Outbox tables were duplicated inside `http.createServer`. The SQLite database reference was never injected into `supabase.mjs`. |
| **Silent divergence risk** | If remote calls fail, local SQLite was committed while Supabase diverged silently with no retry queue. |

---

## 2️⃣ Desired Consistency Model

| Entity | Authoritative Store | Local Persistence | Remote Sync Responsibility | Conflict Resolution | Supabase Down Behavior |
|---|---|---|---|---|---|
| **Player Profile** | Supabase (`player_profiles`) | Transient / JWT claims | Direct upsert | Latest write wins (`onConflict: node_id`) | Client alerted on timeout |
| **Team / Room** | SQLite (Smoke) / Supabase (NODES) | SQLite `rooms` | Outbox entry -> Supabase `smoke_rooms`/`teams` | Monotonic operation ID; outbox ordering | Enqueued in SQLite outbox; processed when available |
| **Room Membership** | SQLite (`room_members`) | SQLite `room_members` | Outbox entry -> Supabase `team_members` | Local `revoked_at` is authoritative; revocation cannot be undone by stale sync | Enqueued in SQLite outbox |
| **Messages** | SQLite (`messages`) | SQLite `messages` | Outbox entry -> Supabase `messages` | Primary key `id` deduplication | Enqueued in SQLite outbox |

---

## 3️⃣ Phase 5.2A Implementation: Smoke Outbox Foundation

In Phase 5.2A, the focus is strictly on recovering partial edits and stabilizing the SQLite outbox foundation for Smoke, completing only the `upsertRoom()` vertical slice without touching other methods or NODES.

### 3.1 Architecture Components

1. **`smoke/outbox.mjs`**:
   - **Schema Initialization**: `initOutbox(db)` creates `supabase_outbox` and `supabase_dead_letter` tables with indexes if they do not exist.
   - **Schema Details**:
     ```sql
     CREATE TABLE IF NOT EXISTS supabase_outbox (
       id TEXT PRIMARY KEY,
       entity TEXT NOT NULL,
       action TEXT NOT NULL,
       payload TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
       attempt_count INTEGER NOT NULL DEFAULT 0,
       last_error TEXT,
       created_at TEXT NOT NULL,
       next_attempt_at TEXT NOT NULL
     );
     CREATE TABLE IF NOT EXISTS supabase_dead_letter (
       id TEXT PRIMARY KEY,
       entity TEXT NOT NULL,
       action TEXT NOT NULL,
       payload TEXT NOT NULL,
       created_at TEXT NOT NULL,
       failed_at TEXT NOT NULL,
       error TEXT NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_supabase_outbox_dispatch
       ON supabase_outbox(status, next_attempt_at, created_at);
     ```
   - **Payload Validation**: Strict structure checks before insertion. Requires required fields (`roomId`, `teamId`, `teamName` for `room:upsert`).
   - **Duplicate Operation ID Protection**: Prevents duplicate insertions sharing the same ID, throwing an explicit error.
   - **Safe Error Handling**: Uses prepared statements with parameter binding.

2. **`smoke/supabase.mjs`**:
   - Exports `createSupabaseAdapter(client, db)` factory allowing proper dependency injection.
   - Injects the SQLite database reference cleanly via `adapter.setDatabase(db)` or factory argument.
   - `upsertRoom(roomId, teamId, teamName, leaderNodeId, role, operationId)`:
     - Enqueues the operation into `supabase_outbox` via `enqueueOutbox()`.
     - Uses caller-supplied `operationId` if present, or generates a stable UUID.
     - Does **not** dispatch an immediate remote RPC.
     - Returns `{ queued: true, synchronized: false, operationId, status, createdAt }`, explicitly clarifying it is queued rather than falsely reporting remote synchronization.
   - Preserves all other methods (`upsertMember`, `insertMessage`, `revokeMember`, `updateRole`, `updateTeam`) untouched for subsequent phases.

3. **`smoke/server.mjs`**:
   - Removed duplicated `db.exec` blocks inside `http.createServer`.
   - Initializes outbox once via `initOutbox(db)` upon database creation.
   - Properly injects `db` into `supabase` if enabled via `supabase.setDatabase(db)`.

---

## 4️⃣ Files Modified & Created

| File | Status | Description |
|---|---|---|
| `C:\Users\Asus\Downloads\smoke\outbox.mjs` | **Created** | Core outbox module: `initOutbox`, `enqueueOutbox`, `validatePayload`, `getOutboxEntry`. |
| `C:\Users\Asus\Downloads\smoke\supabase.mjs` | **Modified** | Refactored with `createSupabaseAdapter`, `setDatabase`, and `upsertRoom` outbox queueing. |
| `C:\Users\Asus\Downloads\smoke\server.mjs` | **Modified** | Clean single initialization, removed duplicate `db.exec`, properly passes `db` to `supabase`. |
| `C:\Users\Asus\Downloads\smoke\test\outbox.test.mjs` | **Created** | Focused tests for outbox foundation and `upsertRoom` slice. |
| `C:\Users\Asus\Downloads\NODES-main\docs\PHASE_5_2_SYNC_RELIABILITY.md` | **Updated** | Accurate status report and test verification documentation. |

---

## 5️⃣ Verification & Test Results

### 5.1 Smoke Focused Test Suite (`test/*.test.mjs`)
Executed via `npm test` in `smoke/`:
```
> the-smoking-area-replica@1.0.0 test
> node --test test/*.test.mjs

✔ internal revocation is idempotent and removes access (851.7558ms)
✔ invalid and expired NODES tokens are rejected (821.1193ms)
✔ 1. Successful outbox insertion (61.8345ms)
✔ 2. Duplicate operation ID rejection (52.0418ms)
✔ 3. Persistence after SQLite database close and reopen (67.7288ms)
✔ 4. Invalid payload rejection (56.4643ms)
✔ 5. Missing database initialization (1.7245ms)
✔ 6. upsertRoom() queues rather than making a remote call (57.2007ms)
✔ authorized members share a persistent isolated room (848.3088ms)
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1354.9555
```
**Smoke Result: 9 passed, 0 failed.**

### 5.2 NODES Test Suite
Executed via `npm test` in `NODES-main/`:
```
Test Files  16 passed (16)
     Tests  149 passed (149)
  Duration  8.67s
```
**NODES Result: 149 passed, 0 failed.**

---

## 6️⃣ API Compatibility & Safety

1. **`upsertRoom` Callers**:
   - Existing caller in `server.mjs` passes `(roomId, teamId, teamName, nodeId, role)` and awaits the result.
   - The method now queues into SQLite and returns `{ queued: true, synchronized: false, operationId: ... }`.
   - The endpoint `/api/v1/rooms/:roomId/authorize` completes successfully and returns local authorization state without relying on remote network availability.
2. **Untouched Methods**:
   - `upsertMember`, `insertMessage`, `revokeMember`, `updateRole`, `updateTeam` remain unchanged until their vertical slices are tackled.
3. **Cross-Service Boundaries**:
   - No NODES files were modified.
   - No remote Supabase migrations were applied (`supabase db push` / `reset` were avoided).

---

## 7️⃣ Phase 5.2 Checklist

| Area / Requirement | Status | Verification Detail |
|---|---|---|
| **Phase 5.2A: Smoke outbox schema initialization** | **PASS** | `initOutbox` sets up `supabase_outbox` and `supabase_dead_letter` tables with indexes; tested on disk. |
| **Phase 5.2A: SQLite database injection into Supabase module** | **PASS** | `createSupabaseAdapter` and `setDatabase` cleanly provide `db` without circular dependencies. |
| **Phase 5.2A: Outbox insertion helper & validation** | **PASS** | `enqueueOutbox` validates payload format and required fields; tested. |
| **Phase 5.2A: Stable operation IDs** | **PASS** | Accepts caller-supplied operation IDs or generates UUIDs; tested. |
| **Phase 5.2A: Duplicate operation ID rejection** | **PASS** | Rejects conflicting IDs with explicit descriptive error; tested. |
| **Phase 5.2A: Database close and reopen persistence** | **PASS** | Queued operations survive SQLite restart and can be retrieved from disk; tested. |
| **Phase 5.2A: upsertRoom vertical slice** | **PASS** | Queues to SQLite outbox without calling remote RPC directly; tested with mocked client. |
| **Phase 5.2A: Existing Smoke test suite regression check** | **PASS** | All 3 existing tests pass alongside 6 new outbox unit tests (9/9 pass). |
| **Phase 5.2A: Existing NODES test suite regression check** | **PASS** | All 149 NODES tests pass (149/149 pass). |
| **Phase 5.2B: Remaining Smoke methods outbox integration** | **PARTIAL** | Only `upsertRoom` converted; `upsertMember`, `insertMessage`, `revokeMember`, etc. queued for Phase 5.2B. |
| **Phase 5.2C: Background sync worker daemon** | **NOT VERIFIED** | Outbox dispatcher daemon not yet implemented (scheduled next). |
| **Phase 5.2D: NODES idempotent RPC with `p_op_id`** | **NOT VERIFIED** | Requires migration proposal and review before implementation. |
| **Phase 5.2E: Remote fault-injection test suite** | **PARTIAL** | Local outbox failure tests verified; remote Supabase network fault injection scheduled with dispatcher. |

---

## 8️⃣ Next Steps
1. Implement the durable background sync dispatcher worker (`smoke/sync-worker.mjs`) with exponential backoff and jitter.
2. Convert remaining Smoke methods (`upsertMember`, `insertMessage`, `revokeMember`, `updateRole`, `updateTeam`) to outbox operations.
3. Formulate the Supabase migration proposal for idempotent RPCs with rollback instructions for review.
