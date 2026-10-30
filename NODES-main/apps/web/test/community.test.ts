import { describe, expect, it } from 'vitest';
import type { LinkRequestView, LinkView, NodeView } from '@mng/protocol';
import {
  buildLeaderboard,
  searchPlayers,
  type PlayerEntry,
} from '../src/community';

function node(
  id: string,
  name: string,
  restoredRoutes = 0,
  status: NodeView['status'] = 'active',
): NodeView {
  return { id, x: 0, y: 0, name, status, restoredRoutes };
}

function link(
  id: string,
  a: string,
  b: string,
  active = true,
  starter = false,
): LinkView {
  return { id, a, b, active, starter };
}

function request(
  requestId: string,
  fromNodeId: string,
  toNodeId: string,
): LinkRequestView {
  return {
    requestId,
    fromNodeId,
    fromName: fromNodeId,
    toNodeId,
    toName: toNodeId,
    createdAt: 1,
    expiresAt: 2,
  };
}

function rank(
  entries: readonly PlayerEntry[],
  nodeId: string,
): number | undefined {
  return entries.find((entry) => entry.nodeId === nodeId)?.rank;
}

describe('player search', () => {
  const entries = buildLeaderboard(
    [
      node('n1', 'Ravi', 2),
      node('n2', 'Ritesh', 1),
      node('n3', 'Mumbai Wanderer', 0),
      node('n4', 'Asha', 0),
    ],
    [],
    [],
    [],
    'n1',
  );

  it('matches exact and partial usernames case-insensitively', () => {
    expect(searchPlayers(entries, 'ravi').map((entry) => entry.nodeId)).toEqual(['n1']);
    expect(searchPlayers(entries, 'RIT').map((entry) => entry.nodeId)).toEqual(['n2']);
    expect(searchPlayers(entries, 'wander').map((entry) => entry.nodeId)).toEqual(['n3']);
  });

  it('matches node IDs and returns no results for an unknown query', () => {
    expect(searchPlayers(entries, 'n4').map((entry) => entry.nodeId)).toEqual(['n4']);
    expect(searchPlayers(entries, 'nobody')).toEqual([]);
    expect(searchPlayers(entries, '   ')).toEqual([]);
  });

  it('sorts exact names before prefix and substring matches', () => {
    const withPrefix = buildLeaderboard(
      [node('n1', 'Ravi'), node('n2', 'Ravi Kumar'), node('n3', 'Pravi')],
      [],
      [],
      [],
      null,
    );
    expect(searchPlayers(withPrefix, 'ravi').map((entry) => entry.name)).toEqual([
      'Ravi',
      'Ravi Kumar',
      'Pravi',
    ]);
  });
});

describe('contribution leaderboard', () => {
  const nodes = [
    node('n1', 'Ravi', 1),
    node('n2', 'Ritesh', 3),
    node('n3', 'Asha', 1),
    node('n4', 'Bina', 1, 'disabled'),
  ];
  const links = [
    link('l1', 'n1', 'n2'),
    link('l2', 'n1', 'n3'),
    link('l3', 'n2', 'n3', false),
    link('l4', 'n2', 'n4', true, true),
  ];

  it('ranks by restored routes, then active accepted links', () => {
    const entries = buildLeaderboard(nodes, links, [], [], 'n1');
    expect(entries.map((entry) => entry.name)).toEqual([
      'Ritesh',
      'Ravi',
      'Asha',
      'Bina',
    ]);
    expect(rank(entries, 'n2')).toBe(1);
    expect(rank(entries, 'n1')).toBe(2);
    expect(rank(entries, 'n3')).toBe(3);
    expect(rank(entries, 'n4')).toBe(4);
  });

  it('counts only active, non-starter accepted links', () => {
    const entries = buildLeaderboard(nodes, links, [], [], 'n1');
    const byId = new Map(entries.map((entry) => [entry.nodeId, entry]));
    expect(byId.get('n1')?.activeLinks).toBe(2);
    expect(byId.get('n2')?.activeLinks).toBe(1);
    expect(byId.get('n3')?.activeLinks).toBe(1);
    expect(byId.get('n4')?.activeLinks).toBe(0);
  });

  it('breaks complete ties deterministically by name and node ID', () => {
    const tied = [node('n2', 'Same'), node('n1', 'same'), node('n3', 'Same')];
    const first = buildLeaderboard(tied, [], [], [], null);
    const second = buildLeaderboard([...tied].reverse(), [], [], [], null);
    expect(first.map((entry) => entry.nodeId)).toEqual(['n1', 'n2', 'n3']);
    expect(first.map((entry) => entry.nodeId)).toEqual(
      second.map((entry) => entry.nodeId),
    );
  });

  it('marks the current player and derives searchable relationship state', () => {
    const entries = buildLeaderboard(
      [node('n1', 'Ravi'), node('n2', 'Ritesh'), node('n3', 'Asha')],
      [link('l1', 'n1', 'n2')],
      [request('r1', 'n3', 'n1')],
      [request('r2', 'n1', 'n3')],
      'n1',
    );
    const byId = new Map(entries.map((entry) => [entry.nodeId, entry]));
    expect(byId.get('n1')?.isMe).toBe(true);
    expect(byId.get('n1')?.relation).toBe('self');
    expect(byId.get('n2')?.relation).toBe('connected');
    // Outgoing is shown before an incoming request from the same player.
    expect(byId.get('n3')?.relation).toBe('pending');
  });

  it('keeps the relationship connected when an outage cuts the edge', () => {
    const entries = buildLeaderboard(
      [node('n1', 'Ravi'), node('n2', 'Ritesh')],
      [link('l1', 'n1', 'n2', false)],
      [],
      [],
      'n1',
    );
    const byId = new Map(entries.map((entry) => [entry.nodeId, entry]));
    expect(byId.get('n2')?.relation).toBe('connected');
    expect(byId.get('n2')?.activeLinks).toBe(0);
  });

  it('does not count a link while an endpoint is disabled', () => {
    const entries = buildLeaderboard(
      [node('n1', 'Ravi'), node('n2', 'Ritesh', 0, 'disabled')],
      [link('l1', 'n1', 'n2', true)],
      [],
      [],
      'n1',
    );
    const byId = new Map(entries.map((entry) => [entry.nodeId, entry]));
    expect(byId.get('n1')?.activeLinks).toBe(0);
    expect(byId.get('n2')?.activeLinks).toBe(0);
    expect(byId.get('n2')?.relation).toBe('connected');
  });
});
