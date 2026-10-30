/**
 * Outage targeting and caps (PRD 6.5, 6.6.1). The caps are absolute (C-01 ruling).
 */

import { describe, expect, it } from 'vitest';
import { loadDefaultConfig } from '@mng/config';
import type { GameConfig } from '@mng/config';
import { activeNodeIds, applyStrike, outageCaps, reduce } from '@mng/engine';
import type { LineState, StrikeType } from '@mng/engine';
import { addLinks, addNodes, atRepair, emptyLine } from '@mng/testing';

const config: GameConfig = loadDefaultConfig();

function ring(n: number, seed = 99): LineState {
  const ids = Array.from({ length: n }, (_, i) => `N${i}`);
  const base = addNodes(
    emptyLine(config, { seed }),
    ids.map((id) => ({ id })),
    config,
  );
  const pairs: Array<[string, string]> = ids.map((id, i) => [id, ids[(i + 1) % n] as string]);
  const s = addLinks(base, pairs);
  return atRepair(s, { startedAt: 0, endsAt: 35000, s2: 0, roundNo: 3 });
}

function countDisabled(s: LineState): number {
  return s.nodeOrder.filter((id) => s.nodes[id]?.status === 'disabled').length;
}

function countCut(s: LineState): number {
  return Object.values(s.links).filter((l) => l.cut).length;
}

describe('strike targeting (6.5)', () => {
  it('strike A disables the node with the most active links', () => {
    let s = addNodes(
      emptyLine(config),
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }],
      config,
    );
    s = addLinks(s, [
      ['A', 'B'],
      ['A', 'C'],
      ['A', 'D'],
      ['B', 'C'],
    ]);
    s = atRepair(s, { startedAt: 0, endsAt: 35000, s2: 0, roundNo: 3 });

    const record = applyStrike(structuredClone(s), 'A', config);
    expect(record.type).toBe('A');
    expect(record.nodes).toEqual(['A']);
  });

  it('breaks strike A ties deterministically from the round seed', () => {
    const s = ring(6);
    const first = applyStrike(structuredClone(s), 'A', config);
    const second = applyStrike(structuredClone(s), 'A', config);
    expect(first.nodes).toEqual(second.nodes);
    expect(first.nodes).toHaveLength(1);
  });

  it('strike B cuts at most the cable-cut maximum and disables a low-degree node', () => {
    const s = ring(20);
    const record = applyStrike(structuredClone(s), 'B', config);

    expect(record.links.length).toBeLessThanOrEqual(config.outage.cableCutMaxLinks);
    expect(record.nodes).toHaveLength(1);
    // In a ring every node has the same active degree, so any node is in the lowest quarter.
    expect(s.nodeOrder).toContain(record.nodes[0]);
  });

  it('strike C disables up to five spatially adjacent nodes', () => {
    const s = ring(30);
    const record = applyStrike(structuredClone(s), 'C', config);
    const cap = Math.min(config.outage.regionalMaxNodes, Math.floor(30 / 5));
    expect(record.nodes).toHaveLength(cap);
  });
});

describe('outage caps are absolute (C-01 ruling)', () => {
  it('never disables more than floor(N/5) nodes or more than the link cap', () => {
    for (let n = 5; n <= 30; n++) {
      for (const type of ['A', 'B', 'C'] as StrikeType[]) {
        const base = ring(n, 1000 + n);
        const caps = outageCaps(n, n, config);
        const before = countDisabled(base);
        const beforeCut = countCut(base);
        const next = structuredClone(base);
        applyStrike(next, type, config);

        const disabled = countDisabled(next) - before;
        const cut = countCut(next) - beforeCut;

        expect(disabled, `type ${type} N=${n}`).toBeLessThanOrEqual(caps.nodeCap);
        expect(cut, `type ${type} N=${n}`).toBeLessThanOrEqual(caps.linkCap);
        expect(disabled).toBeGreaterThan(0);
        expect(disabled).toBeLessThan(n);
      }
    }
  });

  it('round 1 is always a Hub strike; later rounds draw from the seeded schedule', () => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    let s = addNodes(emptyLine(config, { seed: 7 }), ids.map((id) => ({ id })), config);
    s = addLinks(s, [
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'D'],
      ['D', 'E'],
    ]);

    // Seeding ends -> Build 1 -> Warning ends -> Outage.
    const at = config.phases.seeding + config.phases.build + config.phases.warning;
    const out = reduce(s, { type: 'tick' }, config, at);
    expect(out.state.roundNo).toBe(1);
    expect(out.state.phase).toBe('repair');
    expect(out.state.lastStrike?.type).toBe('A');
    expect(out.state.cAtOutage).not.toBeNull();
  });

  it('is deterministic: the same state at the same round produces the same strike', () => {
    const a = ring(12, 424242);
    const b = structuredClone(a);
    const ra = applyStrike(structuredClone(a), 'C', config);
    const rb = applyStrike(structuredClone(b), 'C', config);
    expect(ra).toEqual(rb);
  });

  it('leaves the active-node count consistent with the recorded strike', () => {
    const s = ring(25);
    const next = structuredClone(s);
    const record = applyStrike(next, 'C', config);
    expect(activeNodeIds(next)).toHaveLength(25 - record.nodes.length);
  });
});
