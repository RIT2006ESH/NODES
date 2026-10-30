/**
 * Scoring internals (PRD 6.6.1): exact arithmetic, articulation points, tie-breaks.
 */

import { describe, expect, it } from 'vitest';
import { loadDefaultConfig } from '@mng/config';
import { articulationPoints, largestComponent, roundScore } from '@mng/engine';
import type { LineState } from '@mng/engine';
import { addLinks, addNodes, emptyLine } from '@mng/testing';

const config = loadDefaultConfig();

describe('roundScore (exact arithmetic, half-up once)', () => {
  it('scores a single connected node as 60', () => {
    expect(
      roundScore({ activeCount: 1, componentSize: 1, articulationPoints: 0, s2: 0, config }).score,
    ).toBe(60);
  });

  it('scores an isolated node out of two as 30', () => {
    expect(
      roundScore({ activeCount: 2, componentSize: 1, articulationPoints: 0, s2: 0, config }).score,
    ).toBe(30);
  });

  it('sets B to 0 when the largest component has fewer than three nodes', () => {
    const breakdown = roundScore({
      activeCount: 4,
      componentSize: 2,
      articulationPoints: 0,
      s2: 0,
      config,
    });
    expect(breakdown.b).toEqual({ num: 0, den: 1 });
    expect(breakdown.score).toBe(30);
  });

  it("rounds 92.5 up to 93 and never uses banker's rounding", () => {
    const breakdown = roundScore({
      activeCount: 4,
      componentSize: 4,
      articulationPoints: 1,
      s2: 2,
      config,
    });
    expect(breakdown.c).toEqual({ num: 1, den: 1 });
    expect(breakdown.b).toEqual({ num: 3, den: 4 });
    expect(breakdown.score).toBe(93);
  });

  it('scores a triangle with immediate reconnection as 100', () => {
    expect(
      roundScore({ activeCount: 3, componentSize: 3, articulationPoints: 0, s2: 2, config }).score,
    ).toBe(100);
  });

  it('cannot exceed 100 or go below 0 for any legal input', () => {
    for (let N = 1; N <= 40; N++) {
      for (let n = 1; n <= N; n++) {
        for (let ap = 0; ap <= n; ap++) {
          for (const s2 of [0, 1, 2] as const) {
            const score = roundScore({ activeCount: N, componentSize: n, articulationPoints: ap, s2, config })
              .score;
            expect(score).toBeGreaterThanOrEqual(0);
            expect(score).toBeLessThanOrEqual(100);
          }
        }
      }
    }
  });

  it('rejects N = 0 (void rounds are not scored)', () => {
    expect(() =>
      roundScore({ activeCount: 0, componentSize: 0, articulationPoints: 0, s2: 0, config }),
    ).toThrow(/void/i);
  });
});

describe('articulation points (iterative, 6.6.1)', () => {
  it('finds every articulation point in a path of 5', () => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const adj = new Map<string, string[]>([
      ['A', ['B']],
      ['B', ['A', 'C']],
      ['C', ['B', 'D']],
      ['D', ['C', 'E']],
      ['E', ['D']],
    ]);
    expect([...articulationPoints(adj, ids)].sort()).toEqual(['B', 'C', 'D']);
  });

  it('finds none in a ring', () => {
    const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
    const adj = new Map<string, string[]>();
    for (const [i, id] of ids.entries()) {
      adj.set(id, [ids[(i + ids.length - 1) % ids.length] as string, ids[(i + 1) % ids.length] as string]);
    }
    expect(articulationPoints(adj, ids).size).toBe(0);
  });

  it('does not overflow the stack on a very deep graph', () => {
    const n = 5000;
    const ids = Array.from({ length: n }, (_, i) => `n${i}`);
    const adj = new Map<string, string[]>();
    for (let i = 0; i < n; i++) {
      const neighbours: string[] = [];
      if (i > 0) neighbours.push(`n${i - 1}`);
      if (i < n - 1) neighbours.push(`n${i + 1}`);
      adj.set(`n${i}`, neighbours);
    }
    expect(articulationPoints(adj, ids).size).toBe(n - 2);
  });
});

describe('largest component tie-break (6.6.1)', () => {
  it('prefers more links, then the lowest node id', () => {
    // Path A-B-C (size 3, 2 links) vs triangle D-E-F (size 3, 3 links).
    let s: LineState = addNodes(
      emptyLine(config),
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }, { id: 'F' }],
      config,
    );
    s = addLinks(s, [
      ['A', 'B'],
      ['B', 'C'],
      ['D', 'E'],
      ['E', 'F'],
      ['F', 'D'],
    ]);

    const largest = largestComponent(s);
    expect(largest?.nodes).toEqual(['D', 'E', 'F']);
    expect(largest?.links).toBe(3);
  });

  it('falls back to the lowest node id when size and links tie', () => {
    let s: LineState = addNodes(
      emptyLine(config),
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
      config,
    );
    s = addLinks(s, [
      ['A', 'B'],
      ['C', 'D'],
    ]);
    expect(largestComponent(s)?.lowestId).toBe('A');
  });
});
