/**
 * Config validation. Tunables live in one file and must fail loudly when wrong.
 */

import { describe, expect, it } from 'vitest';
import { ConfigError, loadDefaultConfig, validateConfig } from '@mng/config';

const config = loadDefaultConfig();

describe('game.config.json', () => {
  it('loads and matches the PRD defaults', () => {
    expect(config.phases.build).toBe(40_000);
    expect(config.phases.warning).toBe(5_000);
    expect(config.phases.repair).toBe(35_000);
    expect(config.phases.result).toBe(10_000);
    expect(config.phases.seeding).toBe(40_000);
    expect(config.phases.build + config.phases.warning + config.phases.repair + config.phases.result).toBe(90_000);
    expect(config.links.degreeCap).toBe(5);
    expect(config.links.maxTokens).toBe(3);
    expect(config.links.tokenRegenMs).toBe(20_000);
    expect(config.links.requestTtlMs).toBe(30_000);
    expect(config.line.seedThreshold).toBe(5);
    expect(config.line.capacity).toBe(400);
    expect(config.scoring.speedHalfPointMs).toBe(17_500);
    expect(config.movement.worldRadius).toBe(1400);
    expect(config.movement.maxSpeed).toBe(5000);
    expect(config.movement.maxMessagesPerSecond).toBe(25);
  });

  it('rejects invalid movement bounds or rates', () => {
    const bad = structuredClone(config) as unknown as Record<string, unknown>;
    (bad['movement'] as { worldRadius: number }).worldRadius = 0;
    expect(() => validateConfig(bad)).toThrow(/movement.worldRadius/);

    const slow = structuredClone(config) as unknown as Record<string, unknown>;
    (slow['movement'] as { maxSpeed: number }).maxSpeed = -1;
    expect(() => validateConfig(slow)).toThrow(/movement.maxSpeed/);

    const spam = structuredClone(config) as unknown as Record<string, unknown>;
    (spam['movement'] as { maxMessagesPerSecond: number }).maxMessagesPerSecond = 0;
    expect(() => validateConfig(spam)).toThrow(/movement.maxMessagesPerSecond/);
  });

  it('rejects any attempt to make difficulty add strike targets (C-01 ruling)', () => {
    const bad = structuredClone(config) as unknown as Record<string, unknown>;
    (bad['difficulty'] as { nodeBonusPer5Rounds: number }).nodeBonusPer5Rounds = 1;
    expect(() => validateConfig(bad)).toThrow(ConfigError);
    expect(() => validateConfig(bad)).toThrow(/C-01/);
  });

  it('rejects scoring weights that do not sum to 100', () => {
    const bad = structuredClone(config) as unknown as Record<string, unknown>;
    (bad['scoring'] as { weightC: number }).weightC = 50;
    expect(() => validateConfig(bad)).toThrow(/sum to 100/);
  });

  it('rejects a Line capacity above the PRD limit', () => {
    const bad = structuredClone(config) as unknown as Record<string, unknown>;
    (bad['line'] as { capacity: number }).capacity = 401;
    expect(() => validateConfig(bad)).toThrow(/400/);
  });

  it('rejects a speed half-point longer than the Repair phase', () => {
    const bad = structuredClone(config) as unknown as Record<string, unknown>;
    (bad['scoring'] as { speedHalfPointMs: number }).speedHalfPointMs = 40_000;
    expect(() => validateConfig(bad)).toThrow(/speedHalfPointMs/);
  });

  it('rejects a missing phase duration', () => {
    const bad = structuredClone(config) as unknown as Record<string, unknown>;
    delete (bad['phases'] as Record<string, unknown>)['repair'];
    expect(() => validateConfig(bad)).toThrow(/phases.repair/);
  });
});
