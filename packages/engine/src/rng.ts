/**
 * Deterministic randomness (D-06).
 *
 * Rules:
 *  - No Math.random() anywhere in the engine.
 *  - Every decision draws from a stream derived from (line seed, round number,
 *    purpose). Purpose tags keep decisions independent: a starter-link tie-break
 *    cannot perturb the next strike.
 *  - Values are integers; modulo bias is removed by rejection sampling.
 */

/** FNV-1a 32-bit over the UTF-8 bytes of the joined parts. */
export function hash32(...parts: Array<number | string>): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      // Fold the high byte for non-ASCII code points so distinct text stays distinct.
      h ^= (text.charCodeAt(i) >>> 8) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x1f; // separator
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: small, fast, seed-stable across platforms (32-bit integer ops only). */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform integer in [0, maxExclusive). Rejection sampling, no modulo bias. */
  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`nextInt requires a positive integer, got ${maxExclusive}`);
    }
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    for (;;) {
      const r = this.nextUint32();
      if (r < limit) return r % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick() called on an empty list');
    return items[this.nextInt(items.length)] as T;
  }

  /** Fisher-Yates on a copy. */
  shuffled<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }
}

export const PURPOSE = {
  strikeType: 'strike.type',
  strikeTarget: 'strike.target',
  strikeTie: 'strike.tie',
  strikeCenter: 'strike.center',
  strikeLowDegree: 'strike.lowdegree',
  starterTie: 'starter.tie',
} as const;

/** A fresh, independent stream for one decision. */
export function stream(lineSeed: number, roundNo: number, purpose: string): Rng {
  return new Rng(hash32(lineSeed, roundNo, purpose));
}
