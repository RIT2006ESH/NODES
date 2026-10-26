# Phase 0 — Greenfield Readiness Report

**Project:** Mumbai Network Garden
**Phase:** 0 of 6 — Greenfield Readiness Review
**Date:** 2026-10-26
**Owner:** Ritesh Singh
**Author:** Technical lead (Phase 0 session)
**Status:** Complete. Gate NOT approved. No implementation started.

**PRD basis:** `C:\Users\Asus\Desktop\nodes\Mumbai_Network_Garden_PRD_v1.4.md` — 635 lines, read in full (VERIFIED). The canonical path `docs/PRD.md` referenced by PRD Section 0 rule 5 and Section 23 does **not** exist (VERIFIED); this is recorded as finding C-09 and decision D-R10. The PRD was **not** copied, moved or edited.

---

## 1. Scope compliance

### 1.1 What this phase was allowed to do

Per PRD Section 16 (lines 355–375) and the owner's Phase 0 instruction, this phase produces: a readiness review, a proposed repository structure, a proposed architecture, an implementation plan, owner decisions, plus `docs/STATUS.md` and `docs/DECISIONS.md`. Nothing else.

### 1.2 What was done

| Item | Result |
|---|---|
| PRD read completely before any other action | VERIFIED |
| Contradictions / blocking ambiguities identified | VERIFIED — Section 5 |
| Minimal repository structure proposed | PROPOSED — Section 7 |
| Architecture proposed, requirements vs. technology separated | PROPOSED — Section 6 |
| Phase plan + dependencies + risks + acceptance criteria | PROPOSED — Section 8 |
| Testing strategy | PROPOSED — Section 9 |
| Hosting/budget decisions before scale-out | Section 10 |
| `docs/STATUS.md`, `docs/DECISIONS.md`, this report | VERIFIED created |

### 1.3 What was explicitly NOT done

| Prohibited item | Observation |
|---|---|
| Application or game code | None written (VERIFIED: no source files created) |
| Scaffolding | None (VERIFIED: no `package.json`, no workspace files, no `src/`) |
| Dependency installation | None (VERIFIED: no `node_modules`, no lockfile, no venv) |
| Feature implementation | None |
| Architectural decisions presented as approved | None — all marked PROPOSED |
| Audit/clone of an unrelated repository | None — no external repo touched |
| Performance or concurrency claim | None — no measurement performed |
| PRD modification | None — byte-for-byte untouched |

### 1.4 Evidence log

| Check | Method | Result |
|---|---|---|
| Workspace contents | directory listing | 1 file: `Mumbai_Network_Garden_PRD_v1.4.md` (44,370 bytes) |
| `docs/` exists | `Test-Path .\docs` | `False` before this phase; created by this phase |
| `docs/PRD.md` exists | `Test-Path .\docs\PRD.md` | `False` |
| Application code | directory listing | absent |
| Project git repo | `git status` | folder untracked (`?? ./`) inside an unrelated Desktop repo |
| Appendix B arithmetic | recomputation of B1–B9 | all nine correct (details in §5.4) |
| Phase arithmetic | 40+5+0+35+10 | 90 s; half-point 17.5 s — consistent |
| Cap arithmetic | `floor(N/5)` across N=5…25 | matches PRD's own table in 6.6.1 |

---

## 2. Section 16 compliance map

| PRD Section 16 requirement | Where satisfied |
|---|---|
| 1. Confirmation the PRD is understood + genuine contradictions/ambiguities | §4 (understanding), §5 (findings) |
| 2. Proposed minimal repository structure with folder purposes | §7 |
| 3. Architecture consistent with Section 9, requirements vs. technology separated | §6 |
| 4. Phase-by-phase plan + dependencies and blocking risks | §8, §11 |
| 5. Decisions the owner must make, including hosting/budget before Phase 4 | §12, §10, `DECISIONS.md` §1 |
| 6. `STATUS.md` and `DECISIONS.md`, status Phase 0, no unapproved decision final | `docs/STATUS.md`, `docs/DECISIONS.md` |

---

## 3. Executive summary

The PRD is unusually precise and is, in substance, implementable. Its scoring rules, phase gating, outage caps and Appendix B golden cases are self-consistent, and its multiplayer interaction spec (FR-25 to FR-33) is better than most production specs I have reviewed.

It is **not** yet safe to start Phase 1 on this text. Three defects are blocking, and all three are cheap to fix, but they are *rule* defects, not typos:

1. **The difficulty knob contradicts the hard outage caps** (C-01). As written, "+1 targeted node every 5 rounds" is either inert or illegal at every Line size. A rules engine cannot be written until the owner rules.
2. **Starter-link targeting is defined twice, differently** (C-02). One clause points at 6.5's "lowest quarter" definition; the exact rule just above it says "lowest active degree". These produce different links on the most common join path in the game.
3. **"Every edge case must be tested" includes states that legal play cannot reach** (C-03). With a 5-node round-start threshold and a `floor(N/5)` cap, surviving N is always ≥ 4. N = 0/1/2/3 need a policy decision or the Phase 1 gate is unsatisfiable as written.

Beyond those, five contradictions are low-severity but will cause divergent implementations if left (C-04 … C-08), and one is structural: **all six tables sit detached at the end of the file**, leaving Sections 2, 7, 17, 19 and 22 effectively empty (C-10). Verbatim-respecting review also found **seven residual references to auditing an existing repository or NetQuest** (C-07) that contradict the greenfield premise in the same document — a strong signal the v1.4 edit landed on top of v1.2 rather than replacing it.

On architecture, the single most consequential recommendation is to **not build Section 9's Redis lease and Streams design in the MVP**. Section 9 itself flags it as a hypothesis. Phase 2 should run one process with a serialized per-Line actor behind a `LineHost` seam; Phase 4 then benchmarks the two candidates against a real baseline, as the PRD requires. This is the difference between shipping a demo and shipping a demo plus unproven infrastructure.

No performance claim is made anywhere in this report.

---

## 4. Confirmation of understanding

The following is stated to prove comprehension, not to restate the PRD.

Mumbai Network Garden is a cooperative, screen-based multiplayer game for Devcon 8 attendees, not a graph editor or a visualization. A visitor arrives at a URL, gets a session token with no account, and is placed by the server into the least-full *Line* — a shard capped at 400 nodes, themed after a Mumbai suburban line. Their node is theirs alone; the network is shared, and the point of the game is that no one owns its health. On join they receive one automatic *starter link* to a low-degree neighbour so nobody starts isolated, and they hold three link tokens that regenerate every 20 s. Crucially, players may link **any** two eligible nodes, not only their own: the game casts the player as a helpful neighbour rather than a defender of a personal hub, and the 5-link degree cap exists to prevent one giant hub from trivialising resilience.

Each Line runs an independent 90-second cycle: 40 s Build, 5 s Warning (strike *type* announced, targets hidden), an instant Outage, 35 s Repair, 10 s Result. The Outage is the teaching device: a Hub strike removes the most-connected node, a Cable cut severs links plus one low-degree node, a Regional blackout removes up to five spatially adjacent nodes. Strikes are capped at `floor(N/5)` nodes so the game never annihilates a Line, and the first strike in a Line's life is always the Hub strike so the lesson lands first. Disabled nodes and links are *not* repairable — they return automatically at Result — so "repair" means routing around the damage with new links between survivors, which is exactly the mental model decentralised networks are supposed to teach.

Scoring, at the end of Repair: `round(60·C + 30·B + 10·S)`, half-up, computed once from exact arithmetic on the server, where C is the largest-connected-component share of active nodes, B is a redundancy measure on that component only (`1 − articulation points / component size`), and S rewards reconnecting to ≥ 90% C within 17.5 s. The global community score is a node-weighted average of each Line's latest round, because there is no per-player ranking — the only individual number is "restored routes", a pride metric. A Line under five active nodes runs Build-only seeding cycles ("Grow this Line to 5 nodes") and is excluded from the average rather than scored zero. The whole system is server-authoritative and deterministic per (Line seed, round number), so a round can be replayed exactly.

---

## 5. Findings

Severity: **B** = blocks a phase · **H** = high, causes divergent implementations · **M** = medium · **L** = low.

### 5.1 Contradictions

| ID | Sev | Finding | PRD ref | Consequence | Proposed resolution |
|---|---|---|---|---|---|
| **C-01** | **B** | Difficulty scaling ("+1 targeted node every 5 rounds up to a cap defined in config") contradicts the absolute node cap `floor(N/5)` and the fixed strike counts (A = 1 node, B = 1 node, C = `min(5, cap)`). At N = 5…9 the cap is 1, so the first bump would strike 2 nodes and violate the cap; conversely, if the cap wins, the difficulty rule can never fire. | 6.4 L117; 6.5 L133–141; 6.6.1 L167 | The strike engine has no legal implementation. `game.config`'s difficulty knob is dead or illegal. | Owner ruling D-R1. Recommended: caps stay absolute; difficulty changes the *mix* (more type B/C, fewer A), the Warning length, or the schedule — never the node count. |
| **C-02** | **B** | Starter-link target is defined twice: 6.2 line 97 says "a low-degree active node **(defined in 6.5)**", but 6.5 L135 defines low-degree as "the lowest quarter of active nodes by degree". 6.2 L99 says "choose the node with the lowest **active degree**", ties by seed. These select different nodes on the most common join path. | 6.2 L97–99; 6.5 L135 | Different join behaviour per implementer; a Phase 1 test can pass while the game misbehaves. | D-R2: 6.2 L99 governs; re-point the 6.5 cross-reference at the degree cap in 6.3, not at "low-degree". |
| **C-03** | **B** | 6.6.1 requires tests for N = 0 (void round) and gives worked examples for N = 1 and N = 2, but with the 5-node round-start threshold and `node cap = floor(N/5)`, legal play always leaves N ≥ 4 (proof: `N − floor(N/5) ≥ 4` for all N ≥ 5). | 6.6.1 L165–181; Section 14 L321 | "Tests must cover each one" is unsatisfiable through the public interface; a Phase 1 gate worded that way cannot close honestly. | D-R3: keep them as defensive guards, unit-tested by direct state injection; restrict play-reachable golden cases to Appendix B. |
| **C-04** | **H** | Section 8 promises ≤ 5 s of game-state loss on instance failure; Section 9 persists snapshots every 10 s and describes the event log only as "batched writes". No flush bound is given, so the 5 s claim is unsupported by the design. | 8 L237; 9 L257 | Persistence design cannot be validated against its own NFR; failover test has no pass criterion. | D-R7: bound event-log group-commit at ≤ 1 s; snapshots stay 10 s; the 5 s bound is then met by the log. |
| **C-05** | **H** | Timelapse replay is FR-20 priority **C** in the MVP FR table, while Section 4 lists "post-event timelapse export" as a **Phase 2 candidate, only after MVP acceptance**. | 4 L61; FR-20 L527; 18 L391 | Scope ambiguity: it may or may not be in the MVP backlog; affects Phase 3 planning. | D-R4: Section 4 wins; strike FR-20 from the MVP table. |
| **C-06** | **L** | 6.4 and FR-32 lock link creation during the instant Outage **and** Result; open decision 9 (L633) says "locked during Result" only. FR-32's `PHASE_LOCKED` copy ("Round results…") is also wrong for the outage instant. | 6.4 L121; FR-32 L217; 22 L633 | Small test asymmetry; wrong microcopy at phase boundary. | Editorial fix in v1.5: decision 9 = "Build, Warning, Repair only"; copy becomes phase-aware. |
| **C-07** | **H** | Seven residual references to auditing an existing repository / NetQuest survive the greenfield rewrite: L3 ("Ready for Phase 0 audit"), L15 ("when the repository is not accessible"), L243 ("Inspect the repository first"), L565 (phase "0. Audit"), L603 (risk "Phase 0 access check"), L623 ("pending the Phase 0 audit"). | L3, 15, 243, 565, 603, 623 vs L31, 245, 357, 375 | The document contradicts its own premise in six places; a new model or contributor can reasonably conclude a repository is expected. | Editorial fix in v1.5, owner approval. No behavioural change. |
| **C-08** | **M** | Section 8: "Clients never compute scores or decide validity." FR-27 requires the client to glow valid targets and dim invalid ones in real time. | 8 L235; 6.9 L207 | Implementers may either duplicate rules in the client (drift) or disable the affordance. | Clarify: server is authoritative for outcomes; the client may run the **same pure engine** for *preview only* (D-02/D-04), and every preview is still confirmed by `action_result`. |
| **C-09** | **B** (process) | Canonical PRD path `docs/PRD.md` (required by Section 0 rule 5 and Section 23) does not exist; the file is `Mumbai_Network_Garden_PRD_v1.4.md` at the folder root, and the folder is untracked inside an unrelated git repo. | 0 L21, 27; 23 L423 | Session continuity rules cannot be followed as written; no version history for the source of truth. | D-R10: move to `docs/PRD.md`, keep versioned copy, give the project its own repo. |
| **C-10** | **B** (structural) | All six tables are detached at end of file: goals/metrics (L449), phase durations (L467), FR-1…34 (L485), phase plan (L561), risks (L583), open decisions (L613). Body Sections 2, 7, 17, 19, 22 contain only a heading and a one-line stub. | L43, 221, 377, 393, 419 vs L449–635 | Any reader paging the body sees empty sections; the "single source of truth" claim fails on contact; line references shift for everyone. | Restore tables to their sections in v1.5. Content unchanged. |

### 5.2 Ambiguities

| ID | Finding | PRD ref | Impact | Proposed answer (needs approval) |
|---|---|---|---|---|
| **A-01** | Strike **targets** can be computed at Warning announcement or at the Outage instant. Warning lasts 5 s and links are legal during it, so the two timings give different hubs for strike A and different neighbours for strike C. | 6.5 L133–139; 6.4 L473 | Determinism and replay; "announces the type but not the targets" only makes sense if targets are locked later. | Targets resolved at the Outage instant from the state at that moment; type locked at Warning. |
| **A-02** | Starter-link tie-break uses "the deterministic Line/round seed", but a starter attempt may run in Build, Warning or Repair, or be deferred to a later Build — so which `round_no` seeds it is undefined. | 6.2 L99; 6.4 L125 | Same join, different link, depending on implementation; breaks replay tests. | Purpose-tagged stream (D-06) seeded with the round in progress; deferred attempt uses the round of the Build it runs in. |
| **A-03** | Community score is a "node-weighted average of the latest round scores" — weighting basis unstated (nodes at round start? active at scoring? total nodes?), and treatment of seeding-mode, paused, and not-yet-scored Lines is unstated. | 6.6 L155 | Aggregation is testable behaviour; two implementations differ on every event-day Line. | D-R5: weight by active nodes at round start; excluded Lines contribute nothing (not a zero); paused Lines keep last score at frozen weight. |
| **A-04** | "Network Health trend of the last 10 rounds" is global, but rounds are per-Line and independent. There is no global round. | 6.6 L155; 6.4 L115 | Display metric cannot be computed as specified. | Define the trend as the last 10 completed rounds **across all Lines, in completion order**, each contributing its own round score (unweighted), with per-Line counts in the payload. |
| **A-05** | Line capacity counts nodes or sessions? What is an "open" Line (status enum undefined)? Is there a maximum number of Lines? What happens when all are full? | 6.1 L81; 6.2 L95; 6.8 L197 | Join logic, load model (25–30 Lines), event-day failure mode. | D-R6. |
| **A-06** | Pruning rule forbids removing "the sole connection of another node", which is weaker than "never remove an articulation point" — pruning can still split a component, outside the round loop, with no rescore. Interaction with "returning with the same token restores the same node" is also unstated. | 6.8 L197; 6.2 L101 | Silent connectivity loss; resurrection of a pruned node. | Prune only non-articulation, non-isolating nodes; a pruned node's session restores a **new** node; pruning emits an event so clients see it. |
| **A-07** | Token initial state and regeneration shape: does a new visitor start at 3? Continuous refill every 20 s, or per-token timer? A fractional "regeneration ring" (FR-27) implies a progress value no rule defines. | 6.3 L111; FR-27 L207 | HUD correctness; NO_TOKENS timing ("next in N s"). | Start at 3; one token per 20 s on a single timer, capped at 3; server publishes `next_token_at`; ring is derived, not authoritative. |
| **A-08** | Layout algorithm is unspecified, yet strike C depends on layout distance, and re-layout would silently redefine "nearest". | 6.2 L95; 6.5 L137 | Strike C is unreproducible if positions move. | D-10: deterministic spiral, coordinates immutable after creation. |
| **A-09** | No data-model home for `request_id` dedupe, no pending cap, no retention window. | 10 L261–277; 11 L287 | FR-33/FR-29 and "duplicate request_id must not create duplicate links" cannot be implemented or tested. | D-13. |
| **A-10** | Resume requires per-`request_id` statuses, but Section 11 defines no message that carries them (implicitly one `action_result` each) and no bound on how many may be sent. | 11 L283–287; FR-29 L211 | Reconnect UX is unspecified at the protocol level; unbounded resume is a DoS vector. | One `action_result` per pending id, ordered, max 32 per session, then `resume_complete`. |
| **A-11** | The join bot check is "for example a privacy-friendly challenge or proof-of-work" — unnamed, unowned, and absent from the Section 22 open decisions. | 12 L293 | Join latency, third-party/privacy posture, Phase 2 scope. | D-R9: server-issued signed challenge, ~2 s work budget, no third-party widget. |
| **A-12** | `game.config` format is unspecified (JSON/YAML/TS), and whether the client receives tunables at runtime. | 0 L25 | Client/server drift on durations and caps. | D-11. |
| **A-13** | Retention is "delete within 30 days", but FR-19 exports a final snapshot that will contain display names. | 22 L631; FR-19 L525 | Privacy commitment contradicted by a deliverable. | D-R12: strip names from exports or scope them as owner-only and deleted with the dataset. |
| **A-14** | Session token lifetime is "at least 24 h" for a multi-day event; storage location (cookie vs localStorage) is unstated. | 6.2 L101; 12 L303 | Returning visitors lose their node; localStorage invites XSS token theft (and there is no CSP requirement — G-07). | 72 h token, HttpOnly `Secure` cookie, `SameSite=Lax`, CSP added. |
| **A-15** | Ban semantics: does the banned session's node disappear, go inactive, or stay? What does the banned client see? | 6.8 L199; 12 L299 | Moderation outcome, reconnect behaviour, code path. | D-R11. |
| **A-16** | Admin auth transport ("require a secret") unstated — header vs query; no admin action audit log is required. | 12 L297 | Secret leakage into logs/referrers; no accountability for resets/bans. | `Authorization` header, server-side session, `admin_audit` table (D-12). |

### 5.3 Gaps (missing requirements)

| ID | Gap | Impact | Proposal |
|---|---|---|---|
| **G-01** | Closing the stable-code list at FR-32 leaves no code for protocol-version mismatch, maintenance mode, `LINE_FULL`, or banned sessions. | Clients must invent codes; "never silent" breaks at the edges. | D-R13: extend the enum. |
| **G-02** | No durability/flush requirement for the event log. | Ties C-04. | D-08 / D-R7. |
| **G-03** | Section 18 lists metrics but no FR owns them; no alert thresholds are defined anywhere. | Event-day blindness. | D-14; thresholds from Phase 2 baseline. |
| **G-04** | Data model is missing: difficulty counter, per-Line `rounds_survived`, global trend history, `request_id` dedupe, Line `status` enum, admin audit. | Cannot persist required outputs. | Extend Section 10 in v1.5 (schema is proposed, not code). |
| **G-05** | The success metric "≥ 70% explain why redundant routes help" requires a 3-question quiz instrument that no phase owns. | An MVP success metric is unmeasurable. | Phase 3 gate item; instrument designed then, run at playtest. |
| **G-06** | FR-24 (S) requires language-ready strings; no extraction tooling, pluralisation or number/date formatting rule is stated. | Late-stage i18n retrofit risk if Hindi/Marathi are chosen. | Extract strings from day 1 with ICU message format; no locale shipped at launch (decision 6). |
| **G-07** | Section 12 requires origin checks and dependency scanning but no CSP/security headers. | Token theft via XSS, clickjacking. | CSP, HSTS, `X-Frame-Options`/frame-ancestors, `Referrer-Policy`. |
| **G-08** | `lines.status` values are unspecified. | Join/pause/reset logic undefined. | Enum: `seeding`, `active`, `paused`, `archived`. |
| **G-09** | Rate limits are "2/s" plus "hundreds of joins per minute" guidance; no join-limit number, no message-burst limit beyond size. | Abuse posture is untestable. | Config: join 300/min/IP, 120 msg/10 s/session, 32 pending actions. |
| **G-10** | No spectator-scale requirement (how many `/screen` clients, refresh rate, read-only fan-out budget). | Venue screens may starve player fan-out. | Treat screens as normal subscribers at 1 Hz; separate read-only topic; cap documented. |
| **G-11** | "Resilience score" display precision and trend semantics undefined (ties A-04). | UI inconsistency between HUD, screen and report. | Integers 0–100 everywhere; trend = signed delta over 10 rounds. |
| **G-12** | "Understands in ~10 s" and the quiz have no measurement procedure. | Success metric not reproducible. | Fixed playtest script + observation sheet in Phase 3. |

### 5.4 What checks out (verified by recomputation)

- **Phase arithmetic:** 40 + 5 + 0 + 35 + 10 = 90 s; S half-point = 17.5 s. Consistent with Section 24's stated defaults.
- **Cap table:** N = 5–9 → 1; 10–14 → 2; 15–19 → 3; 20–24 → 4; ≥ 25 → 5. Matches `floor(N/5)` exactly.
- **Appendix B, all nine cases, arithmetically correct:**
  - B1: path of 5, C disabled → N = 4, components {A,B} and {D,E} → C = 0.5, B = 0. ✓
  - B2: no repair → 60 × 0.5 = 30. ✓
  - B3: B–D at 10 s → C = 1, APs = B, D → B = 1 − 2/4 = 0.5, S = 1 → 60 + 15 + 10 = 85. ✓
  - B4: same at 25 s → S = 0.5 → 80. ✓
  - B5: ring of 6, A struck → path of 5, C = 1, S = 1, APs = C, D, E → B = 0.4 → 82; then B–F → 100. ✓
  - B6: triangle + pendant → C = 1, S = 1, AP = X → B = 0.75 → 92.5 → **93** half-up (this is the case that catches banker's rounding). ✓
  - B7: seeding cycle, 40 s, excluded, first full strike is type A. ✓
  - B8: node cap 9→1, 10→2, 24→4, 25→5; link cap `floor(4/5) = 0` raised to 1. ✓
  - B9: Result-phase or +1 ms link → PHASE_LOCKED, no state change. ✓
- **Load model:** 400 clients/Line × 28 Lines ≈ 11,200; 5 Hz × 400 = 2,000 msg/s/Line; ≈ 56k msg/s total. Internally consistent — and the PRD correctly labels these as estimates to be verified, not capacity claims.
- **Phase gating for starter links, inactive links counting toward the degree cap, and recovery *after* scoring** are consistent across 6.3, 6.4, 6.6.1 and Section 14. This is the part of the rules most likely to be implemented inconsistently, and it is already airtight.

---

## 6. Proposed architecture

### 6.1 Confirmed requirements (from the PRD — not negotiable)

| # | Requirement | Source |
|---|---|---|
| R1 | Browser client, instant join, no account, no wallet | §1, FR-1, FR-2 |
| R2 | Server authoritative for validity and scoring | §8 |
| R3 | One authoritative owner per Line at a time | §9 |
| R4 | Full snapshot then batched deltas at 5 Hz with sequence numbers | §9, §11 |
| R5 | Pure, deterministic, I/O-free rules module with seeded randomness | §9, 6.6.1 |
| R6 | Postgres snapshots + append-only event log; reset snapshots first | §9, 6.8 |
| R7 | Mobile-first UI; 400 nodes at ≥ 30 fps on mid-range Android; JS < 250 KB gz | §8, §13 |
| R8 | Read-only `/screen`; secret-protected admin panel; pause/reset/ban | FR-17, FR-18 |
| R9 | Rate limits, validation, 1 KB message cap, session bans, profanity filter | §12 |
| R10 | Stable rejection codes, pending-action timeouts, reconnect reconciliation | FR-28…FR-33, §11 |

### 6.2 Proposed technology (my recommendation — needs approval)

| Layer | Proposal | Why | Alternative kept open |
|---|---|---|---|
| Language | TypeScript everywhere | One implementation of the rules for server + preview; one test toolchain for Appendix B | Python/FastAPI backend (D-02) |
| Engine | `packages/engine`, pure functions, zero I/O, lint-banned globals | Enforces R5 mechanically | Class + injected clock/PRNG |
| Server | Node + Fastify + `ws` (or uWebSockets.js), one process in Phase 2 | Lowest moving parts; per-Line actor gives single-writer semantics | FastAPI |
| Client | React + TS + Vite, hand-written Canvas 2D renderer | 400 nodes is Canvas territory; no graph library in the 250 KB budget | WebGL if Phase 3 misses fps |
| State | In-process hot state (Phase 2) → Redis (Phase 4) | Avoids a single-Redis SPOF in the demo | Redis from Phase 2 |
| Persistence | Postgres: snapshots 10 s + event log ≤ 1 s group commit | Meets R6 and the 5 s bound | Redis AOF as primary |
| Protocol | JSON + `v` + `seq` + `request_id`; zod-style validation at the boundary | Matches §11 exactly | Binary/protobuf later if measured necessary |
| Config | One schema-validated JSON file, tunables only | §0 rule 6 | YAML |
| Tests | Vitest (unit/property with fast-check), Playwright (e2e), k6 (load) | Matches §14/§15 evidence requirements | Jest |

### 6.3 Runtime model

```
Browser (React + Canvas)
   │  WS: join / resume(last_seq, pending_ids) / create_link(a,b) / ping
   ▼
Gateway (same process in Phase 2)
   │  validate shape → auth/rate-limit → route to Line actor
   ▼
LineHost[lineId]  ──serialized queue──►  engine.reduce(state, action, config, seed)
   │                                          │
   │◄──────────── events + new state ─────────┘
   ├─► 5 Hz batcher → delta(seq, events[]) → subscribers of that Line
   ├─► event log writer (group commit ≤ 1 s)  → Postgres
   └─► snapshot writer (every 10 s)           → Postgres
```

Phase 4 changes only the transport between Gateway and `LineHost` (to Redis Streams + pub/sub under a lease) and the state store (to Redis). Engine, protocol, client and tests are untouched. That seam is the single most important design decision in this report.

### 6.4 Determinism strategy

- Time and randomness are **inputs**, never reads: `tick(state, now)` and `seedStream(lineSeed, roundNo, purpose)`.
- Purpose-tagged streams prevent one decision from perturbing another (D-06).
- Scoring is exact integer arithmetic with one final half-up rounding (D-05).
- `stateHash()` after every applied action; the replay test asserts hash equality for a recorded action log.
- Articulation points via iterative DFS (6.6.1 requires it); no recursion on graph depth.
- Golden fixtures for B1–B9 live as data files in `packages/testing`, not inline in tests, so the report and the suite cannot drift apart.

### 6.5 Client behaviour

- Optimistic pending line (dashed) on tap, resolved or retracted by `action_result` within the FR-28/FR-33 windows.
- Preview of valid/invalid targets uses the shared pure engine, clearly a *preview*: the authoritative answer is always the server's (resolves C-08).
- Countdown derives from server `ends_at` plus an offset measured at handshake; never from client wall clock.
- Reconnect: dim, banner, `resume`, replay "While you were away" from `delta` + `action_result`, read-only after 30 s.

### 6.6 Security posture (proposed)

HttpOnly `Secure` cookie session token; CSP with no inline script; origin allow-list on upgrade; per-session rate limits plus per-IP join allowance sized for conference NAT; 1 KB frame cap and connection-count caps; admin behind header secret with separate rate limit and audit log; no secrets in the bundle; dependency scanning in CI.

---

## 7. Proposed repository structure (PROPOSED)

```
mumbai-network-garden/
├── apps/
│   ├── web/                  # React+TS player client; routes /, /screen, /admin
│   └── server/               # authoritative host: WS gateway, LineHost actors, persistence, admin API
├── packages/
│   ├── engine/               # pure rules: state, actions, strikes, scoring, seeds, layout (no I/O)
│   ├── protocol/             # message schemas, version, rejection-code enum, shared types
│   ├── config/               # game.config schema + defaults + validation
│   └── testing/              # golden fixtures (B1–B9), bot simulator, property-test generators
├── docs/
│   ├── PRD.md                # canonical PRD (pending D-R10)
│   ├── STATUS.md
│   ├── DECISIONS.md
│   ├── PHASE0_READINESS_REPORT.md
│   ├── RUNBOOK.md            # Phase 6
│   └── loadtest/             # Phase 5 report + raw results
├── tests/
│   ├── e2e/                  # Playwright multi-client
│   ├── integration/          # reconnect, restart, persistence
│   └── abuse/                # malformed, oversize, replayed ids, bans, rate limits
├── tools/
│   ├── loadtest/             # k6 scenarios (a)–(i)
│   └── scripts/              # dev fixtures, seed loaders
├── infra/
│   ├── compose/              # local Postgres (+ Redis from Phase 4)
│   └── deploy/               # manifests / IaC (Phase 4+)
├── .github/workflows/        # lint, typecheck, unit, e2e smoke, dependency scan
├── package.json              # pnpm workspace root
└── README.md                 # what this is, limitations, honest status
```

**Why each top-level folder exists**

| Folder | Purpose | Absent means |
|---|---|---|
| `apps/` | Deployable surfaces only (web, server) | — |
| `packages/engine` | The one place game rules live; importable by server, client preview, and tests | Rules would be duplicated → drift |
| `packages/protocol` | Single schema source for client/server/tests | Hand-rolled message shapes diverge |
| `packages/config` | Tunables in one file, validated at boot | §0 rule 6 violated |
| `packages/testing` | Golden fixtures + bots, reusable by any harness | Appendix B tests duplicated per layer |
| `docs/` | Source of truth + status + decisions + runbook | Session continuity fails |
| `tests/` | Cross-cutting tests that need a real server/browser | §14 cases scattered |
| `tools/` | Load and dev tooling, not shipped | §15 evidence unproducible |
| `infra/` | Local compose, later deploy manifests | "Works on my machine" |
| `.github/` | CI gates that enforce the rules above | Regressions land silently |

**Deliberately absent:** no `services/` microservice split, no per-Line process directory, no client-side rules fork, no Kubernetes manifests before Phase 4, no design-system package at MVP (tokens live in `apps/web` until a second consumer exists).

---

## 8. Phase-by-phase implementation plan

Each phase ends at a gate: artifacts produced, `STATUS.md` updated, `DECISIONS.md` appended, then **stop for written approval**. Durations are deliberately omitted — the sequence is fixed, the calendar is the owner's call.

### Phase 0 — Readiness review (this phase)
**Work:** read PRD, find contradictions/ambiguities/gaps, propose architecture + structure + plan, produce status and decisions.
**Gate artifacts:** this report; `docs/STATUS.md`; `docs/DECISIONS.md`; owner's written approval recorded verbatim in `DECISIONS.md`.
**Exit criteria:** owner has ruled on C-01, C-02, C-03, D-02, D-07 and PRD canonicalization.

### Phase 1 — Rules engine (pure, no server, no UI)
**Work:** workspace skeleton with the pure engine only; `game.config`; state/action model; strikes; scoring with exact arithmetic; iterative AP; seeded streams; bot simulator; golden fixtures B1–B9; property tests.
**Testing:** unit (every 6.6.1 rule), property (invariants: degree ≤ 5, no duplicates, no links to disabled nodes, inactive links count), determinism (replay hash equality), golden (B1–B9), simulation report with score distributions over ≥ 10k bot rounds.
**Acceptance:** 100% of Appendix B passes as automated tests; zero I/O imports in the engine (lint-enforced); replay of a 10k-action log reproduces the same state hash; config change alone alters behaviour with no code edit.
**Dependencies:** owner sign-off on 6.6.1 + Appendix B (PRD phase table); resolutions D-R1…D-R3. **Risk:** ambiguity discovered mid-engine → stop and ask, never guess.

### Phase 2 — Single-server MVP
**Work:** Fastify + WS; join/resume/link/round loop; per-Line actor; Postgres snapshots + event log; admin pause/reset/ban; minimal UI sufficient to play.
**Testing:** two-browser e2e full round; concurrency (many simultaneous links on the same pair → exactly one success); reconnect with delta and with forced snapshot; restart recovery from Postgres; idempotent replay of `request_id`; malformed/oversize/banned/rate-limited inputs.
**Acceptance:** FR-1…FR-14 demonstrated on a real network; state survives a process kill with ≤ 5 s loss (measured, recorded); every FR-32 code reachable in a test.
**Dependencies:** D-R6, D-R7, D-R9, D-R11; D-02 approved. **Risk:** persistence correctness — mitigate with event-log replay tests from day one.

### Phase 3 — Experience (UI, theme, mobile, accessibility, spectator, admin)
**Work:** Mumbai-themed visuals (line colours, route-map links); node/link interaction per 6.9; HUD; onboarding overlay; `/screen`; `/admin`; accessibility (44 px, reduced motion, colourblind-safe + shape cues, screen-reader status).
**Testing:** playtest with ≥ 10 people on real phones (script from G-12); axe/keyboard/screen-reader smoke; small-viewport layouts; 400-node fps harness on mid-range Android; bundle budget check.
**Acceptance:** playtest notes committed with fixes applied; ≥ 30 fps at 400 nodes; initial JS < 250 KB gz; interactive < 3 s on throttled 4G; every FR-25…FR-33 behaviour observed on a device.
**Dependencies:** Phase 2 demo; UX sign-off on layout (D-10). **Risk:** the spiral layout may read as a hairball — playtest decides, config keeps it adjustable.

### Phase 4 — Scale-out (benchmark, not assumption)
**Work:** multi-instance gateways; per-Line ownership; Redis lease + Streams; snapshots + event log under ownership transfer; failover; **benchmark against sticky per-Line routing**.
**Testing:** failover demo mid-round; ownership split-brain test; scenarios (d) reconnect storm, (h) simultaneous outages in every Line, (i) both at once — p95/p99, CPU, memory.
**Acceptance:** multi-instance tests pass; failover preserves state from snapshot + log; benchmark comparison **recorded in `DECISIONS.md` with raw numbers**; no claim of 10k capacity yet.
**Dependencies:** D-R8 (hosting/budget) **must be resolved first**. **Risk:** this is the PRD's declared hypothesis — be prepared for sticky routing to win.

### Phase 5 — Load testing
**Work:** k6 scenarios (a)–(i) exactly as Section 15; committed scripts, environment, raw results.
**Acceptance:** p95 ≤ 750 ms, p99 ≤ 1500 ms action-to-other-clients; < 1% failed actions; ≥ 99% resume within 10 s; full 10k reconnect storm in 60 s without a crash; CPU headroom ≥ 30% at peak; memory stable; no corruption. Report states plainly what was and was not achieved (if it is 3,000, it says 3,000).
**Dependencies:** Phase 4; hardware matching the intended event target.
**Risk:** the 56k msg/s fan-out estimate may be off — measure before optimising.

### Phase 6 — Release
**Work:** deployment guide, runbook (start/pause/reset/ban/metrics/rollback), rehearsal on venue-like network with real devices, final snapshot export, retention/deletion, README limitations.
**Acceptance:** a second person can deploy and run a round from the runbook alone; rehearsal completed; export produced and PII policy honoured.
**Dependencies:** everything above. **Risk:** event-day Wi-Fi — rehearse the read-only fallback path deliberately.

---

## 9. Testing strategy

### 9.1 Layers and what each proves

| Layer | Tool | Proves |
|---|---|---|
| Golden rules | Vitest + fixtures | The PRD's own worked examples (B1–B9) are implemented exactly |
| Rule units | Vitest | Every clause in 6.3, 6.4, 6.5, 6.6.1 |
| Properties | fast-check | Invariants hold over random play (degree ≤ 5, no dupes, no links to disabled, tokens never negative, cap never exceeded) |
| Determinism | state-hash replay | Same seed + same actions → identical state, forever |
| Simulation | bot harness | Score distribution sanity; no dead-lock; seeding-mode exit; difficulty behaviour |
| Concurrency | integration | Exactly one winner per contested pair; no corruption |
| Reconnect | integration | Delta path, forced-snapshot path, pending reconciliation, 500-event boundary |
| Durability | integration | Kill the process mid-round; replay from snapshot + log; ≤ 5 s loss |
| Protocol abuse | `tests/abuse` | Malformed, oversize, replayed id, banned, rate-limited, unsupported version |
| E2E | Playwright | Two browsers see each other; full round; score explained |
| Client perf | fps harness | ≥ 30 fps / 400 nodes / mid-range Android; bundle budget |
| Accessibility | axe + manual | Keyboard, screen reader, reduced motion, 44 px, colourblind cues |
| Load | k6 | Section 15 scenarios and acceptance numbers, honestly reported |

### 9.2 Evidence discipline

- A target is **achieved** only when a committed artifact (test output, report, raw run) shows it. Otherwise the wording is "target" or "unverified".
- Golden fixtures are data, not code, so a rule change forces a visible fixture diff.
- Every rejection code in FR-32 has at least one test that reaches the client, per Section 14.
- The load report includes the environment, so results are reproducible.

---

## 10. Hosting, infrastructure and budget (must be resolved before Phase 4)

**Status: UNKNOWN.** No quote, benchmark or cost figure exists. The PRD requires this to be stated before Phase 4 (Section 22 decision 5; Section 16 item 5).

| Decision | Why it matters | Needed by |
|---|---|---|
| Region | Audience is physically in Mumbai; venue latency dominates perceived responsiveness | Phase 4 planning |
| Compute shape | Fan-out and per-Line CPU are unknown until Phase 2/5 measurement | Phase 4 |
| Managed vs. self-hosted Postgres/Redis | Operational risk on event day vs. cost | Phase 4 |
| Egress budget | 5 Hz × 400 clients per Line is the dominant cost driver | Phase 4 |
| CDN for static assets | Keeps the 250 KB bundle off the venue link | Phase 3 |
| Cost ceiling per day / total | Owner-only decision | Phase 4 |
| TLS/domain, monitoring vendor | Event-day operability | Phase 5/6 |

**Proposed shape (hypothesis, not a claim):** Phases 2–3 — one app node + one managed Postgres. Phase 4 — two app nodes + managed Redis + managed Postgres, static assets behind a CDN. Phase 5 — the same shape at event-day size, plus a second load-generator host outside the target network. Each of these must be replaced by measured numbers in Phase 5.

---

## 11. Risks

### 11.1 From the PRD (unchanged, acknowledged)

Hairball graph; fan-out overload at round start; bots and spam; venue NAT; game feels trivial; scope creep; overclaiming scale; model drift between sessions; missing repository; Redis design failing at reconnect storms; ambiguous scoring edge cases.

### 11.2 Added by this review

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Difficulty rule is "fixed" twice, in opposite directions, after Phase 1 starts | Medium | Engine rewrite | D-R1 ruled before any Phase 1 code |
| Starter-link behaviour differs between join paths (immediate vs. deferred) | High | Visible inconsistency; flaky tests | D-R2 + purpose-tagged seed (D-06) |
| Unreachable-state tests get faked or skipped, weakening the Phase 1 gate | Medium | False "green" gate | D-R3 defines the policy explicitly |
| Persistence design fails its own 5 s bound on event day | Medium | Lost rounds, broken trust | D-R7 + steady-state failover drills in Phase 4 |
| Section 9's Redis design consumes the MVP budget and still loses the benchmark | Medium | Schedule loss | Build the `LineHost` seam, not the infrastructure (D-07) |
| Canvas 2D renderer misses 30 fps on low-end Android at 400 nodes | Medium | Perf target missed | Harness from Phase 3 start; WebGL fallback scoped |
| Layout reads as a hairball despite the degree cap | Medium | Comprehension goal missed | Playtest + config-tunable spacing (D-10) |
| One-developer scope across six phases | High | Slipped gate | Phases are gates, not deadlines; cut Phase 2 candidates first |
| Spec drift between PRD and code as rulings accumulate | High | Divergence | Rulings land in `DECISIONS.md`, fixtures change visibly |
| Event-day network worse than rehearsal | Medium | Read-only fallback used heavily | Rehearse the fallback, not just the happy path |

---

## 12. Decisions required (priority order)

**Before the Phase 0 gate can close**
1. **D-R10** — PRD canonical path / project repository (C-09).
2. Approve or reject the v1.5 editorial fixes: C-07 (strike residual audit language), C-10 (restore tables), C-06 (decision 9 + PHASE_LOCKED copy).

**Before Phase 1 code**
3. **D-R1** — difficulty vs. outage cap (C-01).
4. **D-R2** — canonical starter-link rule (C-02).
5. **D-R3** — policy for unreachable scoring states (C-03).
6. **D-02** — stack: TypeScript end-to-end, or FastAPI candidate.
7. **D-R5** — community-score weighting (A-03).

**Before Phase 2**
8. **D-R7** — event-log durability bound (C-04).
9. **D-R6** — Line capacity, creation, exhaustion (A-05).
10. **D-R9** — join bot challenge (A-11).
11. **D-R11** — ban semantics (A-15).
12. **D-R13** — extend the stable-code enum (G-01).
13. **D-R12** — retention vs. snapshot export (A-13).

**Before Phase 3**
14. **D-10** — layout algorithm sign-off (A-08).
15. **D-R4** — timelapse scope (C-05).

**Before Phase 4**
16. **D-R8 / D-16** — hosting target, instance shapes, cost ceiling. **UNKNOWN today.**

Everything else in `DECISIONS.md` §2 is my recommendation and carries no authority until approved.

---

## 13. Assumptions and unknowns

| # | Statement | Label |
|---|---|---|
| 1 | The root PRD file is the current source of truth | VERIFIED (single file present) |
| 2 | No implementation, dependency or scaffold exists | VERIFIED |
| 3 | Appendix B arithmetic is internally correct | VERIFIED (recomputed) |
| 4 | N ≥ 4 is the minimum survivable N under the current caps | VERIFIED (arithmetic) |
| 5 | Event-day traffic reaches 10,000 concurrent | **UNKNOWN** — target only |
| 6 | Redis lease + Streams beats sticky routing | **UNKNOWN** — PRD says benchmark it |
| 7 | 400 nodes render at ≥ 30 fps on mid-range Android | **UNKNOWN** — unmeasured |
| 8 | Budget and hosting shape | **UNKNOWN** — owner decision |
| 9 | Venue network quality | **UNKNOWN** — rehearsal required |
| 10 | Playtest comprehension (~10 s / ≥ 70% quiz) | **UNKNOWN** — Phase 3 measurement |

---

## 14. Recommendation

Proceed to Phase 1 **only after** the owner has:

1. ruled on C-01, C-02, C-03 and D-02 (these change what the engine *is*, so they cannot be deferred);
2. authorized the PRD canonicalization and the three editorial fixes (C-06, C-07, C-10);
3. read the risk list in §11 and accepted the `LineHost` seam recommendation (D-07), which is the difference between a demo and a demo plus unproven infrastructure.

If those land, Phase 1 is a well-bounded, testable, code-only task with no infrastructure and no UI, and its gate — every Appendix B case green plus a determinism replay — is the strongest quality signal available this early.

No code, scaffolding, dependency, PRD edit or performance claim was made in this phase. Verification of the three documentation files is recorded in `docs/STATUS.md`.

**Awaiting owner approval.**
