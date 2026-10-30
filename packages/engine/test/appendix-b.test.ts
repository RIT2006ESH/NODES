/**
 * PRD Appendix B golden cases (Section 24). Every case is a test here.
 *
 * The fixture file holds the expected numbers, so changing an expectation is a
 * visible diff rather than an edit buried in a test body.
 */

import { describe, expect, it } from 'vitest';
import { loadDefaultConfig } from '@mng/config';
import type { GameConfig } from '@mng/config';
import { connectivity, outageCaps, reduce } from '@mng/engine';
import type { LineState } from '@mng/engine';
import {
  addNodes,
  atRepair,
  disableNodes,
  emptyLine,
  pathOfFive,
  ringOfSix,
} from '@mng/testing';
import fixtures from '../../testing/fixtures/appendix-b.json';

const config: GameConfig = loadDefaultConfig();
const cases = fixtures.cases;

function tickTo(state: LineState, at: number): LineState {
  return reduce(state, { type: 'tick' }, config, at).state;
}

describe('Appendix B golden cases', () => {
  it('B1: path of 5, hub strike on C leaves N=4 in two components', () => {
    const struck = atRepair(disableNodes(pathOfFive(config), ['C']), {
      startedAt: 1000,
      endsAt: 36000,
      s2: 0,
      strikeNodes: ['C'],
    });

    expect(struck.nodeOrder.filter((id) => struck.nodes[id]?.status === 'active')).toHaveLength(4);
    expect(struck.lastStrike?.nodes).toEqual(['C']);
    expect(connectivity(struck)).toEqual({ num: 2, den: 4 });
  });

  it('B2: no repair scores 30', () => {
    const struck = atRepair(disableNodes(pathOfFive(config), ['C']), {
      startedAt: 1000,
      endsAt: 36000,
      s2: 0,
      strikeNodes: ['C'],
    });
    const result = tickTo(struck, 36000).lastRound;

    expect(result).not.toBeNull();
    expect(result?.c).toEqual(cases.B2.c);
    expect(result?.b).toEqual(cases.B2.b);
    expect(result?.s2).toBe(cases.B2.s2);
    expect(result?.score).toBe(cases.B2.score);
  });

  it('B3: repair at 10 s scores 85 and counts a restored route', () => {
    const struck = atRepair(disableNodes(pathOfFive(config), ['C']), {
      startedAt: 1000,
      endsAt: 36000,
      s2: 0,
      strikeNodes: ['C'],
    });

    const out = reduce(
      struck,
      { type: 'create_link', requestId: 'b3', sessionId: 's-B', a: 'B', b: 'D' },
      config,
      11000,
    );

    expect(out.result).toMatchObject({ ok: true, restoredRoute: true });

    const result = tickTo(out.state, 36000).lastRound;
    expect(result?.c).toEqual(cases.B3.c);
    expect(result?.b).toEqual(cases.B3.b);
    expect(result?.s2).toBe(cases.B3.s2);
    expect(result?.score).toBe(cases.B3.score);
  });

  it('B4: repair at 25 s scores 80 (S is 0.5 after the half-point)', () => {
    const struck = atRepair(disableNodes(pathOfFive(config), ['C']), {
      startedAt: 1000,
      endsAt: 36000,
      s2: 0,
      strikeNodes: ['C'],
    });

    const out = reduce(
      struck,
      { type: 'create_link', requestId: 'b4', sessionId: 's-B', a: 'B', b: 'D' },
      config,
      26000,
    );

    expect(out.result).toMatchObject({ ok: true, restoredRoute: true });

    const result = tickTo(out.state, 36000).lastRound;
    expect(result?.c).toEqual(cases.B4.c);
    expect(result?.b).toEqual(cases.B4.b);
    expect(result?.s2).toBe(cases.B4.s2);
    expect(result?.score).toBe(cases.B4.score);
  });

  it('B5: ring of 6 struck on A scores 82; closing the ring scores 100', () => {
    const struck = disableNodes(ringOfSix(config), ['A']);

    const s1 = atRepair(struck, { startedAt: 0, endsAt: 35000, s2: 2, strikeNodes: ['A'] });
    const result1 = tickTo(s1, 35000).lastRound;
    expect(result1?.c).toEqual(cases.B5_struck.c);
    expect(result1?.b).toEqual(cases.B5_struck.b);
    expect(result1?.s2).toBe(cases.B5_struck.s2);
    expect(result1?.score).toBe(cases.B5_struck.score);

    const s2 = atRepair(struck, { startedAt: 0, endsAt: 35000, s2: 2, strikeNodes: ['A'] });
    const linked = reduce(
      s2,
      { type: 'create_link', requestId: 'b5', sessionId: 's-B', a: 'B', b: 'F' },
      config,
      5000,
    );
    expect(linked.result).toMatchObject({ ok: true });

    const result2 = tickTo(linked.state, 35000).lastRound;
    expect(result2?.b).toEqual(cases.B5_repaired.b);
    expect(result2?.score).toBe(cases.B5_repaired.score);
  });

  it('B6: 92.5 rounds half-up to 93', () => {
    const base = emptyLine(config, { seed: 0xb6 });
    const nodes = addNodes(base, [{ id: 'X' }, { id: 'Y' }, { id: 'Z' }, { id: 'W' }], config);
    const graph = addNodes(nodes, [], config);
    const linked = (() => {
      const s = structuredClone(graph);
      const pairs: Array<[string, string]> = [
        ['X', 'Y'],
        ['Y', 'Z'],
        ['Z', 'X'],
        ['W', 'X'],
      ];
      for (const [a, b] of pairs) {
        s.linkSeq++;
        s.links[`l${s.linkSeq}`] = {
          id: `l${s.linkSeq}`,
          a,
          b,
          cut: false,
          createdBy: 'test',
          createdAt: 0,
          starter: false,
        };
      }
      return s;
    })();

    const s = atRepair(linked, { startedAt: 0, endsAt: 35000, s2: 2 });
    const result = tickTo(s, 35000).lastRound;

    expect(result?.c).toEqual(cases.B6.c);
    expect(result?.b).toEqual(cases.B6.b);
    expect(result?.s2).toBe(cases.B6.s2);
    expect(result?.score).toBe(cases.B6.score);
    // The trap: 92.5 must be 93, not 92 (banker's rounding would give 92).
    expect(result?.score).toBe(93);
  });

  it('B7: a Line below 5 nodes runs Build-only seeding cycles, then a full round with a Hub strike', () => {
    let s: LineState = addNodes(emptyLine(config), [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }], config);

    const afterFirstCycle = tickTo(s, config.phases.seeding);
    expect(afterFirstCycle.phase).toBe('seeding');
    expect(afterFirstCycle.roundNo).toBe(0);
    expect(afterFirstCycle.seedingCycles).toBe(1);
    expect(afterFirstCycle.lastRound).toBeNull();

    s = addNodes(afterFirstCycle, [{ id: 'E' }], config);

    const started = tickTo(s, config.phases.seeding * 2);
    expect(started.phase).toBe('build');
    expect(started.roundNo).toBe(1);

    const warned = tickTo(started, config.phases.seeding * 2 + config.phases.build);
    expect(warned.phase).toBe('warning');

    const struck = tickTo(warned, config.phases.seeding * 2 + config.phases.build + config.phases.warning);
    expect(struck.phase).toBe('repair');
    expect(struck.lastStrike?.type).toBe('A');
  });

  it('B8: outage caps round as specified, including the link-cap minimum', () => {
    for (const [nodes, cap] of Object.entries(cases.B8.nodeCaps)) {
      expect(outageCaps(Number(nodes), 0, config).nodeCap).toBe(cap);
    }
    expect(outageCaps(5, 4, config).linkCap).toBe(cases.B8.linkCapFor5NodesWith4Links);
    expect(outageCaps(5, 0, config).linkCap).toBe(1);
  });

  it('B9: create_link at or after the end of Repair is PHASE_LOCKED and changes nothing', () => {
    const struck = atRepair(disableNodes(pathOfFive(config), ['C']), {
      startedAt: 1000,
      endsAt: 36000,
      s2: 0,
      strikeNodes: ['C'],
    });

    const atEnd = reduce(
      struck,
      { type: 'create_link', requestId: 'b9-exact', sessionId: 's-A', a: 'A', b: 'E' },
      config,
      36000,
    );
    expect(atEnd.result).toMatchObject({ ok: false, reason: 'PHASE_LOCKED' });
    expect(Object.keys(atEnd.state.links)).toHaveLength(Object.keys(struck.links).length);

    const justAfter = reduce(
      struck,
      { type: 'create_link', requestId: 'b9-plus-1', sessionId: 's-A', a: 'A', b: 'E' },
      config,
      36001,
    );
    expect(justAfter.result).toMatchObject({ ok: false, reason: 'PHASE_LOCKED' });
    expect(Object.keys(justAfter.state.links)).toHaveLength(Object.keys(struck.links).length);
  });
});
