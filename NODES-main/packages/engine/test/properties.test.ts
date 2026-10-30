/**
 * Property tests (Section 14): invariants hold under random play, and replay is
 * bit-identical.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadDefaultConfig } from '@mng/config';
import { Rng, activeNodeIds, createLine, reduce, stateHash, totalDegree } from '@mng/engine';
import type { LineState } from '@mng/engine';

const config = loadDefaultConfig();

/** Plays a deterministic random game. Same seed => same actions => same state. */
function play(seed: number, steps = 400): LineState {
  let state = createLine('L-prop', seed, config, 0);
  const rng = new Rng(seed);
  const sessions: string[] = [];
  let t = 0;

  for (let step = 0; step < steps; step++) {
    t += 500;

    if (sessions.length < 15 && step % 2 === 0) {
      const sessionId = `s${sessions.length}`;
      state = reduce(state, { type: 'join', sessionId, name: `b${sessions.length}` }, config, t).state;
      sessions.push(sessionId);
    }

    const active = activeNodeIds(state);
    if (active.length >= 2 && sessions.length > 0) {
      const a = rng.pick(active);
      const b = rng.pick(active);
      if (a !== b) {
        state = reduce(
          state,
          { type: 'create_link', requestId: `q${step}`, sessionId: rng.pick(sessions), a, b },
          config,
          t,
        ).state;
      }
    }

    state = reduce(state, { type: 'tick' }, config, t).state;
  }

  return state;
}

function assertInvariants(s: LineState): void {
  const pairs = new Set<string>();
  for (const id in s.links) {
    const link = s.links[id];
    if (!link) continue;
    expect(s.nodes[link.a], `endpoint ${link.a}`).toBeDefined();
    expect(s.nodes[link.b], `endpoint ${link.b}`).toBeDefined();
    const key = link.a < link.b ? `${link.a}|${link.b}` : `${link.b}|${link.a}`;
    expect(pairs.has(key), `duplicate pair ${key}`).toBe(false);
    pairs.add(key);
  }

  for (const id of s.nodeOrder) {
    const node = s.nodes[id];
    if (!node) continue;
    expect(totalDegree(s, id)).toBeLessThanOrEqual(config.links.degreeCap);
    expect(node.tokens).toBeGreaterThanOrEqual(0);
    expect(node.tokens).toBeLessThanOrEqual(config.links.maxTokens);
  }

  if (s.lastRound) {
    expect(s.lastRound.score).toBeGreaterThanOrEqual(0);
    expect(s.lastRound.score).toBeLessThanOrEqual(100);
    expect(s.lastRound.c.num).toBeLessThanOrEqual(s.lastRound.c.den);
    expect(s.lastRound.s2).toBeGreaterThanOrEqual(0);
    expect(s.lastRound.s2).toBeLessThanOrEqual(2);
  }

  expect(['seeding', 'build', 'warning', 'repair', 'result']).toContain(s.phase);
  expect(s.roundNo).toBeGreaterThanOrEqual(0);
}

describe('engine invariants', () => {
  it('holds for random play (degree cap, no duplicates, token range, score range)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), (seed) => {
        assertInvariants(play(seed));
        return true;
      }),
      { numRuns: 8 },
    );
  });

  it('replays deterministically: same seed and timing produce the same digest', () => {
    expect(stateHash(play(123))).toBe(stateHash(play(123)));
  });

  it('produces different play for different seeds', () => {
    expect(stateHash(play(1))).not.toBe(stateHash(play(2)));
  });
});
