/**
 * The Line state machine. This is the whole game.
 *
 * Contract (PRD Section 9):
 *   reduce(state, action, config, now) -> { state, events, result? }
 * is pure: no clock, no randomness, no I/O. `now` and the Line seed are the only
 * inputs from outside the rules. Callers may replay any action log and get a
 * byte-identical state.
 *
 * Every action first advances the phase machine to `now`, so a create_link sent
 * 1 ms after Repair ends is evaluated in Result and rejected with PHASE_LOCKED
 * (Appendix B9).
 */

import type { GameConfig } from '@mng/config';
import { isLinkAllowed, type ActionResult, type ReasonCode } from '@mng/protocol';
import type {
  Action,
  JoinResult,
  LineEvent,
  LineLink,
  LineNode,
  LineState,
  ReduceOutcome,
  StrikeRecord,
  StrikeType,
} from './types.js';
import {
  activeNodeIds,
  connectivity,
  fractionAtLeast,
  hasLinkBetween,
  inSameComponent,
  totalDegree,
} from './graph.js';
import { applyStrike, outageCaps } from './outage.js';
import { positionFor } from './layout.js';
import { nextTokenInMs, refreshTokens } from './tokens.js';
import { scoreRound } from './scoring.js';
import { PURPOSE, hash32, stream } from './rng.js';

/** Idempotency window. Large enough for a resume after a long outage, small enough to bound memory. */
const DEDUPE_LIMIT = 512;
const HISTORY_LIMIT = 10;

export function createLine(id: string, seed: number, config: GameConfig, now: number): LineState {
  return {
    id,
    seed: seed >>> 0,
    now,
    phase: 'seeding',
    phaseStartedAt: now,
    phaseEndsAt: now + config.phases.seeding,
    roundNo: 0,
    roundStartedAt: now,
    roundsSurvived: 0,
    seedingCycles: 0,
    difficulty: 0,
    pendingStrikeType: null,
    lastStrike: null,
    cAtOutage: null,
    s2: 0,
    nodes: {},
    links: {},
    nodeOrder: [],
    nodeSeq: 0,
    linkSeq: 0,
    history: [],
    lastRound: null,
    processed: {},
    processedOrder: [],
    paused: false,
    seq: 0,
  };
}

export function reduce(
  state: LineState,
  action: Action,
  config: GameConfig,
  now: number,
): ReduceOutcome {
  if (!Number.isFinite(now)) throw new Error('reduce requires a finite server time');

  const s: LineState = structuredClone(state);
  const events: LineEvent[] = [];
  s.now = now;

  advance(s, config, events);

  switch (action.type) {
    case 'tick': {
      // Token regeneration is the only thing a tick does on its own. Emitting an
      // event per grant keeps every client's HUD honest without polling.
      for (const id of s.nodeOrder) {
        const node = s.nodes[id];
        if (!node) continue;
        if (refreshTokens(node, s.now, config)) {
          push(events, s, { type: 'tokens.granted', at: s.now, nodeId: id, tokens: node.tokens });
        }
      }
      return { state: s, events };
    }

    case 'join': {
      const result = join(s, action.sessionId, action.name, config, action.nodeId, events);
      return { state: s, events, result };
    }

    case 'create_link': {
      const result = createLink(s, action, config, events);
      return { state: s, events, result };
    }
  }
}

// ---------------------------------------------------------------------------
// phase machine
// ---------------------------------------------------------------------------

function advance(s: LineState, config: GameConfig, events: LineEvent[]): void {
  let guard = 0;
  while (s.now >= s.phaseEndsAt) {
    if (guard++ > 10_000) throw new Error('phase machine failed to settle (zero-length phase?)');
    const at = s.phaseEndsAt;
    transition(s, config, at, events);
  }
}

function transition(s: LineState, config: GameConfig, at: number, events: LineEvent[]): void {
  switch (s.phase) {
    case 'seeding': {
      if (activeNodeIds(s).length >= config.line.seedThreshold) {
        startRound(s, config, at, events);
      } else {
        // Another Build-only cycle. Counters for rounds/difficulty are untouched.
        s.seedingCycles++;
        enterPhase(s, 'seeding', at, config.phases.seeding, events);
      }
      return;
    }

    case 'build': {
      s.pendingStrikeType = pickStrikeType(s, config);
      enterPhase(s, 'warning', at, config.phases.warning, events);
      return;
    }

    case 'warning': {
      const type: StrikeType = s.pendingStrikeType ?? 'A';
      const strike = applyStrike(s, type, config);
      s.lastStrike = strike;
      s.pendingStrikeType = null;

      // S is seeded from the state immediately after the outage (6.6.1).
      const cAfterOutage = connectivity(s);
      s.cAtOutage = cAfterOutage;
      s.s2 = fractionAtLeast(cAfterOutage, config.scoring.speedThresholdNum, config.scoring.speedThresholdDen)
        ? 2
        : 0;

      push(events, s, { type: 'outage.applied', at, strike, cAfterOutage });
      enterPhase(s, 'repair', at, config.phases.repair, events);
      return;
    }

    case 'repair': {
      const strike = s.lastStrike ?? { type: 'A', nodes: [], links: [] };
      const result = scoreRound(s, config, strike, at, s.roundStartedAt);

      if (result) {
        s.lastRound = result;
        s.roundsSurvived++;
        s.difficulty = Math.floor(s.roundsSurvived / 5);
        s.history.push(result);
        if (s.history.length > HISTORY_LIMIT) s.history.shift();
        push(events, s, { type: 'round.scored', at, result });
      } else {
        // N = 0: void round. Not scored, not survived, excluded from the community score (6.6.1).
        push(events, s, { type: 'round.void', at, roundNo: s.roundNo, reason: 'NO_ACTIVE_NODES' });
      }

      // Recovery happens at the start of Result, *after* scoring (6.4 / 6.6.1).
      let recoveredNodes = 0;
      let recoveredLinks = 0;
      for (const id of s.nodeOrder) {
        const node = s.nodes[id] as LineNode;
        if (node.status !== 'active') {
          node.status = 'active';
          recoveredNodes++;
        }
      }
      for (const id in s.links) {
        const link = s.links[id] as LineLink;
        if (link.cut) {
          link.cut = false;
          recoveredLinks++;
        }
      }
      push(events, s, { type: 'round.recovered', at, nodes: recoveredNodes, links: recoveredLinks });

      enterPhase(s, 'result', at, config.phases.result, events);
      return;
    }

    case 'result': {
      if (activeNodeIds(s).length >= config.line.seedThreshold) {
        startRound(s, config, at, events);
      } else {
        s.seedingCycles++;
        enterPhase(s, 'seeding', at, config.phases.seeding, events);
      }
      return;
    }
  }
}

function startRound(s: LineState, config: GameConfig, at: number, events: LineEvent[]): void {
  s.roundNo++;
  s.roundStartedAt = at;
  s.s2 = 0;
  s.cAtOutage = null;
  s.pendingStrikeType = null;
  s.lastStrike = null;
  enterPhase(s, 'build', at, config.phases.build, events);
}

function enterPhase(s: LineState, phase: LineState['phase'], at: number, duration: number, events: LineEvent[]): void {
  s.phase = phase;
  s.phaseStartedAt = at;
  s.phaseEndsAt = at + duration;
  push(events, s, { type: 'line.phase', at, phase, endsAt: s.phaseEndsAt, roundNo: s.roundNo });
}

/**
 * Round 1 (the first full round) is always a Hub strike. Later rounds draw from
 * the configured weights using the round-seeded type stream.
 */
function pickStrikeType(s: LineState, config: GameConfig): StrikeType {
  if (s.roundNo <= 1) return 'A';
  const w = config.outage.typeWeights;
  const a = Math.round(w.A);
  const b = Math.round(w.B);
  const c = Math.round(w.C);
  const total = a + b + c;
  if (total <= 0) return 'A';
  const r = stream(s.seed, s.roundNo, PURPOSE.strikeType).nextInt(total);
  if (r < a) return 'A';
  if (r < a + b) return 'B';
  return 'C';
}

// ---------------------------------------------------------------------------
// join
// ---------------------------------------------------------------------------

function join(
  s: LineState,
  sessionId: string,
  name: string,
  config: GameConfig,
  requestedNodeId: string | undefined,
  events: LineEvent[],
): JoinResult {
  // Same token returns the same node and Line (6.2).
  const existingId = s.nodeOrder.find((id) => s.nodes[id]?.sessionId === sessionId);
  if (existingId) {
    const node = s.nodes[existingId] as LineNode;
    refreshTokens(node, s.now, config);
    node.lastSeenAt = s.now;
    return {
      kind: 'join',
      ok: true,
      nodeId: existingId,
      starterLinkId: null,
      starterDeferred: false,
      tokens: node.tokens,
    };
  }

  const id = requestedNodeId ?? `n${s.nodeSeq + 1}`;
  if (s.nodes[id]) {
    return { kind: 'join', ok: false, reason: 'STALE_STATE' };
  }
  s.nodeSeq++;

  const pos = positionFor(s.nodeOrder.length, config);
  const node: LineNode = {
    id,
    sessionId,
    name: sanitizeName(name, id),
    x: pos.x,
    y: pos.y,
    status: 'active',
    createdAt: s.now,
    lastSeenAt: s.now,
    tokens: config.links.maxTokens,
    lastRegenAt: s.now,
    pendingStarter: false,
    restoredRoutes: 0,
  };
  s.nodes[id] = node;
  s.nodeOrder.push(id);

  // Owner amendment 2026-10-26: joining never creates an edge. PRD 6.2's
  // automatic starter link is intentionally overridden; every edge requires an
  // explicit request accepted by the target player.
  push(events, s, {
    type: 'node.joined',
    at: s.now,
    nodeId: id,
    sessionId,
    name: node.name,
    x: node.x,
    y: node.y,
    tokens: node.tokens,
    starterLinkId: null,
    starterDeferred: false,
  });

  return {
    kind: 'join',
    ok: true,
    nodeId: id,
    starterLinkId: null,
    starterDeferred: false,
    tokens: node.tokens,
  };
}

// ---------------------------------------------------------------------------
// link validation
// ---------------------------------------------------------------------------

export interface LinkRejection {
  readonly reason: ReasonCode;
  readonly retryAfterMs?: number;
}

/**
 * Pure validation shared by the request flow and actual link creation.
 * Returning null means the link would be legal right now. It does not mutate
 * state, spend a token, or create an edge.
 */
export function checkLink(
  s: LineState,
  a: string,
  b: string,
  actorSessionId: string,
  config: GameConfig,
): LinkRejection | null {
  const actorId = s.nodeOrder.find((id) => s.nodes[id]?.sessionId === actorSessionId);
  if (!actorId) return { reason: 'STALE_STATE' };
  const actor = s.nodes[actorId] as LineNode;

  const na = s.nodes[a];
  const nb = s.nodes[b];

  // Validation order matches create_link and is part of the contract.
  if (!na || !nb) return { reason: 'STALE_STATE' };
  if (a === b) return { reason: 'SELF_LINK' };
  if (hasLinkBetween(s, a, b)) return { reason: 'ALREADY_LINKED' };
  if (s.paused) return { reason: 'LINE_PAUSED' };
  if (!isLinkAllowed(s.phase)) {
    return { reason: 'PHASE_LOCKED', retryAfterMs: Math.max(0, s.phaseEndsAt - s.now) };
  }
  if (na.status !== 'active' || nb.status !== 'active') return { reason: 'NODE_OFFLINE' };
  if (totalDegree(s, a) >= config.links.degreeCap || totalDegree(s, b) >= config.links.degreeCap) {
    return { reason: 'NODE_FULL' };
  }
  if (actor.tokens < 1) {
    return { reason: 'NO_TOKENS', retryAfterMs: nextTokenInMs(actor, s.now, config) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// create_link
// ---------------------------------------------------------------------------

function createLink(
  s: LineState,
  action: Extract<Action, { type: 'create_link' }>,
  config: GameConfig,
  events: LineEvent[],
): ActionResult {
  const actorId = s.nodeOrder.find((id) => s.nodes[id]?.sessionId === action.sessionId);
  if (!actorId) {
    return { requestId: action.requestId, ok: false, reason: 'STALE_STATE' };
  }
  const actor = s.nodes[actorId] as LineNode;

  // Idempotent retry: return the recorded answer, emit nothing (Section 11).
  const cached = s.processed[action.requestId];
  if (cached) return cached;

  refreshTokens(actor, s.now, config);
  actor.lastSeenAt = s.now;

  const { a, b } = action;

  const fail = (reason: ReasonCode, retryAfterMs?: number): ActionResult => {
    const result: ActionResult =
      retryAfterMs === undefined
        ? { requestId: action.requestId, ok: false, reason }
        : { requestId: action.requestId, ok: false, reason, retryAfterMs };
    remember(s, result);
    push(events, s, { type: 'link.rejected', at: s.now, requestId: action.requestId, reason, a, b });
    return result;
  };

  // Validation order is part of the contract; tests pin it. The same helper is
  // used for request-time checks so a pending request can never bypass rules.
  const rejection = checkLink(s, a, b, action.sessionId, config);
  if (rejection) return fail(rejection.reason, rejection.retryAfterMs);

  actor.tokens--;

  // Restored route: only Repair-phase links, only when the endpoints were in
  // different components at the moment of creation (6.6.1). Starter links never count.
  const restoredRoute = s.phase === 'repair' && !inSameComponent(s, a, b);

  const link = addLink(s, a, b, action.sessionId, false);
  if (restoredRoute) actor.restoredRoutes++;

  const result: ActionResult = {
    requestId: action.requestId,
    ok: true,
    linkId: link.id,
    restoredRoute,
  };
  remember(s, result);
  push(events, s, {
    type: 'link.created',
    at: s.now,
    linkId: link.id,
    a,
    b,
    createdBy: action.sessionId,
    byNodeId: actorId,
    starter: false,
    restoredRoute,
  });

  if (s.phase === 'repair') updateSpeed(s, config);

  return result;
}

/** Re-evaluated after the outage and after every accepted Repair link (6.6.1). */
function updateSpeed(s: LineState, config: GameConfig): void {
  const c = connectivity(s);
  if (!fractionAtLeast(c, config.scoring.speedThresholdNum, config.scoring.speedThresholdDen)) return;
  if (s.s2 >= 2) return;
  const elapsed = s.now - s.phaseStartedAt;
  s.s2 = elapsed <= config.scoring.speedHalfPointMs ? 2 : 1;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function addLink(s: LineState, a: string, b: string, createdBy: string, starter: boolean): LineLink {
  const link: LineLink = {
    id: `l${s.linkSeq + 1}`,
    a,
    b,
    cut: false,
    createdBy,
    createdAt: s.now,
    starter,
  };
  s.linkSeq++;
  s.links[link.id] = link;
  return link;
}

function remember(s: LineState, result: ActionResult): void {
  if (s.processed[result.requestId]) return;
  s.processed[result.requestId] = result;
  s.processedOrder.push(result.requestId);
  while (s.processedOrder.length > DEDUPE_LIMIT) {
    const oldest = s.processedOrder.shift();
    if (oldest !== undefined) delete s.processed[oldest];
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventBody = DistributiveOmit<LineEvent, 'seq'>;

function push(events: LineEvent[], s: LineState, body: EventBody): void {
  s.seq++;
  events.push({ ...body, seq: s.seq } as LineEvent);
}

function sanitizeName(name: string, fallback: string): string {
  const trimmed = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  return trimmed.length > 0 ? trimmed : fallback;
}

// ---------------------------------------------------------------------------
// introspection
// ---------------------------------------------------------------------------

/** Canonical state digest used by determinism/replay tests. */
export function stateHash(state: LineState): string {
  return hash32(stableStringify(state)).toString(16).padStart(8, '0');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export { outageCaps };
