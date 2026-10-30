/**
 * Rendering geometry is pure: positions in, screen segments out.
 *
 * A canvas pixel cannot be asserted without a browser, but these tests pin the
 * two properties the renderer relies on: a moved node maps to a new screen
 * point, and an edge is derived from both current endpoints every frame.
 */

import { describe, expect, it } from 'vitest';
import type { NodeView } from '@mng/protocol';
import { edgeGeometry, fitCamera, toScreen, type Camera } from '../src/render';

const camera: Camera = { scale: 2, ox: 100, oy: 50 };

function node(id: string, x: number, y: number): NodeView {
  return { id, x, y, name: id, status: 'active', restoredRoutes: 0 };
}

describe('node and edge geometry', () => {
  it('changes a node screen position when the node moves', () => {
    const before = toScreen(camera, 10, 20);
    const after = toScreen(camera, 60, -20);
    expect(after).not.toEqual(before);
    expect(after).toEqual({ x: 220, y: 10 });
  });

  it('redraws the edge when either endpoint moves', () => {
    const a = node('a', 0, 0);
    const b = node('b', 100, 0);
    const base = edgeGeometry(a, b, camera);
    expect(base).toMatchObject({ ax: 100, ay: 50, bx: 300, by: 50, worldLength: 100 });

    const movedA = edgeGeometry({ x: -50, y: 30 }, b, camera);
    expect({ ax: movedA.ax, ay: movedA.ay }).not.toEqual({ ax: base.ax, ay: base.ay });
    expect({ bx: movedA.bx, by: movedA.by }).toEqual({ bx: base.bx, by: base.by });
    expect(movedA.worldLength).toBeGreaterThan(base.worldLength);

    const movedB = edgeGeometry(a, { x: 100, y: 90 }, camera);
    expect({ ax: movedB.ax, ay: movedB.ay }).toEqual({ ax: base.ax, ay: base.ay });
    expect({ bx: movedB.bx, by: movedB.by }).not.toEqual({ bx: base.bx, by: base.by });
    expect(movedB.worldLength).toBeGreaterThan(base.worldLength);
  });

  it('keeps both ends of a very long edge inside a fitted viewport', () => {
    const positions = new Map([
      ['a', { x: -1400, y: 0 }],
      ['b', { x: 1400, y: 0 }],
    ]);
    const fitted = fitCamera([], 800, 600, positions);
    const edge = edgeGeometry(positions.get('a')!, positions.get('b')!, fitted);

    expect(edge.worldLength).toBe(2800);
    expect(edge.ax).toBeGreaterThanOrEqual(0);
    expect(edge.ax).toBeLessThanOrEqual(800);
    expect(edge.bx).toBeGreaterThanOrEqual(0);
    expect(edge.bx).toBeLessThanOrEqual(800);
    expect(edge.ay).toBeGreaterThanOrEqual(0);
    expect(edge.ay).toBeLessThanOrEqual(600);
    expect(edge.by).toBeGreaterThanOrEqual(0);
    expect(edge.by).toBeLessThanOrEqual(600);
    expect(Number.isFinite(edge.screenLength)).toBe(true);
    expect(edge.screenLength).toBeGreaterThan(0);
  });

  it('does not change edge identity or length when the camera zooms', () => {
    const a = { x: -700, y: 100 };
    const b = { x: 900, y: -200 };
    const near = edgeGeometry(a, b, { scale: 3, ox: 0, oy: 0 });
    const far = edgeGeometry(a, b, { scale: 0.2, ox: 400, oy: 300 });
    expect(near.worldLength).toBe(far.worldLength);
    expect(near.screenLength).not.toBe(far.screenLength);
  });
});
