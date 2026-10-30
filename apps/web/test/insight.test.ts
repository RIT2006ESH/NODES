/**
 * The weak-point radar must never lie to players. Its cut vertices are checked
 * against two independent oracles: brute-force vertex removal, and the
 * engine's own articulationPoints (the function that scores PRD 6.6 B).
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { articulationPoints as enginePoints } from '@mng/engine';
import type { LinkView, NodeView } from '@mng/protocol';
import {
  ACHIEVEMENTS,
  analyseNetwork,
  applyProgress,
  freshProgress,
  gradeFor,
  rankFor,
} from '../src/insight';

function build(
  count: number,
  edges: ReadonlyArray<readonly [number, number]>,
  disabled: readonly number[] = [],
): { nodes: Map<string, NodeView>; links: Map<string, LinkView> } {
  const nodes = new Map<string, NodeView>();
  for (let i = 0; i < count; i++) {
    nodes.set(`n${i}`, {
      id: `n${i}`,
      x: i,
      y: 0,
      name: `n${i}`,
      status: disabled.includes(i) ? 'disabled' : 'active',
      restoredRoutes: 0,
    });
  }
  const links = new Map<string, LinkView>();
  const seen = new Set<string>();
  edges.forEach(([a, b], i) => {
    if (a === b || a >= count || b >= count) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    const live = !disabled.includes(a) && !disabled.includes(b);
    links.set(`l${i}`, { id: `l${i}`, a: `n${a}`, b: `n${b}`, active: live, starter: false });
  });
  return { nodes, links };
}

function componentCount(ids: string[], adj: Map<string, string[]>, skip: string | null): number {
  const seen = new Set<string>();
  let groups = 0;
  for (const id of ids) {
    if (id === skip || seen.has(id)) continue;
    groups++;
    const queue = [id];
    seen.add(id);
    while (queue.length) {
      for (const next of adj.get(queue.shift() as string) ?? []) {
        if (next === skip || seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return groups;
}

describe('analyseNetwork', () => {
  it('finds nothing in an empty network', () => {
    const a = analyseNetwork(new Map(), new Map());
    expect(a.activeCount).toBe(0);
    expect(a.cutVertices.size).toBe(0);
    expect(a.baseScore).toBe(0);
  });

  it('flags the middle of a path and nothing in a ring', () => {
    const path = build(5, [[0, 1], [1, 2], [2, 3], [3, 4]]);
    expect([...analyseNetwork(path.nodes, path.links).cutVertices].sort()).toEqual(['n1', 'n2', 'n3']);

    const ring = build(5, [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0]]);
    const a = analyseNetwork(ring.nodes, ring.links);
    expect(a.cutVertices.size).toBe(0);
    expect(a.redundancy).toBe(1);
    expect(a.reach).toBe(1);
    expect(a.baseScore).toBe(90);
  });

  it('flags the hub of a star and reports it as the strike target', () => {
    const star = build(6, [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5]]);
    const a = analyseNetwork(star.nodes, star.links);
    expect([...a.cutVertices]).toEqual(['n0']);
    expect([...a.hubIds]).toEqual(['n0']);
  });

  it('treats disabled nodes and dead links as gone', () => {
    // Ring of 5 with n2 knocked out: a path n3-n4-n0-n1 remains.
    const ring = build(5, [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0]], [2]);
    const a = analyseNetwork(ring.nodes, ring.links);
    expect(a.activeCount).toBe(4);
    expect(a.componentSize).toBe(4);
    expect([...a.cutVertices].sort()).toEqual(['n0', 'n4']);
  });

  it('reports split groups and scores reach against all active nodes', () => {
    const split = build(6, [[0, 1], [1, 2], [3, 4]]);
    const a = analyseNetwork(split.nodes, split.links);
    expect(a.groups).toBe(3);
    expect(a.componentSize).toBe(3);
    expect(a.reach).toBeCloseTo(0.5);
  });

  it('gives redundancy 0 below three nodes (PRD 6.6.1)', () => {
    const pair = build(2, [[0, 1]]);
    expect(analyseNetwork(pair.nodes, pair.links).redundancy).toBe(0);
  });

  it('matches brute-force vertex removal and the engine on random graphs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 14 }),
        fc.array(fc.tuple(fc.nat(13), fc.nat(13)), { maxLength: 30 }),
        (count, edges) => {
          const { nodes, links } = build(count, edges);
          const a = analyseNetwork(nodes, links);

          const adj = new Map<string, string[]>();
          for (const id of nodes.keys()) adj.set(id, []);
          for (const l of links.values()) {
            adj.get(l.a)?.push(l.b);
            adj.get(l.b)?.push(l.a);
          }
          const comp = [...a.largest];
          const base = componentCount(comp, adj, null);
          expect(base).toBe(1);

          // Brute force: v is a cut vertex iff removing it splits its component.
          const expected = new Set<string>();
          if (comp.length >= 3) {
            for (const v of comp) if (componentCount(comp, adj, v) > 1) expected.add(v);
          }
          expect(new Set(a.cutVertices)).toEqual(expected);

          if (comp.length >= 3) {
            expect(new Set(a.cutVertices)).toEqual(enginePoints(adj, comp));
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('handles a 400-node chain without recursion limits', () => {
    const edges: Array<[number, number]> = [];
    for (let i = 0; i < 399; i++) edges.push([i, i + 1]);
    const chain = build(400, edges);
    const a = analyseNetwork(chain.nodes, chain.links);
    expect(a.cutVertices.size).toBe(398);
  });
});

describe('gradeFor', () => {
  it('maps score bands', () => {
    expect([100, 90, 89, 80, 79, 65, 64, 50, 49, 0].map(gradeFor)).toEqual([
      'S', 'S', 'A', 'A', 'B', 'B', 'C', 'C', 'D', 'D',
    ]);
  });
});

describe('rankFor', () => {
  it('climbs through ranks and tops out', () => {
    expect(rankFor(0).title).toBe('Packet');
    expect(rankFor(40).title).toBe('Relay');
    expect(rankFor(799).title).toBe('Backbone');
    const top = rankFor(5000);
    expect(top.title).toBe('Architect');
    expect(top.toNext).toBeNull();
    expect(top.fraction).toBe(1);
  });

  it('reports progress toward the next rank', () => {
    const r = rankFor(80);
    expect(r.title).toBe('Relay');
    expect(r.toNext).toBe(40);
    expect(r.fraction).toBeCloseTo(0.5);
  });
});

describe('applyProgress', () => {
  it('awards xp and unlocks achievements exactly once', () => {
    let p = freshProgress();
    const first = applyProgress(p, { kind: 'link', restored: false });
    p = first.progress;
    expect(first.unlocked.map((a) => a.id)).toEqual(['handshake']);
    expect(p.xp).toBe(10 + 20);

    const second = applyProgress(p, { kind: 'link', restored: false });
    expect(second.unlocked).toEqual([]);
    expect(second.gained).toBe(10);
  });

  it('does not mutate the previous progress', () => {
    const p = freshProgress();
    applyProgress(p, { kind: 'link', restored: true });
    expect(p).toEqual(freshProgress());
  });

  it('tracks a 70+ streak and resets it on a bad round', () => {
    let p = freshProgress();
    for (const score of [75, 80, 90]) p = applyProgress(p, { kind: 'round', score }).progress;
    expect(p.streak).toBe(3);
    expect(p.unlocked).toContain('streak');
    expect(p.unlocked).toContain('stayedup');
    p = applyProgress(p, { kind: 'round', score: 40 }).progress;
    expect(p.streak).toBe(0);
    expect(p.best).toBe(90);
  });

  it('can unlock every achievement', () => {
    let p = freshProgress();
    for (let i = 0; i < 5; i++) p = applyProgress(p, { kind: 'link', restored: true }).progress;
    p = applyProgress(p, { kind: 'hit' }).progress;
    p = applyProgress(p, { kind: 'resilient' }).progress;
    for (const score of [96, 96, 96]) p = applyProgress(p, { kind: 'round', score }).progress;
    expect(p.unlocked.sort()).toEqual(ACHIEVEMENTS.map((a) => a.id).sort());
  });
});
