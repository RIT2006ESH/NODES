/**
 * Regression tests for the reported "preconnected mesh".
 *
 * Owner amendment 2026-10-26: every newcomer joins as an isolated node. The
 * PRD 6.2 starter link is removed for this build, so joining must never create
 * an edge, directly or later. Edges require an explicit request accepted by the
 * target player.
 */

import { describe, expect, it } from 'vitest';
import { loadDefaultConfig } from '@mng/config';
import type { GameConfig } from '@mng/config';
import { activeNodeIds, reduce, totalDegree } from '@mng/engine';
import type { LineState } from '@mng/engine';
import { addLinks, emptyLine, setPhase } from '@mng/testing';

const config: GameConfig = loadDefaultConfig();

function freshLine(at = 0): LineState {
  return setPhase(emptyLine(config, { seed: 0xbeef, now: at }), 'build', at, at + 600_000);
}

function joinAll(
  count: number,
  start: LineState = freshLine(),
): { state: LineState; linksAfter: number[]; newIds: string[]; events: string[] } {
  let state = start;
  const linksAfter: number[] = [];
  const newIds: string[] = [];
  const events: string[] = [];

  for (let i = 0; i < count; i++) {
    const out = reduce(
      state,
      { type: 'join', sessionId: `session-${i}`, name: `Player ${i}` },
      config,
      1000 + i * 1000,
    );
    state = out.state;
    const result = out.result as { ok: boolean; nodeId?: string } | undefined;
    if (result?.nodeId) newIds.push(result.nodeId);
    linksAfter.push(Object.keys(state.links).length);
    events.push(...out.events.map((event) => event.type));
  }

  return { state, linksAfter, newIds, events };
}

describe('joining cannot create a preconnected mesh', () => {
  it('gives every joining node zero links', () => {
    const { state, linksAfter, events } = joinAll(12);

    expect(linksAfter).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Object.keys(state.links)).toHaveLength(0);
    expect(events.filter((type) => type === 'starter.link' || type === 'starter.unavailable')).toEqual(
      [],
    );
  });

  it('creates no link for 30 joins, regardless of eligibility', () => {
    const { state, newIds } = joinAll(30, emptyLine(config, { seed: 0xbeef, now: 0 }));

    expect(new Set(newIds)).toHaveLength(30);
    expect(Object.keys(state.links)).toHaveLength(0);
    for (const id of state.nodeOrder) {
      expect(totalDegree(state, id)).toBe(0);
      expect(state.nodes[id]?.tokens).toBe(config.links.maxTokens);
      expect(state.nodes[id]?.pendingStarter).toBe(false);
    }
  });

  it('creates no edge when a newcomer joins during Result, even after the next Build starts', () => {
    let s = joinAll(4, emptyLine(config, { seed: 0xbeef, now: 0 })).state;
    s = setPhase(s, 'result', 0, 10_000, { roundNo: 1 });

    const joined = reduce(s, { type: 'join', sessionId: 'late', name: 'Late' }, config, 5000);
    expect(joined.result).toMatchObject({
      kind: 'join',
      ok: true,
      starterLinkId: null,
      starterDeferred: false,
    });
    expect(Object.keys(joined.state.links)).toHaveLength(0);

    const next = reduce(joined.state, { type: 'tick' }, config, 10_000).state;
    expect(next.phase).toBe('build');
    expect(Object.keys(next.links)).toHaveLength(0);
  });

  it('a line with four active nodes stays in seeding and does not strike or score', () => {
    const { state } = joinAll(4, emptyLine(config, { seed: 0xbeef, now: 0 }));
    const afterCycle = reduce(state, { type: 'tick' }, config, config.phases.seeding + 1000).state;

    expect(activeNodeIds(afterCycle)).toHaveLength(4);
    expect(afterCycle.phase).toBe('seeding');
    expect(afterCycle.roundNo).toBe(0);
    expect(afterCycle.roundsSurvived).toBe(0);
    expect(afterCycle.lastRound).toBeNull();
    expect(afterCycle.lastStrike).toBeNull();
  });

  it('a fifth active node lets the next cycle start round 1 in Build', () => {
    const { state } = joinAll(4, emptyLine(config, { seed: 0xbeef, now: 0 }));
    const fifth = reduce(
      state,
      { type: 'join', sessionId: 'fifth', name: 'Fifth' },
      config,
      config.phases.seeding + 500,
    ).state;

    expect(activeNodeIds(fifth)).toHaveLength(5);
    expect(Object.keys(fifth.links)).toHaveLength(0);
    const started = reduce(fifth, { type: 'tick' }, config, config.phases.seeding * 2 + 1000).state;

    expect(started.phase).toBe('build');
    expect(started.roundNo).toBe(1);
    expect(started.roundsSurvived).toBe(0);
  });
});

describe('outages only touch the real graph', () => {
  it('targets a subset of existing active nodes and links and invents nothing', () => {
    // Joining no longer supplies edges, so build the graph explicitly. The test
    // is about the outage targeting real ids, not about how the edges arrived.
    const joined = joinAll(25);
    const ids = joined.newIds;
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < ids.length; i++) {
      pairs.push([ids[i] as string, ids[(i + 1) % ids.length] as string]);
    }
    const linked = addLinks(joined.state, pairs);
    const before = {
      nodeIds: new Set(Object.keys(linked.nodes)),
      linkIds: new Set(Object.keys(linked.links)),
      activeNodes: new Set(activeNodeIds(linked)),
    };
    expect(before.linkIds.size).toBe(25);

    const atWarningEnd = linked.now + config.phases.warning + 1;
    const staged = setPhase(linked, 'warning', linked.now, atWarningEnd, {
      roundNo: 1,
      roundStartedAt: linked.now - config.phases.build,
    });
    // Type B cuts links and disables one node.
    staged.pendingStrikeType = 'B';

    const out = reduce(staged, { type: 'tick' }, config, atWarningEnd + 1);
    const outage = out.events.find((event) => event.type === 'outage.applied');
    if (!outage || outage.type !== 'outage.applied') throw new Error('no outage applied');

    for (const id of outage.strike.nodes) {
      expect(before.nodeIds.has(id), `struck unknown node ${id}`).toBe(true);
      expect(before.activeNodes.has(id), `struck inactive node ${id}`).toBe(true);
      expect(out.state.nodes[id]?.status).toBe('disabled');
    }
    expect(outage.strike.links.length).toBeGreaterThan(0);
    for (const id of outage.strike.links) {
      expect(before.linkIds.has(id), `cut unknown link ${id}`).toBe(true);
      expect(linked.links[id]?.cut).toBe(false);
    }

    // No phantom nodes or links appeared during the strike.
    expect(new Set(Object.keys(out.state.nodes))).toEqual(before.nodeIds);
    expect(new Set(Object.keys(out.state.links))).toEqual(before.linkIds);
  });
});
