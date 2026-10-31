import { describe, expect, it } from 'vitest';
import { validateUsername } from '../src/username.js';

describe('username validation', () => {
  it('accepts the supported username format', () => {
    expect(validateUsername(' rino303_dev ')).toBe('rino303_dev');
  });

  it('rejects invalid lengths and characters', () => {
    expect(validateUsername('ab')).toBeNull();
    expect(validateUsername('name with spaces')).toBeNull();
    expect(validateUsername('a'.repeat(21))).toBeNull();
  });
});
