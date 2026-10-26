/**
 * Scoring (PRD 6.6 / 6.6.1), implemented exactly.
 *
 * score = wC·(cSize/N) + wB·((n−ap)/n) + wS·(s2/2), rounded once, half-up.
 *
 * With N active nodes, n the largest component's size, ap its articulation
 * points and s2 ∈ {0,1,2} the speed points in halves, the whole expression is
 * evaluated as one rational with denominator 2·N·n:
 *
 *   num = 2·wC·cSize·n + 2·wB·(n−ap)·N + wS·s2·N·n
 *   den = 2·N·n
 *   score = floor((2·num + den) / (2·den))       // exact half-up
 *
 * No floating point, no intermediate rounding. B is 0 when n < 3 (6.6.1), which
 * is handled by dropping the B term rather than by computing 1 − ap/n.
 */

import type { GameConfig } from '@mng/config';
import type { Fraction, LineState, RoundResult, StrikeRecord } from './types.js';
import { activeNodeIds, activeAdjacency, largestComponent, articulationPoints } from './graph.js';

export interface ScoreInput {
  readonly activeCount: number;
  readonly componentSize: number;
  /** Articulation points in the largest component; ignored when componentSize < 3. */
  readonly articulationPoints: number;
  readonly s2: 0 | 1 | 2;
  readonly config: GameConfig;
}

export interface ScoreBreakdown {
  readonly c: Fraction;
  readonly b: Fraction;
  readonly s2: 0 | 1 | 2;
  readonly score: number;
}

export function roundScore(input: ScoreInput): ScoreBreakdown {
  const { activeCount: N, componentSize: n, s2, config } = input;
  if (N <= 0) throw new Error('roundScore requires at least one active node; N=0 rounds are void');
  if (n <= 0) throw new Error('roundScore requires a non-empty largest component');

  const { weightC, weightB, weightS } = config.scoring;
  const ap = n < 3 ? 0 : input.articulationPoints;

  const num =
    2 * weightC * n * n + (n < 3 ? 0 : 2 * weightB * (n - ap) * N) + weightS * s2 * N * n;
  const den = 2 * N * n;
  const score = Math.floor((2 * num + den) / (2 * den));

  return {
    c: reduceFraction(n, N),
    b: n < 3 ? { num: 0, den: 1 } : reduceFraction(n - ap, n),
    s2,
    score,
  };
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x === 0 ? 1 : x;
}

/** Fractions are normalised so equal values compare equal in tests and deltas. */
function reduceFraction(num: number, den: number): Fraction {
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

/**
 * Computes the round result from the live state at the end of Repair.
 * Returns null when N = 0: the round is void (no score, not survived, excluded
 * from the community score).
 */
export function scoreRound(
  state: LineState,
  config: GameConfig,
  strike: StrikeRecord,
  endedAt: number,
  roundStartedAt: number,
): RoundResult | null {
  const active = activeNodeIds(state);
  if (active.length === 0) return null;

  const largest = largestComponent(state);
  if (!largest) return null;

  const adj = activeAdjacency(state);
  const aps = articulationPoints(adj, largest.nodes).size;

  const breakdown = roundScore({
    activeCount: active.length,
    componentSize: largest.nodes.length,
    articulationPoints: aps,
    s2: state.s2,
    config,
  });

  return {
    roundNo: state.roundNo,
    strike,
    c: breakdown.c,
    b: breakdown.b,
    s2: breakdown.s2,
    score: breakdown.score,
    startedAt: roundStartedAt,
    endedAt,
  };
}
