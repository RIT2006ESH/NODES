/**
 * Link tokens (PRD 6.3): up to N tokens, one regenerates every 20 s by default.
 *
 * Shape chosen here (A-07): a single timer, at most one token per interval, no
 * fractional banking, and the timer only runs while below the cap. FR-27's
 * "regeneration ring" is therefore derived from `nextTokenInMs`, not
 * authoritative.
 */

import type { GameConfig } from '@mng/config';
import type { LineNode } from './types.js';

/** Applies any elapsed regeneration. Returns true when the balance changed. */
export function refreshTokens(node: LineNode, now: number, config: GameConfig): boolean {
  const max = config.links.maxTokens;
  const regen = config.links.tokenRegenMs;

  if (node.tokens >= max) {
    node.tokens = max;
    node.lastRegenAt = now;
    return false;
  }

  let changed = false;
  while (node.tokens < max && now - node.lastRegenAt >= regen) {
    node.tokens++;
    node.lastRegenAt += regen;
    changed = true;
  }
  if (node.tokens >= max) node.lastRegenAt = now;
  return changed;
}

export function nextTokenInMs(node: LineNode, now: number, config: GameConfig): number {
  if (node.tokens >= config.links.maxTokens) return 0;
  const elapsed = now - node.lastRegenAt;
  return Math.max(0, config.links.tokenRegenMs - elapsed);
}
