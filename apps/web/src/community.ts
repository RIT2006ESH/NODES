/**
 * Pure player discovery and contribution-ranking helpers.
 *
 * These functions only read authoritative snapshot/delta state. They never
 * create edges, spend tokens, or mutate the game. The primary leaderboard
 * metric is the PRD 6.6.1 `restoredRoutes` pride metric (Repair links that
 * merged components). Active accepted links are the deterministic secondary
 * metric. The shared network round score is deliberately not reused as an
 * individual score.
 */

import type { LinkRequestView, LinkView, NodeView } from '@mng/protocol';

export type PlayerRelation = 'self' | 'connected' | 'pending' | 'incoming' | 'open';

export interface PlayerEntry {
  readonly nodeId: string;
  readonly name: string;
  readonly status: NodeView['status'];
  readonly presence: NodeView['presence'];
  readonly activeLinks: number;
  readonly restoredRoutes: number;
  readonly isMe: boolean;
  readonly relation: PlayerRelation;
  /** Overall rank, 1-based. Stable for the same authoritative state. */
  readonly rank: number;
}

function activeLinkCounts(
  nodes: Iterable<NodeView>,
  links: Iterable<LinkView>,
): Map<string, number> {
  const counts = new Map<string, number>();
  const activeNodes = new Set<string>();
  for (const node of nodes) {
    counts.set(node.id, 0);
    if (node.status === 'active') activeNodes.add(node.id);
  }
  for (const link of links) {
    if (!link.active || link.starter) continue;
    // Mirror server isLinkActive: a link is only contributing while both
    // endpoints are active, even before the next delta arrives.
    if (!activeNodes.has(link.a) || !activeNodes.has(link.b)) continue;
    counts.set(link.a, (counts.get(link.a) ?? 0) + 1);
    counts.set(link.b, (counts.get(link.b) ?? 0) + 1);
  }
  return counts;
}

function compareText(a: string, b: string): number {
  const aa = a.toLowerCase();
  const bb = b.toLowerCase();
  if (aa < bb) return -1;
  if (aa > bb) return 1;
  return 0;
}

function relationFor(
  nodeId: string,
  meId: string | null,
  links: Iterable<LinkView>,
  incoming: Iterable<LinkRequestView>,
  outgoing: Iterable<LinkRequestView>,
): PlayerRelation {
  if (nodeId === meId) return 'self';
  for (const link of links) {
    // Any existing edge blocks a second request, even if an outage has cut it
    // or it is a legacy starter edge. Active contribution is counted separately.
    if (
      (link.a === meId && link.b === nodeId) ||
      (link.b === meId && link.a === nodeId)
    ) {
      return 'connected';
    }
  }
  for (const request of outgoing) {
    if (request.toNodeId === nodeId) return 'pending';
  }
  for (const request of incoming) {
    if (request.fromNodeId === nodeId) return 'incoming';
  }
  return 'open';
}

/**
 * Build the same ranking on every client from the same authoritative graph.
 * Ties break by restored routes, active links, name, then node ID. No random
 * order, clock, or client-only counter is involved.
 */
export function buildLeaderboard(
  nodes: Iterable<NodeView>,
  links: Iterable<LinkView>,
  incoming: Iterable<LinkRequestView>,
  outgoing: Iterable<LinkRequestView>,
  meId: string | null,
): PlayerEntry[] {
  const nodeList = [...nodes];
  const linkList = [...links];
  const counts = activeLinkCounts(nodeList, linkList);
  const entries = nodeList.map((node) => ({
    nodeId: node.id,
    name: node.name,
    status: node.status,
    presence: node.presence,
    activeLinks: counts.get(node.id) ?? 0,
    restoredRoutes: node.restoredRoutes ?? 0,
    isMe: node.id === meId,
    relation: relationFor(
      node.id,
      meId,
      linkList,
      incoming,
      outgoing,
    ),
    rank: 0,
  }));

  entries.sort(
    (a, b) =>
      b.restoredRoutes - a.restoredRoutes ||
      b.activeLinks - a.activeLinks ||
      compareText(a.name, b.name) ||
      compareText(a.nodeId, b.nodeId),
  );
  entries.forEach((entry, index) => {
    (entry as { rank: number }).rank = index + 1;
  });
  return entries;
}

/** Case-insensitive partial match by player name or node ID. */
export function searchPlayers(
  entries: readonly PlayerEntry[],
  query: string,
): PlayerEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  return entries
    .filter(
      (entry) =>
        entry.name.toLowerCase().includes(needle) ||
        entry.nodeId.toLowerCase().includes(needle),
    )
    .sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aMatch = aName === needle ? 0 : aName.startsWith(needle) ? 1 : 2;
      const bMatch = bName === needle ? 0 : bName.startsWith(needle) ? 1 : 2;
      return aMatch - bMatch || a.rank - b.rank;
    });
}

export const RELATION_LABEL: Record<PlayerRelation, string> = {
  self: 'You',
  connected: 'Connected',
  pending: 'Request pending',
  incoming: 'Incoming request',
  open: 'Not connected',
};

export const STATUS_LABEL: Record<NodeView['status'], string> = {
  active: 'Active',
  disabled: 'Offline until results',
};
