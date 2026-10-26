/**
 * One authoritative Line. Serialized actions, 5 Hz tick, snapshot persistence.
 *
 * Everything game-rule related lives in packages/engine. This class only owns
 * time, the event ring buffer and the on-disk snapshot.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GameConfig } from '@mng/config';
import { createLine, moveNode, reduce } from '@mng/engine';
import type { Action, LineEvent, LineState, NodeMovedEvent, ReduceOutcome } from '@mng/engine';
import type { WireEvent } from '@mng/protocol';

export class LineHost {
  state: LineState;
  /** Last N events, for cheap reconnect handling and debugging. */
  private buffer: WireEvent[] = [];

  constructor(
    readonly config: GameConfig,
    readonly seed: number,
    now: number,
    readonly lineId = 'western',
  ) {
    this.state = createLine(lineId, seed, config, now);
  }

  apply(action: Action, now: number): ReduceOutcome {
    const out = reduce(this.state, action, this.config, now);
    this.state = out.state;
    this.record(out.events);
    return out;
  }

  tick(now: number): ReduceOutcome {
    return this.apply({ type: 'tick' }, now);
  }

  /**
   * Hot-path movement: mutate only coordinates, record the event, keep the
   * action pipeline (`reduce`) untouched. The caller has already validated
   * ownership, rate, world bounds and speed.
   */
  move(nodeId: string, x: number, y: number, now: number): NodeMovedEvent | null {
    const event = moveNode(this.state, nodeId, x, y, now, this.config);
    if (event) this.record([event]);
    return event;
  }

  get seq(): number {
    return this.state.seq;
  }

  bufferedSince(seq: number): WireEvent[] | null {
    if (this.buffer.length === 0) return seq === this.state.seq ? [] : null;
    const first = this.buffer[0]?.seq ?? 0;
    if (seq + 1 < first) return null;
    return this.buffer.filter((e) => e.seq > seq);
  }

  private record(events: readonly LineEvent[]): void {
    for (const event of events) {
      if (event.type === 'prng.debug') continue;
      this.buffer.push(event as unknown as WireEvent);
    }
    const limit = this.config.sync.replayBufferEvents;
    if (this.buffer.length > limit) this.buffer.splice(0, this.buffer.length - limit);
  }

  save(path: string): void {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ savedAt: Date.now(), state: this.state }), 'utf8');
    } catch {
      // Persistence is best effort in V1; a failed write must not kill the game.
    }
  }

  static load(path: string, config: GameConfig): LineHost | null {
    if (!existsSync(path)) return null;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { state?: LineState };
      if (!raw.state || !Array.isArray(raw.state.nodeOrder)) return null;
      // A save from days ago would replay thousands of rounds on the first tick.
      // For V1, a stale line starts fresh instead.
      const savedAt = Number(raw.state.now);
      if (!Number.isFinite(savedAt) || Date.now() - savedAt > 5 * 60_000) return null;
      const host = new LineHost(config, raw.state.seed, Date.now(), raw.state.id);
      host.state = raw.state;
      host.state.now = Date.now();
      return host;
    } catch {
      return null;
    }
  }

  reset(seed: number, now: number): void {
    this.state = createLine(this.lineId, seed, this.config, now);
    this.buffer = [];
  }
}
