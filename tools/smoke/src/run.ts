/**
 * Live-loop smoke test against a running server.
 *
 * It joins real players, then waits for a complete round and asserts the
 * observable sequence: outage → repair → score → recovery → results.
 * Exits non-zero if the loop does not complete within the timeout.
 *
 *   BASE_URL=http://127.0.0.1:8080 npm run smoke
 */

import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage, WireEvent } from '@mng/protocol';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8080';
const WS_BASE = BASE.replace(/^http/, 'ws');
const PLAYERS = Math.max(6, Number(process.env.PLAYERS) || 6);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 240_000;

const phases: string[] = [];
let score: { score: number; c: number; b: number; s2: number } | null = null;
let strike: { type: string; nodes: string[]; links: string[] } | null = null;
let outageAt = 0;
let scoredAt = 0;

// Only one socket reports, so events are not counted six times.
// A round only counts if outage, score and recovery all belong to that round.
let recording = false;
let currentRound = 0;
let outageRound: number | null = null;
let scoredRound: number | null = null;
let recoveredRound: number | null = null;

const sockets: WebSocket[] = [];
const nodes = new Set<string>();

function log(message: string): void {
  console.log(`[smoke] ${message}`);
}

async function join(name: string): Promise<void> {
  const reporter = sockets.length === 0;
  const ws = new WebSocket(`${WS_BASE}/ws`);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  ws.send(JSON.stringify({ type: 'join', name } satisfies ClientMessage));

  ws.on('message', (raw) => {
    if (!reporter) return;
    let message: ServerMessage;
    try {
      message = JSON.parse(String(raw)) as ServerMessage;
    } catch {
      return;
    }

    if (message.type === 'snapshot') {
      for (const node of message.nodes) nodes.add(node.id);
      return;
    }
    if (message.type !== 'delta') return;

    for (const event of message.events as WireEvent[]) {
      switch (event.type) {
        case 'node.joined':
          nodes.add(String(event.nodeId));
          break;

        case 'line.phase': {
          const phase = String(event.phase);
          currentRound = Number(event.roundNo);
          phases.push(phase);
          log(`phase → ${phase} (round ${currentRound})`);
          if (phase === 'build') {
            recording = true;
            outageRound = null;
            scoredRound = null;
            recoveredRound = null;
            strike = null;
            outageAt = 0;
            scoredAt = 0;          }
          break;
        }

        case 'outage.applied': {
          if (!recording) break;
          const s = event.strike as { type: string; nodes: string[]; links: string[] };
          strike = s;
          outageRound = currentRound;
          outageAt = Date.now();
          log(`outage ${s.type}: ${s.nodes.length} nodes, ${s.links.length} links disabled/cut`);
          break;
        }

        case 'round.scored': {
          if (!recording) break;
          const result = event.result as {
            roundNo: number;
            score: number;
            c: { num: number; den: number };
            b: { num: number; den: number };
            s2: number;
          };
          score = {
            score: result.score,
            c: result.c.num / result.c.den,
            b: result.b.num / result.b.den,
            s2: result.s2,
          };
          scoredRound = result.roundNo;
          scoredAt = Date.now();
          log(
            `scored ${result.score.toFixed(1)} (C=${(result.c.num / result.c.den).toFixed(3)}, B=${(
              result.b.num / result.b.den
            ).toFixed(3)}, S2=${result.s2})`,
          );
          break;
        }

        case 'round.recovered':
          if (!recording) break;          recoveredRound = currentRound;
          log(`recovered ${String(event.nodes)} nodes, ${String(event.links)} links`);
          break;
      }
    }
  });
}

async function main(): Promise<void> {
  log(`connecting ${PLAYERS} players to ${BASE}`);
  for (let i = 0; i < PLAYERS; i++) {
    await join(`smoke ${Date.now() % 10_000}-${i}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  log(`${nodes.size} nodes known to this client`);

  const started = Date.now();
  const completeRound = (): boolean =>
    outageRound !== null && outageRound === scoredRound && outageRound === recoveredRound;

  while (Date.now() - started < TIMEOUT_MS) {
    if (completeRound()) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const failures: string[] = [];
  if (!recording) failures.push('never saw a build phase to start a round');
  if (outageRound === null) failures.push('no outage.applied observed');
  if (scoredRound === null) failures.push('no round.scored observed');
  if (recoveredRound === null) failures.push('no round.recovered observed');
  if (outageRound !== null && (outageRound !== scoredRound || outageRound !== recoveredRound)) {
    failures.push(
      `events came from different rounds (outage ${String(outageRound)}, score ${String(
        scoredRound,
      )}, recovery ${String(recoveredRound)})`,
    );
  }
  if (strike && strike.nodes.length === 0 && strike.links.length === 0) {
    failures.push('outage had no targets');
  }
  if (score && (score.score < 0 || score.score > 100)) failures.push(`score out of range: ${score.score}`);
  if (!phases.includes('build')) failures.push('never saw build');

  if (failures.length > 0) {
    log(`FAIL: ${failures.join('; ')}`);
    log(`phases seen: ${[...new Set(phases)].join(', ')}`);
    process.exitCode = 1;
  } else {
    log(`PASS: round ${String(outageRound)} completed end to end`);
    log(`phases seen: ${[...new Set(phases)].join(', ')}`);
    log(`score: ${score ? score.score.toFixed(1) : 'n/a'}`);
    log(
      `outage → score in ${((scoredAt - outageAt) / 1000).toFixed(1)}s` +
        ' (repair is 35 s in the default config)',
    );
  }

  for (const ws of sockets) ws.close();
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
