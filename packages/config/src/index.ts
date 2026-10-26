/**
 * Single source of tunables (PRD Section 0 rule 6).
 *
 * Every number that designers may want to change lives in game.config.json and
 * is validated here at boot. No tunable constant is allowed in engine code.
 *
 * C-01 ruling (owner-approved 2026-10-26): the outage caps in PRD 6.6.1 are
 * absolute. Difficulty may never add strike targets, so
 * `difficulty.nodeBonusPer5Rounds` is pinned to 0 and rejected if raised.
 */

import { readFileSync } from 'node:fs';

export interface GameConfig {
  readonly version: 1;
  readonly line: {
    readonly capacity: number;
    readonly seedThreshold: number;
  };
  readonly phases: {
    readonly seeding: number;
    readonly build: number;
    readonly warning: number;
    readonly repair: number;
    readonly result: number;
  };
  readonly links: {
    readonly degreeCap: number;
    readonly maxTokens: number;
    readonly tokenRegenMs: number;
    readonly maxPendingActions: number;
    /** How long a pending connection request remains acceptable. */
    readonly requestTtlMs: number;
  };
  readonly outage: {
    readonly cableCutMaxLinks: number;
    readonly regionalMaxNodes: number;
    readonly typeWeights: { readonly A: number; readonly B: number; readonly C: number };
  };
  readonly difficulty: {
    /** Pinned to 0 by the C-01 ruling. Kept so the decision is visible and testable. */
    readonly nodeBonusPer5Rounds: number;
  };
  readonly scoring: {
    readonly weightC: number;
    readonly weightB: number;
    readonly weightS: number;
    readonly speedThresholdNum: number;
    readonly speedThresholdDen: number;
    readonly speedHalfPointMs: number;
  };
  readonly layout: {
    readonly spacing: number;
    readonly goldenAngle: number;
    readonly margin: number;
  };
  readonly movement: {
    /** Circular world boundary around the origin, in world units. */
    readonly worldRadius: number;
    /** Server speed clamp, world units per second (anti-teleport, not a game rule). */
    readonly maxSpeed: number;
    /** Maximum accepted move messages per session per second. */
    readonly maxMessagesPerSecond: number;
  };
  readonly sync: {
    readonly tickHz: number;
    readonly replayBufferEvents: number;
  };
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid game config:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

const isPosInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function validateConfig(raw: unknown): GameConfig {
  const problems: string[] = [];
  const c = raw as Partial<GameConfig> | null;

  if (!c || typeof c !== 'object') throw new ConfigError(['config must be a JSON object']);
  if (c.version !== 1) problems.push('version must be 1');

  const line = c.line ?? ({} as GameConfig['line']);
  const phases = c.phases ?? ({} as GameConfig['phases']);
  const links = c.links ?? ({} as GameConfig['links']);
  const outage = c.outage ?? ({} as GameConfig['outage']);
  const difficulty = c.difficulty ?? ({} as GameConfig['difficulty']);
  const scoring = c.scoring ?? ({} as GameConfig['scoring']);
  const layout = c.layout ?? ({} as GameConfig['layout']);
  const movement = c.movement ?? ({} as GameConfig['movement']);
  const sync = c.sync ?? ({} as GameConfig['sync']);

  if (!isPosInt(line.capacity)) problems.push('line.capacity must be a positive integer');
  if (!isPosInt(line.seedThreshold)) problems.push('line.seedThreshold must be a positive integer');
  if (isPosInt(line.capacity) && isPosInt(line.seedThreshold) && line.seedThreshold > line.capacity) {
    problems.push('line.seedThreshold must not exceed line.capacity');
  }
  if (isPosInt(line.capacity) && line.capacity > 400) {
    problems.push('line.capacity must not exceed 400 (PRD 6.1)');
  }

  for (const key of ['seeding', 'build', 'warning', 'repair', 'result'] as const) {
    if (!isPosInt(phases[key])) problems.push(`phases.${key} must be a positive integer (ms)`);
  }

  if (!isPosInt(links.degreeCap) || links.degreeCap < 2) {
    problems.push('links.degreeCap must be an integer >= 2');
  }
  if (!isPosInt(links.maxTokens)) problems.push('links.maxTokens must be a positive integer');
  if (!isPosInt(links.tokenRegenMs)) problems.push('links.tokenRegenMs must be a positive integer (ms)');
  if (!isPosInt(links.maxPendingActions)) {
    problems.push('links.maxPendingActions must be a positive integer');
  }
  if (!isPosInt(links.requestTtlMs)) {
    problems.push('links.requestTtlMs must be a positive integer (ms)');
  }

  if (!isPosInt(outage.cableCutMaxLinks)) problems.push('outage.cableCutMaxLinks must be a positive integer');
  if (!isPosInt(outage.regionalMaxNodes)) problems.push('outage.regionalMaxNodes must be a positive integer');
  const w = outage.typeWeights ?? ({} as GameConfig['outage']['typeWeights']);
  for (const k of ['A', 'B', 'C'] as const) {
    if (!isNum(w[k]) || w[k] < 0) problems.push(`outage.typeWeights.${k} must be a number >= 0`);
  }

  if (!isNum(difficulty.nodeBonusPer5Rounds)) {
    problems.push('difficulty.nodeBonusPer5Rounds must be a number');
  } else if (difficulty.nodeBonusPer5Rounds !== 0) {
    problems.push(
      'difficulty.nodeBonusPer5Rounds must be 0: the C-01 ruling makes the outage caps absolute ' +
        '(PRD 6.6.1). Difficulty may not add strike targets.',
    );
  }

  for (const k of ['weightC', 'weightB', 'weightS'] as const) {
    if (!isNum(scoring[k]) || scoring[k] < 0) problems.push(`scoring.${k} must be a number >= 0`);
  }
  if (isNum(scoring.weightC) && isNum(scoring.weightB) && isNum(scoring.weightS)) {
    if (scoring.weightC + scoring.weightB + scoring.weightS !== 100) {
      problems.push('scoring weights must sum to 100 (PRD 6.6)');
    }
  }
  if (!isPosInt(scoring.speedThresholdNum) || !isPosInt(scoring.speedThresholdDen)) {
    problems.push('scoring.speedThresholdNum/Den must be positive integers');
  } else if (scoring.speedThresholdNum > scoring.speedThresholdDen) {
    problems.push('scoring speed threshold must be <= 1');
  }
  if (!isPosInt(scoring.speedHalfPointMs)) problems.push('scoring.speedHalfPointMs must be positive (ms)');
  if (isPosInt(phases.repair) && isPosInt(scoring.speedHalfPointMs) && scoring.speedHalfPointMs > phases.repair) {
    problems.push('scoring.speedHalfPointMs must not exceed phases.repair');
  }

  if (!isNum(layout.spacing) || layout.spacing <= 0) problems.push('layout.spacing must be > 0');
  if (!isNum(layout.goldenAngle) || layout.goldenAngle <= 0) problems.push('layout.goldenAngle must be > 0');
  if (!isNum(layout.margin) || layout.margin < 0) problems.push('layout.margin must be >= 0');

  if (!isNum(movement.worldRadius) || movement.worldRadius <= 0) {
    problems.push('movement.worldRadius must be > 0');
  }
  if (!isNum(movement.maxSpeed) || movement.maxSpeed <= 0) {
    problems.push('movement.maxSpeed must be > 0 (world units per second)');
  }
  if (!isPosInt(movement.maxMessagesPerSecond)) {
    problems.push('movement.maxMessagesPerSecond must be a positive integer');
  }

  if (!isPosInt(sync.tickHz) || sync.tickHz > 30) problems.push('sync.tickHz must be 1..30');
  if (!isPosInt(sync.replayBufferEvents)) problems.push('sync.replayBufferEvents must be positive');

  if (problems.length > 0) throw new ConfigError(problems);

  return deepFreeze({
    version: 1,
    line: { capacity: line.capacity, seedThreshold: line.seedThreshold },
    phases: {
      seeding: phases.seeding,
      build: phases.build,
      warning: phases.warning,
      repair: phases.repair,
      result: phases.result,
    },
    links: {
      degreeCap: links.degreeCap,
      maxTokens: links.maxTokens,
      tokenRegenMs: links.tokenRegenMs,
      maxPendingActions: links.maxPendingActions,
      requestTtlMs: links.requestTtlMs,
    },
    outage: {
      cableCutMaxLinks: outage.cableCutMaxLinks,
      regionalMaxNodes: outage.regionalMaxNodes,
      typeWeights: { A: w.A, B: w.B, C: w.C },
    },
    difficulty: { nodeBonusPer5Rounds: difficulty.nodeBonusPer5Rounds },
    scoring: {
      weightC: scoring.weightC,
      weightB: scoring.weightB,
      weightS: scoring.weightS,
      speedThresholdNum: scoring.speedThresholdNum,
      speedThresholdDen: scoring.speedThresholdDen,
      speedHalfPointMs: scoring.speedHalfPointMs,
    },
    layout: {
      spacing: layout.spacing,
      goldenAngle: layout.goldenAngle,
      margin: layout.margin,
    },
    movement: {
      worldRadius: movement.worldRadius,
      maxSpeed: movement.maxSpeed,
      maxMessagesPerSecond: movement.maxMessagesPerSecond,
    },
    sync: { tickHz: sync.tickHz, replayBufferEvents: sync.replayBufferEvents },
  } satisfies GameConfig);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Loads the canonical game.config.json. Server and tests use this; the engine never reads files. */
export function loadDefaultConfig(): GameConfig {
  const url = new URL('../game.config.json', import.meta.url);
  return validateConfig(JSON.parse(readFileSync(url, 'utf8')));
}
