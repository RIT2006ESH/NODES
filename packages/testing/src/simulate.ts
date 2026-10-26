/**
 * Phase 1 bot simulation.
 *
 * Plays whole rounds with random-but-legal bots to produce the simulation
 * artifact required by the Phase 1 gate: score distribution, rejection mix,
 * restored routes, and invariant checks. It is also the determinism smoke test:
 * rerunning with the same seed must reproduce the same digest.
 *
 * Run: npm run simulate
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadDefaultConfig } from '@mng/config';
import { Rng, activeNodeIds, components, createLine, reduce, stateHash } from '@mng/engine';
import type { LineState, RoundResult } from '@mng/engine';

const LINES = 8;
const BOTS_PER_LINE = 80;
const TARGET_ROUNDS = 12;
const STEP_MS = 1000;
const MAX_STEPS = 60_000;

const config = loadDefaultConfig();
const startedAt = Date.now();

interface LineOutcome {
  readonly line: string;
  readonly seed: number;
  readonly scores: number[];
  readonly rounds: RoundResult[];
  readonly restoredRoutes: number;
  readonly reasons: Record<string, number>;
  readonly violations: string[];
  readonly digest: string;
  readonly durationMs: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx] as number;
}

function simulateLine(index: number): LineOutcome {
  const seed = 0x1000 + index;
  const rng = new Rng(seed);
  const lineId = `L${index + 1}`;
  let state: LineState = createLine(lineId, seed, config, 0);

  const sessions: string[] = [];
  const scores: number[] = [];
  const rounds: RoundResult[] = [];
  const reasons: Record<string, number> = {};
  const violations: string[] = [];
  let t = 0;
  let steps = 0;

  while (state.roundsSurvived < TARGET_ROUNDS && steps < MAX_STEPS) {
    steps++;
    t += STEP_MS;

    if (sessions.length < BOTS_PER_LINE) {
      const sessionId = `s${index}-${sessions.length}`;
      const out = reduce(state, { type: 'join', sessionId, name: `bot${index}-${sessions.length}` }, config, t);
      state = out.state;
      sessions.push(sessionId);
    }

    // Bots act on a fixed cadence so runs are reproducible.
    for (let bot = 0; bot < sessions.length; bot++) {
      if ((steps + bot) % 8 !== 0) continue;
      const active = activeNodeIds(state);
      if (active.length < 2) continue;

      const a = rng.pick(active);
      let b = rng.pick(active);
      if (a === b) continue;

      // In Repair, prefer pairs that are currently disconnected: that is the
      // behaviour the game wants to teach, and it exercises restored routes.
      if (state.phase === 'repair' && rng.nextUint32() % 100 < 70) {
        const comps = components(state);
        const from = comps.find((c) => c.nodes.includes(a));
        const outside = comps.filter((c) => c !== from);
        if (outside.length > 0) {
          const target = rng.pick(outside);
          b = rng.pick(target.nodes);
        }
      }
      if (a === b) continue;

      const requestId = `r${index}-${t}-${bot}`;
      const out = reduce(state, { type: 'create_link', requestId, sessionId: sessions[bot] as string, a, b }, config, t);
      state = out.state;
      const result = out.result;
      if (result && 'reason' in result && result.ok === false) {
        reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
      }
    }

    const out = reduce(state, { type: 'tick' }, config, t);
    state = out.state;
    for (const ev of out.events) {
      if (ev.type === 'round.scored') {
        scores.push(ev.result.score);
        rounds.push(ev.result);
      }
    }

    // Invariant sweep (cheap, on every step, independent of the engine).
    for (const id of state.nodeOrder) {
      const node = state.nodes[id];
      if (!node) continue;
      if (node.tokens < 0 || node.tokens > config.links.maxTokens) {
        violations.push(`tokens out of range on ${id}`);
      }
      let degree = 0;
      for (const lid in state.links) {
        const l = state.links[lid];
        if (l && (l.a === id || l.b === id)) degree++;
      }
      if (degree > config.links.degreeCap) violations.push(`degree ${degree} on ${id}`);
    }
  }

  const restoredRoutes = Object.values(state.nodes).reduce((sum, n) => sum + n.restoredRoutes, 0);

  return {
    line: lineId,
    seed,
    scores,
    rounds,
    restoredRoutes,
    reasons,
    violations: [...new Set(violations)].slice(0, 10),
    digest: stateHash(state),
    durationMs: t,
  };
}

const outcomes = Array.from({ length: LINES }, (_, i) => simulateLine(i));
const allScores = outcomes.flatMap((o) => o.scores).sort((a, b) => a - b);
const totalRounds = allScores.length;
const mean = totalRounds === 0 ? 0 : allScores.reduce((a, b) => a + b, 0) / totalRounds;

const histogram: Record<string, number> = {};
for (const score of allScores) {
  const bucket = `${Math.floor(score / 10) * 10}-${Math.floor(score / 10) * 10 + 9}`;
  histogram[bucket] = (histogram[bucket] ?? 0) + 1;
}

const reasonTotals: Record<string, number> = {};
for (const o of outcomes) {
  for (const [reason, count] of Object.entries(o.reasons)) {
    reasonTotals[reason] = (reasonTotals[reason] ?? 0) + count;
  }
}

const summary = {
  generatedAt: new Date().toISOString(),
  engineVersion: '0.1.0',
  config: {
    phases: config.phases,
    degreeCap: config.links.degreeCap,
    maxTokens: config.links.maxTokens,
    tokenRegenMs: config.links.tokenRegenMs,
    seedThreshold: config.line.seedThreshold,
  },
  simulation: {
    lines: LINES,
    botsPerLine: BOTS_PER_LINE,
    targetRounds: TARGET_ROUNDS,
    stepMs: STEP_MS,
  },
  totals: {
    rounds: totalRounds,
    scores: {
      mean: Number(mean.toFixed(2)),
      min: allScores[0] ?? 0,
      p50: percentile(allScores, 50),
      p90: percentile(allScores, 90),
      max: allScores[allScores.length - 1] ?? 0,
    },
    histogram,
    restoredRoutes: outcomes.reduce((sum, o) => sum + o.restoredRoutes, 0),
    rejections: reasonTotals,
    invariantViolations: outcomes.reduce((sum, o) => sum + o.violations.length, 0),
  },
  determinism: {
    note: 'Rerun `npm run simulate` with the same seed set; every digest below must be identical.',
    digests: outcomes.map((o) => ({ line: o.line, seed: o.seed, digest: o.digest })),
  },
  lines: outcomes.map((o) => ({
    line: o.line,
    seed: o.seed,
    rounds: o.scores.length,
    durationMs: o.durationMs,
    meanScore: o.scores.length === 0 ? 0 : Number((o.scores.reduce((a, b) => a + b, 0) / o.scores.length).toFixed(2)),
    restoredRoutes: o.restoredRoutes,
    violations: o.violations,
  })),
};

const outDir = fileURLToPath(new URL('../../../reports/', import.meta.url));
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}phase1-simulation.json`, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

const md = [
  '# Phase 1 simulation report',
  '',
  `Generated ${summary.generatedAt} in ${Date.now() - startedAt} ms.`,
  '',
  '> Targets are targets. These numbers describe bot play in the rules engine, not real players and not capacity.',
  '',
  '## Setup',
  '',
  `- Lines: ${LINES}, bots per line: ${BOTS_PER_LINE}, target rounds per line: ${TARGET_ROUNDS}`,
  `- Phase durations: ${JSON.stringify(config.phases)}`,
  `- Degree cap ${config.links.degreeCap}, ${config.links.maxTokens} tokens, ${config.links.tokenRegenMs} ms regen`,
  '',
  '## Scores',
  '',
  `- Rounds scored: ${totalRounds}`,
  `- Mean ${summary.totals.scores.mean}, min ${summary.totals.scores.min}, p50 ${summary.totals.scores.p50}, p90 ${summary.totals.scores.p90}, max ${summary.totals.scores.max}`,
  '',
  '| Bucket | Rounds |',
  '| --- | --- |',
  ...Object.entries(histogram)
    .sort(([a], [b]) => Number(a.split('-')[0]) - Number(b.split('-')[0]))
    .map(([bucket, count]) => `| ${bucket} | ${count} |`),
  '',
  '## Behaviour',
  '',
  `- Restored routes created: ${summary.totals.restoredRoutes}`,
  `- Invariant violations: ${summary.totals.invariantViolations}`,
  '',
  '### Rejections',
  '',
  '| Reason | Count |',
  '| --- | --- |',
  ...Object.entries(reasonTotals)
    .sort(([, a], [, b]) => b - a)
    .map(([reason, count]) => `| ${reason} | ${count} |`),
  '',
  '## Determinism',
  '',
  '| Line | Seed | Digest |',
  '| --- | --- | --- |',
  ...outcomes.map((o) => `| ${o.line} | ${o.seed} | ${o.digest} |`),
  '',
].join('\n');

writeFileSync(`${outDir}phase1-simulation.md`, md, 'utf8');

console.log(md);
console.log(`Wrote ${outDir}phase1-simulation.json and .md`);
