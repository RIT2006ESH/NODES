/**
 * Player movement.
 *
 * Movement changes only a node's coordinates. It never creates, cuts or
 * reweights a Link, so distance can never disconnect a graph edge. The server
 * is authoritative: it clamps every update to the circular world and to a
 * speed budget before this function is called.
 *
 * This is the one hot-path mutation in the engine: a full state clone per
 * 25 Hz movement message would be wasteful for a 400-node Line. It touches
 * `x`, `y`, `now` and `seq` only.
 */

import type { GameConfig } from '@mng/config';
import type { Point } from './layout.js';
import type { LineState, NodeMovedEvent } from './types.js';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Clamp a point into the circular world boundary, rounded to 2 decimals. */
export function clampToWorld(x: number, y: number, radius: number): Point {
  const length = Math.hypot(x, y);
  if (!Number.isFinite(length) || length === 0) return { x: round2(x), y: round2(y) };
  const scale = length > radius ? radius / length : 1;
  return { x: round2(x * scale), y: round2(y * scale) };
}

/**
 * Apply a validated position update in place and return the broadcast event.
 * Returns null for an unknown node, non-finite input, or no meaningful change.
 */
export function moveNode(
  state: LineState,
  nodeId: string,
  x: number,
  y: number,
  now: number,
  config: GameConfig,
): NodeMovedEvent | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(now)) return null;
  const node = state.nodes[nodeId];
  if (!node) return null;

  const point = clampToWorld(x, y, config.movement.worldRadius);
  if (Math.abs(node.x - point.x) < 0.005 && Math.abs(node.y - point.y) < 0.005) return null;

  node.x = point.x;
  node.y = point.y;
  state.now = now;
  state.seq += 1;

  return { seq: state.seq, type: 'node.moved', at: now, nodeId, x: point.x, y: point.y };
}
