import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDefaultConfig, type GameConfig } from '@mng/config';
import type { ClientMessage, ServerMessage, SnapshotView } from '@mng/protocol';
import { createGameServer } from '../src/app.js';
import type { GameServer } from '../src/app.js';
import { buildLeaderboard, searchPlayers } from '../../web/src/community.js';

function fastConfig(): GameConfig {
  const base = loadDefaultConfig();
  return {
    ...base,
    phases: { seeding: 400, build: 60_000, warning: 100, repair: 700, result: 300 },
    links: { ...base.links, requestTtlMs: 5000 },
    scoring: { ...base.scoring, speedHalfPointMs: 250 },
  } as GameConfig;
}

class TestClient {
  private inbox: ServerMessage[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      try {
        this.inbox.push(JSON.parse(String(raw)) as ServerMessage);
      } catch {
        // ignore malformed
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

  async tryJoin(name: string): Promise<
    | { ok: true; token: string; nodeId: string; snapshot: SnapshotView }
    | { ok: false; code: string }
  > {
    this.send({ type: 'join', name });
    const msg = await this.wait((m) => m.type === 'welcome' || m.type === 'error');
    if (msg.type === 'error') {
      return { ok: false, code: msg.code };
    }
    const snap = (await this.wait((m) => m.type === 'snapshot')) as Extract<ServerMessage, { type: 'snapshot' }>;
    return { ok: true, token: msg.token, nodeId: snap.you.nodeId!, snapshot: snap };
  }

  close(): void {
    this.ws.close();
  }
}

describe('Globally unique player usernames', () => {
  let server: GameServer;
  let persistPath: string;

  beforeEach(async () => {
    persistPath = join(tmpdir(), `mng-username-test-${randomUUID()}.json`);
    server = await createGameServer({
      config: fastConfig(),
      port: 0,
      adminSecret: 'test-secret',
      distDir: join(tmpdir(), 'mng-no-client'),
      persistPath,
      handleSignals: false,
      seed: 42,
    });
  });

  afterEach(async () => {
    await server.close();
  });

  it('1. First player registers "devesh" -> ACCEPT', async () => {
    const c1 = await TestClient.open(server.port);
    const res = await c1.tryJoin('devesh');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(server.line.state.nodes[res.nodeId]?.name).toBe('devesh');
    }
    c1.close();
  });

  it('2. Second player attempts exact "devesh" -> REJECT (USERNAME_TAKEN)', async () => {
    const c1 = await TestClient.open(server.port);
    const r1 = await c1.tryJoin('devesh');
    expect(r1.ok).toBe(true);

    const c2 = await TestClient.open(server.port);
    const r2 = await c2.tryJoin('devesh');
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.code).toBe('USERNAME_TAKEN');
    }
    c1.close();
    c2.close();
  });

  it('3. Second player attempts "Devesh" (case-insensitive) -> REJECT (USERNAME_TAKEN)', async () => {
    const c1 = await TestClient.open(server.port);
    const r1 = await c1.tryJoin('devesh');
    expect(r1.ok).toBe(true);

    const c2 = await TestClient.open(server.port);
    const r2 = await c2.tryJoin('Devesh');
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.code).toBe('USERNAME_TAKEN');
    }
    c1.close();
    c2.close();
  });

  it('4. Second player attempts "DEVESH" (case-insensitive) -> REJECT (USERNAME_TAKEN)', async () => {
    const c1 = await TestClient.open(server.port);
    const r1 = await c1.tryJoin('devesh');
    expect(r1.ok).toBe(true);

    const c2 = await TestClient.open(server.port);
    const r2 = await c2.tryJoin('DEVESH');
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.code).toBe('USERNAME_TAKEN');
    }
    c1.close();
    c2.close();
  });

  it('5. Registration with leading/trailing spaces ("  devesh  ") -> trimmed & rejected if taken', async () => {
    const c1 = await TestClient.open(server.port);
    const r1 = await c1.tryJoin('devesh');
    expect(r1.ok).toBe(true);

    const c2 = await TestClient.open(server.port);
    const r2 = await c2.tryJoin('  devesh  ');
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.code).toBe('USERNAME_TAKEN');
    }
    c1.close();
    c2.close();
  });

  it('6. Simultaneous registrations race test (same username) -> exactly 1 succeeds', async () => {
    const c1 = await TestClient.open(server.port);
    const c2 = await TestClient.open(server.port);

    const [r1, r2] = await Promise.all([
      c1.tryJoin('concurrent_user'),
      c2.tryJoin('concurrent_user'),
    ]);

    const successes = [r1, r2].filter((r) => r.ok);
    const rejections = [r1, r2].filter((r) => !r.ok);

    expect(successes).toHaveLength(1);
    expect(rejections).toHaveLength(1);
    if (!rejections[0].ok) {
      expect(rejections[0].code).toBe('USERNAME_TAKEN');
    }
    c1.close();
    c2.close();
  });

  it('7. Fallback usernames are distinct per player and cannot duplicate existing', async () => {
    const c1 = await TestClient.open(server.port);
    const c2 = await TestClient.open(server.port);
    const c3 = await TestClient.open(server.port);

    // Join without providing a username
    const [r1, r2, r3] = await Promise.all([
      c1.tryJoin(''),
      c2.tryJoin(''),
      c3.tryJoin(''),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);

    if (r1.ok && r2.ok && r3.ok) {
      const name1 = server.line.state.nodes[r1.nodeId]?.name;
      const name2 = server.line.state.nodes[r2.nodeId]?.name;
      const name3 = server.line.state.nodes[r3.nodeId]?.name;

      expect(name1).toBeDefined();
      expect(name2).toBeDefined();
      expect(name3).toBeDefined();
      expect(new Set([name1, name2, name3]).size).toBe(3);
    }

    c1.close();
    c2.close();
    c3.close();
  });

  it('8. Reconnect preserves player\'s own username', async () => {
    const c1 = await TestClient.open(server.port);
    const r1 = await c1.tryJoin('my_unique_name');
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    c1.close();

    // Reconnect with same token
    const c1Resume = await TestClient.open(server.port, `?token=${encodeURIComponent(r1.token)}`);
    const welcome = await c1Resume.wait((m) => m.type === 'welcome');
    expect(welcome.type).toBe('welcome');
    const snapshot = (await c1Resume.wait((m) => m.type === 'snapshot')) as Extract<ServerMessage, { type: 'snapshot' }>;
    expect(snapshot.you.nodeId).toBe(r1.nodeId);
    expect(server.line.state.nodes[r1.nodeId]?.name).toBe('my_unique_name');
    c1Resume.close();
  });

  it('9. Leaderboard displays canonical usernames', async () => {
    const c1 = await TestClient.open(server.port);
    const c2 = await TestClient.open(server.port);

    const r1 = await c1.tryJoin('devesh');
    const r2 = await c2.tryJoin('rino303');
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    const lb = buildLeaderboard(
      r2.snapshot.nodes,
      r2.snapshot.links,
      [],
      [],
      r2.nodeId,
    );

    const names = lb.map((e) => e.name);
    expect(names).toContain('devesh');
    expect(names).toContain('rino303');
    expect(new Set(names).size).toBe(names.length);

    c1.close();
    c2.close();
  });

  it('10. Search resolves correct player', async () => {
    const c1 = await TestClient.open(server.port);
    const c2 = await TestClient.open(server.port);

    const r1 = await c1.tryJoin('devesh123');
    const r2 = await c2.tryJoin('rino303');
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    const lb = buildLeaderboard(
      r2.snapshot.nodes,
      r2.snapshot.links,
      [],
      [],
      r2.nodeId,
    );

    const searchResult = searchPlayers(lb, 'Devesh');
    expect(searchResult).toHaveLength(1);
    expect(searchResult[0]?.nodeId).toBe(r1.nodeId);
    expect(searchResult[0]?.name).toBe('devesh123');

    c1.close();
    c2.close();
  });

  it('11. Two different players appear as separate entries without duplicate usernames', async () => {
    const c1 = await TestClient.open(server.port);
    const c2 = await TestClient.open(server.port);

    const r1 = await c1.tryJoin('devesh');
    const r2 = await c2.tryJoin('devesh123');
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    // Node 1 and Node 2 must have distinct node IDs and distinct usernames
    expect(r1.nodeId).not.toBe(r2.nodeId);
    expect(server.line.state.nodes[r1.nodeId]?.name).toBe('devesh');
    expect(server.line.state.nodes[r2.nodeId]?.name).toBe('devesh123');

    // Both appear on leaderboard without duplicates
    const lb = buildLeaderboard(
      r2.snapshot.nodes,
      r2.snapshot.links,
      [],
      [],
      r2.nodeId,
    );
    expect(lb).toHaveLength(2);
    const usernames = lb.map((e) => e.name);
    expect(usernames).toEqual(expect.arrayContaining(['devesh', 'devesh123']));
    expect(new Set(usernames).size).toBe(2);

    c1.close();
    c2.close();
  });
});

