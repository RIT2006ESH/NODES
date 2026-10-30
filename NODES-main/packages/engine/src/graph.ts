/**
 * Graph helpers. Everything here is iterative: PRD 6.6.1 forbids recursive
 * articulation-point search, and a 400-node Line is still deep enough to matter
 * once test graphs run larger.
 */

import type { Fraction, LineLink, LineState } from './types.js';

export function activeNodeIds(state: LineState): string[] {
  return state.nodeOrder.filter((id) => state.nodes[id]?.status === 'active');
}

export function isNodeActive(state: LineState, id: string): boolean {
  return state.nodes[id]?.status === 'active';
}

/**
 * A link is active when it was not cut directly and both endpoints are active.
 * Inactive links still exist and still count toward the degree cap (6.3, 6.4).
 */
export function isLinkActive(state: LineState, link: LineLink): boolean {
  if (link.cut) return false;
  return isNodeActive(state, link.a) && isNodeActive(state, link.b);
}

/** Total degree: every link counts, active or not (6.3). */
export function totalDegree(state: LineState, nodeId: string): number {
  let d = 0;
  for (const id in state.links) {
    const link = state.links[id] as LineLink;
    if (link.a === nodeId || link.b === nodeId) d++;
  }
  return d;
}

/** Active degree: only links that carry connectivity right now. */
export function activeDegree(state: LineState, nodeId: string): number {
  let d = 0;
  for (const id in state.links) {
    const link = state.links[id] as LineLink;
    if ((link.a === nodeId || link.b === nodeId) && isLinkActive(state, link)) d++;
  }
  return d;
}

export function hasLinkBetween(state: LineState, a: string, b: string): boolean {
  for (const id in state.links) {
    const link = state.links[id] as LineLink;
    if ((link.a === a && link.b === b) || (link.a === b && link.b === a)) return true;
  }
  return false;
}

export function activeLinks(state: LineState): LineLink[] {
  return Object.values(state.links).filter((l) => isLinkActive(state, l));
}

export function activeAdjacency(state: LineState): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const id of state.nodeOrder) {
    if (isNodeActive(state, id)) adj.set(id, []);
  }
  for (const link of activeLinks(state)) {
    adj.get(link.a)?.push(link.b);
    adj.get(link.b)?.push(link.a);
  }
  return adj;
}

export interface Component {
  readonly nodes: string[];
  readonly links: number;
  readonly lowestId: string;
}

/** Connected components of the active graph. Isolated active nodes are size-1 components. */
export function components(state: LineState): Component[] {
  const adj = activeAdjacency(state);
  const seen = new Set<string>();
  const out: Component[] = [];

  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const stack = [start];
    const nodes: string[] = [];
    seen.add(start);
    while (stack.length > 0) {
      const v = stack.pop() as string;
      nodes.push(v);
      for (const w of adj.get(v) ?? []) {
        if (!seen.has(w)) {
          seen.add(w);
          stack.push(w);
        }
      }
    }
    nodes.sort();
    // Count active links whose both endpoints landed in this component.
    const inComp = new Set(nodes);
    let links = 0;
    for (const link of activeLinks(state)) {
      if (inComp.has(link.a) && inComp.has(link.b)) links++;
    }
    out.push({ nodes, links, lowestId: nodes[0] as string });
  }
  return out;
}

/**
 * 6.6.1 tie-break: more links wins, then the component containing the lowest node id.
 * Returns null only when there are no active nodes.
 */
export function largestComponent(state: LineState): Component | null {
  const comps = components(state);
  if (comps.length === 0) return null;
  const sorted = comps.slice().sort((x, y) => {
    if (y.nodes.length !== x.nodes.length) return y.nodes.length - x.nodes.length;
    if (y.links !== x.links) return y.links - x.links;
    return x.lowestId < y.lowestId ? -1 : 1;
  });
  return sorted[0] as Component;
}

export function connectivity(state: LineState): Fraction {
  const n = activeNodeIds(state).length;
  if (n === 0) return { num: 0, den: 1 };
  const comp = largestComponent(state);
  return { num: comp ? comp.nodes.length : 0, den: n };
}

/** Exact rational comparison: num/den >= thresholdNum/thresholdDen. */
export function fractionAtLeast(f: Fraction, num: number, den: number): boolean {
  return f.num * den >= num * f.den;
}

/**
 * Articulation points of the induced subgraph on `nodes`, iterative Tarjan.
 * Only nodes inside the given component are considered (6.6.1).
 */
export function articulationPoints(adj: Map<string, string[]>, nodes: readonly string[]): Set<string> {
  const member = new Set(nodes);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const aps = new Set<string>();
  let counter = 0;

  for (const root of nodes) {
    if (index.has(root)) continue;

    index.set(root, counter);
    low.set(root, counter);
    parent.set(root, null);
    counter++;

    const stack: Array<{ v: string; i: number; children: number }> = [{ v: root, i: 0, children: 0 }];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { v: string; i: number; children: number };
      const neighbours = adj.get(frame.v) ?? [];
      if (frame.i < neighbours.length) {
        const w = neighbours[frame.i] as string;
        frame.i++;
        if (!member.has(w)) continue;
        if (!index.has(w)) {
          parent.set(w, frame.v);
          frame.children++;
          index.set(w, counter);
          low.set(w, counter);
          counter++;
          stack.push({ v: w, i: 0, children: 0 });
        } else if (w !== parent.get(frame.v)) {
          low.set(frame.v, Math.min(low.get(frame.v) as number, index.get(w) as number));
        }
        continue;
      }

      stack.pop();
      const p = parent.get(frame.v) ?? null;
      if (p === null) {
        if (frame.children > 1) aps.add(frame.v);
      } else {
        low.set(p, Math.min(low.get(p) as number, low.get(frame.v) as number));
        if (parent.get(p) !== null && (low.get(frame.v) as number) >= (index.get(p) as number)) {
          aps.add(p);
        }
      }
    }
  }

  return aps;
}

/** Are a and b in the same active component? Used for restored routes (6.6.1). */
export function inSameComponent(state: LineState, a: string, b: string): boolean {
  if (a === b) return true;
  const adj = activeAdjacency(state);
  if (!adj.has(a) || !adj.has(b)) return false;
  const seen = new Set<string>([a]);
  const stack = [a];
  while (stack.length > 0) {
    const v = stack.pop() as string;
    if (v === b) return true;
    for (const w of adj.get(v) ?? []) {
      if (!seen.has(w)) {
        seen.add(w);
        stack.push(w);
      }
    }
  }
  return false;
}
