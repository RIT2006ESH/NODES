import type { GameConfig } from '@mng/config';
import { isLinkActive, nextTokenInMs } from '@mng/engine';
import type { LineState } from '@mng/engine';
import type {
  LinkRequestView,
  LinkView,
  NodeView,
  PublicConfig,
  ScoreView,
  SnapshotMessage,
  StatsView,
  TeamView,
  YouView,
} from '@mng/protocol';
import { PROTOCOL_VERSION } from '@mng/protocol';

export function toNodes(state: LineState, onlineNodeIds: ReadonlySet<string> = new Set(), areas: ReadonlyMap<string, 'main' | 'surprise'> = new Map()): NodeView[] {
  return state.nodeOrder.map((id) => {
    const n = state.nodes[id]!;
    return {
      id: n.id,
      x: n.x,
      y: n.y,
      name: n.name,
      status: n.status,
      restoredRoutes: n.restoredRoutes,
      joinedAt: n.createdAt,
      presence: onlineNodeIds.has(n.id) ? 'online' : 'offline',
      area: areas.get(n.id) ?? 'main',
    };
  });
}

export function toLinks(state: LineState, areas: ReadonlyMap<string, 'main' | 'surprise'> = new Map()): LinkView[] {
  return Object.values(state.links).map((l) => ({
    id: l.id,
    a: l.a,
    b: l.b,
    active: isLinkActive(state, l) && (areas.get(l.a) ?? 'main') === (areas.get(l.b) ?? 'main'),
    starter: l.starter,
  }));
}

export function toYou(state: LineState, config: GameConfig, nodeId: string | null): YouView {
  const node = nodeId ? state.nodes[nodeId] : undefined;
  if (!node) {
    return { nodeId: null, tokens: 0, nextTokenInMs: 0, restoredRoutes: 0, offline: false };
  }
  return {
    nodeId: node.id,
    tokens: node.tokens,
    nextTokenInMs: nextTokenInMs(node, state.now, config),
    restoredRoutes: node.restoredRoutes,
    offline: node.status === 'disabled',
  };
}

export function toScore(state: LineState): ScoreView | null {
  const r = state.lastRound;
  if (!r) return null;
  return { roundNo: r.roundNo, score: r.score, c: r.c, b: r.b, s2: r.s2, strikeType: r.strike.type };
}

export function toStats(state: LineState): StatsView {
  return {
    nodes: state.nodeOrder.length,
    links: Object.keys(state.links).length,
    rounds: state.roundsSurvived,
  };
}

export function toPublicConfig(config: GameConfig): PublicConfig {
  return {
    phases: config.phases,
    maxTokens: config.links.maxTokens,
    tokenRegenMs: config.links.tokenRegenMs,
    degreeCap: config.links.degreeCap,
    movement: {
      worldRadius: config.movement.worldRadius,
      maxSpeed: config.movement.maxSpeed,
    },
  };
}

export function toSnapshot(
  state: LineState,
  config: GameConfig,
  nodeId: string | null,
  now: number,
  incomingRequests: readonly LinkRequestView[] = [],
  outgoingRequests: readonly LinkRequestView[] = [],
  onlineNodeIds: ReadonlySet<string> = new Set(),
  packetMission: SnapshotMessage['packetMission'] = null,
  teams: readonly TeamView[] = [],
  areas: ReadonlyMap<string, 'main' | 'surprise'> = new Map(),
): SnapshotMessage {
  return {
    type: 'snapshot',
    v: PROTOCOL_VERSION,
    seq: state.seq,
    serverNow: now,
    lineId: state.id,
    phase: state.phase,
    phaseEndsAt: state.phaseEndsAt,
    roundNo: state.roundNo,
    nodes: toNodes(state, onlineNodeIds, areas),
    links: toLinks(state, areas),
    incomingRequests,
    outgoingRequests,
    you: toYou(state, config, nodeId),
    lastScore: toScore(state),
    history: state.history.map((r) => r.score),
    stats: toStats(state),
    config: toPublicConfig(config),
    packetMission,
    teams,
  };
}
