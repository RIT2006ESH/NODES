import { describe, expect, it } from 'vitest';
import {
  validateUsername,
  normalizeUsername,
  canonicalUsername,
  generateFallbackUsername,
} from '../src/username.js';

describe('username normalization and validation', () => {
  it('accepts the supported username format', () => {
    expect(validateUsername(' rino303_dev ')).toBe('rino303_dev');
    expect(validateUsername('devesh')).toBe('devesh');
    expect(validateUsername('Devesh')).toBe('Devesh');
    expect(validateUsername('devesh123')).toBe('devesh123');
  });

  it('rejects invalid lengths and characters', () => {
    expect(validateUsername('ab')).toBeNull();
    expect(validateUsername('name with spaces')).toBeNull();
    expect(validateUsername('a'.repeat(21))).toBeNull();
    expect(validateUsername('invalid!char')).toBeNull();
  });

  it('normalizes unicode and trims whitespace', () => {
    expect(normalizeUsername('  devesh  ')).toBe('devesh');
    expect(canonicalUsername('  Devesh  ')).toBe('devesh');
    expect(canonicalUsername('DEVESH')).toBe('devesh');
  });

  it('generates distinct, valid fallback usernames that avoid collisions', () => {
    const existing = new Set(['Player_1', 'Player_1_1']);
    const isTaken = (cand: string) => existing.has(cand);

    const f1 = generateFallbackUsername('Player_1', isTaken);
    expect(f1).toBe('Player_1_2');
    expect(validateUsername(f1)).toBe(f1);

    const f2 = generateFallbackUsername('n2', () => false);
    expect(f2).toBe('Player_n2');
    expect(validateUsername(f2)).toBe(f2);
  });
});
