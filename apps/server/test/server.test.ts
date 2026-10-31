/**
 * End-to-end protocol tests: real HTTP server, real WebSocket clients.
 *
 * The connection flow is deliberately consent-first: a request is pending
 * server state, and only the named target can turn it into an edge. These tests
 * use a short-phase config so the suite stays fast, but the rules are the same.
 */
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDefaultConfig } from '@mng/config';
import type { GameConfig } from '@mng/config';
import type { ClientMessage, LinkRequestView, ServerMessage } from '@mng/protocol';
import { createGameServer, type GameServer, type GameServerOptions } from '../src/app.js';

function testConfig(): GameConfig {
  const base = JSON.parse(JSON.stringify(loadDefaultConfig())) as GameConfig;
  return {
    ...base,
    phases: { seeding: 400, build: 60_000, warning: 100, repair: 700, result: 300 },
    links: { ...base.links, requestTtlMs: 5000 },
    scoring: { ...base.scoring, speedHalfPointMs: 250 },
  } as GameConfig;
}

class TestClient {
  private inbox: ServerMessage[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      try {
        this.inbox.push(JSON.parse(String(raw)) as ServerMessage);
      } catch {
        // ignore malformed frames in tests
      }
    });
  }

  static async open(port: number, query = ''): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
    const client = new TestClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return client;
  }

  send(message: ClientMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  sendRaw(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  async wait(predicate: (m: ServerMessage) => boolean, timeoutMs = 4000): Promise<ServerMessage> {
    const started = Date.now();
    let cursor = 0;
    while (Date.now() - started < timeoutMs) {
      for (let i = cursor; i < this.inbox.length; i++) {
        const message = this.inbox[i]!;
        if (predicate(message)) {
          this.inbox.splice(0, i + 1);
          return message;
        }
      }
      cursor = this.inbox.length;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('timed out waiting for message');
  }

  async join(name: string): Promise<{
    token: string;
    nodeId: string;
    links: number;
    nodes: number;
    starters: number;
  }> {
    this.send({ type: 'join', name });
    const welcome = await this.wait((m) => m.type === 'welcome');
    const snapshot = await this.wait((m) => m.type === 'snapshot');
    if (welcome.type !== 'welcome' || snapshot.type !== 'snapshot') throw new Error('bad handshake');
    if (!snapshot.you.nodeId) throw new Error('joined without a node');
    return {
      token: welcome.token,
      nodeId: snapshot.you.nodeId,
      links: snapshot.links.length,
      nodes: snapshot.nodes.length,
      starters: snapshot.links.filter((link) => link.starter).length,
    };
  }

  close(): void {
    this.ws.close();
  }
}

interface Player {
  client: TestClient;
  token: string;
  nodeId: string;
}

let server: GameServer;
let clients: TestClient[] = [];

async function start(overrides: Partial<GameServerOptions> = {}): Promise<void> {
  server = await createGameServer({
    config: testConfig(),
    port: 0,
    adminSecret: 'test-secret',
    distDir: join(tmpdir(), 'mng-no-client'),
    persistPath: join(tmpdir(), `mng-test-${randomUUID()}.json`),
    handleSignals: false,
    seed: 12345,
    ...overrides,
  });
  clients = [];

  // Freeze the line in Build so each test starts from the same place.
  server.line.state.phase = 'build';
  server.line.state.phaseStartedAt = Date.now();
  server.line.state.phaseEndsAt = Date.now() + 60_000;
}

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  for (const client of clients) client.close();
  await server.close();
});

async function open(query = ''): Promise<TestClient> {
  const client = await TestClient.open(server.port, query);
  clients.push(client);
  return client;
}

async function player(name: string): Promise<Player> {
  const client = await open();
  const joined = await client.join(name);
  return { client, token: joined.token, nodeId: joined.nodeId };
}

async function players(count: number): Promise<Player[]> {
  const list: Player[] = [];
  for (let i = 0; i < count; i++) list.push(await player(`Player${i}`));
  return list;
}

function linkCount(): number {
  return Object.keys(server.line.state.links).length;
}

function hasEdge(a: string, b: string): boolean {
  return Object.values(server.line.state.links).some(
    (link) => (link.a === a && link.b === b) || (link.a === b && link.b === a),
  );
}

async function requestPending(from: TestClient, targetNodeId: string): Promise<LinkRequestView> {
  from.send({ type: 'request_link', targetNodeId });
  const result = await from.wait(
    (m) => m.type === 'request_result' && m.status === 'pending',
  );
  if (result.type !== 'request_result') throw new Error('expected request result');
  return result.request;
}

/** Full happy-path setup: A requests B and B explicitly accepts. */
async function connect(from: Player, target: Player): Promise<LinkRequestView> {
  const request = await requestPending(from.client, target.nodeId);
  const incoming = await target.client.wait(
    (m) => m.type === 'link_request' && m.request.requestId === request.requestId,
  );
  if (incoming.type !== 'link_request') throw new Error('target did not receive request');
  target.client.send({ type: 'respond_link', requestId: request.requestId, accept: true });
  await from.client.wait(
    (m) =>
      m.type === 'request_result' &&
      m.request.requestId === request.requestId &&
      m.status === 'accepted',
  );
  await target.client.wait(
    (m) =>
      m.type === 'request_result' &&
      m.request.requestId === request.requestId &&
      m.status === 'accepted',
  );
  return request;
}

describe('handshake', () => {
  it('gives a spectator a read-only snapshot', async () => {
    const client = await open('?spectate=1');
    const welcome = await client.wait((m) => m.type === 'welcome');
    expect(welcome.type === 'welcome' && welcome.spectator).toBe(true);
    const snapshot = await client.wait((m) => m.type === 'snapshot');
    expect(snapshot.type === 'snapshot' && snapshot.you.nodeId).toBe(null);
    if (snapshot.type !== 'snapshot') throw new Error('expected snapshot');
    expect(snapshot.incomingRequests).toEqual([]);
    expect(snapshot.outgoingRequests).toEqual([]);
  });

  it('gives a joining player a session token, a node and three link tokens', async () => {
    const client = await open();
    const { token, nodeId } = await client.join('Asha');
    expect(token.length).toBeGreaterThan(10);
    expect(nodeId).toMatch(/^n\d+$/);
    expect(server.line.state.nodes[nodeId]?.tokens).toBe(3);
  });

  it('starts isolated and never auto-connects a newcomer', async () => {
    const linksPerJoin: number[] = [];
    const nodesPerJoin: number[] = [];
    const startersPerJoin: number[] = [];

    for (let i = 0; i < 10; i++) {
      const client = await open();
      const joined = await client.join(`Player ${i}`);
      linksPerJoin.push(joined.links);
      nodesPerJoin.push(joined.nodes);
      startersPerJoin.push(joined.starters);
    }

    expect(linksPerJoin).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(nodesPerJoin).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(startersPerJoin).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(linkCount()).toBe(0);
  });

  it('announces a new node to everyone already connected', async () => {
    const first = await open();
    await first.join('Asha');
    const second = await open();
    await second.join('Ravi');

    const delta = await first.wait(
      (m) => m.type === 'delta' && m.events.some((e) => e.type === 'node.joined' && e.name === 'Ravi'),
    );
    if (delta.type !== 'delta') throw new Error('expected delta');
    const joined = delta.events.find((e) => e.type === 'node.joined');
    expect(joined?.name).toBe('Ravi');
    expect(linkCount()).toBe(0);
  });

  it('resumes a session from its token and keeps the same node', async () => {
    const client = await open();
    const { token, nodeId } = await client.join('Asha');
    client.close();
    await new Promise((r) => setTimeout(r, 50));

    const resumed = await open(`?token=${encodeURIComponent(token)}`);
    await resumed.wait((m) => m.type === 'welcome');
    const snapshot = await resumed.wait((m) => m.type === 'snapshot');
    if (snapshot.type !== 'snapshot') throw new Error('expected snapshot');
    expect(snapshot.you.nodeId).toBe(nodeId);
  });

  it('rejects an unknown token so the client can rejoin', async () => {
    const client = await open('?token=not-a-real-token');
    const error = await client.wait((m) => m.type === 'error');
    expect(error.type === 'error' && error.code).toBe('INVALID_TOKEN');
  });

  it('keeps sessions across a restart when the data directory persists', async () => {
    const persistPath = join(tmpdir(), `mng-restart-${randomUUID()}.json`);
    await server.close();

    await start({ persistPath, seed: 999 });
    const client = await open();
    const { token, nodeId } = await client.join('Asha');
    client.close();
    await server.close();

    await start({ persistPath, seed: 999 });
    const resumed = await open(`?token=${encodeURIComponent(token)}`);
    await resumed.wait((m) => m.type === 'welcome');
    const snapshot = await resumed.wait((m) => m.type === 'snapshot');
    if (snapshot.type !== 'snapshot') throw new Error('expected snapshot');
    expect(snapshot.you.nodeId).toBe(nodeId);
  });

  it('persists qualified team identity and Surprise Zone area across restart', async () => {
    const persistPath = join(tmpdir(), `mng-team-restart-${randomUUID()}.json`);
    await server.close();
    await start({ persistPath, seed: 999 });
    const group = await players(3);
    await connect(group[0]!, group[1]!);
    await connect(group[1]!, group[2]!);
    server.line.state.phase = 'repair';
    server.line.state.phaseStartedAt = Date.now() - 1000;
    server.line.state.phaseEndsAt = Date.now() - 1;
    group[0]!.client.send({ type: 'resync' });
    const entered = await group[0]!.client.wait((m) => m.type === 'snapshot' && m.teams.some((team) => team.qualification === 'entered'));
    if (entered.type !== 'snapshot') throw new Error('expected entered team');
    const team = entered.teams.find((entry) => entry.qualification === 'entered');
    if (!team) throw new Error('missing entered team');
    const tokens = group.map((player) => player.token);
    await server.close();
    await start({ persistPath, seed: 999 });
    const resumed = await open(`?token=${encodeURIComponent(tokens[0]!)}`);
    const restored = await resumed.wait((m) => m.type === 'snapshot');
    if (restored.type !== 'snapshot') throw new Error('expected restored snapshot');
    const restoredTeam = restored.teams.find((entry) => entry.teamId === team.teamId);
    expect(restoredTeam).toMatchObject({ teamId: team.teamId, area: 'surprise', qualification: 'entered', name: team.name });
    expect(restoredTeam?.memberNodeIds).toEqual(expect.arrayContaining(group.map((player) => player.nodeId)));
    expect(restored.nodes.find((node) => node.id === group[0]!.nodeId)?.area).toBe('surprise');
    expect(restored.teams.filter((entry) => entry.area === 'surprise')).toHaveLength(1);

    // Recovery must be idempotent: resyncing and reconnecting another member
    // reuses the restored team and cannot qualify it a second time.
    resumed.send({ type: 'resync' });
    const repeated = await resumed.wait((message) => message.type === 'snapshot');
    if (repeated.type !== 'snapshot') throw new Error('expected repeated snapshot');
    expect(repeated.teams.filter((entry) => entry.area === 'surprise')).toHaveLength(1);
    const secondResumed = await open(`?token=${encodeURIComponent(tokens[1]!)}`);
    const secondSnapshot = await secondResumed.wait((message) => message.type === 'snapshot');
    if (secondSnapshot.type !== 'snapshot') throw new Error('expected second restored snapshot');
    expect(secondSnapshot.teams.filter((entry) => entry.teamId === team.teamId)).toHaveLength(1);
    expect(secondSnapshot.teams.find((entry) => entry.teamId === team.teamId)?.qualification).toBe('entered');
  });
});

describe('connection requests', () => {
  it('lets A see B while remaining unconnected', async () => {
    const a = await player('Asha');
    const b = await player('Ravi');

    a.client.send({ type: 'resync' });
    const snapshot = await a.client.wait((m) => m.type === 'snapshot');
    if (snapshot.type !== 'snapshot') throw new Error('expected snapshot');
    expect(snapshot.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([a.nodeId, b.nodeId]),
    );
    expect(snapshot.links).toEqual([]);
    expect(hasEdge(a.nodeId, b.nodeId)).toBe(false);
  });

  it('creates a pending request but never an edge', async () => {
    const a = await player('Asha');
    const b = await player('Ravi');

    const request = await requestPending(a.client, b.nodeId);
    const incoming = await b.client.wait(
      (m) => m.type === 'link_request' && m.request.requestId === request.requestId,
    );
    if (incoming.type !== 'link_request') throw new Error('target did not receive request');

    expect(request.fromNodeId).toBe(a.nodeId);
    expect(request.toNodeId).toBe(b.nodeId);
    expect(request.toName).toBe('Ravi');
    expect(linkCount()).toBe(0);
    expect(hasEdge(a.nodeId, b.nodeId)).toBe(false);

    a.client.send({ type: 'resync' });
    const snapshot = await a.client.wait((m) => m.type === 'snapshot');
    if (snapshot.type !== 'snapshot') throw new Error('expected snapshot');
    expect(snapshot.links).toEqual([]);
    expect(snapshot.outgoingRequests.map((r) => r.requestId)).toContain(request.requestId);
    expect(snapshot.incomingRequests).toEqual([]);
  });

  it('accepting creates exactly one edge and broadcasts it to everyone', async () => {
    const [a, b, c] = await players(3);
    if (!a || !b || !c) throw new Error('missing players');

    const request = await requestPending(a.client, b.nodeId);
    const incoming = await b.client.wait(
      (m) => m.type === 'link_request' && m.request.requestId === request.requestId,
    );
    if (incoming.type !== 'link_request') throw new Error('target did not receive request');
    b.client.send({ type: 'respond_link', requestId: request.requestId, accept: true });

    const acceptedA = await a.client.wait(
      (m) => m.type === 'request_result' && m.request.requestId === request.requestId,
    );
    const acceptedB = await b.client.wait(
      (m) => m.type === 'request_result' && m.request.requestId === request.requestId,
    );
    expect(acceptedA.type === 'request_result' && acceptedA.status).toBe('accepted');
    expect(acceptedB.type === 'request_result' && acceptedB.status).toBe('accepted');

    const delta = await c.client.wait(
      (m) => m.type === 'delta' && m.events.some((e) => e.type === 'link.created'),
    );
    if (delta.type !== 'delta') throw new Error('expected delta');
    const created = delta.events.find((e) => e.type === 'link.created');
    expect(created).toMatchObject({ a: a.nodeId, b: b.nodeId });

    expect(linkCount()).toBe(1);
    expect(hasEdge(a.nodeId, b.nodeId)).toBe(true);
  });

  it('derives one team only after acceptance and synchronizes its name', async () => {
    const [a, b] = await players(2);
    if (!a || !b) throw new Error('missing players');
    const pendingRequest = await requestPending(a.client, b.nodeId);
    expect(linkCount()).toBe(0);
    a.client.send({ type: 'resync' });
    const before = await a.client.wait((m) => m.type === 'snapshot');
    if (before.type !== 'snapshot') throw new Error('expected snapshot');
    expect(before.teams).toEqual([]);
    b.client.send({ type: 'respond_link', requestId: pendingRequest.requestId, accept: true });
    await a.client.wait((m) => m.type === 'request_result' && m.status === 'accepted');
    const formed = await a.client.wait((m) => m.type === 'delta' && m.teams.some((team) => team.memberNodeIds.length === 2));
    if (formed.type !== 'delta') throw new Error('expected team delta');
    const team = formed.teams.find((entry) => entry.memberNodeIds.length === 2);
    if (!team) throw new Error('team was not formed');
    expect(team.nameOwnerNodeId).toBe(a.nodeId);
    expect(team.leaderNodeId).toBe(a.nodeId);
    expect(team.roomId).toBe(team.teamId);
    b.client.send({ type: 'team_name', teamId: team.teamId, name: 'Not The Leader' });
    const unauthorized = await b.client.wait((message) => message.type === 'error' && message.code === 'TEAM_NOT_FOUND');
    expect(unauthorized.type).toBe('error');
    a.client.send({ type: 'team_name', teamId: team.teamId, name: 'Monsoon Mesh', description: 'Connected by consent.' });
    const named = await b.client.wait((m) => m.type === 'snapshot' && m.teams.some((entry) => entry.teamId === team.teamId && entry.name === 'Monsoon Mesh'));
    expect(named.type === 'snapshot' && named.teams[0]?.name).toBe('Monsoon Mesh');
    expect(named.type === 'snapshot' && named.teams.find((entry) => entry.teamId === team.teamId)?.description).toBe('Connected by consent.');
  });

  it('removes a timed-out leader, succeeds the earliest active member, and allows former-leader rejoin', async () => {
    await server.close();
    await start({ offlineTimeoutMs: 100 });
    const [leader, successor, member] = await players(3);
    await connect(leader!, successor!);
    await connect(successor!, member!);
    successor!.client.send({ type: 'ping', t: Date.now() });
    member!.client.send({ type: 'ping', t: Date.now() });
    leader!.client.close();

    await new Promise((resolve) => setTimeout(resolve, 60));
    successor!.client.send({ type: 'ping', t: Date.now() });
    member!.client.send({ type: 'ping', t: Date.now() });
    const changed = await successor!.client.wait(
      (message) => message.type === 'mesh_event' && message.event.type === 'mesh.leader_changed',
      1000,
    );
    expect(changed.type === 'mesh_event' && changed.event.type === 'mesh.leader_changed' && changed.event.leaderNodeId).toBe(successor!.nodeId);

    successor!.client.send({ type: 'resync' });
    const afterRemoval = await successor!.client.wait((message) =>
      message.type === 'snapshot' &&
      message.teams.some((team) => team.leaderNodeId === successor!.nodeId && !team.memberNodeIds.includes(leader!.nodeId)),
    );
    if (afterRemoval.type !== 'snapshot') throw new Error('expected post-removal snapshot');
    const team = afterRemoval.teams.find((entry) => entry.leaderNodeId === successor!.nodeId);
    if (!team) throw new Error('missing successor team');
    successor!.client.send({ type: 'team_name', teamId: team.teamId, name: 'Renamed Mesh' });
    const renamed = await member!.client.wait((message) =>
      message.type === 'snapshot' &&
      message.teams.some((entry) => entry.teamId === team.teamId && entry.name === 'Renamed Mesh'),
    );
    expect(renamed.type).toBe('snapshot');

    const resumed = await open(`?token=${encodeURIComponent(leader!.token)}`);
    await resumed.wait((message) => message.type === 'welcome');
    const formerLeaderSnapshot = await resumed.wait((message) => message.type === 'snapshot');
    if (formerLeaderSnapshot.type !== 'snapshot') throw new Error('expected former leader snapshot');
    expect(formerLeaderSnapshot.teams.some((entry) => entry.memberNodeIds.includes(leader!.nodeId))).toBe(false);
  });

  it('does not remove a member that reconnects before the timeout', async () => {
    await server.close();
    await start({ offlineTimeoutMs: 150 });
    const [leader, member] = await players(2);
    await connect(leader!, member!);
    member!.client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const resumed = await open(`?token=${encodeURIComponent(member!.token)}`);
    await resumed.wait((message) => message.type === 'welcome');
    const snapshot = await resumed.wait((message) => message.type === 'snapshot');
    if (snapshot.type !== 'snapshot') throw new Error('expected resumed snapshot');
    expect(snapshot.teams.some((entry) => entry.memberNodeIds.includes(member!.nodeId))).toBe(true);
  });

  it('represents a five-node connected chain as one active team', async () => {
    const group = await players(5);
    for (let i = 0; i < group.length - 1; i++) await connect(group[i]!, group[i + 1]!);
    group[0]!.client.send({ type: 'resync' });
    const expectedMembers = new Set(group.map((player) => player.nodeId));
    const snapshot = await group[0]!.client.wait((m) => m.type === 'snapshot' && m.teams.length === 1 && m.teams[0]!.memberNodeIds.length === expectedMembers.size && m.teams[0]!.memberNodeIds.every((id) => expectedMembers.has(id)));
    if (snapshot.type !== 'snapshot') throw new Error('expected snapshot');
    expect(snapshot.teams).toHaveLength(1);
    expect(snapshot.teams[0]?.memberNodeIds).toEqual(expect.arrayContaining(group.map((player) => player.nodeId)));
  });

  it('qualifies a connected three-member team at Results and enters one authoritative zone', async () => {
    const group = await players(3);
    await connect(group[0]!, group[1]!);
    await connect(group[1]!, group[2]!);
    server.line.state.phase = 'repair';
    server.line.state.phaseStartedAt = Date.now() - 1000;
    server.line.state.phaseEndsAt = Date.now() - 1;

    group[0]!.client.send({ type: 'resync' });
    const snapshot = await group[0]!.client.wait((m) => m.type === 'snapshot' && m.teams.some((team) => team.qualification === 'entered'));
    if (snapshot.type !== 'snapshot') throw new Error('expected Surprise Zone snapshot');
    const entered = snapshot.teams.filter((team) => team.qualification === 'entered');
    expect(entered).toHaveLength(1);
    expect(entered[0]?.area).toBe('surprise');
    expect(entered[0]?.memberNodeIds).toEqual(expect.arrayContaining(group.map((player) => player.nodeId)));

    const resumed = await open(`?token=${encodeURIComponent(group[1]!.token)}`);
    const resumedSnapshot = await resumed.wait((m) => m.type === 'snapshot');
    if (resumedSnapshot.type !== 'snapshot') throw new Error('expected resumed snapshot');
    expect(resumedSnapshot.nodes.find((node) => node.id === group[1]!.nodeId)?.area).toBe('surprise');
  });

  it('broadcasts restored-route contribution and includes it in snapshots', async () => {
    server.line.state.phase = 'repair';
    server.line.state.phaseStartedAt = Date.now();
    server.line.state.phaseEndsAt = Date.now() + 5000;
    const [a, b, c] = await players(3);
    if (!a || !b || !c) throw new Error('missing players');

    await connect(a, b);
    const delta = await c.client.wait(
      (m) => m.type === 'delta' && m.events.some((e) => e.type === 'link.created'),
    );
    if (delta.type !== 'delta') throw new Error('expected delta');
    const created = delta.events.find((e) => e.type === 'link.created');
    expect(created).toMatchObject({
      a: a.nodeId,
      b: b.nodeId,
      byNodeId: a.nodeId,
      restoredRoute: true,
    });

    c.client.send({ type: 'resync' });
    const snapshot = await c.client.wait(
      (m) => m.type === 'snapshot' && m.you.nodeId === c.nodeId,
    );
    if (snapshot.type !== 'snapshot') throw new Error('expected snapshot');
    expect(snapshot.nodes.find((node) => node.id === a.nodeId)?.restoredRoutes).toBe(1);
    expect(snapshot.nodes.find((node) => node.id === b.nodeId)?.restoredRoutes).toBe(0);
  });

  it('keeps multiple incoming requests for one target', async () => {
    const [a, b, c] = await players(3);
    if (!a || !b || !c) throw new Error('missing players');

    const first = await requestPending(a.client, c.nodeId);
    const second = await requestPending(b.client, c.nodeId);
    for (const request of [first, second]) {
      await c.client.wait(
        (m) => m.type === 'link_request' && m.request.requestId === request.requestId,
      );
    }

    c.client.send({ type: 'resync' });
    const snapshot = await c.client.wait(
      (m) => m.type === 'snapshot' && m.you.nodeId === c.nodeId,
    );
    if (snapshot.type !== 'snapshot') throw new Error('missing snapshot');
    const ids = snapshot.incomingRequests.map((request) => request.requestId);
    expect(ids).toContain(first.requestId);
    expect(ids).toContain(second.requestId);
    expect(linkCount()).toBe(0);
  });

  it('replays the accepted outcome for a repeated acceptance without a second edge', async () => {
    const [a, b] = await players(2);
    if (!a || !b) throw new Error('missing players');
    const request = await requestPending(a.client, b.nodeId);
    await b.client.wait(
      (m) => m.type === 'link_request' && m.request.requestId === request.requestId,
    );

    b.client.send({ type: 'respond_link', requestId: request.requestId, accept: true });
    await a.client.wait(
      (m) =>
        m.type === 'request_result' &&
        m.request.requestId === request.requestId &&
        m.status === 'accepted',
    );
    expect(linkCount()).toBe(1);

    b.client.send({ type: 'respond_link', requestId: request.requestId, accept: true });
    const repeated = await b.client.wait(
      (m) => m.type === 'request_result' && m.request.requestId === request.requestId,
    );
    expect(repeated.type === 'request_result' && repeated.status).toBe('accepted');
    expect(linkCount()).toBe(1);
    expect(hasEdge(a.nodeId, b.nodeId)).toBe(true);
  });

  it('declining reports the outcome and creates no edge', async () => {
    const a = await player('Asha');
    const b = await player('Ravi');
    const request = await requestPending(a.client, b.nodeId);
    await b.client.wait(
      (m) => m.type === 'link_request' && m.request.requestId === request.requestId,
    );

    b.client.send({ type: 'respond_link', requestId: request.requestId, accept: false });
    const declinedA = await a.client.wait(
      (m) =>
        m.type === 'request_result' &&
        m.request.requestId === request.requestId &&
        m.status === 'declined',
    );
    const declinedB = await b.client.wait(
      (m) =>
        m.type === 'request_result' &&
        m.request.requestId === request.requestId &&
        m.status === 'declined',
    );
    expect(declinedA.type).toBe('request_result');
    expect(declinedB.type).toBe('request_result');
    expect(linkCount()).toBe(0);
  });

  it('expiry reports on both sides and creates no edge', async () => {
    for (const client of clients) client.close();
    await server.close();
    await start({ requestTtlMs: 200 });

    const a = await player('Asha');
    const b = await player('Ravi');
    const request = await requestPending(a.client, b.nodeId);

    const expiredA = await a.client.wait(
      (m) =>
        m.type === 'request_result' &&
        m.request.requestId === request.requestId &&
        m.status === 'expired',
      3000,
    );
    const expiredB = await b.client.wait(
      (m) =>
        m.type === 'request_result' &&
        m.request.requestId === request.requestId &&
        m.status === 'expired',
      3000,
    );
    expect(expiredA.type).toBe('request_result');
    expect(expiredB.type).toBe('request_result');
    expect(linkCount()).toBe(0);
    expect(hasEdge(a.nodeId, b.nodeId)).toBe(false);
  });

  it('prevents duplicate pending requests and duplicate accepted edges', async () => {
    const [a, b] = await players(2);
    if (!a || !b) throw new Error('missing players');
    const request = await requestPending(a.client, b.nodeId);
    await b.client.wait(
      (m) => m.type === 'link_request' && m.request.requestId === request.requestId,
    );

    a.client.send({ type: 'request_link', targetNodeId: b.nodeId });
    const duplicate = await a.client.wait(
      (m) => m.type === 'request_result' && m.status === 'failed',
    );
    expect(duplicate.type === 'request_result' && duplicate.reason).toBe('REQUEST_PENDING');
    expect(linkCount()).toBe(0);

    b.client.send({ type: 'respond_link', requestId: request.requestId, accept: true });
    await a.client.wait(
      (m) =>
        m.type === 'request_result' &&
        m.request.requestId === request.requestId &&
        m.status === 'accepted',
    );
    expect(linkCount()).toBe(1);

    // Let the per-session request rate window pass so the edge duplicate, not
    // the rate limiter, is the reason under test.
    await new Promise((r) => setTimeout(r, 1100));
    a.client.send({ type: 'request_link', targetNodeId: b.nodeId });
    const already = await a.client.wait(
      (m) => m.type === 'request_result' && m.status === 'failed',
    );
    expect(already.type === 'request_result' && already.reason).toBe('ALREADY_LINKED');
    expect(linkCount()).toBe(1);
  });

  it('rejects an unauthorized responder and leaves the request intact', async () => {
    const [a, b, c] = await players(3);
    if (!a || !b || !c) throw new Error('missing players');
    const request = await requestPending(a.client, b.nodeId);
    await b.client.wait(
      (m) => m.type === 'link_request' && m.request.requestId === request.requestId,
    );

    c.client.send({ type: 'respond_link', requestId: request.requestId, accept: true });
    const rejected = await c.client.wait(
      (m) => m.type === 'request_result' && m.request.requestId === request.requestId,
    );
    expect(rejected.type === 'request_result' && rejected.status).toBe('failed');
    expect(rejected.type === 'request_result' && rejected.reason).toBe('REQUEST_NOT_FOUND');
    expect(linkCount()).toBe(0);

    b.client.send({ type: 'respond_link', requestId: request.requestId, accept: true });
    await a.client.wait(
      (m) =>
        m.type === 'request_result' &&
        m.request.requestId === request.requestId &&
        m.status === 'accepted',
    );
    expect(linkCount()).toBe(1);
  });

  it('does not accept the legacy direct create_link command', async () => {
    const [a, b] = await players(2);
    if (!a || !b) throw new Error('missing players');

    a.client.sendRaw({ type: 'create_link', requestId: 'legacy', a: a.nodeId, b: b.nodeId });
    const error = await a.client.wait((m) => m.type === 'error');
    expect(error.type === 'error' && error.code).toBe('UNKNOWN_TYPE');
    expect(linkCount()).toBe(0);
    expect(hasEdge(a.nodeId, b.nodeId)).toBe(false);
  });

  it('ignores a client-supplied source and links only the requester own node', async () => {
    const [a, b, c] = await players(3);
    if (!a || !b || !c) throw new Error('missing players');

    // A tries to nominate B as the source of a B-C helper link. The protocol
    // has no source field; the server must ignore the extra field and request
    // only A-C.
    a.client.sendRaw({
      type: 'request_link',
      targetNodeId: c.nodeId,
      fromNodeId: b.nodeId,
    });
    const incoming = await c.client.wait(
      (m) => m.type === 'link_request' && m.request.toNodeId === c.nodeId,
    );
    if (incoming.type !== 'link_request') throw new Error('target did not receive request');
    expect(incoming.request.fromNodeId).toBe(a.nodeId);
    expect(incoming.request.toNodeId).toBe(c.nodeId);
    expect(linkCount()).toBe(0);
    expect(hasEdge(b.nodeId, c.nodeId)).toBe(false);
  });

  it('revalidates the request when the target accepts', async () => {
    const a = await player('Asha');
    const b = await player('Ravi');
    const request = await requestPending(a.client, b.nodeId);
    await b.client.wait(
      (m) => m.type === 'link_request' && m.request.requestId === request.requestId,
    );

    server.line.state.phase = 'result';
    server.line.state.phaseEndsAt = Date.now() + 60_000;
    b.client.send({ type: 'respond_link', requestId: request.requestId, accept: true });

    const failed = await a.client.wait(
      (m) => m.type === 'request_result' && m.request.requestId === request.requestId,
    );
    expect(failed.type === 'request_result' && failed.status).toBe('failed');
    expect(failed.type === 'request_result' && failed.reason).toBe('PHASE_LOCKED');
    expect(linkCount()).toBe(0);
  });

  it('rejects requests to self and unknown nodes', async () => {
    const a = await player('Asha');
    a.client.send({ type: 'request_link', targetNodeId: a.nodeId });
    const self = await a.client.wait(
      (m) => m.type === 'request_result' && m.status === 'failed',
    );
    expect(self.type === 'request_result' && self.reason).toBe('SELF_LINK');

    a.client.send({ type: 'request_link', targetNodeId: 'n999' });
    const unknown = await a.client.wait(
      (m) => m.type === 'request_result' && m.status === 'failed',
    );
    expect(unknown.type === 'request_result' && unknown.reason).toBe('STALE_STATE');
    expect(linkCount()).toBe(0);
  });

  it('rate limits a third request within one second', async () => {
    const a = await player('Asha');
    const b = await player('Ravi');
    await requestPending(a.client, b.nodeId);
    a.client.send({ type: 'request_link', targetNodeId: b.nodeId });
    a.client.send({ type: 'request_link', targetNodeId: b.nodeId });
    const limited = await a.client.wait(
      (m) => m.type === 'request_result' && m.status === 'failed' && m.reason === 'RATE_LIMITED',
    );
    expect(limited.type === 'request_result').toBe(true);
    expect(linkCount()).toBe(0);
  });

  it('shows a pending request to the target after reconnect', async () => {
    const a = await player('Asha');
    const b = await player('Ravi');
    const request = await requestPending(a.client, b.nodeId);
    b.client.close();
    await new Promise((r) => setTimeout(r, 50));

    const resumed = await open(`?token=${encodeURIComponent(b.token)}`);
    await resumed.wait((m) => m.type === 'welcome');
    const snapshot = await resumed.wait((m) => m.type === 'snapshot');
    if (snapshot.type !== 'snapshot') throw new Error('expected snapshot');
    expect(snapshot.incomingRequests.map((r) => r.requestId)).toContain(request.requestId);

    resumed.send({ type: 'respond_link', requestId: request.requestId, accept: true });
    await a.client.wait(
      (m) =>
        m.type === 'request_result' &&
        m.request.requestId === request.requestId &&
        m.status === 'accepted',
    );
    expect(linkCount()).toBe(1);
  });
});

describe('movement', () => {
  function statePosition(id: string): { x: number; y: number } {
    const node = server.line.state.nodes[id];
    if (!node) throw new Error(`missing node ${id}`);
    return { x: node.x, y: node.y };
  }

  it('moves a node, tells other clients, and keeps its accepted edge', async () => {
    const a = await player('Asha');
    const b = await player('Ravi');
    await connect(a, b);
    expect(hasEdge(a.nodeId, b.nodeId)).toBe(true);
    const beforeLinks = linkCount();
    const bBefore = statePosition(b.nodeId);
    const roundBefore = server.line.state.roundNo;
    const phaseBefore = server.line.state.phase;

    a.client.send({ type: 'move', x: 240, y: -160 });
    const delta = await b.client.wait(
      (m) => m.type === 'delta' && m.events.some((e) => e.type === 'node.moved' && e.nodeId === a.nodeId),
    );
    if (delta.type !== 'delta') throw new Error('expected delta');
    const moved = delta.events.find((e) => e.type === 'node.moved');
    expect(moved).toMatchObject({ nodeId: a.nodeId, x: 240, y: -160 });
    expect(linkCount()).toBe(beforeLinks);
    expect(hasEdge(a.nodeId, b.nodeId)).toBe(true);
    expect(statePosition(b.nodeId)).toEqual(bBefore);
    expect(server.line.state.roundNo).toBe(roundBefore);
    expect(server.line.state.phase).toBe(phaseBefore);

    // Moving the other endpoint must not break the same edge either.
    b.client.send({ type: 'move', x: -260, y: 190 });
    const back = await a.client.wait(
      (m) => m.type === 'delta' && m.events.some((e) => e.type === 'node.moved' && e.nodeId === b.nodeId),
    );
    if (back.type !== 'delta') throw new Error('expected delta');
    expect(hasEdge(a.nodeId, b.nodeId)).toBe(true);
    expect(linkCount()).toBe(beforeLinks);

    // A resync sees the authoritative positions and the actual edge.
    b.client.send({ type: 'resync' });
    const snapshot = await b.client.wait((m) => m.type === 'snapshot');
    if (snapshot.type !== 'snapshot') throw new Error('expected snapshot');
    const seen = snapshot.nodes.find((node) => node.id === a.nodeId);
    expect(seen).toMatchObject({ x: 240, y: -160 });
    expect(
      snapshot.links.some(
        (link) =>
          (link.a === a.nodeId && link.b === b.nodeId) ||
          (link.a === b.nodeId && link.b === a.nodeId),
      ),
    ).toBe(true);
  });

  it('gives a late joiner the current positions and real edges', async () => {
    const a = await player('Asha');
    const b = await player('Ravi');
    await connect(a, b);
    await new Promise((r) => setTimeout(r, 80));
    a.client.send({ type: 'move', x: 320, y: 180 });
    await new Promise((r) => setTimeout(r, 300));

    const c = await player('Meera');
    c.client.send({ type: 'resync' });
    const snapshot = await c.client.wait((m) => m.type === 'snapshot');
    if (snapshot.type !== 'snapshot') throw new Error('expected snapshot');
    expect(snapshot.nodes.find((node) => node.id === a.nodeId)).toMatchObject({
      x: 320,
      y: 180,
    });
    expect(
      snapshot.links.some(
        (link) =>
          (link.a === a.nodeId && link.b === b.nodeId) ||
          (link.a === b.nodeId && link.b === a.nodeId),
      ),
    ).toBe(true);
  });

  it('does not auto-connect nodes that move onto each other', async () => {
    const [a, b] = await players(2);
    if (!a || !b) throw new Error('missing players');
    expect(linkCount()).toBe(0);

    a.client.send({ type: 'move', x: 75, y: 75 });
    b.client.send({ type: 'move', x: 75, y: 75 });
    await new Promise((r) => setTimeout(r, 300));

    expect(hasEdge(a.nodeId, b.nodeId)).toBe(false);
    expect(linkCount()).toBe(0);
    expect(statePosition(a.nodeId)).toMatchObject({ x: 75, y: 75 });
    expect(statePosition(b.nodeId)).toMatchObject({ x: 75, y: 75 });
  });

  it('clamps speed and world bounds on every position update', async () => {
    const playerA = await player('Asha');
    const start = statePosition(playerA.nodeId);

    playerA.client.send({ type: 'move', x: 1_000_000, y: 1_000_000 });
    playerA.client.send({ type: 'move', x: 1_000_000, y: 1_000_000 });
    await new Promise((r) => setTimeout(r, 300));

    const end = statePosition(playerA.nodeId);
    const total = Math.hypot(end.x - start.x, end.y - start.y);
    expect(total).toBeLessThanOrEqual(server.line.config.movement.maxSpeed * 0.25 + 120);
    expect(Math.hypot(end.x, end.y)).toBeLessThanOrEqual(
      server.line.config.movement.worldRadius + 0.01,
    );
    expect(total).toBeGreaterThan(100);
  });

  it('does not move a disabled node, matching the outage rule', async () => {
    const playerA = await player('Asha');
    const before = statePosition(playerA.nodeId);
    const node = server.line.state.nodes[playerA.nodeId]!;
    node.status = 'disabled';
    playerA.client.send({ type: 'move', x: 300, y: 300 });
    await new Promise((r) => setTimeout(r, 100));
    expect(statePosition(playerA.nodeId)).toEqual(before);
  });

  it('still enforces the degree cap after a node moves', async () => {
    const joined = await players(7);
    const target = joined[0];
    if (!target) throw new Error('missing target');
    const cap = server.line.config.links.degreeCap;

    for (const other of joined.slice(1, 1 + cap)) {
      await connect(other, target);
    }
    expect(linkCount()).toBe(cap);
    expect(
      Object.values(server.line.state.links).filter(
        (link) => link.a === target.nodeId || link.b === target.nodeId,
      ),
    ).toHaveLength(cap);

    const extra = joined[cap + 1];
    if (!extra) throw new Error('missing extra');
    extra.client.send({ type: 'request_link', targetNodeId: target.nodeId });
    const blocked = await extra.client.wait(
      (m) => m.type === 'request_result' && m.status === 'failed',
    );
    expect(blocked.type === 'request_result' && blocked.reason).toBe('NODE_FULL');
    expect(hasEdge(target.nodeId, extra.nodeId)).toBe(false);

    target.client.send({ type: 'move', x: 900, y: -400 });
    await target.client.wait(
      (m) => m.type === 'delta' && m.events.some((e) => e.type === 'node.moved'),
    );
    extra.client.send({ type: 'request_link', targetNodeId: target.nodeId });
    const stillBlocked = await extra.client.wait(
      (m) => m.type === 'request_result' && m.status === 'failed',
    );
    expect(stillBlocked.type === 'request_result' && stillBlocked.reason).toBe('NODE_FULL');
    expect(hasEdge(target.nodeId, extra.nodeId)).toBe(false);
  });
});

describe('admin', () => {
  it('rejects admin calls without the secret', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/admin/pause`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(server.line.state.paused).toBe(false);
  });

  it('pauses with the secret and tells clients', async () => {
    const client = await open();
    await client.join('Asha');

    const res = await fetch(`http://127.0.0.1:${server.port}/admin/pause`, {
      method: 'POST',
      headers: { 'x-admin-secret': 'test-secret' },
    });
    expect(res.status).toBe(200);
    expect(server.line.state.paused).toBe(true);

    const snapshot = await client.wait((m) => m.type === 'snapshot');
    expect(snapshot.type).toBe('snapshot');
  });

  it('resets the line and lets connected players rejoin', async () => {
    const client = await open();
    const first = await client.join('Asha');
    expect(first.nodeId).toMatch(/^n\d+$/);

    const res = await fetch(`http://127.0.0.1:${server.port}/admin/reset?seed=7`, {
      method: 'POST',
      headers: { 'x-admin-secret': 'test-secret' },
    });
    expect(res.status).toBe(200);

    const error = await client.wait((m) => m.type === 'error' && m.code === 'RESET');
    expect(error.type).toBe('error');
    expect(server.line.state.nodeOrder).toHaveLength(0);

    const second = await client.join('Asha');
    expect(server.line.state.nodeOrder).toHaveLength(1);
    expect(server.line.state.nodes[second.nodeId]?.status).toBe('active');
  });

  it('serves health and metrics', async () => {
    const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { ok: boolean; phase: string };
    expect(body.ok).toBe(true);

    const metrics = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    expect((await metrics.json()) as { connectionsNow: number }).toHaveProperty('connectionsNow');
  });
});
