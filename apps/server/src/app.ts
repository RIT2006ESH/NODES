/**
 * V1 game server: one process, one authoritative Line, HTTP + WebSocket.
 *
 * Deliberately small: no Redis, no Postgres, no message bus. The LineHost owns
 * the only mutable state; every action is serialized through it.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { loadDefaultConfig } from '@mng/config';
import type { GameConfig } from '@mng/config';
import type { Action } from '@mng/engine';
import { checkLink, clampToWorld } from '@mng/engine';
import { PROTOCOL_VERSION } from '@mng/protocol';
import type {
  ClientMessage,
  LinkRequestStatus,
  LinkRequestView,
  ReasonCode,
  ServerMessage,
  WireEvent,
  PacketMissionView,
  TeamView,
} from '@mng/protocol';
import { LineHost } from './line.js';
import { toScore, toSnapshot, toStats, toYou } from './view.js';

interface ClientConnection {
  ws: WebSocket;
  sessionId: string | null;
  nodeId: string | null;
  spectator: boolean;
  ready: boolean;
}

/**
 * Server-owned pending request. It is deliberately ephemeral: a request is
 * either accepted, declined or expires. It is never written as a link and is
 * never persisted as an edge.
 */
interface PendingLinkRequest {
  readonly requestId: string;
  readonly fromSessionId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly fromName: string;
  readonly toName: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * Requests have a lifecycle separate from edges. Pending requests are the only
 * ones exposed in snapshots; terminal records are kept briefly so a duplicate
 * Accept/Decline (two tabs, a retry, or a lost response) is idempotent instead
 * of creating a second edge or pretending the request never existed.
 */
type RequestStatus = LinkRequestStatus;
interface RequestRecord extends PendingLinkRequest {
  status: RequestStatus;
  resolvedAt: number | null;
  reason?: ReasonCode;
  retryAfterMs?: number;
  linkId?: string;
}

export interface GameServer {
  readonly http: Server;
  readonly wss: WebSocketServer;
  readonly line: LineHost;
  readonly port: number;
  readonly metrics: Metrics;
  close(): Promise<void>;
}

interface Metrics {
  startedAt: number;
  connections: number;
  joins: number;
  actions: number;
  accepted: number;
  rejected: number;
  rounds: number;
  ticks: number;
  lastTickMs: number;
  moves: number;
  requests: number;
  requestAccepted: number;
  requestDeclined: number;
  requestExpired: number;
  requestFailed: number;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

export interface GameServerOptions {
  readonly config?: GameConfig;
  readonly port?: number;
  readonly adminSecret?: string;
  readonly persistPath?: string;
  readonly distDir?: string;
  readonly tickMs?: number;
  readonly seed?: number;
  readonly now?: () => number;
  /** Tests create many servers; only the real process should own signal handlers. */
  readonly handleSignals?: boolean;
  /** Test/ops override; production uses config.links.requestTtlMs. */
  readonly requestTtlMs?: number;
}

export async function createGameServer(options: GameServerOptions = {}): Promise<GameServer> {
  const config = options.config ?? loadDefaultConfig();
  const clock = options.now ?? (() => Date.now());
  const adminSecret = options.adminSecret ?? process.env.ADMIN_SECRET ?? '';
  const dataDir =
    process.env.DATA_DIR ?? fileURLToPath(new URL('../../../data', import.meta.url));
  const persistPath = options.persistPath ?? join(dataDir, 'line.json');
  const distDir = options.distDir ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
  const tickMs = options.tickMs ?? 200;
  const requestTtlMs = options.requestTtlMs ?? config.links.requestTtlMs;
  const seed = options.seed ?? (Number(process.env.SEED) || (clock() >>> 0));

  const line = LineHost.load(persistPath, config) ?? new LineHost(config, seed, clock());
  const clients = new Map<WebSocket, ClientConnection>();
  const sessions = new Map<string, { sessionId: string; nodeId: string; name: string }>();
  const sessionsPath = persistPath.replace(/\.json$/, '.sessions.json');
  const teamStatePath = persistPath.replace(/\.json$/, '.teams.json');
  const rate = new Map<string, number[]>();
  /** Connection requests. Server-owned; never an edge until accepted. */
  const requests = new Map<string, RequestRecord>();
  /** Bounded terminal-request history for idempotent retries. */
  const MAX_REQUEST_RECORDS = 1024;
  /** Movement message timestamps and last accepted time, per session. */
  const moveRate = new Map<string, number[]>();
  const moveLastAt = new Map<string, number>();
  /** One coalesced position event per node, flushed on the 5 Hz tick. */
  const pendingMoves = new Map<string, WireEvent>();
  let packetMission: PacketMissionView | null = null;
  let packetMissionSeq = 0;
  // Packet Run is an occasional round-side event, not a per-tick loop. A
  // completed/failed mission must leave a quiet window before another starts.
  let packetNextAt = 0;
  type TeamRecord = { name: string | null; memberNodeIds: string[]; createdAt: number; area: 'main' | 'surprise'; qualification: 'ineligible' | 'qualified' | 'entered'; recoveries: number; activeLinks: number };
  const teamRecords = new Map<string, TeamRecord>();
  const areas = new Map<string, 'main' | 'surprise'>();
  const repairBaseline = new Map<string, number>();

  const saveTeamState = (): void => {
    try {
      mkdirSync(dirname(teamStatePath), { recursive: true });
      const temporaryPath = `${teamStatePath}.${process.pid}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify({ version: 1, areas: Object.fromEntries(areas), teams: Object.fromEntries(teamRecords) }), 'utf8');
      renameSync(temporaryPath, teamStatePath);
    } catch { /* best effort, like the line snapshot */ }
  };

  try {
    const raw = JSON.parse(readFileSync(teamStatePath, 'utf8')) as { version?: number; areas?: Record<string, unknown>; teams?: Record<string, Partial<TeamRecord>> };
    if (raw.version === 1) {
      for (const [id, area] of Object.entries(raw.areas ?? {})) if (line.state.nodes[id] && (area === 'main' || area === 'surprise')) areas.set(id, area);
      for (const [teamId, value] of Object.entries(raw.teams ?? {})) {
        const members = [...new Set(value.memberNodeIds ?? [])].filter((id): id is string => Boolean(line.state.nodes[id]));
        if (members.length < 2) continue;
        teamRecords.set(teamId, { name: typeof value.name === 'string' ? value.name.slice(0, 32) : null, memberNodeIds: members, createdAt: Number(value.createdAt) || clock(), area: value.area === 'surprise' ? 'surprise' : 'main', qualification: value.qualification === 'entered' ? 'entered' : value.qualification === 'qualified' ? 'qualified' : 'ineligible', recoveries: Math.max(0, Number(value.recoveries) || 0), activeLinks: 0 });
      }
    }
  } catch { /* missing, invalid, or old team state starts safely empty */ }

  function currentTeams(now: number): TeamView[] {
    const active = new Set(line.state.nodeOrder.filter((id) => line.state.nodes[id]?.status === 'active'));
    const adjacency = new Map<string, string[]>();
    for (const id of active) adjacency.set(id, []);
    for (const link of Object.values(line.state.links)) {
      if (link.cut || !active.has(link.a) || !active.has(link.b) || (areas.get(link.a) ?? 'main') !== (areas.get(link.b) ?? 'main')) continue;
      adjacency.get(link.a)!.push(link.b);
      adjacency.get(link.b)!.push(link.a);
    }
    const seen = new Set<string>();
    const components: string[][] = [];
    for (const start of [...active].sort()) {
      if (seen.has(start)) continue;
      const group: string[] = []; const queue = [start]; seen.add(start);
      while (queue.length) {
        const id = queue.shift()!; group.push(id);
        for (const next of adjacency.get(id) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
      if (group.length >= 2) components.push(group.sort());
    }
    components.sort((a, b) => b.length - a.length || a.join(',').localeCompare(b.join(',')));
    const next = new Map<string, TeamRecord>();
    const used = new Set<string>();
    for (const members of components) {
      const area = areas.get(members[0]!) ?? 'main';
      const activeLinks = Object.values(line.state.links).filter((link) => !link.cut && members.includes(link.a) && members.includes(link.b) && (areas.get(link.a) ?? 'main') === area && (areas.get(link.b) ?? 'main') === area).length;
      const candidates = [...teamRecords.entries()]
        .filter(([id, record]) => !used.has(id) && record.memberNodeIds.some((id) => members.includes(id)))
        .sort((a, b) => b[1].memberNodeIds.length - a[1].memberNodeIds.length || a[1].createdAt - b[1].createdAt || a[0].localeCompare(b[0]));
      const inherited = candidates[0]?.[1];
      const teamId = candidates[0]?.[0] ?? `team_${members.join('_')}`;
      const prior = inherited;
      const record: TeamRecord = { name: prior?.name ?? null, memberNodeIds: members, createdAt: prior?.createdAt ?? now, area, qualification: prior?.qualification ?? 'ineligible', recoveries: prior?.recoveries ?? 0, activeLinks };
      if (candidates[0]) used.add(candidates[0][0]);
      next.set(teamId, record);
    }
    teamRecords.clear();
    for (const [id, record] of next) teamRecords.set(id, record);
    return [...next.entries()].map(([teamId, record]) => ({ teamId, ...record }));
  }

  function evaluateQualification(now: number): boolean {
    let transitioned = false;
    const teams = currentTeams(now);
    for (const team of teams) {
      const record = teamRecords.get(team.teamId);
      if (!record || record.area !== 'main' || team.memberNodeIds.length < 3) continue;
      const repaired = team.memberNodeIds.some((id) => (line.state.nodes[id]?.restoredRoutes ?? 0) > (repairBaseline.get(id) ?? 0));
      const survived = (line.state.lastRound?.c.num ?? 0) / Math.max(1, line.state.lastRound?.c.den ?? 1) >= 0.9;
      if (repaired || survived) { record.qualification = 'qualified'; record.recoveries++; }
    }
    const ranked = currentTeams(now).filter((team) => team.qualification === 'qualified' && team.area === 'main').sort((a, b) => Number(b.qualification === 'qualified') - Number(a.qualification === 'qualified') || b.memberNodeIds.length - a.memberNodeIds.length || b.recoveries - a.recoveries || b.activeLinks - a.activeLinks || a.teamId.localeCompare(b.teamId));
    const winner = ranked[0];
    if (winner) {
      const record = teamRecords.get(winner.teamId);
      if (record && record.qualification === 'qualified') {
        for (const id of winner.memberNodeIds) areas.set(id, 'surprise');
        record.area = 'surprise'; record.qualification = 'entered'; transitioned = true;
        saveTeamState();
      }
    }
    return transitioned;
  }

  function activeRoute(source: string, destination: string): string[] {
    const queue = [source];
    const previous = new Map<string, string | null>([[source, null]]);
    while (queue.length) {
      const current = queue.shift()!;
      if (current === destination) break;
      for (const link of Object.values(line.state.links)) {
        if (!isLinkActiveForMission(link)) continue;
        const next = link.a === current ? link.b : link.b === current ? link.a : null;
        if (next && !previous.has(next)) { previous.set(next, current); queue.push(next); }
      }
    }
    if (!previous.has(destination)) return [];
    const route: string[] = [];
    for (let id: string | null = destination; id !== null; id = previous.get(id) ?? null) route.unshift(id);
    return route;
  }
  function isLinkActiveForMission(link: { a: string; b: string; cut: boolean }): boolean {
    return !link.cut && (areas.get(link.a) ?? 'main') === (areas.get(link.b) ?? 'main') && line.state.nodes[link.a]?.status === 'active' && line.state.nodes[link.b]?.status === 'active';
  }
  function updatePacketMission(now: number): boolean {
    let changed = false;
    if (!packetMission && line.state.nodeOrder.length >= 2 && now >= packetNextAt) {
      const source = line.state.nodeOrder[0]!;
      const destination = line.state.nodeOrder[line.state.nodeOrder.length - 1]!;
      packetMission = { id: ++packetMissionSeq, sourceNodeId: source, destinationNodeId: destination, startedAt: now, endsAt: now + 45_000, status: 'blocked', route: [] };
      changed = true;
    }
    if (!packetMission) return changed;
    const route = activeRoute(packetMission.sourceNodeId, packetMission.destinationNodeId);
    if (packetMission.status === 'blocked' && route.length > 1) { packetMission = { ...packetMission, status: 'in_transit', route, startedAt: now, endsAt: now + 45_000 }; changed = true; }
    else if (packetMission.status === 'in_transit' && route.length === 0) { packetMission = { ...packetMission, status: 'failed', route: [] }; changed = true; }
    else if (packetMission.status === 'in_transit' && now >= packetMission.startedAt + 2200) { packetMission = { ...packetMission, status: 'delivered', route }; changed = true; }
    else if (packetMission.status === 'failed' || packetMission.status === 'delivered' || now >= packetMission.endsAt) {
      packetMission = null;
      packetNextAt = now + 30_000;
      changed = true;
    }
    return changed;
  }

  // Reconnect tokens survive a restart when the data directory does.
  try {
    const raw = JSON.parse(readFileSync(sessionsPath, 'utf8')) as Record<
      string,
      { sessionId?: string; nodeId?: string; name?: string }
    >;
    for (const [token, session] of Object.entries(raw)) {
      if (session?.sessionId && session.nodeId && line.state.nodes[session.nodeId]) {
        sessions.set(token, {
          sessionId: session.sessionId,
          nodeId: session.nodeId,
          name: session.name ?? 'Visitor',
        });
      }
    }
  } catch {
    // first boot, or no persisted sessions
  }

  const saveSessions = (): void => {
    try {
      mkdirSync(dirname(sessionsPath), { recursive: true });
      const temporaryPath = `${sessionsPath}.${process.pid}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify(Object.fromEntries(sessions)), 'utf8');
      renameSync(temporaryPath, sessionsPath);
    } catch {
      // best effort, same as the state snapshot
    }
  };

  const metrics: Metrics = {
    startedAt: clock(),
    connections: 0,
    joins: 0,
    actions: 0,
    accepted: 0,
    rejected: 0,
    rounds: line.state.roundsSurvived,
    ticks: 0,
    lastTickMs: 0,
    moves: 0,
    requests: 0,
    requestAccepted: 0,
    requestDeclined: 0,
    requestExpired: 0,
    requestFailed: 0,
  };

  const send = (ws: WebSocket, message: ServerMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  const deltaFor = (
    events: readonly WireEvent[],
    nodeId: string | null,
  ): ServerMessage => ({
    type: 'delta',
    v: PROTOCOL_VERSION,
    seq: line.seq,
    serverNow: clock(),
    phase: line.state.phase,
    phaseEndsAt: line.state.phaseEndsAt,
    roundNo: line.state.roundNo,
    events,
    you: toYou(line.state, config, nodeId),
    lastScore: toScore(line.state),
    stats: toStats(line.state),
    packetMission,
      teams: currentTeams(clock()),
  });

  const broadcastEvents = (events: readonly WireEvent[]): void => {
    if (events.length === 0) return;
    for (const client of clients.values()) {
      if (!client.ready) continue;
      send(client.ws, deltaFor(events, client.nodeId));
    }
  };

  const requestView = (request: PendingLinkRequest): LinkRequestView => ({
    requestId: request.requestId,
    fromNodeId: request.fromNodeId,
    fromName: request.fromName,
    toNodeId: request.toNodeId,
    toName: request.toName,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  });

  const makeRequestView = (
    requestId: string,
    fromNodeId: string,
    toNodeId: string,
    now: number,
    expiresAt: number,
  ): LinkRequestView => ({
    requestId,
    fromNodeId,
    fromName: line.state.nodes[fromNodeId]?.name ?? fromNodeId,
    toNodeId,
    toName: line.state.nodes[toNodeId]?.name ?? toNodeId,
    createdAt: now,
    expiresAt,
  });

  const sendToNode = (nodeId: string, message: ServerMessage): void => {
    for (const client of clients.values()) {
      if (client.ready && client.nodeId === nodeId) send(client.ws, message);
    }
  };

  const sendRequestResult = (
    request: PendingLinkRequest,
    status: LinkRequestStatus,
    extra: { reason?: ReasonCode; retryAfterMs?: number; linkId?: string } = {},
  ): void => {
    const message: ServerMessage = {
      type: 'request_result',
      request: requestView(request),
      status,
      ...extra,
    };
    sendToNode(request.fromNodeId, message);
    if (request.toNodeId !== request.fromNodeId) sendToNode(request.toNodeId, message);
  };

  const pruneRequestHistory = (): void => {
    if (requests.size <= MAX_REQUEST_RECORDS) return;
    const resolved = [...requests.values()]
      .filter((request) => request.status !== 'pending')
      .sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0));
    for (const request of resolved) {
      if (requests.size <= MAX_REQUEST_RECORDS) break;
      requests.delete(request.requestId);
    }
  };

  const resolveRequest = (
    request: RequestRecord,
    status: Exclude<RequestStatus, 'pending'>,
    extra: { reason?: ReasonCode; retryAfterMs?: number; linkId?: string } = {},
  ): void => {
    request.status = status;
    request.resolvedAt = clock();
    if (extra.reason !== undefined) request.reason = extra.reason;
    if (extra.retryAfterMs !== undefined) request.retryAfterMs = extra.retryAfterMs;
    if (extra.linkId !== undefined) request.linkId = extra.linkId;
    pruneRequestHistory();
  };

  const terminalExtra = (request: RequestRecord): {
    reason?: ReasonCode;
    retryAfterMs?: number;
    linkId?: string;
  } => ({
    ...(request.reason === undefined ? {} : { reason: request.reason }),
    ...(request.retryAfterMs === undefined ? {} : { retryAfterMs: request.retryAfterMs }),
    ...(request.linkId === undefined ? {} : { linkId: request.linkId }),
  });

  const expireDueRequests = (now: number): void => {
    for (const request of [...requests.values()]) {
      if (request.status !== 'pending') continue;
      if (request.expiresAt > now) continue;
      resolveRequest(request, 'expired');
      metrics.requestExpired++;
      sendRequestResult(request, 'expired');
    }
  };

  const requestsFor = (
    nodeId: string | null,
    now: number,
  ): { incoming: LinkRequestView[]; outgoing: LinkRequestView[] } => {
    if (!nodeId) return { incoming: [], outgoing: [] };
    const incoming: LinkRequestView[] = [];
    const outgoing: LinkRequestView[] = [];
    for (const request of requests.values()) {
      if (request.status !== 'pending' || request.expiresAt <= now) continue;
      if (request.toNodeId === nodeId) incoming.push(requestView(request));
      if (request.fromNodeId === nodeId) outgoing.push(requestView(request));
    }
    incoming.sort((a, b) => a.createdAt - b.createdAt);
    outgoing.sort((a, b) => a.createdAt - b.createdAt);
    return { incoming, outgoing };
  };

  const snapshotFor = (client: ClientConnection): ServerMessage => {
    const now = clock();
    const pending = requestsFor(client.nodeId, now);
    return toSnapshot(
      line.state,
      config,
      client.nodeId,
      now,
      pending.incoming,
      pending.outgoing,
      new Set([...clients.values()].filter((other) => other.ready && other.nodeId).map((other) => other.nodeId as string)),
      packetMission,
      currentTeams(now),
      areas,
    );
  };

  const broadcastSnapshot = (): void => {
    for (const client of clients.values()) {
      if (!client.ready) continue;
      send(client.ws, snapshotFor(client));
    }
  };

  const http = createServer((req, res) => {
    void handleHttp(req, res);
  });

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/healthz') {
      json(res, 200, {
        ok: true,
        seq: line.seq,
        phase: line.state.phase,
        roundNo: line.state.roundNo,
        nodes: line.state.nodeOrder.length,
        uptimeMs: clock() - metrics.startedAt,
      });
      return;
    }

    if (url.pathname === '/metrics') {
      json(res, 200, {
        ...metrics,
        connectionsNow: clients.size,
        nodes: line.state.nodeOrder.length,
        links: Object.keys(line.state.links).length,
        phase: line.state.phase,
        roundNo: line.state.roundNo,
        seq: line.seq,
      });
      return;
    }

    if (url.pathname.startsWith('/admin/')) {
      if (!adminSecret) {
        json(res, 503, { error: 'admin disabled: ADMIN_SECRET not set' });
        return;
      }
      if (req.headers['x-admin-secret'] !== adminSecret) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      await handleAdmin(url, req, res);
      return;
    }

    serveStatic(url.pathname, res);
  }

  async function handleAdmin(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const action = url.pathname.slice('/admin/'.length);
    if (req.method !== 'POST') {
      json(res, 405, { error: 'POST required' });
      return;
    }

    switch (action) {
      case 'pause':
        line.state.paused = true;
        broadcastSnapshot();
        json(res, 200, { paused: true });
        return;
      case 'resume':
        line.state.paused = false;
        broadcastSnapshot();
        json(res, 200, { paused: false });
        return;
      case 'reset': {
        const next = Number(url.searchParams.get('seed')) || (clock() >>> 0);
        line.reset(next, clock());
        sessions.clear();
        requests.clear();
        rate.clear();
        pendingMoves.clear();
        moveRate.clear();
        moveLastAt.clear();
        saveSessions();
        for (const [ws, client] of clients) {
          client.sessionId = null;
          client.nodeId = null;
          client.ready = false;
          send(ws, { type: 'error', code: 'RESET' });
        }
        broadcastSnapshot();
        json(res, 200, { reset: true, seed: next });
        return;
      }
      case 'ban': {
        const sessionId = url.searchParams.get('session');
        if (!sessionId) {
          json(res, 400, { error: 'session parameter required' });
          return;
        }
        for (const [token, s] of [...sessions.entries()]) {
          if (s.sessionId === sessionId) sessions.delete(token);
        }
        for (const [ws, client] of [...clients.entries()]) {
          if (client.sessionId === sessionId) {
            send(ws, { type: 'error', code: 'SESSION_BANNED' });
            ws.close(4003, 'banned');
            clients.delete(ws);
          }
        }
        json(res, 200, { banned: sessionId });
        return;
      }
      default:
        json(res, 404, { error: 'unknown admin action' });
    }
  }

  function serveStatic(pathname: string, res: ServerResponse): void {
    if (!existsSync(distDir)) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>Client not built</h1><p>Run <code>npm run build</code> first.</p>');
      return;
    }

    const root = resolve(distDir);
    const requested = pathname === '/' ? '/index.html' : pathname;
    let filePath = resolve(root, `.${requested}`);
    if (!(filePath === root || filePath.startsWith(root + sep))) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      filePath = resolve(root, 'index.html');
    }

    try {
      const body = readFileSync(filePath);
      res.writeHead(200, {
        'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
      });
      res.end(body);
    } catch {
      res.writeHead(500);
      res.end('error');
    }
  }

  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 1024 });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const spectator = url.searchParams.get('spectate') === '1';
    const token = url.searchParams.get('token');

    const client: ClientConnection = {
      ws,
      sessionId: null,
      nodeId: null,
      spectator,
      ready: false,
    };
    clients.set(ws, client);
    metrics.connections++;

    // Returning visitors resume by token (PRD 6.2). If the token is unknown
    // (server restart), the client falls back to the join overlay.
    if (token && sessions.has(token)) {
      const session = sessions.get(token)!;
      if (line.state.nodes[session.nodeId]) {
        client.sessionId = session.sessionId;
        client.nodeId = session.nodeId;
        client.ready = true;
        send(ws, {
          type: 'welcome',
          v: PROTOCOL_VERSION,
          token,
          lineId: line.state.id,
          spectator: false,
        });
        send(ws, snapshotFor(client));
        saveSessions();
      } else {
        sessions.delete(token);
        saveSessions();
        send(ws, { type: 'error', code: 'INVALID_TOKEN' });
      }
    } else if (token) {
      send(ws, { type: 'error', code: 'INVALID_TOKEN' });
    } else if (spectator) {
      client.ready = true;
      send(ws, { type: 'welcome', v: PROTOCOL_VERSION, token: '', lineId: line.state.id, spectator: true });
      send(ws, snapshotFor(client));
    }

    ws.on('message', (data) => {
      const now = clock();
      let message: ClientMessage;
      try {
        message = JSON.parse(String(data)) as ClientMessage;
      } catch {
        send(ws, { type: 'error', code: 'BAD_MESSAGE' });
        return;
      }
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
        send(ws, { type: 'error', code: 'BAD_MESSAGE' });
        return;
      }

      switch (message.type) {
        case 'join':
          handleJoin(ws, client, message.name, now);
          return;

        case 'team_name':
          handleTeamName(ws, client, message.teamId, message.name, now);
          return;

        case 'request_link':
          handleRequestLink(ws, client, message, now);
          return;

        case 'respond_link':
          handleRespondLink(ws, client, message, now);
          return;

        case 'move':
          handleMove(ws, client, message, now);
          return;

        case 'resync':
          if (client.ready) send(ws, snapshotFor(client));
          return;

        case 'ping':
          send(ws, { type: 'pong', t: Number(message.t) || 0, serverNow: now });
          return;

        default:
          send(ws, { type: 'error', code: 'UNKNOWN_TYPE' });
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      if (client.sessionId) {
        moveRate.delete(client.sessionId);
        moveLastAt.delete(client.sessionId);
      }
      broadcastSnapshot();
    });

    ws.on('error', () => {
      clients.delete(ws);
      broadcastSnapshot();
    });
  });

  function handleTeamName(ws: WebSocket, client: ClientConnection, rawTeamId: unknown, rawName: unknown, now: number): void {
    if (!client.ready || !client.nodeId || typeof rawTeamId !== 'string' || typeof rawName !== 'string') {
      send(ws, { type: 'error', code: 'BAD_MESSAGE' });
      return;
    }
    const name = rawName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32);
    if (!name) {
      send(ws, { type: 'error', code: 'BAD_TEAM_NAME' });
      return;
    }
    const team = currentTeams(now).find((entry) => entry.teamId === rawTeamId);
    if (!team || !team.memberNodeIds.includes(client.nodeId)) {
      send(ws, { type: 'error', code: 'TEAM_NOT_FOUND' });
      return;
    }
    const record = teamRecords.get(team.teamId);
    if (!record) {
      send(ws, { type: 'error', code: 'TEAM_NOT_FOUND' });
      return;
    }
    if (record.name === null) {
      record.name = sanitizeName(name);
      saveTeamState();
      broadcastSnapshot();
    }
  }

  function handleJoin(ws: WebSocket, client: ClientConnection, rawName: unknown, now: number): void {
    if (client.sessionId) {
      send(ws, snapshotFor(client));
      return;
    }
    if (client.spectator) {
      send(ws, { type: 'error', code: 'SPECTATOR_READ_ONLY' });
      return;
    }

    const name = sanitizeName(typeof rawName === 'string' ? rawName : '');
    const sessionId = randomBytes(8).toString('hex');
    const token = randomBytes(18).toString('base64url');

    const action: Action = { type: 'join', sessionId, name };
    const out = line.apply(action, now);
    metrics.actions++;
    metrics.joins++;

    const joined = out.result;
    if (!joined || !('kind' in joined) || !joined.ok) {
      metrics.rejected++;
      send(ws, { type: 'error', code: 'JOIN_FAILED' });
      return;
    }

    client.sessionId = sessionId;
    client.nodeId = joined.nodeId;
    client.ready = true;
    sessions.set(token, { sessionId, nodeId: joined.nodeId, name });
    saveSessions();

    send(ws, { type: 'welcome', v: PROTOCOL_VERSION, token, lineId: line.state.id, spectator: false });
    send(ws, snapshotFor(client));

    // Everyone else learns about the new node by delta. A join creates no edge.
    broadcastEvents(out.events as unknown as WireEvent[]);
  }

  /**
   * Step 1 of the consent flow. The requester is always the node owned by the
   * session; clients cannot nominate a third-party pair. The request is stored
   * server-side and broadcast to the target only as a request, never as an edge.
   */
  function handleRequestLink(
    ws: WebSocket,
    client: ClientConnection,
    message: Extract<ClientMessage, { type: 'request_link' }>,
    now: number,
  ): void {
    if (!client.sessionId || !client.nodeId) {
      send(ws, { type: 'error', code: 'NOT_JOINED' });
      return;
    }
    const targetNodeId = message.targetNodeId;
    if (typeof targetNodeId !== 'string' || targetNodeId.length === 0 || targetNodeId.length > 64) {
      send(ws, { type: 'error', code: 'BAD_MESSAGE' });
      return;
    }

    expireDueRequests(now);

    // Keep the PRD's 2 link attempts/s/session limit for requests too.
    const stamps = (rate.get(client.sessionId) ?? []).filter((t) => now - t < 1000);
    if (stamps.length >= 2) {
      metrics.rejected++;
      const view = makeRequestView(
        `rejected_${randomBytes(9).toString('base64url')}`,
        client.nodeId,
        targetNodeId,
        now,
        now,
      );
      send(ws, { type: 'request_result', request: view, status: 'failed', reason: 'RATE_LIMITED' });
      return;
    }
    stamps.push(now);
    rate.set(client.sessionId, stamps);

    const duplicate = [...requests.values()].find(
      (request) =>
        request.status === 'pending' &&
        request.fromNodeId === client.nodeId &&
        request.toNodeId === targetNodeId,
    );
    if (duplicate) {
      metrics.rejected++;
      const view = makeRequestView(
        `rejected_${randomBytes(9).toString('base64url')}`,
        client.nodeId,
        targetNodeId,
        now,
        now,
      );
      send(ws, { type: 'request_result', request: view, status: 'failed', reason: 'REQUEST_PENDING' });
      return;
    }

    // Request-time validation cannot bypass any PRD rule; it is repeated in
    // full at acceptance because the Line may have changed in between.
    const rejection = checkLink(line.state, client.nodeId, targetNodeId, client.sessionId, line.config);
    if (rejection) {
      metrics.rejected++;
      const view = makeRequestView(
        `rejected_${randomBytes(9).toString('base64url')}`,
        client.nodeId,
        targetNodeId,
        now,
        now,
      );
      send(ws, {
        type: 'request_result',
        request: view,
        status: 'failed',
        reason: rejection.reason,
        ...(rejection.retryAfterMs === undefined ? {} : { retryAfterMs: rejection.retryAfterMs }),
      });
      return;
    }

    const request: RequestRecord = {
      requestId: `req_${randomBytes(12).toString('base64url')}`,
      fromSessionId: client.sessionId,
      fromNodeId: client.nodeId,
      toNodeId: targetNodeId,
      fromName: line.state.nodes[client.nodeId]?.name ?? client.nodeId,
      toName: line.state.nodes[targetNodeId]?.name ?? targetNodeId,
      createdAt: now,
      expiresAt: now + requestTtlMs,
      status: 'pending',
      resolvedAt: null,
    };
    requests.set(request.requestId, request);
    pruneRequestHistory();
    metrics.requests++;

    send(ws, { type: 'request_result', request: requestView(request), status: 'pending' });
    sendToNode(targetNodeId, { type: 'link_request', request: requestView(request) });
  }

  /**
   * Step 2. Only the named target can accept or decline. Acceptance is
   * revalidated against the current Line before the engine creates the edge;
   * a pending request is never treated as an edge.
   */
  function handleRespondLink(
    ws: WebSocket,
    client: ClientConnection,
    message: Extract<ClientMessage, { type: 'respond_link' }>,
    now: number,
  ): void {
    if (!client.sessionId || !client.nodeId) {
      send(ws, { type: 'error', code: 'NOT_JOINED' });
      return;
    }
    if (
      typeof message.requestId !== 'string' ||
      message.requestId.length === 0 ||
      message.requestId.length > 80 ||
      typeof message.accept !== 'boolean'
    ) {
      send(ws, { type: 'error', code: 'BAD_MESSAGE' });
      return;
    }

    const request = requests.get(message.requestId);
    if (!request) {
      const view = makeRequestView(
        message.requestId,
        client.nodeId,
        client.nodeId,
        now,
        now,
      );
      send(ws, { type: 'request_result', request: view, status: 'failed', reason: 'REQUEST_NOT_FOUND' });
      metrics.rejected++;
      return;
    }

    if (request.toNodeId !== client.nodeId) {
      send(ws, {
        type: 'request_result',
        request: requestView(request),
        status: 'failed',
        reason: 'REQUEST_NOT_FOUND',
      });
      metrics.rejected++;
      return;
    }

    // A retry from another tab or a repeated click must not create a second
    // edge. Replay the terminal outcome to the target instead.
    if (request.status !== 'pending') {
      send(ws, {
        type: 'request_result',
        request: requestView(request),
        status: request.status,
        ...terminalExtra(request),
      });
      return;
    }

    if (request.expiresAt <= now) {
      resolveRequest(request, 'expired');
      metrics.requestExpired++;
      sendRequestResult(request, 'expired');
      return;
    }

    if (!message.accept) {
      resolveRequest(request, 'declined');
      metrics.requestDeclined++;
      sendRequestResult(request, 'declined');
      return;
    }

    const out = line.apply(
      {
        type: 'create_link',
        requestId: request.requestId,
        sessionId: request.fromSessionId,
        a: request.fromNodeId,
        b: request.toNodeId,
      },
      now,
    );
    metrics.actions++;

    const result = out.result;
    if (result && 'requestId' in result && result.ok) {
      resolveRequest(request, 'accepted', { linkId: result.linkId });
      metrics.accepted++;
      metrics.requestAccepted++;
      sendRequestResult(request, 'accepted', { linkId: result.linkId });
      broadcastEvents(out.events as unknown as WireEvent[]);
      return;
    }

    metrics.rejected++;
    metrics.requestFailed++;
    const reason: ReasonCode =
      result && 'reason' in result ? result.reason : 'SERVER_ERROR';
    const retryAfterMs =
      result && 'retryAfterMs' in result ? result.retryAfterMs : undefined;
    resolveRequest(request, 'failed', {
      reason,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
    sendRequestResult(request, 'failed', {
      reason,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });

    // link.rejected is private. Phase/outage events still need to reach clients.
    const shared = (out.events as unknown as WireEvent[]).filter((event) => event.type !== 'link.rejected');
    broadcastEvents(shared);
  }

  /**
   * Movement is fire-and-forget: the server never trusts a position. It checks
   * ownership (derived from the session, never from the message), rate, world
   * bounds and a speed budget, then mutates only x/y. The event is coalesced
   * and broadcast on the next 5 Hz tick, so 25 Hz input does not become 25 Hz
   * fan-out.
   */
  function handleMove(
    ws: WebSocket,
    client: ClientConnection,
    message: Extract<ClientMessage, { type: 'move' }>,
    now: number,
  ): void {
    if (!client.sessionId || !client.nodeId) {
      send(ws, { type: 'error', code: 'NOT_JOINED' });
      return;
    }
    const node = line.state.nodes[client.nodeId];
    if (!node) return;
    // PRD 6.6: a disabled node cannot be changed by anyone, including its owner.
    if (node.status !== 'active') return;
    if (typeof message.x !== 'number' || typeof message.y !== 'number') {
      send(ws, { type: 'error', code: 'BAD_MESSAGE' });
      return;
    }
    if (!Number.isFinite(message.x) || !Number.isFinite(message.y)) {
      send(ws, { type: 'error', code: 'BAD_MESSAGE' });
      return;
    }

    const sessionId = client.sessionId;
    const stamps = (moveRate.get(sessionId) ?? []).filter((t) => now - t < 1000);
    if (stamps.length >= line.config.movement.maxMessagesPerSecond) return;
    stamps.push(now);
    moveRate.set(sessionId, stamps);

    const target = clampToWorld(message.x, message.y, line.config.movement.worldRadius);
    const dx = target.x - node.x;
    const dy = target.y - node.y;
    const wanted = Math.hypot(dx, dy);
    const previous = moveLastAt.get(sessionId);
    const dt = previous === undefined ? 250 : Math.min(250, Math.max(16, now - previous));
    const maxDistance = (line.config.movement.maxSpeed * dt) / 1000;

    let x = target.x;
    let y = target.y;
    if (wanted > maxDistance && wanted > 0) {
      x = node.x + (dx / wanted) * maxDistance;
      y = node.y + (dy / wanted) * maxDistance;
    }
    moveLastAt.set(sessionId, now);

    const event = line.move(client.nodeId, x, y, now);
    if (event) {
      pendingMoves.set(client.nodeId, event as unknown as WireEvent);
      metrics.moves++;
    }
  }

  // 5 Hz authoritative tick: phase transitions, token grants, coalesced moves.
  const tickTimer = setInterval(() => {
    const started = clock();
    expireDueRequests(started);
    const previousPhase = line.state.phase;
    const out = line.tick(started);
    const transitionedTeam = previousPhase === 'repair' && line.state.phase === 'result' ? evaluateQualification(started) : false;
    if (line.state.phase === 'repair' && previousPhase !== 'repair') {
      repairBaseline.clear();
      for (const node of Object.values(line.state.nodes)) repairBaseline.set(node.id, node.restoredRoutes);
    }
    const missionChanged = updatePacketMission(started);
    metrics.ticks++;
    metrics.lastTickMs = clock() - started;

    const moved = [...pendingMoves.values()].sort((a, b) => a.seq - b.seq);
    pendingMoves.clear();
    const events = [...(out.events as unknown as WireEvent[]), ...moved].sort(
      (a, b) => a.seq - b.seq,
    );
    if (events.length > 0) broadcastEvents(events);
    if (missionChanged || transitionedTeam) broadcastSnapshot();
    if (line.state.roundsSurvived > metrics.rounds) metrics.rounds = line.state.roundsSurvived;
  }, tickMs);

  const saveTimer = setInterval(() => {
    line.save(persistPath);
    saveSessions();
  }, 10_000);

  const shutdown = (): void => {
    clearInterval(tickTimer);
    clearInterval(saveTimer);
    line.save(persistPath);
    saveSessions();
    saveTeamState();
  };

  if (options.handleSignals !== false) {
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }

  const port = options.port ?? Number(process.env.PORT ?? 10000);
  await new Promise<void>((resolveListen) => http.listen(port, '0.0.0.0', resolveListen));
  const address = http.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    http,
    wss,
    line,
    port: actualPort,
    metrics,
    close: async () => {
      clearInterval(tickTimer);
      clearInterval(saveTimer);
      line.save(persistPath);
      saveSessions();
      saveTeamState();
      for (const client of clients.values()) client.ws.close();
      await new Promise<void>((done) => wss.close(() => done()));
      await new Promise<void>((done) => http.close(() => done()));
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function sanitizeName(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  if (!cleaned) return `Visitor ${Math.floor(Math.random() * 900 + 100)}`;
  return PROFANITY.some((word) => cleaned.toLowerCase().includes(word)) ? 'Guest' : cleaned;
}

/** Deliberately tiny for V1; a real list/loader is a documented gap. */
const PROFANITY = ['fuck', 'shit', 'bitch'];
