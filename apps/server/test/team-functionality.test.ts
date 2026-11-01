import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { rmSync } from 'node:fs';
import { createGameServer } from '../src/app.js';
import type { ServerMessage, SnapshotMessage, DeltaMessage } from '@mng/protocol';

class TestClient {
  private inbox: ServerMessage[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      this.inbox.push(JSON.parse(String(raw)));
    });
  }

  static async open(port: number, query = ''): Promise<TestClient> {
    const ws = new WebSocket(`ws://localhost:${port}/ws${query}`);
    const client = new TestClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    return client;
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  async wait(predicate: (message: ServerMessage) => boolean, timeoutMs = 4000): Promise<ServerMessage> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const index = this.inbox.findIndex(predicate);
      if (index !== -1) {
        return this.inbox.splice(index, 1)[0]!;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Timeout waiting for message. Inbox has: ${JSON.stringify(this.inbox.map((m) => m.type))}`);
  }

  async join(name: string): Promise<{ token: string; nodeId: string }> {
    this.send({ type: 'join', name });
    const welcome = await this.wait((m) => m.type === 'welcome') as Extract<ServerMessage, { type: 'welcome' }>;
    const snapshot = await this.wait((m) => m.type === 'snapshot') as SnapshotMessage;
    return { token: welcome.token, nodeId: snapshot.you.nodeId! };
  }

  close(): void {
    this.ws.close();
  }
}

describe('NODES Team Functionality', () => {
  let server: Awaited<ReturnType<typeof createGameServer>>;
  const persistPath = 'data/test-team-line.json';
  const sessionsPath = 'data/test-team-line.sessions.json';
  const teamStatePath = 'data/test-team-line.teams.json';

  beforeEach(async () => {
    rmSync(persistPath, { force: true });
    rmSync(sessionsPath, { force: true });
    rmSync(teamStatePath, { force: true });
    server = await createGameServer({
      port: 0,
      persistPath,
      offlineTimeoutMs: 60_000,
    });
  });

  afterEach(async () => {
    await server.close();
    rmSync(persistPath, { force: true });
    rmSync(sessionsPath, { force: true });
    rmSync(teamStatePath, { force: true });
  });

  it('allows the elected leader to name the team and broadcasts immediately to all members', async () => {
    const a = await TestClient.open(server.port);
    const b = await TestClient.open(server.port);
    const pA = await a.join('LeaderNode');
    const pB = await b.join('MemberNode');

    // Establish link: a requests b, b accepts
    a.send({ type: 'request_link', targetNodeId: pB.nodeId });
    const req = await a.wait((m) => m.type === 'request_result' && m.status === 'pending');
    expect(req.type).toBe('request_result');

    b.send({ type: 'respond_link', requestId: (req as any).request.requestId, accept: true });
    await a.wait((m) => m.type === 'request_result' && m.status === 'accepted');

    const formed = await a.wait((m) => m.type === 'snapshot' && m.teams?.some((t) => t.memberNodeIds.length === 2)) as SnapshotMessage;
    const team = formed.teams.find((t) => t.memberNodeIds.includes(pA.nodeId))!;
    expect(team.leaderNodeId).toBe(pA.nodeId);
    expect(team.name).toBeNull();

    // Leader sets team name
    a.send({
      type: 'team_name',
      teamId: team.teamId,
      name: 'Cyber Panthers',
      description: 'First team in Mumbai',
    });

    // Both a and b immediately receive snapshot with the updated name
    const aNamed = await a.wait((m) => m.type === 'snapshot' && m.teams?.some((t) => t.name === 'Cyber Panthers')) as SnapshotMessage;
    const bNamed = await b.wait((m) => m.type === 'snapshot' && m.teams?.some((t) => t.name === 'Cyber Panthers')) as SnapshotMessage;

    expect(aNamed.teams.find((t) => t.teamId === team.teamId)?.name).toBe('Cyber Panthers');
    expect(bNamed.teams.find((t) => t.teamId === team.teamId)?.name).toBe('Cyber Panthers');
    expect(bNamed.teams.find((t) => t.teamId === team.teamId)?.description).toBe('First team in Mumbai');

    a.close();
    b.close();
  });

  it('rejects unauthorized non-leader attempts to name or rename the team', async () => {
    const a = await TestClient.open(server.port);
    const b = await TestClient.open(server.port);
    const pA = await a.join('Leader_One');
    const pB = await b.join('Member_One');

    a.send({ type: 'request_link', targetNodeId: pB.nodeId });
    const req = await a.wait((m) => m.type === 'request_result' && m.status === 'pending');
    b.send({ type: 'respond_link', requestId: (req as any).request.requestId, accept: true });
    await a.wait((m) => m.type === 'request_result' && m.status === 'accepted');

    const snap = await a.wait((m) => m.type === 'snapshot' && m.teams?.some((t) => t.memberNodeIds.length === 2)) as SnapshotMessage;
    const team = snap.teams.find((t) => t.memberNodeIds.includes(pA.nodeId))!;

    // Non-leader b attempts to set name
    b.send({
      type: 'team_name',
      teamId: team.teamId,
      name: 'Unauthorized Name',
    });

    const err = await b.wait((m) => m.type === 'error');
    expect(err.type).toBe('error');
    expect((err as any).code).toBe('NOT_TEAM_LEADER');

    a.close();
    b.close();
  });

  it('enforces case-insensitive globally unique team names', async () => {
    const a = await TestClient.open(server.port);
    const b = await TestClient.open(server.port);
    const c = await TestClient.open(server.port);
    const d = await TestClient.open(server.port);

    const pA = await a.join('Leader_A');
    const pB = await b.join('Member_B');
    const pC = await c.join('Leader_C');
    const pD = await d.join('Member_D');

    // Form team 1 (a + b)
    a.send({ type: 'request_link', targetNodeId: pB.nodeId });
    const req1 = await a.wait((m) => m.type === 'request_result' && m.status === 'pending');
    b.send({ type: 'respond_link', requestId: (req1 as any).request.requestId, accept: true });
    await a.wait((m) => m.type === 'request_result' && m.status === 'accepted');
    const snap1 = await a.wait((m) => m.type === 'snapshot' && m.teams?.some((t) => t.memberNodeIds.includes(pA.nodeId))) as SnapshotMessage;
    const team1 = snap1.teams.find((t) => t.memberNodeIds.includes(pA.nodeId))!;

    // Leader a names team 'Vortex Crew'
    a.send({ type: 'team_name', teamId: team1.teamId, name: 'Vortex Crew' });
    await a.wait((m) => m.type === 'snapshot' && m.teams?.some((t) => t.name === 'Vortex Crew'));

    // Form team 2 (c + d)
    c.send({ type: 'request_link', targetNodeId: pD.nodeId });
    const req2 = await c.wait((m) => m.type === 'request_result' && m.status === 'pending');
    d.send({ type: 'respond_link', requestId: (req2 as any).request.requestId, accept: true });
    await c.wait((m) => m.type === 'request_result' && m.status === 'accepted');
    const snap2 = await c.wait((m) => m.type === 'snapshot' && m.teams?.some((t) => t.memberNodeIds.includes(pC.nodeId))) as SnapshotMessage;
    const team2 = snap2.teams.find((t) => t.memberNodeIds.includes(pC.nodeId))!;

    // Leader c tries exact duplicate
    c.send({ type: 'team_name', teamId: team2.teamId, name: 'Vortex Crew' });
    const errExact = await c.wait((m) => m.type === 'error');
    expect((errExact as any).code).toBe('TEAM_NAME_TAKEN');

    // Leader c tries case-insensitive duplicate 'vortex crew'
    c.send({ type: 'team_name', teamId: team2.teamId, name: 'vortex crew' });
    const errCase = await c.wait((m) => m.type === 'error');
    expect((errCase as any).code).toBe('TEAM_NAME_TAKEN');

    // Leader c tries UPPERCASE duplicate 'VORTEX CREW'
    c.send({ type: 'team_name', teamId: team2.teamId, name: 'VORTEX CREW' });
    const errUpper = await c.wait((m) => m.type === 'error');
    expect((errUpper as any).code).toBe('TEAM_NAME_TAKEN');

    a.close();
    b.close();
    c.close();
    d.close();
  });

  it('new members joining an existing mesh automatically inherit its team name and room ID', async () => {
    const a = await TestClient.open(server.port);
    const b = await TestClient.open(server.port);
    const c = await TestClient.open(server.port);

    const pA = await a.join('Founder_A');
    const pB = await b.join('Founder_B');
    const pC = await c.join('Joiner_C');

    // a + b form team
    a.send({ type: 'request_link', targetNodeId: pB.nodeId });
    const req = await a.wait((m) => m.type === 'request_result' && m.status === 'pending');
    b.send({ type: 'respond_link', requestId: (req as any).request.requestId, accept: true });
    await a.wait((m) => m.type === 'request_result' && m.status === 'accepted');

    const snap = await a.wait((m) => m.type === 'snapshot' && m.teams?.some((t) => t.memberNodeIds.length === 2)) as SnapshotMessage;
    const team = snap.teams.find((t) => t.memberNodeIds.includes(pA.nodeId))!;

    // Name team
    a.send({ type: 'team_name', teamId: team.teamId, name: 'Heritage Network' });
    await a.wait((m) => m.type === 'snapshot' && m.teams?.some((t) => t.name === 'Heritage Network'));

    // Now c links with b to join the existing mesh
    c.send({ type: 'request_link', targetNodeId: pB.nodeId });
    const reqC = await c.wait((m) => m.type === 'request_result' && m.status === 'pending');
    b.send({ type: 'respond_link', requestId: (reqC as any).request.requestId, accept: true });
    await c.wait((m) => m.type === 'request_result' && m.status === 'accepted');

    // c receives snapshot showing 3 members, inheriting 'Heritage Network'
    const snapC = await c.wait((m) => m.type === 'snapshot' && m.teams?.some((t) => t.memberNodeIds.includes(pC.nodeId) && t.memberNodeIds.length === 3)) as SnapshotMessage;
    const teamForC = snapC.teams.find((t) => t.memberNodeIds.includes(pC.nodeId))!;
    expect(teamForC.name).toBe('Heritage Network');
    expect(teamForC.leaderNodeId).toBe(pA.nodeId);
    expect(teamForC.memberNodeIds).toContain(pC.nodeId);

    a.close();
    b.close();
    c.close();
  });

  it('persists team name across reconnect and server restart', async () => {
    const a = await TestClient.open(server.port);
    const b = await TestClient.open(server.port);
    const pA = await a.join('Persistent_A');
    const pB = await b.join('Persistent_B');

    a.send({ type: 'request_link', targetNodeId: pB.nodeId });
    const req = await a.wait((m) => m.type === 'request_result' && m.status === 'pending');
    b.send({ type: 'respond_link', requestId: (req as any).request.requestId, accept: true });
    await a.wait((m) => m.type === 'request_result' && m.status === 'accepted');

    const snap = await a.wait((m) => m.type === 'snapshot' && m.teams?.some((t) => t.memberNodeIds.length === 2)) as SnapshotMessage;
    const team = snap.teams.find((t) => t.memberNodeIds.includes(pA.nodeId))!;

    a.send({ type: 'team_name', teamId: team.teamId, name: 'Evergreen Line' });
    await a.wait((m) => m.type === 'snapshot' && m.teams?.some((t) => t.name === 'Evergreen Line'));

    a.close();
    b.close();

    console.log('Step 1: Reconnecting before server restart...');
    const aReconnect = await TestClient.open(server.port, `?token=${encodeURIComponent(pA.token)}`);
    const wel1 = await aReconnect.wait((m) => m.type === 'welcome');
    expect(wel1.type).toBe('welcome');
    const recSnap = await aReconnect.wait((m) => m.type === 'snapshot') as SnapshotMessage;
    expect(recSnap.teams.find((t) => t.memberNodeIds.includes(pA.nodeId))?.name).toBe('Evergreen Line');
    aReconnect.close();

    console.log('Step 2: Restarting server...');
    await server.close();
    const restarted = await createGameServer({
      port: 0,
      persistPath,
      offlineTimeoutMs: 60_000,
    });

    console.log('Step 3: Reconnecting after server restart...');
    const aAfterRestart = await TestClient.open(restarted.port, `?token=${encodeURIComponent(pA.token)}`);
    const wel2 = await aAfterRestart.wait((m) => m.type === 'welcome');
    expect(wel2.type).toBe('welcome');
    const postRestartSnap = await aAfterRestart.wait((m) => m.type === 'snapshot') as SnapshotMessage;
    expect(postRestartSnap.teams.find((t) => t.memberNodeIds.includes(pA.nodeId))?.name).toBe('Evergreen Line');

    aAfterRestart.close();
    await restarted.close();
  });
});
