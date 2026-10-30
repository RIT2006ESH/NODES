import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDefaultConfig } from '@mng/config';
import { LineHost } from '../src/line.js';

function snapshotPath(): string {
  const directory = join(tmpdir(), `mng-persistence-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  return join(directory, 'line.json');
}

function writeSnapshot(path: string, stateNow: number): void {
  const config = loadDefaultConfig();
  const host = new LineHost(config, 123, stateNow);
  host.state.now = stateNow;
  host.save(path);
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { state: { now: number } };
  saved.state.now = stateNow;
  writeFileSync(path, JSON.stringify(saved), 'utf8');
}

describe('LineHost persistence age and corruption handling', () => {
  it.each([
    ['fresh', 1_000],
    ['near the five-minute limit', 5 * 60_000 - 1_000],
  ])('loads a %s snapshot', (_label, ageMs) => {
    const path = snapshotPath();
    writeSnapshot(path, Date.now() - ageMs);
    expect(LineHost.load(path, loadDefaultConfig())).not.toBeNull();
  });

  it('rejects a snapshot older than five minutes instead of restoring stale game state', () => {
    const path = snapshotPath();
    writeSnapshot(path, Date.now() - (5 * 60_000 + 1_000));
    expect(LineHost.load(path, loadDefaultConfig())).toBeNull();
  });

  it('ignores malformed and structurally incomplete snapshots', () => {
    const path = snapshotPath();
    writeFileSync(path, '{"state":', 'utf8');
    expect(LineHost.load(path, loadDefaultConfig())).toBeNull();
    writeFileSync(path, JSON.stringify({ state: { now: Date.now() } }), 'utf8');
    expect(LineHost.load(path, loadDefaultConfig())).toBeNull();
  });
});
