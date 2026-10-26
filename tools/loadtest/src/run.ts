/**
 * Synthetic load test. Measures what actually happens: handshake time, action
 * round-trip latency, rejection mix, bandwidth and server-side tick time.
 *
 * Usage:
 *   CLIENTS=100 DURATION_MS=60000 npm run loadtest
 *   BASE_URL=https://your-host CLIENTS=100 npm run loadtest
 *
 * It does not claim capacity beyond what it measures.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import type { ServerMessage } from '@mng/protocol';

const env = process.env;
const BASE = env.BASE_URL ?? 'http://127.0.0.1:8080';
const WS_BASE = BASE.replace(/^http/, 'ws');
const CLIENTS = num(env.CLIENTS, 50);
const DURATION_MS = num(env.DURATION_MS, 45_000);
const RAMP_MS = num(env.RAMP_MS, 2000);
const THINK_MS = num(env.THINK_MS, 1000);
const MOVE_MS = env.MOVE_MS === undefined ? 0 : Math.max(0, Number(env.MOVE_MS) || 0);
const PREFIX = env.NAME_PREFIX ?? 'bot';

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

interface Metrics {
  startedAt: number;
  connections: number;
  joins: number;
  actions: number;
  accepted: number;
  rejected: number;
  ticks: number;
  lastTickMs: number;
  connectionsNow: number;
  nodes: number;
  links: number;
  phase: string;
  roundNo: number;
  moves: number;
}

interface BotResult {
  id: string;
  joined: boolean;
  nodeId: string | null;
  handshakeMs: number | null;
  actionsSent: number;
  movesSent: number;
  latencies: number[];
  bytes: number;
  messages: number;
  rejections: Record<string, number>;
  errors: string[];
}

interface Bot {
  index: number;
  ws: WebSocket;
  result: BotResult;
  nodeId: string | null;
  nodes: Set<string>;
  pending: Map<string, number>;
  /** Send time waiting for the server to assign a request id. */
  lastRequestAt: number | null;
  timer: NodeJS.Timeout | null;
  moveTimer: NodeJS.Timeout | null;
  ping: NodeJS.Timeout | null;
  radius: number;
  finished: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchMetrics(): Promise<Metrics> {
  const res = await fetch(`${BASE}/metrics`);
  return (await res.json()) as Metrics;
}

async function runBot(index: number): Promise<Bot> {
  const result: BotResult = {
    id: `${PREFIX}-${index}`,
    joined: false,
    nodeId: null,
    handshakeMs: null,
    actionsSent: 0,
    movesSent: 0,
    latencies: [],
    bytes: 0,
    messages: 0,
    rejections: {},
    errors: [],
  };

  const ws = new WebSocket(`${WS_BASE}/ws`);
  const bot: Bot = {
    index,
    ws,
    result,
    nodeId: null,
    nodes: new Set(),
    pending: new Map(),
    lastRequestAt: null,
    timer: null,
    moveTimer: null,
    ping: null,
    radius: 1400,
    finished: false,
  };

  const joinStarted = performance.now();

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'join', name: `${PREFIX} ${index}` }));
  });

  ws.on('message', (raw) => {
    const text = String(raw);
    result.bytes += Buffer.byteLength(text);
    result.messages++;

    let message: ServerMessage;
    try {
      message = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }

    switch (message.type) {
      case 'snapshot':
        for (const node of message.nodes) bot.nodes.add(node.id);
        if (!bot.result.joined) {
          bot.result.joined = true;
          bot.result.handshakeMs = performance.now() - joinStarted;
          bot.result.nodeId = message.you.nodeId;
          bot.nodeId = message.you.nodeId;
          bot.radius = message.config.movement.worldRadius;
          startActing(bot);
        }
        break;

      case 'delta':
        for (const event of message.events) {
          if (event.type === 'node.joined') bot.nodes.add(String(event.nodeId));
        }
        break;

      case 'link_request':
        // Every bot is both a requester and a target. Consent still goes through
        // the real protocol: the target explicitly accepts the named request.
        if (bot.ws.readyState === WebSocket.OPEN) {
          bot.ws.send(
            JSON.stringify({
              type: 'respond_link',
              requestId: message.request.requestId,
              accept: true,
            }),
          );
        }
        break;

      case 'request_result': {
        if (message.status === 'pending') {
          const sentAt = bot.lastRequestAt;
          if (sentAt !== null) {
            bot.pending.set(message.request.requestId, sentAt);
            bot.lastRequestAt = null;
          }
        } else {
          let sentAt = bot.pending.get(message.request.requestId);
          if (
            sentAt === undefined &&
            message.request.fromNodeId === bot.nodeId &&
            bot.lastRequestAt !== null
          ) {
            sentAt = bot.lastRequestAt;
          }
          if (sentAt !== undefined) {
            bot.pending.delete(message.request.requestId);
            result.latencies.push(performance.now() - sentAt);
          }
          if (message.request.fromNodeId === bot.nodeId) bot.lastRequestAt = null;
          if (message.status === 'failed') {
            const reason = message.reason ?? 'SERVER_ERROR';
            result.rejections[reason] = (result.rejections[reason] ?? 0) + 1;
          }
        }
        break;
      }

      case 'error':
        result.errors.push(message.code);
        break;
    }
  });

  ws.on('error', (error) => {
    result.errors.push(`socket: ${error.message}`);
  });

  ws.on('close', () => {
    if (bot.timer) clearInterval(bot.timer);
    if (bot.moveTimer) clearInterval(bot.moveTimer);
    if (bot.ping) clearInterval(bot.ping);
  });

  return bot;
}

function startActing(bot: Bot): void {
  if (bot.finished || !bot.nodeId) return;

  bot.ping = setInterval(() => {
    if (bot.ws.readyState === WebSocket.OPEN) bot.ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
  }, 10_000);

  if (MOVE_MS > 0) {
    bot.moveTimer = setInterval(() => {
      if (bot.finished || bot.ws.readyState !== WebSocket.OPEN) return;
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.sqrt(Math.random()) * bot.radius * 0.95;
      bot.result.movesSent++;
      bot.ws.send(
        JSON.stringify({
          type: 'move',
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
        }),
      );
    }, MOVE_MS);
  }

  bot.timer = setInterval(() => {
    if (bot.finished || bot.ws.readyState !== WebSocket.OPEN || !bot.nodeId) return;
    // One outstanding request per bot keeps latency attribution unambiguous.
    if (bot.pending.size > 0 || bot.lastRequestAt !== null) return;
    const candidates = [...bot.nodes].filter((id) => id !== bot.nodeId);
    if (candidates.length === 0) return;

    const target = candidates[Math.floor(Math.random() * candidates.length)] as string;
    bot.result.actionsSent++;
    bot.lastRequestAt = performance.now();
    bot.ws.send(JSON.stringify({ type: 'request_link', targetNodeId: target }));
  }, THINK_MS);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] as number;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function main(): Promise<void> {
  const before = await fetchMetrics();
  const startedAt = new Date();
  console.log(
    `load test: ${CLIENTS} clients, ${DURATION_MS / 1000}s, ramp ${RAMP_MS}ms, think ${THINK_MS}ms, move ${MOVE_MS}ms -> ${BASE}`,
  );

  const bots: Bot[] = [];
  const stagger = CLIENTS > 1 ? RAMP_MS / CLIENTS : 0;

  for (let i = 0; i < CLIENTS; i++) {
    bots.push(await runBot(i));
    if (stagger > 0) await sleep(stagger);
  }

  // Let the last joins settle, then measure for the configured window.
  await sleep(Math.max(1000, RAMP_MS));
  const measureStart = performance.now();
  await sleep(DURATION_MS);
  const measuredForMs = performance.now() - measureStart;

  for (const bot of bots) {
    bot.finished = true;
    if (bot.timer) clearInterval(bot.timer);
    if (bot.moveTimer) clearInterval(bot.moveTimer);
    if (bot.ping) clearInterval(bot.ping);
    bot.ws.close();
  }
  await sleep(500);

  const after = await fetchMetrics();
  const results = bots.map((bot) => bot.result);
  const joined = results.filter((r) => r.joined);
  const latencies = results.flatMap((r) => r.latencies);
  const handshakes = joined.flatMap((r) => (r.handshakeMs === null ? [] : [r.handshakeMs]));
  const rejections: Record<string, number> = {};
  const movesSent = results.reduce((sum, r) => sum + r.movesSent, 0);
  for (const r of results) {
    for (const [reason, count] of Object.entries(r.rejections)) {
      rejections[reason] = (rejections[reason] ?? 0) + count;
    }
  }

  const totalBytes = results.reduce((sum, r) => sum + r.bytes, 0);
  const totalMessages = results.reduce((sum, r) => sum + r.messages, 0);
  const errors = results.flatMap((r) => r.errors);

  const report = {
    startedAt: startedAt.toISOString(),
    baseUrl: BASE,
    configured: { clients: CLIENTS, durationMs: DURATION_MS, rampMs: RAMP_MS, thinkMs: THINK_MS, moveMs: MOVE_MS },
    measuredForMs: Math.round(measuredForMs),
    clients: {
      requested: CLIENTS,
      joined: joined.length,
      failed: CLIENTS - joined.length,
    },
    handshakeMs: {
      p50: round(percentile(handshakes, 50), 1),
      p95: round(percentile(handshakes, 95), 1),
      max: round(Math.max(0, ...handshakes), 1),
    },
    actions: {
      sent: results.reduce((sum, r) => sum + r.actionsSent, 0),
      answered: latencies.length,
      accepted: after.accepted - before.accepted,
      rejectedByReason: rejections,
      latencyMs: {
        p50: round(percentile(latencies, 50), 1),
        p95: round(percentile(latencies, 95), 1),
        p99: round(percentile(latencies, 99), 1),
        max: round(Math.max(0, ...latencies), 1),
      },
      throughputPerSec: round((latencies.length / measuredForMs) * 1000, 1),
    },
    traffic: {
      totalBytes,
      bytesPerClientPerSec: joined.length
        ? round(totalBytes / joined.length / (measuredForMs / 1000), 1)
        : 0,
      messages: totalMessages,
    },
    movement: {
      sent: movesSent,
      serverMoves: after.moves - before.moves,
    },
    server: {
      phase: after.phase,
      roundNo: after.roundNo,
      nodes: after.nodes,
      links: after.links,
      connectionsNow: after.connectionsNow,
      ticksDuringTest: after.ticks - before.ticks,
      lastTickMs: after.lastTickMs,
      actionsHandled: after.actions - before.actions,
      movesHandled: after.moves - before.moves,
    },
    errors: errors.slice(0, 20),
    errorCount: errors.length,
  };

  const outDir = fileURLToPath(new URL('../../../reports', import.meta.url));
  mkdirSync(outDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  writeFileSync(`${outDir}/loadtest-${stamp}.json`, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(`${outDir}/loadtest-latest.json`, JSON.stringify(report, null, 2), 'utf8');

  console.log(JSON.stringify(report, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
