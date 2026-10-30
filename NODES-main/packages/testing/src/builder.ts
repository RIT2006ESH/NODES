/**
 * State builders for tests and the bot simulator.
 *
 * These bypass `join` on purpose: golden cases describe a graph, not a join
 * sequence. Anything that the golden case actually tests (outage, scoring,
 * phases, tokens, links) still goes through the real engine.
 */

import type { GameConfig } from '@mng/config';
import { createLine, positionFor } from '@mng/engine';
import type { LineState, RoundResult, StrikeType } from '@mng/engine';

export interface NodeSpec {
  readonly id: string;
  readonly sessionId?: string;
}

export function emptyLine(
  config: GameConfig,
  opts: { id?: string; seed?: number; now?: number } = {},
): LineState {
  return createLine(opts.id ?? 'line-1', opts.seed ?? 0x5eed, config, opts.now ?? 0);
}

export function addNodes(state: LineState, specs: readonly NodeSpec[], config: GameConfig): LineState {
  const s = structuredClone(state);
  for (const spec of specs) {
    if (s.nodes[spec.id]) throw new Error(`duplicate node id ${spec.id}`);
    const index = s.nodeOrder.length;
    const pos = positionFor(index, config);
    s.nodes[spec.id] = {
      id: spec.id,
      sessionId: spec.sessionId ?? `s-${spec.id}`,
      name: spec.id,
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
    s.nodeOrder.push(spec.id);
  }
  return s;
}

export function addLinks(
  state: LineState,
  pairs: ReadonlyArray<readonly [string, string]>,
  opts: { starter?: boolean; cut?: boolean; createdBy?: string } = {},
): LineState {
  const s = structuredClone(state);
  for (const [a, b] of pairs) {
    if (!s.nodes[a] || !s.nodes[b]) throw new Error(`link endpoint missing: ${a}-${b}`);
    s.linkSeq++;
    s.links[`l${s.linkSeq}`] = {
      id: `l${s.linkSeq}`,
      a,
      b,
      cut: opts.cut ?? false,
      createdBy: opts.createdBy ?? 'test',
      createdAt: s.now,
      starter: opts.starter ?? false,
    };
  }
  return s;
}

export function disableNodes(state: LineState, ids: readonly string[]): LineState {
  const s = structuredClone(state);
  for (const id of ids) {
    const n = s.nodes[id];
    if (!n) throw new Error(`missing node ${id}`);
    n.status = 'disabled';
  }
  return s;
}

/** Puts the state in an arbitrary phase without running the phase machine. */
export function setPhase(
  state: LineState,
  phase: LineState['phase'],
  startedAt: number,
  endsAt: number,
  opts: { roundNo?: number; s2?: 0 | 1 | 2; roundStartedAt?: number } = {},
): LineState {
  const s = structuredClone(state);
  s.phase = phase;
  s.phaseStartedAt = startedAt;
  s.phaseEndsAt = endsAt;
  s.now = startedAt;
  if (opts.roundNo !== undefined) s.roundNo = opts.roundNo;
  if (opts.s2 !== undefined) s.s2 = opts.s2;
  if (opts.roundStartedAt !== undefined) s.roundStartedAt = opts.roundStartedAt;
  return s;
}

/** Puts the state at the start of a Repair phase with a synthetic strike record. */export function atRepair(
  state: LineState,
  opts: {
    startedAt: number;
    endsAt: number;
    s2?: 0 | 1 | 2;
    roundNo?: number;
    roundStartedAt?: number;
    strikeType?: StrikeType;
    strikeNodes?: readonly string[];
    strikeLinks?: readonly string[];
  },
): LineState {
  const s = structuredClone(state);
  s.phase = 'repair';
  s.phaseStartedAt = opts.startedAt;
  s.phaseEndsAt = opts.endsAt;
  s.s2 = opts.s2 ?? 0;
  s.roundNo = opts.roundNo ?? 1;
  s.roundStartedAt = opts.roundStartedAt ?? opts.startedAt - 45_000;
  s.lastStrike = {
    type: opts.strikeType ?? 'A',
    nodes: opts.strikeNodes ?? [],
    links: opts.strikeLinks ?? [],
  };
  s.now = opts.startedAt;
  return s;
}

/** Runs the engine forward to `now` and returns the final round result. */
export function lastRoundOf(state: LineState): RoundResult | null {
  return state.lastRound;
}

/** Convenience: a path graph A-B-C-D-E. */
export function pathOfFive(config: GameConfig): LineState {
  const base = emptyLine(config, { seed: 0xb1 });
  const s = addNodes(base, [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }], config);
  return addLinks(s, [
    ['A', 'B'],
    ['B', 'C'],
    ['C', 'D'],
    ['D', 'E'],
  ]);
}

/** Convenience: a ring A-B-C-D-E-F-A. */
export function ringOfSix(config: GameConfig): LineState {
  const base = emptyLine(config, { seed: 0xb5 });
  const s = addNodes(base, [
    { id: 'A' },
    { id: 'B' },
    { id: 'C' },
    { id: 'D' },
    { id: 'E' },
    { id: 'F' },
  ], config);
  return addLinks(s, [
    ['A', 'B'],
    ['B', 'C'],
    ['C', 'D'],
    ['D', 'E'],
    ['E', 'F'],
    ['F', 'A'],
  ]);
}
