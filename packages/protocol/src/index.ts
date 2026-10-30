/**
 * Wire-level vocabulary shared by the engine, the server and the client.
 *
 * Rejection codes are a closed set defined by PRD FR-32. They are part of the
 * protocol, not UI copy: the client maps a code to wording from the language
 * files. The English map below is the canonical reference used by tests.
 *
 * Protocol v2 replaces the old fire-and-forget `create_link` command with a
 * server-owned request/accept flow. A link can only be created when the target
 * player explicitly accepts; pending requests are never represented as links.
 */

export const PROTOCOL_VERSION = 2 as const;

export const REJECTION_CODES = [
  'NODE_FULL',
  'NO_TOKENS',
  'NODE_OFFLINE',
  'ALREADY_LINKED',
  'SELF_LINK',
  'PHASE_LOCKED',
  'RATE_LIMITED',
  'LINE_PAUSED',
  'STALE_STATE',
  'SERVER_ERROR',
  'REQUEST_PENDING',
  'REQUEST_NOT_FOUND',
] as const;

export type ReasonCode = (typeof REJECTION_CODES)[number];

/** FR-32 canonical English wording. `{N}` is substituted at render time. */
export const REJECTION_COPY: Record<ReasonCode, string> = {
  NODE_FULL: 'Full, 5 of 5 links',
  NO_TOKENS: 'Out of link tokens, next in {N} s',
  NODE_OFFLINE: 'Offline until results',
  ALREADY_LINKED: 'Already linked',
  SELF_LINK: 'Pick a different node',
  PHASE_LOCKED: 'Round results, linking resumes in {N} s',
  RATE_LIMITED: 'Slow down a little',
  LINE_PAUSED: 'Paused by the organizers',
  STALE_STATE: 'That just changed, try again',
  SERVER_ERROR: 'Could not confirm, try again',
  REQUEST_PENDING: 'Connection request already pending',
  REQUEST_NOT_FOUND: 'That request is no longer available',
};

export type ActionResult =
  | { requestId: string; ok: true; linkId: string; restoredRoute: boolean }
  | { requestId: string; ok: false; reason: ReasonCode; retryAfterMs?: number };

export type Phase = 'seeding' | 'build' | 'warning' | 'repair' | 'result';

/** Phases in which link creation is accepted (PRD 6.4 + 6.6.1). */
export const LINK_ALLOWED_PHASES: readonly Phase[] = ['seeding', 'build', 'warning', 'repair'];

export function isLinkAllowed(phase: Phase): boolean {
  return LINK_ALLOWED_PHASES.includes(phase);
}

// ---------------------------------------------------------------------------
// V1 wire messages
// ---------------------------------------------------------------------------

export interface Ratio {
  readonly num: number;
  readonly den: number;
}

export interface NodeView {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly name: string;
  readonly status: 'active' | 'disabled';
  /**
   * PRD 6.6.1 pride metric: Repair-phase accepted links that merged two
   * disconnected components. Exposed so every client can derive the same
   * contribution leaderboard; it is not part of the team round score.
   */
  readonly restoredRoutes: number;
  /** Server-authoritative session metadata for the player info card. */
  readonly joinedAt?: number;
  readonly presence?: 'online' | 'offline' | 'unknown';
  readonly area?: 'main' | 'surprise';
}

export interface LinkView {
  readonly id: string;
  readonly a: string;
  readonly b: string;
  /** False when cut directly or when an endpoint is disabled. */
  readonly active: boolean;
  /**
   * True only for legacy starter edges already persisted before the consent
   * flow. New joins never create an edge, so new links are always false.
   */
  readonly starter: boolean;
}

export interface YouView {
  readonly nodeId: string | null;
  readonly tokens: number;
  readonly nextTokenInMs: number;
  readonly restoredRoutes: number;
  readonly offline: boolean;
}

export interface ScoreView {
  readonly roundNo: number;
  readonly score: number;
  readonly c: Ratio;
  readonly b: Ratio;
  readonly s2: 0 | 1 | 2;
  readonly strikeType: 'A' | 'B' | 'C';
}

export interface StatsView {
  readonly nodes: number;
  readonly links: number;
  readonly rounds: number;
}

/** Server-derived connected group from active accepted edges. */
export interface TeamView {
  readonly teamId: string;
  readonly name: string | null;
  readonly memberNodeIds: readonly string[];
  readonly createdAt: number;
  readonly area: 'main' | 'surprise';
  readonly qualification: 'ineligible' | 'qualified' | 'entered';
  readonly recoveries: number;
  readonly activeLinks: number;
}

export interface PacketMissionView {
  readonly id: number;
  readonly sourceNodeId: string;
  readonly destinationNodeId: string;
  readonly startedAt: number;
  readonly endsAt: number;
  readonly status: 'blocked' | 'in_transit' | 'delivered' | 'failed';
  /** Only accepted active edges are included. Empty means no route. */
  readonly route: readonly string[];
}

export interface PublicConfig {
  readonly phases: { build: number; warning: number; repair: number; result: number; seeding: number };
  readonly maxTokens: number;
  readonly tokenRegenMs: number;
  readonly degreeCap: number;
  readonly movement: { worldRadius: number; maxSpeed: number };
}

/** A server-owned pending connection request. It is not an edge. */
export interface LinkRequestView {
  readonly requestId: string;
  readonly fromNodeId: string;
  readonly fromName: string;
  readonly toNodeId: string;
  readonly toName: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type LinkRequestStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'failed';

/** Engine events are forwarded as-is; the client switches on `type`. */
export interface WireEvent {
  readonly seq: number;
  readonly type: string;
  readonly at: number;
  readonly [key: string]: unknown;
}

export type ClientMessage =
  | { type: 'join'; name: string }
  | { type: 'team_name'; teamId: string; name: string }
  | { type: 'request_link'; targetNodeId: string }
  | { type: 'respond_link'; requestId: string; accept: boolean }
  | { type: 'move'; x: number; y: number }
  | { type: 'resync' }
  | { type: 'ping'; t: number };

export interface SnapshotMessage {
  readonly type: 'snapshot';
  readonly v: number;
  readonly seq: number;
  readonly serverNow: number;
  readonly lineId: string;
  readonly phase: Phase;
  readonly phaseEndsAt: number;
  readonly roundNo: number;
  readonly nodes: readonly NodeView[];
  readonly links: readonly LinkView[];
  /** Pending requests addressed to this player. Never active edges. */
  readonly incomingRequests: readonly LinkRequestView[];
  /** Pending requests sent by this player. Never active edges. */
  readonly outgoingRequests: readonly LinkRequestView[];
  readonly you: YouView;
  readonly lastScore: ScoreView | null;
  readonly history: readonly number[];
  readonly stats: StatsView;
  readonly config: PublicConfig;
  readonly packetMission?: PacketMissionView | null;
  readonly teams: readonly TeamView[];
}

export interface DeltaMessage {
  readonly type: 'delta';
  readonly v: number;
  readonly seq: number;
  readonly serverNow: number;
  readonly phase: Phase;
  readonly phaseEndsAt: number;
  readonly roundNo: number;
  readonly events: readonly WireEvent[];
  readonly you: YouView;
  readonly lastScore: ScoreView | null;
  readonly stats: StatsView;
  readonly packetMission?: PacketMissionView | null;
  readonly teams: readonly TeamView[];
}

export interface WelcomeMessage {
  readonly type: 'welcome';
  readonly v: number;
  readonly token: string;
  readonly lineId: string;
  readonly spectator: boolean;
}

export type ActionResultMessage = ActionResult & { readonly type: 'action_result' };

/** Delivered to a target when a connection request arrives. */
export interface LinkRequestMessage {
  readonly type: 'link_request';
  readonly request: LinkRequestView;
}

/** Delivered to both parties whenever a request changes state. */
export interface LinkRequestResultMessage {
  readonly type: 'request_result';
  readonly request: LinkRequestView;
  readonly status: LinkRequestStatus;
  readonly reason?: ReasonCode;
  readonly retryAfterMs?: number;
  readonly linkId?: string;
}

export interface ErrorMessage {
  readonly type: 'error';
  readonly code: string;
  readonly message?: string;
}

export interface PongMessage {
  readonly type: 'pong';
  readonly t: number;
  readonly serverNow: number;
}

export type ServerMessage =
  | WelcomeMessage
  | SnapshotMessage
  | DeltaMessage
  | ActionResultMessage
  | LinkRequestMessage
  | LinkRequestResultMessage
  | ErrorMessage
  | PongMessage;
