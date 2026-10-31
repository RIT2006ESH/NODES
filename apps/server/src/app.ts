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
import { createPrivateKey, randomBytes, sign as signEd25519 } from 'node:crypto';
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
  MeshEvent,
} from '@mng/protocol';
import { LineHost } from './line.js';
import { toScore, toSnapshot, toStats, toYou } from './view.js';
import { validateUsername, canonicalUsername, generateFallbackUsername } from './username.js';

interface ClientConnection {
  ws: WebSocket;
  sessionId: string | null;
  nodeId: string | null;
  spectator: boolean;
  ready: boolean;
  lastHeartbeatAt: number;
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
  /** Backend heartbeat timeout. Defaults to NODE_OFFLINE_TIMEOUT_MS or 10 seconds. */
  readonly offlineTimeoutMs?: number;
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
  const configuredOfflineTimeout = Number(process.env.NODE_OFFLINE_TIMEOUT_MS);
  const offlineTimeoutMs = options.offlineTimeoutMs ?? (Number.isFinite(configuredOfflineTimeout) && configuredOfflineTimeout > 0 ? configuredOfflineTimeout : 10_000);
  const seed = options.seed ?? (Number(process.env.SEED) || (clock() >>> 0));
  const smokeBaseUrl = process.env.SMOKE_BASE_URL?.replace(/\/+$/, '');
  const smokeInternalSecret = process.env.SMOKE_INTERNAL_API_SECRET;
  const nodesJwtPrivateKey = process.env.NODES_JWT_PRIVATE_KEY
    ?? (process.env.NODES_JWT_PRIVATE_KEY_FILE && existsSync(process.env.NODES_JWT_PRIVATE_KEY_FILE)
      ? readFileSync(process.env.NODES_JWT_PRIVATE_KEY_FILE, 'utf8')
      : undefined);
  const nodesJwtIssuer = process.env.NODES_JWT_ISSUER ?? 'nodes';
  const nodesJwtAudience = process.env.NODES_JWT_AUDIENCE ?? 'smoke-room';

  const line = LineHost.load(persistPath, config) ?? new LineHost(config, seed, clock());
  const clients = new Map<WebSocket, ClientConnection>();
  const offlineNodes = new Set<string>();
  const sessions = new Map<string, { sessionId: string; nodeId: string; name: string }>();
  const inFlightUsernames = new Set<string>();
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
  type TeamRecord = { name: string | null; description: string | null; leaderNodeId: string | null; nameOwnerNodeId: string | null; memberNodeIds: string[]; memberJoinedAt: Record<string, number>; createdAt: number; area: 'main' | 'surprise'; qualification: 'ineligible' | 'qualified' | 'entered'; recoveries: number; activeLinks: number };
  const teamRecords = new Map<string, TeamRecord>();
  const areas = new Map<string, 'main' | 'surprise'>();
  const repairBaseline = new Map<string, number>();
  const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
    ? (await import('./supabase.js')).createSupabaseStore()
    : null;
  if (supabase) {
    void supabase.verify().catch((error: unknown) => {
      console.error('Supabase connection verification failed:', error instanceof Error ? error.message : 'unknown error');
    });
  }

  const syncSmoke = (path: string, payload: unknown, eventId: string): void => {
    if (!smokeBaseUrl || !smokeInternalSecret) return;
    void fetch(`${smokeBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-smoke-internal-secret': smokeInternalSecret },
      body: JSON.stringify({ ...payload as Record<string, unknown>, eventId }),
    }).catch(() => undefined);
  };

  const issueSmokeToken = (nodeId: string, team: TeamView): string | null => {
    if (!nodesJwtPrivateKey) return null;
    const now = Math.floor(clock() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: nodesJwtIssuer, aud: nodesJwtAudience, sub: nodeId, nodeId,
      roomId: team.roomId, teamId: team.teamId, teamName: team.name ?? team.teamId,
      role: team.leaderNodeId === nodeId ? 'leader' : 'member',
      iat: now, exp: now + 300, jti: randomBytes(16).toString('hex'),
    })).toString('base64url');
    const unsigned = `${header}.${payload}`;
    const signature = signEd25519(null, Buffer.from(unsigned), createPrivateKey(nodesJwtPrivateKey)).toString('base64url');
    return `${unsigned}.${signature}`;
  };

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
        const leaderNodeId = typeof value.leaderNodeId === 'string' && members.includes(value.leaderNodeId)
          ? value.leaderNodeId
          : typeof value.nameOwnerNodeId === 'string' && members.includes(value.nameOwnerNodeId)
            ? value.nameOwnerNodeId
            : members[0]!;
        const memberJoinedAt = Object.fromEntries(members.map((id) => [id, Number(value.memberJoinedAt?.[id]) || line.state.nodes[id]!.createdAt]));
        teamRecords.set(teamId, { name: typeof value.name === 'string' ? value.name.slice(0, 24) : null, description: typeof value.description === 'string' ? value.description.slice(0, 160) : null, leaderNodeId, nameOwnerNodeId: typeof value.nameOwnerNodeId === 'string' && members.includes(value.nameOwnerNodeId) ? value.nameOwnerNodeId : null, memberNodeIds: members, memberJoinedAt, createdAt: Number(value.createdAt) || clock(), area: value.area === 'surprise' ? 'surprise' : 'main', qualification: value.qualification === 'entered' ? 'entered' : value.qualification === 'qualified' ? 'qualified' : 'ineligible', recoveries: Math.max(0, Number(value.recoveries) || 0), activeLinks: 0 });
      }
    }
  } catch { /* missing, invalid, or old team state starts safely empty */ }

  function currentTeams(now: number): TeamView[] {
    const active = new Set(line.state.nodeOrder.filter((id) =>
      (line.state.nodes[id]?.status === 'active' || line.state.phase === 'repair') && !offlineNodes.has(id),
    ));
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
      const leaderNodeId = prior?.leaderNodeId && members.includes(prior.leaderNodeId) ? prior.leaderNodeId : prior?.nameOwnerNodeId && members.includes(prior.nameOwnerNodeId) ? prior.nameOwnerNodeId : members[0]!;
      const memberJoinedAt = Object.fromEntries(members.map((id) => [id, prior?.memberJoinedAt[id] ?? line.state.nodes[id]!.createdAt]));
      const record: TeamRecord = { name: prior?.name ?? null, description: prior?.description ?? null, leaderNodeId, nameOwnerNodeId: prior?.nameOwnerNodeId ?? null, memberNodeIds: members, memberJoinedAt, createdAt: prior?.createdAt ?? now, area, qualification: prior?.qualification ?? 'ineligible', recoveries: prior?.recoveries ?? 0, activeLinks };
      if (candidates[0]) used.add(candidates[0][0]);
      next.set(teamId, record);
    }
    teamRecords.clear();
    for (const [id, record] of next) teamRecords.set(id, record);
    return [...next.entries()].map(([teamId, record]) => ({ teamId, roomId: teamId, ...record }));
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

  const broadcastMeshEvent = (event: MeshEvent): void => {
    for (const client of clients.values()) {
      if (client.ready) send(client.ws, { type: 'mesh_event', event });
    }
  };

  const liveNode = (nodeId: string, now: number): boolean =>
    [...clients.values()].some((client) =>
      client.ready &&
      client.nodeId === nodeId &&
      now - client.lastHeartbeatAt <= offlineTimeoutMs,
    );

  function removeOfflineNode(nodeId: string, now: number): void {
    if (offlineNodes.has(nodeId)) return;
    const node = line.state.nodes[nodeId];
    if (!node) return;

    const affected = currentTeams(now).filter((team) => team.memberNodeIds.includes(nodeId));
    offlineNodes.add(nodeId);
    for (const linkId of Object.keys(line.state.links)) {
      const link = line.state.links[linkId]!;
      if (link.a === nodeId || link.b === nodeId) delete line.state.links[linkId];
    }

    for (const team of affected) {
      const record = teamRecords.get(team.teamId);
      if (!record) continue;
      const previousLeader = record.leaderNodeId;
      record.memberNodeIds = record.memberNodeIds.filter((id) => id !== nodeId);
      delete record.memberJoinedAt[nodeId];
      if (previousLeader === nodeId) {
        const successor = record.memberNodeIds
          .filter((id) => !offlineNodes.has(id) && liveNode(id, now))
          .sort((a, b) => (record.memberJoinedAt[a] ?? Number.MAX_SAFE_INTEGER) - (record.memberJoinedAt[b] ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b))[0] ?? null;
        record.leaderNodeId = successor;
        record.nameOwnerNodeId = successor;
        if (successor) {
          broadcastMeshEvent({
            type: 'mesh.leader_changed',
            teamId: team.teamId,
            previousLeaderNodeId: nodeId,
            previousLeaderName: node.name,
            leaderNodeId: successor,
            leaderName: line.state.nodes[successor]?.name ?? successor,
          });
        }
      }
      broadcastMeshEvent({ type: 'mesh.member_removed', nodeId, name: node.name, teamId: team.teamId });
      syncSmoke(`/api/v1/internal/rooms/${encodeURIComponent(team.roomId)}/revoke`, {
        nodeId, reason: 'offline_timeout', occurredAt: new Date(now).toISOString(),
      }, `offline:${team.roomId}:${nodeId}:${now}`);
      if (record.leaderNodeId) {
        syncSmoke(`/api/v1/internal/rooms/${encodeURIComponent(team.roomId)}/role`, {
          nodeId: record.leaderNodeId, role: 'leader',
        }, `leader:${team.roomId}:${record.leaderNodeId}:${now}`);
      }
    }
    broadcastMeshEvent({ type: 'node.offline', nodeId, name: node.name, teamId: affected[0]?.teamId ?? null });
    line.save(persistPath);
    saveTeamState();
    broadcastSnapshot();
  }

  function checkOfflineNodes(now: number): void {
    currentTeams(now);
    const members = new Set<string>();
    for (const team of teamRecords.values()) {
      for (const member of team.memberNodeIds) members.add(member);
    }
    for (const nodeId of members) {
      if (offlineNodes.has(nodeId)) continue;
      const lastHeartbeat = [...clients.values()]
        .filter((client) => client.ready && client.nodeId === nodeId)
        .reduce((latest, client) => Math.max(latest, client.lastHeartbeatAt), line.state.nodes[nodeId]?.lastSeenAt ?? 0);
      if (lastHeartbeat > 0 && now - lastHeartbeat > offlineTimeoutMs) removeOfflineNode(nodeId, now);
    }
  }

  const deltaFor = (
    events: readonly WireEvent[],
    nodeId: string | null,
  ): ServerMessage => {
    const onlineNodeIds = new Set([...clients.values()].filter((client) => client.ready && client.nodeId).map((client) => client.nodeId as string));
    return {
      type: 'delta',
      v: PROTOCOL_VERSION,
      seq: line.seq,
      serverNow: clock(),
      phase: line.state.phase,
      phaseEndsAt: line.state.phaseEndsAt,
      roundNo: line.state.roundNo,
      events,
      you: toYou(line.state, config, nodeId, onlineNodeIds),
      lastScore: toScore(line.state),
      stats: toStats(line.state),
      packetMission,
      teams: currentTeams(clock()),
    };
  };

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
    if (supabase) void supabase.syncTeams(currentTeams(clock())).catch((error: unknown) => {
      console.error('Supabase team synchronization failed:', error instanceof Error ? error.message : 'unknown error');
    });
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

    if (url.pathname === '/api/profile/availability' && req.method === 'GET') {
      const username = validateUsername(url.searchParams.get('username') ?? '');
      if (!username) { json(res, 400, { available: false, error: 'INVALID_USERNAME' }); return; }
      const canonical = canonicalUsername(username);

      const takenInMemory = inFlightUsernames.has(canonical)
        || [...sessions.values()].some((s) => canonicalUsername(s.name) === canonical)
        || Object.values(line.state.nodes).some((n) => canonicalUsername(n.name) === canonical);

      if (takenInMemory) {
        json(res, 200, { available: false });
        return;
      }

      if (supabase) {
        try {
          const existing = await supabase.getProfileByUsername(canonical);
          json(res, 200, { available: !existing });
        } catch {
          json(res, 503, { available: false, error: 'PROFILE_LOOKUP_FAILED' });
        }
      } else {
        json(res, 200, { available: true });
      }
      return;
    }

    if ((url.pathname === '/api/profile/register' || url.pathname === '/api/profile/update') && req.method === 'POST') {
      if (!supabase) { json(res, 503, { error: 'Supabase is not configured' }); return; }
      const supplied = req.headers.authorization;
      const sessionToken = supplied?.startsWith('Bearer ') ? supplied.slice(7) : null;
      const session = sessionToken ? sessions.get(sessionToken) : undefined;
      if (!session) { json(res, 401, { error: 'valid NODES session token required' }); return; }
      const input = await readRequestJson(req);
      const rawUsername = String(input.username ?? '');
      const valid = validateUsername(rawUsername);
      if (!valid) { json(res, 400, { error: 'INVALID_USERNAME' }); return; }
      const canonical = canonicalUsername(valid);

      if (inFlightUsernames.has(canonical)) {
        json(res, 409, { error: 'USERNAME_TAKEN' });
        return;
      }

      const conflictInMemory = [...sessions.values()].some(
        (s) => s.nodeId !== session.nodeId && canonicalUsername(s.name) === canonical,
      ) || Object.values(line.state.nodes).some(
        (n) => n.id !== session.nodeId && canonicalUsername(n.name) === canonical,
      );
      if (conflictInMemory) {
        json(res, 409, { error: 'USERNAME_TAKEN' });
        return;
      }

      inFlightUsernames.add(canonical);
      try {
        const result = url.pathname.endsWith('/register')
          ? await supabase.registerUsername(session.nodeId, valid)
          : await supabase.updateUsername(session.nodeId, valid);
        if (!result.ok) {
          json(res, result.code === 'INVALID_USERNAME' ? 400 : 409, { error: result.code });
          return;
        }

        session.name = valid;
        if (line.state.nodes[session.nodeId]) {
          line.state.nodes[session.nodeId].name = valid;
        }
        saveSessions();
        broadcastSnapshot();

        json(res, 200, { profile: result.profile });
        return;
      } finally {
        inFlightUsernames.delete(canonical);
      }
    }

    if (url.pathname === '/api/integration/rooms/authorize' && req.method === 'POST') {
      const supplied = req.headers.authorization;
      const sessionToken = supplied?.startsWith('Bearer ') ? supplied.slice(7) : null;
      const session = sessionToken ? sessions.get(sessionToken) : undefined;
      if (!session) {
        json(res, 401, { error: 'valid NODES session token required' });
        return;
      }
      const input = await readRequestJson(req);
      const team = currentTeams(clock()).find((entry) =>
        entry.roomId === input.roomId && entry.memberNodeIds.includes(session.nodeId),
      );
      if (!team) {
        json(res, 403, { error: 'node is not an active member of this room' });
        return;
      }
      let accessToken: string | null;
      try {
        accessToken = issueSmokeToken(session.nodeId, team);
      } catch {
        json(res, 503, { error: 'Smoke token issuer configuration is invalid' });
        return;
      }
      if (!accessToken) {
        json(res, 503, { error: 'Smoke token issuer is not configured' });
        return;
      }
      json(res, 200, {
        authorized: true,
        roomId: team.roomId,
        teamId: team.teamId,
        teamName: team.name,
        nodeId: session.nodeId,
        role: team.leaderNodeId === session.nodeId ? 'leader' : 'member',
        accessToken,
      });
      return;
    }

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
      lastHeartbeatAt: clock(),
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
        client.lastHeartbeatAt = clock();
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
      if (message.type === 'ping') {
        client.lastHeartbeatAt = now;
        if (client.nodeId) {
          const node = line.state.nodes[client.nodeId];
          if (node) node.lastSeenAt = now;
        }
      }

      switch (message.type) {
        case 'join':
          void handleJoin(ws, client, message.name, now);
          return;

        case 'team_name':
          void handleTeamName(ws, client, message.teamId, message.name, message.description, now);
          return;

        case 'smoke_invite':
          handleSmokeInvite(ws, client, message.teamId, now);
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

  async function handleTeamName(ws: WebSocket, client: ClientConnection, rawTeamId: unknown, rawName: unknown, rawDescription: unknown, now: number): Promise<void> {
    if (!client.ready || !client.nodeId || typeof rawTeamId !== 'string' || typeof rawName !== 'string') {
      send(ws, { type: 'error', code: 'BAD_MESSAGE' });
      return;
    }

    const name = rawName.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{1,22}[\p{L}\p{N}]$/u.test(name)) {
      send(ws, { type: 'error', code: 'BAD_TEAM_NAME', message: 'Team names must be 3-24 letters, numbers, spaces, hyphens or underscores.' });
      return;
    }

    if (name.length > 24) {
      send(ws, { type: 'error', code: 'BAD_TEAM_NAME', message: 'Team names must be 3-24 characters.' });
      return;
    }
    const description = typeof rawDescription === 'string'
      ? rawDescription.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160)
      : '';
    const teams = currentTeams(now);
    const team = teams.find((entry) => entry.teamId === rawTeamId);
    if (!team || team.leaderNodeId !== client.nodeId) {
      send(ws, { type: 'error', code: 'TEAM_NOT_FOUND' });
      return;
    }
    const record = teamRecords.get(team.teamId);
    if (!record) {
      send(ws, { type: 'error', code: 'TEAM_NOT_FOUND' });
      return;
    }
    const duplicate = teams.some((entry) =>
      entry.teamId !== team.teamId &&
      entry.name !== null &&
      entry.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0,
    );
    if (duplicate) {
      send(ws, { type: 'error', code: 'TEAM_NAME_TAKEN' });
      return;
    }
    if (supabase) {
      try {
        const existing = await supabase.getTeamByName(name);
        if (existing && existing.team_id !== team.teamId) {
          send(ws, { type: 'error', code: 'TEAM_NAME_TAKEN' });
          return;
        }
      } catch {
        send(ws, { type: 'error', code: 'TEAM_NAME_LOOKUP_FAILED' });
        return;
      }
    }
    if (record.name === null || record.leaderNodeId === client.nodeId) {
      record.name = sanitizeName(name);
      record.description = description || null;
      saveTeamState();
      syncSmoke(`/api/v1/internal/rooms/${encodeURIComponent(team.roomId)}/team`, {
        teamId: team.teamId, teamName: record.name,
      }, `team:${team.teamId}:${record.name}:${now}`);
      broadcastSnapshot();
    }
  }

  function handleSmokeInvite(ws: WebSocket, client: ClientConnection, rawTeamId: unknown, now: number): void {
    if (!client.ready || !client.nodeId || typeof rawTeamId !== 'string') {
      send(ws, { type: 'error', code: 'BAD_MESSAGE' });
      return;
    }
    const team = currentTeams(now).find((entry) => entry.teamId === rawTeamId);
    if (!team || !team.memberNodeIds.includes(client.nodeId)) {
      send(ws, { type: 'error', code: 'SMOKE_INVITE_NOT_AUTHORIZED' });
      return;
    }
    const fromName = line.state.nodes[client.nodeId]?.name ?? client.nodeId;
    for (const memberNodeId of team.memberNodeIds) {
      if (memberNodeId === client.nodeId) continue;
      sendToNode(memberNodeId, {
        type: 'smoke_invite',
        teamId: team.teamId,
        roomId: team.roomId,
        teamName: team.name ?? team.teamId,
        fromNodeId: client.nodeId,
        fromName,
      });
    }
  }

  async function handleJoin(ws: WebSocket, client: ClientConnection, rawName: unknown, now: number): Promise<void> {
    if (client.sessionId) {
      send(ws, snapshotFor(client));
      return;
    }
    if (client.spectator) {
      send(ws, { type: 'error', code: 'SPECTATOR_READ_ONLY' });
      return;
    }

    const isTaken = (cand: string): boolean => {
      const c = canonicalUsername(cand);
      if (inFlightUsernames.has(c)) return true;
      for (const s of sessions.values()) {
        if (canonicalUsername(s.name) === c) return true;
      }
      for (const n of Object.values(line.state.nodes)) {
        if (canonicalUsername(n.name) === c) return true;
      }
      return false;
    };

    let name: string;
    const rawStr = typeof rawName === 'string' ? rawName.normalize('NFKC').trim() : '';

    if (!rawStr) {
      const nextSeq = line.state.nodeSeq + 1;
      name = generateFallbackUsername(`Player_${nextSeq}`, isTaken);
    } else {
      const sanitized = rawStr.replace(/\s+/g, '_');
      const valid = validateUsername(sanitized);
      if (!valid) {
        send(ws, { type: 'error', code: 'INVALID_USERNAME' });
        return;
      }
      name = valid;
    }

    const canonical = canonicalUsername(name);

    if (isTaken(name)) {
      send(ws, { type: 'error', code: 'USERNAME_TAKEN' });
      return;
    }

    inFlightUsernames.add(canonical);

    try {
      if (supabase) {
        try {
          const existing = await supabase.getProfileByUsername(canonical);
          if (existing) {
            send(ws, { type: 'error', code: 'USERNAME_TAKEN' });
            return;
          }
        } catch {
          // best-effort lookup
        }
      }

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

      if (supabase) {
        try {
          const reg = await supabase.registerUsername(joined.nodeId, name);
          if (!reg.ok && reg.code === 'USERNAME_TAKEN') {
            metrics.rejected++;
            send(ws, { type: 'error', code: 'USERNAME_TAKEN' });
            return;
          }
        } catch {
          // best-effort persistence
        }
      }

      client.sessionId = sessionId;
      client.nodeId = joined.nodeId;
      client.ready = true;
      client.lastHeartbeatAt = now;
      sessions.set(token, { sessionId, nodeId: joined.nodeId, name });
      saveSessions();

      send(ws, { type: 'welcome', v: PROTOCOL_VERSION, token, lineId: line.state.id, spectator: false });
      send(ws, snapshotFor(client));

      // Everyone else learns about the new node by delta. A join creates no edge.
      broadcastEvents(out.events as unknown as WireEvent[]);
    } finally {
      inFlightUsernames.delete(canonical);
    }
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

    const existingTeamIds = new Set(currentTeams(now).map((team) => team.teamId));
    const wasRemoved = offlineNodes.has(request.fromNodeId);
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
      offlineNodes.delete(request.fromNodeId);
      resolveRequest(request, 'accepted', { linkId: result.linkId });
      metrics.accepted++;
      metrics.requestAccepted++;
      const team = currentTeams(now).find((entry) =>
        entry.memberNodeIds.includes(request.fromNodeId) &&
        entry.memberNodeIds.includes(request.toNodeId),
      );
      const teamRecord = team ? teamRecords.get(team.teamId) : undefined;
      if (teamRecord && team && !existingTeamIds.has(team.teamId)) {
        teamRecord.leaderNodeId = request.fromNodeId;
        teamRecord.nameOwnerNodeId = request.fromNodeId;
        saveTeamState();
      }
      if (teamRecord && team && wasRemoved) {
        teamRecord.memberJoinedAt[request.fromNodeId] = now;
      }
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
    checkOfflineNodes(started);
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

async function readRequestJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function sanitizeName(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  if (!cleaned) return `Visitor ${Math.floor(Math.random() * 900 + 100)}`;
  return PROFANITY.some((word) => cleaned.toLowerCase().includes(word)) ? 'Guest' : cleaned;
}

/** Deliberately tiny for V1; a real list/loader is a documented gap. */
const PROFANITY = ['fuck', 'shit', 'bitch'];
