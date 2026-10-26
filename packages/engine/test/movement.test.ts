/**
 * Movement is a spatial change, never a graph change.
 *
 * These tests pin the boundary between coordinates and connectivity: moving an
 * endpoint (even to the far side of the world) must not create, cut, delete or
 * deactivate a link. Outages remain the only normal way to deactivate one.
 */

import { describe, expect, it } from 'vitest';
import { loadDefaultConfig } from '@mng/config';
import type { GameConfig } from '@mng/config';
import {
  clampToWorld,
  connectivity,
  isLinkActive,
  moveNode,
  reduce,
  totalDegree,
} from '@mng/engine';
import type { LineState } from '@mng/engine';
import { addLinks, addNodes, emptyLine, setPhase } from '@mng/testing';

const config: GameConfig = loadDefaultConfig();

function pathGraph(): LineState {
  const base = emptyLine(config, { seed: 0x1234 });
  const nodes = addNodes(
    base,
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    config,
  );
  return addLinks(nodes, [
    ['A', 'B'],
    ['B', 'C'],
  ]);
}

describe('moving a node', () => {
  it('updates only its position and emits one bounded event', () => {
    const state = pathGraph();
    const linksBefore = JSON.stringify(state.links);

    const event = moveNode(state, 'A', 120, -80, 5000, config);

    expect(event).toMatchObject({ type: 'node.moved', nodeId: 'A', x: 120, y: -80 });
    expect(state.nodes.A?.x).toBe(120);
    expect(state.nodes.A?.y).toBe(-80);
    expect(JSON.stringify(state.links)).toBe(linksBefore);
    expect(totalDegree(state, 'A')).toBe(1);
  });

  it('is a no-op for unknown nodes, non-finite input, or the same point', () => {
    const state = pathGraph();
    const x = state.nodes.A?.x ?? 0;
    const y = state.nodes.A?.y ?? 0;

    expect(moveNode(state, 'nope', 10, 10, 5000, config)).toBeNull();
    expect(moveNode(state, 'A', Number.NaN, 10, 5000, config)).toBeNull();
    expect(moveNode(state, 'A', x, y, 5000, config)).toBeNull();
  });

  it('clamps to the circular world boundary', () => {
    const point = clampToWorld(10_000, -10_000, config.movement.worldRadius);
    expect(Math.hypot(point.x, point.y)).toBeLessThanOrEqual(config.movement.worldRadius + 0.01);
    expect(point.x).toBeGreaterThan(0);
    expect(point.y).toBeLessThan(0);
  });
});

describe('distance never breaks a connection', () => {
  it('keeps both edges and full connectivity when endpoints are at opposite world edges', () => {
    const state = pathGraph();
    const linkIds = Object.keys(state.links);
    const connectivityBefore = connectivity(state);

    const radius = config.movement.worldRadius;
    moveNode(state, 'A', radius * 3, 0, 5000, config);
    moveNode(state, 'C', -radius * 3, 0, 5000, config);

    const a = state.nodes.A!;
    const c = state.nodes.C!;
    const distance = Math.hypot(a.x - c.x, a.y - c.y);

    expect(distance).toBeGreaterThan(radius);
    expect(Object.keys(state.links)).toEqual(linkIds);
    for (const id of linkIds) {
      expect(isLinkActive(state, state.links[id]!)).toBe(true);
    }
    expect(connectivity(state)).toEqual(connectivityBefore);
    expect(connectivity(state)).toEqual({ num: 3, den: 3 });
  });

  it('does not auto-connect nodes that overlap after moving', () => {
    const state = pathGraph();
    const before = Object.keys(state.links);

    // Move C onto A. They are not linked, and proximity must not create an edge.
    moveNode(state, 'C', state.nodes.A!.x, state.nodes.A!.y, 5000, config);

    expect(Object.keys(state.links)).toEqual(before);
    expect(before).toHaveLength(2);
  });

  it('does not let movement bypass the degree cap', () => {
    const base = emptyLine(config, { seed: 0x99 });
    const nodes = addNodes(
      base,
      ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((id) => ({ id })),
      config,
    );
    const state = setPhase(
      addLinks(nodes, [
        ['A', 'B'],
        ['A', 'C'],
        ['A', 'D'],
        ['A', 'E'],
        ['A', 'F'],
      ]),
      'build',
      0,
      600_000,
    );
    expect(totalDegree(state, 'A')).toBe(config.links.degreeCap);

    moveNode(state, 'A', 900, 400, 1000, config);
    moveNode(state, 'G', 900, 400, 1000, config);

    const linksBefore = Object.keys(state.links).length;
    const out = reduce(
      state,
      { type: 'create_link', requestId: 'after-move', sessionId: 's-B', a: 'A', b: 'G' },
      config,
      1100,
    );

    expect(out.result).toMatchObject({ ok: false, reason: 'NODE_FULL' });
    expect(Object.keys(out.state.links)).toHaveLength(linksBefore);
  });
});

describe('outages own edge deactivation, not distance', () => {
  it('cuts an edge while keeping its identity, then restores the same id', () => {
    // A cable cut needs the Line past the seeding threshold for a link cap.
    const base = emptyLine(config, { seed: 0x1234 });
    const nodes = addNodes(
      base,
      ['A', 'B', 'C', 'D', 'E', 'F'].map((id) => ({ id })),
      config,
    );
    const graph = addLinks(nodes, [
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'D'],
      ['D', 'E'],
      ['E', 'F'],
    ]);
    const state = setPhase(graph, 'build', 0, 60_000);
    moveNode(state, 'A', 900, 300, 1000, config);
    moveNode(state, 'B', -700, 200, 1000, config);

    const warning = setPhase(state, 'warning', 1000, 6000, { roundNo: 1 });
    warning.pendingStrikeType = 'B'; // Cable cut: deactivates links without deleting them.

    const outage = reduce(warning, { type: 'tick' }, config, 6001);
    const applied = outage.events.find((event) => event.type === 'outage.applied');
    if (!applied || applied.type !== 'outage.applied') throw new Error('no outage');
    const linkId = applied.strike.links[0];
    expect(linkId).toBeDefined();

    const cutLink = outage.state.links[linkId!];
    expect(cutLink).toBeDefined();
    expect(cutLink?.cut).toBe(true);
    expect(isLinkActive(outage.state, cutLink!)).toBe(false);
    // The endpoints and their positions did not disappear.
    expect(outage.state.nodes[cutLink!.a]).toBeDefined();
    expect(outage.state.nodes[cutLink!.b]).toBeDefined();

    const recovered = reduce(outage.state, { type: 'tick' }, config, outage.state.phaseEndsAt + 1)
      .state;
    expect(recovered.links[linkId!]).toBeDefined();
    expect(recovered.links[linkId!]?.cut).toBe(false);
    expect(isLinkActive(recovered, recovered.links[linkId!]!)).toBe(true);
  });
});
