/**
 * Pure data model for one Line. No behaviour, no I/O, no timers.
 * Field semantics follow PRD Section 10 and 6.4.
 */

import type { Phase, ReasonCode, ActionResult } from '@mng/protocol';

export type { Phase, ReasonCode, ActionResult };

export type NodeStatus = 'active' | 'disabled';
export type StrikeType = 'A' | 'B' | 'C';

export interface LineNode {
  readonly id: string;
  readonly sessionId: string;
  readonly name: string;
  /** Server-authoritative position: initial layout, then validated player movement. */
  x: number;
  y: number;
  status: NodeStatus;
  readonly createdAt: number;
  lastSeenAt: number;
  /** Link tokens, capped at config.links.maxTokens. */
  tokens: number;
  lastRegenAt: number;
  /**
   * Legacy persisted-state field from the removed automatic starter link.
   * New joins always set it to false; retained so old snapshots still load.
   */
  pendingStarter: boolean;
  /** Pride metric (6.6): links this player created during Repair that merged components. */
  restoredRoutes: number;
}

export interface LineLink {
  readonly id: string;
  readonly a: string;
  readonly b: string;
  /** Directly severed by a Cable cut (strike B). Recovers at Result. */
  cut: boolean;
  readonly createdBy: string;
  readonly createdAt: number;
  /**
   * Legacy marker for starter links persisted before the consent flow. New
   * links are always false; the field is kept for saved-state compatibility.
   */
  readonly starter: boolean;
}

export interface Fraction {
  readonly num: number;
  readonly den: number;
}

export interface StrikeRecord {
  readonly type: StrikeType;
  readonly nodes: readonly string[];
  readonly links: readonly string[];
}

export interface RoundResult {
  readonly roundNo: number;
  readonly strike: StrikeRecord;
  readonly c: Fraction;
  readonly b: Fraction;
  readonly s2: 0 | 1 | 2;
  readonly score: number;
  readonly startedAt: number;
  readonly endedAt: number;
}

export interface LineState {
  readonly id: string;
  /** Base seed for every deterministic stream (D-06). */
  readonly seed: number;
  now: number;
  phase: Phase;
  phaseStartedAt: number;
  phaseEndsAt: number;
  /** Full rounds only; seeding cycles never increment this. */
  roundNo: number;
  /** Server time when the current full round's Build phase began. */
  roundStartedAt: number;
  roundsSurvived: number;
  seedingCycles: number;
  /** Display-only difficulty counter. Never changes strike counts (C-01 ruling). */
  difficulty: number;
  pendingStrikeType: StrikeType | null;
  lastStrike: StrikeRecord | null;
  cAtOutage: Fraction | null;
  /** Speed points as halves: 0, 1 (0.5) or 2 (1.0). */
  s2: 0 | 1 | 2;
  nodes: Record<string, LineNode>;
  links: Record<string, LineLink>;
  /** Insertion order; keeps layout and scheduling deterministic. */
  nodeOrder: string[];
  nodeSeq: number;
  linkSeq: number;
  /** Last 10 round results, oldest first (6.6 trend window). */
  history: RoundResult[];
  lastRound: RoundResult | null;
  /** request_id → result, for idempotent retries (Section 11). */
  processed: Record<string, ActionResult>;
  processedOrder: string[];
  paused: boolean;
  /** Monotonic event sequence for deltas and resume (Section 11). */
  seq: number;
}

export type LineEvent =
  | { seq: number; type: 'line.phase'; at: number; phase: Phase; endsAt: number; roundNo: number }
  | {
      seq: number;
      type: 'node.joined';
      at: number;
      nodeId: string;
      sessionId: string;
      name: string;
      x: number;
      y: number;
      tokens: number;
      starterLinkId: string | null;
      starterDeferred: boolean;
    }
  | { seq: number; type: 'starter.link'; at: number; nodeId: string; linkId: string; targetId: string }
  | { seq: number; type: 'node.moved'; at: number; nodeId: string; x: number; y: number }
  | { seq: number; type: 'starter.unavailable'; at: number; nodeId: string; reason: 'NO_ELIGIBLE_TARGET' }
  | {
      seq: number;
      type: 'link.created';
      at: number;
      linkId: string;
      a: string;
      b: string;
      /** Session that requested/accepted the link. */
      createdBy: string;
      /** Node owned by that session; lets every client update the leaderboard. */
      byNodeId: string;
      starter: boolean;
      restoredRoute: boolean;
    }
  | { seq: number; type: 'link.rejected'; at: number; requestId: string; reason: ReasonCode; a: string; b: string }
  | { seq: number; type: 'outage.applied'; at: number; strike: StrikeRecord; cAfterOutage: Fraction }
  | { seq: number; type: 'round.scored'; at: number; result: RoundResult }
  | { seq: number; type: 'round.void'; at: number; roundNo: number; reason: 'NO_ACTIVE_NODES' }
  | { seq: number; type: 'round.recovered'; at: number; nodes: number; links: number }
  | { seq: number; type: 'tokens.granted'; at: number; nodeId: string; tokens: number }
  | { seq: number; type: 'prng.debug'; at: number; stream: string; value: number };

export type NodeMovedEvent = Extract<LineEvent, { type: 'node.moved' }>;

export type Action =
  | { readonly type: 'join'; readonly sessionId: string; readonly name: string; readonly nodeId?: string }
  | {
      readonly type: 'create_link';
      readonly requestId: string;
      readonly sessionId: string;
      readonly a: string;
      readonly b: string;
    }
  | { readonly type: 'tick' };

export type JoinResult =
  | {
      readonly kind: 'join';
      readonly ok: true;
      readonly nodeId: string;
      readonly starterLinkId: string | null;
      readonly starterDeferred: boolean;
      readonly tokens: number;
    }
  | { readonly kind: 'join'; readonly ok: false; readonly reason: ReasonCode };

export interface ReduceOutcome {
  readonly state: LineState;
  readonly events: LineEvent[];
  readonly result?: JoinResult | ActionResult;
}
