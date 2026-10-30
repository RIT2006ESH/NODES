/**
 * Rule-level tests for the parts of 6.2, 6.3, 6.4 and 6.6.1 that are not already
 * covered by the Appendix B golden cases.
 */

import { describe, expect, it } from 'vitest';
import { loadDefaultConfig } from '@mng/config';
import type { GameConfig } from '@mng/config';
import { activeNodeIds, reduce, totalDegree } from '@mng/engine';
import type { LineState } from '@mng/engine';
import { addLinks, addNodes, atRepair, emptyLine, setPhase } from '@mng/testing';

const config: GameConfig = loadDefaultConfig();

function buildState(): LineState {
  const base = emptyLine(config, { seed: 0x1234 });
  return addNodes(base, [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }], config);
}

function tick(state: LineState, at: number): LineState {
  return reduce(state, { type: 'tick' }, config, at).state;
}

describe('joining is isolated (6.2 owner amendment, 6.4)', () => {
  it('leaves the newcomer unlinked even when eligible targets exist', () => {
    const graph = addLinks(
      addNodes(emptyLine(config), [{ id: 'A' }, { id: 'B' }, { id: 'C' }], config),
      [
        ['A', 'B'],
        ['B', 'C'],
        ['A', 'C'],
      ],
    );
    const s = setPhase(graph, 'build', 0, 40000);
    const before = Object.keys(s.links).length;

    const out = reduce(s, { type: 'join', sessionId: 'newbie', name: 'Nat' }, config, 1000);
    const state = out.state;
    const nodeId = (out.result as { nodeId: string }).nodeId;

    expect(out.result).toMatchObject({
      kind: 'join',
      ok: true,
      starterLinkId: null,
      starterDeferred: false,
    });
    expect(Object.keys(state.links)).toHaveLength(before);
    expect(totalDegree(state, nodeId)).toBe(0);
    expect(state.nodes[nodeId]?.tokens).toBe(config.links.maxTokens);
    expect(out.events.some((e) => e.type === 'link.created')).toBe(false);
    expect(
      out.events.some((e) => e.type === 'starter.link' || e.type === 'starter.unavailable'),
    ).toBe(false);
  });

  it('first node in an empty Line starts unlinked and spends no token', () => {
    const s = setPhase(emptyLine(config), 'build', 0, 40000);
    const out = reduce(s, { type: 'join', sessionId: 'solo', name: 'Solo' }, config, 1000);

    expect(out.result).toMatchObject({
      ok: true,
      starterLinkId: null,
      starterDeferred: false,
      tokens: config.links.maxTokens,
    });
    expect(Object.keys(out.state.links)).toHaveLength(0);
    expect(out.state.nodes['n1']?.tokens).toBe(config.links.maxTokens);
  });

  it('leaves the newcomer isolated when every active node is full', () => {
    // K6: every existing node already holds the maximum of 5 links.
    const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
    const base = addNodes(emptyLine(config), ids.map((id) => ({ id })), config);
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i] as string, ids[j] as string]);
    }
    const s = setPhase(addLinks(base, pairs), 'build', 0, 40000);
    const before = Object.keys(s.links).length;

    const out = reduce(s, { type: 'join', sessionId: 'newbie', name: 'Nat' }, config, 1000);
    expect(out.result).toMatchObject({ ok: true, starterLinkId: null, starterDeferred: false });
    expect(Object.keys(out.state.links)).toHaveLength(before);
    expect(out.events.some((e) => e.type === 'link.created')).toBe(false);
    expect(out.events.some((e) => e.type === 'starter.unavailable')).toBe(false);
  });

  it('does not create or defer a link when joining during Result', () => {
    let s = addNodes(emptyLine(config), [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }], config);
    s = addLinks(s, [['A', 'B']]);
    s = setPhase(s, 'result', 0, 10000, { roundNo: 1 });

    const joined = reduce(s, { type: 'join', sessionId: 'late', name: 'Late' }, config, 5000);
    expect(joined.result).toMatchObject({
      ok: true,
      starterDeferred: false,
      starterLinkId: null,
    });
    const lateNodeId = (joined.result as { nodeId: string }).nodeId;
    expect(Object.keys(joined.state.links)).toHaveLength(1);

    // Result ends -> 5 active nodes -> a full round starts, but no owed edge appears.
    const next = tick(joined.state, 10000);
    expect(next.phase).toBe('build');
    expect(Object.keys(next.links)).toHaveLength(1);
    expect(totalDegree(next, lateNodeId)).toBe(0);
    expect(next.nodes[lateNodeId]?.tokens).toBe(config.links.maxTokens);
  });

  it('never counts a join as a restored route (6.6.1)', () => {
    let s = addNodes(emptyLine(config), [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }], config);
    s = addLinks(s, [
      ['A', 'B'],
      ['C', 'D'],
    ]);
    s = setPhase(s, 'repair', 0, 35000, { roundNo: 1 });

    const out = reduce(s, { type: 'join', sessionId: 'x', name: 'X' }, config, 1000);
    const nodeId = (out.result as { nodeId: string }).nodeId;
    const restored = out.events.filter((e) => e.type === 'link.created' && e.restoredRoute);
    expect(restored).toHaveLength(0);
    expect(out.state.nodes[nodeId]?.restoredRoutes).toBe(0);
  });
});

describe('link tokens (6.3)', () => {
  function tokenState(): LineState {
    const base = addNodes(
      emptyLine(config),
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }, { id: 'F' }],
      config,
    );
    return atRepair(base, { startedAt: 0, endsAt: 1_000_000, s2: 0 });
  }

  it('spends one token per link and refuses the fourth with NO_TOKENS', () => {
    let s = tokenState();
    for (const [i, target] of (['B', 'C', 'D'] as const).entries()) {
      const out = reduce(
        s,
        { type: 'create_link', requestId: `t${i}`, sessionId: 's-A', a: 'A', b: target },
        config,
        100 + i,
      );
      expect(out.result).toMatchObject({ ok: true });
      s = out.state;
      expect(s.nodes['A']?.tokens).toBe(config.links.maxTokens - i - 1);
    }

    const denied = reduce(
      s,
      { type: 'create_link', requestId: 't3', sessionId: 's-A', a: 'A', b: 'E' },
      config,
      200,
    );
    expect(denied.result).toMatchObject({ ok: false, reason: 'NO_TOKENS' });
    expect((denied.result as { retryAfterMs?: number }).retryAfterMs).toBeGreaterThan(0);
    expect(denied.state.nodes['A']?.tokens).toBe(0);
  });

  it('regenerates one token per 20 s and never above the cap', () => {
    let s = tokenState();
    for (const [i, target] of (['B', 'C', 'D'] as const).entries()) {
      s = reduce(s, { type: 'create_link', requestId: `u${i}`, sessionId: 's-A', a: 'A', b: target }, config, 100 + i).state;
    }
    expect(s.nodes['A']?.tokens).toBe(0);

    s = tick(s, 20_200);
    expect(s.nodes['A']?.tokens).toBe(1);

    s = tick(s, 200_000);
    expect(s.nodes['A']?.tokens).toBe(config.links.maxTokens);
  });
});

describe('link validation (6.3)', () => {
  function linkedState(): LineState {
    const base = addNodes(
      emptyLine(config),
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }, { id: 'F' }, { id: 'X' }],
      config,
    );
    return atRepair(base, { startedAt: 0, endsAt: 1_000_000, s2: 0 });
  }

  it('rejects self links, duplicates, unknown nodes and paused Lines', () => {
    let s = linkedState();
    const first = reduce(s, { type: 'create_link', requestId: 'a1', sessionId: 's-A', a: 'A', b: 'B' }, config, 10);
    expect(first.result).toMatchObject({ ok: true });
    s = first.state;

    expect(
      reduce(s, { type: 'create_link', requestId: 'a2', sessionId: 's-A', a: 'A', b: 'A' }, config, 20).result,
    ).toMatchObject({ reason: 'SELF_LINK' });

    expect(
      reduce(s, { type: 'create_link', requestId: 'a3', sessionId: 's-A', a: 'A', b: 'B' }, config, 30).result,
    ).toMatchObject({ reason: 'ALREADY_LINKED' });

    expect(
      reduce(s, { type: 'create_link', requestId: 'a4', sessionId: 's-A', a: 'A', b: 'ZZ' }, config, 40).result,
    ).toMatchObject({ reason: 'STALE_STATE' });

    const paused = structuredClone(s);
    paused.paused = true;
    expect(
      reduce(paused, { type: 'create_link', requestId: 'a5', sessionId: 's-A', a: 'A', b: 'C' }, config, 50).result,
    ).toMatchObject({ reason: 'LINE_PAUSED' });
  });

  it('counts inactive links toward the degree cap', () => {
    let s = addNodes(
      emptyLine(config),
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }, { id: 'F' }, { id: 'X' }],
      config,
    );
    s = addLinks(s, [
      ['A', 'B'],
      ['A', 'C'],
      ['A', 'D'],
      ['A', 'E'],
      ['A', 'F'],
    ]);
    // Sever one endpoint of A-B: the link is inactive but still exists.
    s = structuredClone(s);
    (s.nodes['B'] as { status: string }).status = 'disabled';
    s = atRepair(s, { startedAt: 0, endsAt: 1_000_000, s2: 0 });

    expect(totalDegree(s, 'A')).toBe(config.links.degreeCap);
    expect(
      reduce(s, { type: 'create_link', requestId: 'cap', sessionId: 's-A', a: 'A', b: 'X' }, config, 10).result,
    ).toMatchObject({ reason: 'NODE_FULL' });
  });

  it('rejects links involving a disabled node', () => {
    let s = addNodes(emptyLine(config), [{ id: 'A' }, { id: 'B' }], config);
    s = structuredClone(s);
    (s.nodes['B'] as { status: string }).status = 'disabled';
    s = atRepair(s, { startedAt: 0, endsAt: 1_000_000, s2: 0 });

    expect(
      reduce(s, { type: 'create_link', requestId: 'off', sessionId: 's-A', a: 'A', b: 'B' }, config, 10).result,
    ).toMatchObject({ reason: 'NODE_OFFLINE' });
  });

  it('is idempotent: the same request_id never creates a second link', () => {
    const s = linkedState();
    const first = reduce(s, { type: 'create_link', requestId: 'same', sessionId: 's-A', a: 'A', b: 'B' }, config, 10);
    const second = reduce(first.state, { type: 'create_link', requestId: 'same', sessionId: 's-A', a: 'A', b: 'B' }, config, 20);

    expect(second.result).toEqual(first.result);
    expect(Object.keys(second.state.links)).toHaveLength(Object.keys(first.state.links).length);
    expect(second.events).toHaveLength(0);
  });

  it('allows links in seeding, Build, Warning and Repair, and locks Result', () => {
    for (const phase of ['seeding', 'build', 'warning', 'repair'] as const) {
      const s = setPhase(linkedState(), phase, 0, 1_000_000);
      const out = reduce(s, { type: 'create_link', requestId: `p-${phase}`, sessionId: 's-A', a: 'A', b: 'B' }, config, 10);
      expect(out.result, phase).toMatchObject({ ok: true });
    }

    const locked = setPhase(linkedState(), 'result', 0, 1_000_000);
    const out = reduce(locked, { type: 'create_link', requestId: 'p-result', sessionId: 's-A', a: 'A', b: 'B' }, config, 10);
    expect(out.result).toMatchObject({ ok: false, reason: 'PHASE_LOCKED' });
  });
});

describe('restored routes and recovery (6.4, 6.6.1)', () => {
  it('counts a restored route only in Repair', () => {
    let base = addNodes(emptyLine(config), [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }], config);
    base = addLinks(base, [
      ['A', 'B'],
      ['C', 'D'],
    ]);

    const inBuild = setPhase(base, 'build', 0, 40000, { roundNo: 1 });
    const buildLink = reduce(
      inBuild,
      { type: 'create_link', requestId: 'rb', sessionId: 's-A', a: 'B', b: 'C' },
      config,
      1000,
    );
    expect(buildLink.result).toMatchObject({ ok: true, restoredRoute: false });

    const inRepair = setPhase(base, 'repair', 0, 35000, { roundNo: 1, s2: 0 });
    const repairLink = reduce(
      inRepair,
      { type: 'create_link', requestId: 'rr', sessionId: 's-A', a: 'B', b: 'C' },
      config,
      1000,
    );
    expect(repairLink.result).toMatchObject({ ok: true, restoredRoute: true });
    expect(repairLink.state.nodes['A']?.restoredRoutes).toBe(1);
  });

  it('recovers every disabled node and cut link at Result, after scoring', () => {
    let s = addNodes(emptyLine(config), [{ id: 'A' }, { id: 'B' }, { id: 'C' }], config);
    s = addLinks(s, [
      ['A', 'B'],
      ['B', 'C'],
    ]);
    s = atRepair(s, { startedAt: 0, endsAt: 35000, s2: 0, strikeNodes: ['B'], strikeLinks: ['l1'] });
    s = structuredClone(s);
    (s.nodes['B'] as { status: string }).status = 'disabled';
    (s.links['l1'] as { cut: boolean }).cut = true;

    const scored = tick(s, 35000);
    expect(scored.lastRound).not.toBeNull();
    expect(activeNodeIds(scored)).toHaveLength(3);
    expect(Object.values(scored.links).every((l) => !l.cut)).toBe(true);
    expect(scored.phase).toBe('result');
  });

  it('treats N=0 as a void round: no score, not survived (defensive guard, D-R3)', () => {
    let s = addNodes(emptyLine(config), [{ id: 'A' }], config);
    s = atRepair(s, { startedAt: 0, endsAt: 35000, s2: 0, strikeNodes: ['A'] });
    s = structuredClone(s);
    (s.nodes['A'] as { status: string }).status = 'disabled';

    const out = reduce(s, { type: 'tick' }, config, 35000);
    expect(out.state.lastRound).toBeNull();
    expect(out.state.roundsSurvived).toBe(0);
    expect(out.events.some((e) => e.type === 'round.void')).toBe(true);
  });
});
