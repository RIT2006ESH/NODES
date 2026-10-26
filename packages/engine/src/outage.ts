/**
 * Outage targeting and caps (PRD 6.5 + 6.6.1).
 *
 * C-01 ruling: the caps are absolute. `difficulty` never adds strike targets;
 * config validation rejects any attempt to raise the node bonus.
 *
 * Each strike is resolved at the Outage instant from the live state; the strike
 * *type* is locked earlier, at the Warning transition (A-01).
 */

import type { GameConfig } from '@mng/config';
import type { LineNode, LineState, StrikeRecord, StrikeType } from './types.js';
import { activeDegree, activeNodeIds } from './graph.js';
import { distance, type Point } from './layout.js';
import { PURPOSE, stream } from './rng.js';

export interface OutageCaps {
  readonly nodeCap: number;
  readonly linkCap: number;
}

/**
 * 6.6.1: node cap = floor(N/5). Link cap = floor(activeLinks/5), minimum 1 once
 * the Line has at least 5 active nodes. The link cap applies only to links cut
 * directly by a Cable cut.
 */
export function outageCaps(activeNodes: number, liveLinks: number, config: GameConfig): OutageCaps {
  const nodeCap = Math.floor(activeNodes / 5);
  const linkCap = activeNodes >= config.line.seedThreshold ? Math.max(1, Math.floor(liveLinks / 5)) : 0;
  return { nodeCap, linkCap };
}

function nodePoint(n: LineNode): Point {
  return { x: n.x, y: n.y };
}

/**
 * Applies a strike to `state` in place. The caller owns the copy.
 *
 * Strike A: the active node with the most active links (ties by round seed).
 * Strike B: cut min(2, linkCap, links) active links, plus 1 low-degree active
 *           node from the lowest quarter by active degree.
 * Strike C: up to min(5, nodeCap) spatially adjacent active nodes.
 *
 * The low-degree group for strike B is computed before the cable cuts, so the
 * node choice cannot depend on which links happened to be cut.
 */
export function applyStrike(state: LineState, type: StrikeType, config: GameConfig): StrikeRecord {
  const activeIds = activeNodeIds(state);
  const caps = outageCaps(activeIds.length, activeLinksCount(state), config);

  switch (type) {
    case 'A':
      return strikeHub(state, config);
    case 'B':
      return strikeCableCut(state, config, caps);
    case 'C':
      return strikeRegional(state, config, caps);
  }
}

function activeLinksCount(state: LineState): number {
  let n = 0;
  for (const id in state.links) {
    const l = state.links[id]!;
    if (!l.cut && state.nodes[l.a]?.status === 'active' && state.nodes[l.b]?.status === 'active') n++;
  }
  return n;
}

function strikeHub(state: LineState, config: GameConfig): StrikeRecord {
  const ids = activeNodeIds(state);
  if (ids.length === 0) return { type: 'A', nodes: [], links: [] };

  let best = -1;
  const tied: string[] = [];
  for (const id of ids) {
    const d = activeDegree(state, id);
    if (d > best) {
      best = d;
      tied.length = 0;
      tied.push(id);
    } else if (d === best) {
      tied.push(id);
    }
  }

  // Ties broken by the round seed (6.5). Sorted first so the seed maps to a stable choice.
  tied.sort();
  const rng = stream(state.seed, state.roundNo, PURPOSE.strikeTie);
  const target = tied.length === 1 ? (tied[0] as string) : rng.pick(tied);

  const node = state.nodes[target] as LineNode;
  node.status = 'disabled';
  return { type: 'A', nodes: [target], links: [] };
}

function strikeCableCut(state: LineState, config: GameConfig, caps: OutageCaps): StrikeRecord {
  const ids = activeNodeIds(state);
  if (ids.length === 0) return { type: 'B', nodes: [], links: [] };

  // Low-degree group: lowest quarter by active degree, at least one node (6.5).
  const byDegree = ids
    .map((id) => ({ id, d: activeDegree(state, id) }))
    .sort((x, y) => (x.d !== y.d ? x.d - y.d : x.id < y.id ? -1 : 1));
  const quarter = Math.max(1, Math.floor(ids.length / 4));
  const lowGroup = byDegree.slice(0, quarter).map((x) => x.id);

  const rng = stream(state.seed, state.roundNo, PURPOSE.strikeLowDegree);
  const nodeTarget = rng.pick(lowGroup);

  const live = Object.values(state.links).filter(
    (l) => !l.cut && state.nodes[l.a]?.status === 'active' && state.nodes[l.b]?.status === 'active',
  );
  const linkIds = live.map((l) => l.id).sort();
  const cutCount = Math.min(config.outage.cableCutMaxLinks, caps.linkCap, linkIds.length);
  const cut = stream(state.seed, state.roundNo, PURPOSE.strikeTarget).shuffled(linkIds).slice(0, cutCount);

  for (const id of cut) {
    const link = state.links[id];
    if (link) link.cut = true;
  }

  const node = state.nodes[nodeTarget] as LineNode;
  node.status = 'disabled';

  return { type: 'B', nodes: [nodeTarget], links: cut };
}

function strikeRegional(state: LineState, config: GameConfig, caps: OutageCaps): StrikeRecord {
  const ids = activeNodeIds(state);
  if (ids.length === 0) return { type: 'C', nodes: [], links: [] };

  const cap = Math.min(config.outage.regionalMaxNodes, caps.nodeCap);
  if (cap <= 0) return { type: 'C', nodes: [], links: [] };

  const sorted = ids.slice().sort();
  const centreId = stream(state.seed, state.roundNo, PURPOSE.strikeCenter).pick(sorted);
  const centre = state.nodes[centreId] as LineNode;

  const others = sorted
    .filter((id) => id !== centreId)
    .map((id) => ({ id, d: distance(nodePoint(centre), nodePoint(state.nodes[id] as LineNode)) }))
    .sort((x, y) => (x.d !== y.d ? x.d - y.d : x.id < y.id ? -1 : 1));

  const chosen = [centreId, ...others.slice(0, cap - 1).map((o) => o.id)];
  for (const id of chosen) (state.nodes[id] as LineNode).status = 'disabled';

  return { type: 'C', nodes: chosen, links: [] };
}
