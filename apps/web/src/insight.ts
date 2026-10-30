/**
 * Gameplay insight layer. Everything here is derived from the same public
 * node/link views the renderer already has, so it never invents server state
 * and never changes a rule. It answers the question players could not answer
 * before: "where is my network fragile, and what is my round worth?"
 *
 * The maths mirrors PRD 6.6 (reach C, redundancy B) closely enough for a live
 * preview. The server's round.scored event stays the only authoritative score.
 */

import type { LinkView, NodeView } from '@mng/protocol';

/** Default PRD weights; used only for the preview number, never for scoring. */
const WEIGHT_C = 60;
const WEIGHT_B = 30;

export interface Analysis {
  readonly activeCount: number;
  readonly componentSize: number;
  readonly groups: number;
  readonly largest: ReadonlySet<string>;
  /** Articulation points of the largest component: single points of failure. */
  readonly cutVertices: ReadonlySet<string>;
  /** Highest-degree active nodes (only when degree >= 2): what a Hub strike hunts. */
  readonly hubIds: ReadonlySet<string>;
  /** Share of active nodes in the largest component, 0..1. */
  readonly reach: number;
  /** Share of the largest component that is not a cut vertex, 0..1 (0 below 3 nodes). */
  readonly redundancy: number;
  /** round(60·reach + 30·redundancy); the speed bonus (up to 10) is added by the server. */
  readonly baseScore: number;
}

const EMPTY: Analysis = {
  activeCount: 0,
  componentSize: 0,
  groups: 0,
  largest: new Set(),
  cutVertices: new Set(),
  hubIds: new Set(),
  reach: 0,
  redundancy: 0,
  baseScore: 0,
};

export function analyseNetwork(
  nodes: ReadonlyMap<string, NodeView>,
  links: ReadonlyMap<string, LinkView>,
): Analysis {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes.values()) if (node.status === 'active') adjacency.set(node.id, []);
  if (adjacency.size === 0) return EMPTY;

  for (const link of links.values()) {
    if (!link.active) continue;
    const a = adjacency.get(link.a);
    const b = adjacency.get(link.b);
    if (!a || !b || link.a === link.b) continue;
    a.push(link.b);
    b.push(link.a);
  }

  // Components by BFS; remember the largest (first found wins ties).
  const seen = new Set<string>();
  let largest: string[] = [];
  let groups = 0;
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    groups++;
    const members = [start];
    seen.add(start);
    for (let i = 0; i < members.length; i++) {
      for (const next of adjacency.get(members[i] as string) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        members.push(next);
      }
    }
    if (members.length > largest.length) largest = members;
  }

  const n = largest.length;
  const N = adjacency.size;
  const cut = n >= 3 ? articulationPoints(adjacency, largest) : new Set<string>();

  let maxDegree = 0;
  for (const list of adjacency.values()) if (list.length > maxDegree) maxDegree = list.length;
  const hubIds = new Set<string>();
  if (maxDegree >= 2) for (const [id, list] of adjacency) if (list.length === maxDegree) hubIds.add(id);

  const reach = n / N;
  const redundancy = n >= 3 ? (n - cut.size) / n : 0;
  return {
    activeCount: N,
    componentSize: n,
    groups,
    largest: new Set(largest),
    cutVertices: cut,
    hubIds,
    reach,
    redundancy,
    baseScore: Math.round(WEIGHT_C * reach + WEIGHT_B * redundancy),
  };
}

/** Iterative Tarjan: safe for 400-node lines, no recursion depth concerns. */
export function articulationPoints(
  adjacency: ReadonlyMap<string, readonly string[]>,
  component: readonly string[],
): Set<string> {
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const points = new Set<string>();
  let time = 0;

  interface Frame {
    v: string;
    parent: string | null;
    i: number;
    children: number;
  }

  for (const root of component) {
    if (disc.has(root)) continue;
    disc.set(root, ++time);
    low.set(root, time);
    const stack: Frame[] = [{ v: root, parent: null, i: 0, children: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as Frame;
      const neighbours = adjacency.get(frame.v) ?? [];
      if (frame.i < neighbours.length) {
        const w = neighbours[frame.i++] as string;
        if (w === frame.parent) continue;
        if (disc.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v) as number, disc.get(w) as number));
        } else {
          disc.set(w, ++time);
          low.set(w, time);
          frame.children++;
          stack.push({ v: w, parent: frame.v, i: 0, children: 0 });
        }
        continue;
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) {
        low.set(parent.v, Math.min(low.get(parent.v) as number, low.get(frame.v) as number));
        if (parent.parent !== null && (low.get(frame.v) as number) >= (disc.get(parent.v) as number)) {
          points.add(parent.v);
        }
      } else if (frame.children > 1) {
        points.add(frame.v);
      }
    }
  }
  return points;
}

// ---------------------------------------------------------------------------
// Grades
// ---------------------------------------------------------------------------

export type Grade = 'S' | 'A' | 'B' | 'C' | 'D';

export function gradeFor(score: number): Grade {
  if (score >= 90) return 'S';
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}

export const STRIKE_NAME = { A: 'Hub strike', B: 'Cable cut', C: 'Regional blackout' } as const;

// ---------------------------------------------------------------------------
// Progression (per-device, localStorage). Cosmetic only: no gameplay effect.
// ---------------------------------------------------------------------------

export interface Progress {
  xp: number;
  links: number;
  restores: number;
  rounds: number;
  best: number;
  /** Consecutive scored rounds at 70+. */
  streak: number;
  hits: number;
  resilient: number;
  unlocked: string[];
}

export function freshProgress(): Progress {
  return { xp: 0, links: 0, restores: 0, rounds: 0, best: 0, streak: 0, hits: 0, resilient: 0, unlocked: [] };
}

export interface AchievementDef {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly test: (p: Progress) => boolean;
}

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { id: 'handshake', title: 'First Handshake', text: 'Form your first link.', test: (p) => p.links >= 1 },
  { id: 'social', title: 'Social Router', text: 'Form 5 links.', test: (p) => p.links >= 5 },
  { id: 'bridge', title: 'Bridge Builder', text: 'Merge two split groups during Repair.', test: (p) => p.restores >= 1 },
  { id: 'mender', title: 'Mesh Mender', text: 'Restore 5 routes.', test: (p) => p.restores >= 5 },
  { id: 'underfire', title: 'Under Fire', text: 'Have your node knocked out by an outage.', test: (p) => p.hits >= 1 },
  { id: 'stayedup', title: 'Stayed Up', text: 'Finish a round with a score of 80+.', test: (p) => p.best >= 80 },
  { id: 'fivenines', title: 'Five Nines', text: 'Finish a round with a score of 95+.', test: (p) => p.best >= 95 },
  { id: 'streak', title: 'Hot Streak', text: 'Three rounds in a row at 70+.', test: (p) => p.streak >= 3 },
  { id: 'nospof', title: 'No Single Point of Failure', text: 'Enter a warning with 6+ nodes and zero weak points.', test: (p) => p.resilient >= 1 },
];

const RANKS = [
  { at: 0, title: 'Packet' },
  { at: 40, title: 'Relay' },
  { at: 120, title: 'Router' },
  { at: 260, title: 'Gateway' },
  { at: 480, title: 'Backbone' },
  { at: 800, title: 'Architect' },
] as const;

export interface Rank {
  readonly level: number;
  readonly title: string;
  /** 0..1 progress to the next rank (1 at the top rank). */
  readonly fraction: number;
  readonly toNext: number | null;
}

export function rankFor(xp: number): Rank {
  let index = 0;
  for (let i = 0; i < RANKS.length; i++) if (xp >= (RANKS[i] as { at: number }).at) index = i;
  const current = RANKS[index] as { at: number; title: string };
  const next = RANKS[index + 1];
  if (!next) return { level: index + 1, title: current.title, fraction: 1, toNext: null };
  return {
    level: index + 1,
    title: current.title,
    fraction: (xp - current.at) / (next.at - current.at),
    toNext: next.at - xp,
  };
}

export type ProgressEvent =
  | { kind: 'link'; restored: boolean }
  | { kind: 'round'; score: number }
  | { kind: 'hit' }
  | { kind: 'resilient' };

export interface ProgressResult {
  readonly progress: Progress;
  readonly gained: number;
  readonly unlocked: readonly AchievementDef[];
}

/** Pure: returns a new Progress and any achievements this event unlocked. */
export function applyProgress(previous: Progress, event: ProgressEvent): ProgressResult {
  const p: Progress = { ...previous, unlocked: [...previous.unlocked] };
  let gained = 0;
  switch (event.kind) {
    case 'link':
      p.links++;
      gained += 10;
      if (event.restored) {
        p.restores++;
        gained += 15;
      }
      break;
    case 'round':
      p.rounds++;
      p.best = Math.max(p.best, event.score);
      p.streak = event.score >= 70 ? p.streak + 1 : 0;
      gained += Math.max(0, Math.min(20, Math.round(event.score / 5)));
      if (event.score >= 70 && p.streak > 0 && p.streak % 3 === 0) gained += 10;
      break;
    case 'hit':
      p.hits++;
      gained += 5;
      break;
    case 'resilient':
      p.resilient++;
      gained += 30;
      break;
  }
  p.xp += gained;

  const unlocked: AchievementDef[] = [];
  for (const def of ACHIEVEMENTS) {
    if (p.unlocked.includes(def.id) || !def.test(p)) continue;
    p.unlocked.push(def.id);
    p.xp += 20;
    gained += 20;
    unlocked.push(def);
  }
  return { progress: p, gained, unlocked };
}

const STORAGE_KEY = 'mng.progress.v1';

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshProgress();
    const parsed = JSON.parse(raw) as Partial<Progress>;
    const base = freshProgress();
    const num = (value: unknown, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
    return {
      xp: num(parsed.xp, base.xp),
      links: num(parsed.links, base.links),
      restores: num(parsed.restores, base.restores),
      rounds: num(parsed.rounds, base.rounds),
      best: num(parsed.best, base.best),
      streak: num(parsed.streak, base.streak),
      hits: num(parsed.hits, base.hits),
      resilient: num(parsed.resilient, base.resilient),
      unlocked: Array.isArray(parsed.unlocked)
        ? parsed.unlocked.filter((id): id is string => typeof id === 'string')
        : [],
    };
  } catch {
    return freshProgress();
  }
}

export function saveProgress(progress: Progress): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Private mode or quota: progression is a nicety, never a requirement.
  }
}
