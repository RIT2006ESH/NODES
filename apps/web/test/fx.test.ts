/**
 * Effects are cosmetic, but they run inside the 60 fps draw loop, so they must
 * never throw, never grow without bound, and never alter the board geometry.
 */

import { describe, expect, it } from 'vitest';
import type { LinkView, NodeView } from '@mng/protocol';
import { Fx, Sfx } from '../src/fx';
import { drawBoard, type Camera, type DrawOptions } from '../src/render';

interface Call {
  op: string;
  args: unknown[];
}

function recordingContext(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = new Proxy(
    {},
    {
      get(_t, property) {
        return (...args: unknown[]) => {
          calls.push({ op: String(property), args });
        };
      },
      set() {
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const camera: Camera = { scale: 1, ox: 0, oy: 0 };

function node(id: string, x: number, y: number): NodeView {
  return { id, x, y, name: id, status: 'active', restoredRoutes: 0 };
}

function board(ctx: CanvasRenderingContext2D, extra: Partial<DrawOptions> = {}): DrawOptions {
  const link: LinkView = { id: 'l1', a: 'a', b: 'b', active: true, starter: false };
  return {
    ctx,
    nodes: new Map([['a', node('a', 0, 0)], ['b', node('b', 100, 0)]]),
    links: new Map([['l1', link]]),
    positions: new Map([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }]]),
    meId: null,
    targetId: null,
    invalidIds: null,
    pending: [],
    camera,
    width: 400,
    height: 300,
    now: 1234,
    dimmed: false,
    pulseUntil: 0,
    highlightId: null,
    highlightUntil: 0,
    worldRadius: 1400,
    ...extra,
  };
}

describe('Fx', () => {
  it('spawns, ages out and never exceeds its particle cap', () => {
    const fx = new Fx();
    for (let i = 0; i < 100; i++) fx.burst(0, 0, '#fff', 40);
    const { ctx, calls } = recordingContext();
    fx.drawOverlay(ctx, camera);
    const arcs = calls.filter((c) => c.op === 'arc').length;
    expect(arcs).toBeLessThanOrEqual(520 + 40);

    for (let i = 0; i < 200; i++) fx.update(50);
    const after = recordingContext();
    fx.drawOverlay(after.ctx, camera);
    expect(after.calls.filter((c) => c.op === 'arc')).toHaveLength(0);
  });

  it('shakes then settles to zero offset', () => {
    const fx = new Fx();
    fx.shake(10, 500, 1000);
    const mid = fx.offset(1100);
    expect(Math.abs(mid.x) + Math.abs(mid.y)).toBeGreaterThanOrEqual(0);
    expect(fx.offset(1600)).toEqual({ x: 0, y: 0 });
  });

  it('draws rings, floating text and the backdrop without throwing', () => {
    const fx = new Fx();
    fx.ring(10, 10, '#f00');
    fx.float(10, 10, 'ROUTE RESTORED', '#ff0');
    fx.update(100);
    const { ctx, calls } = recordingContext();
    fx.drawBackdrop(ctx, 400, 300);
    fx.drawOverlay(ctx, camera);
    expect(calls.some((c) => c.op === 'fillText')).toBe(true);
  });
});

describe('Sfx', () => {
  it('is a safe no-op before the audio context is unlocked', () => {
    const sfx = new Sfx();
    expect(() => {
      sfx.link();
      sfx.restored();
      sfx.warning();
      sfx.strike();
      sfx.recover();
      sfx.score('S');
      sfx.score('?');
      sfx.achievement();
      sfx.request();
    }).not.toThrow();
  });
});

describe('drawBoard overlays', () => {
  it('draws weak-point rings, hub reticles, flow packets and the backdrop', () => {
    const plain = recordingContext();
    drawBoard(board(plain.ctx));

    let backdropCalls = 0;
    const rich = recordingContext();
    drawBoard(
      board(rich.ctx, {
        weakIds: new Set(['a']),
        hubIds: new Set(['b']),
        flow: true,
        backdrop: () => {
          backdropCalls++;
        },
      }),
    );
    expect(backdropCalls).toBe(1);
    expect(rich.calls.length).toBeGreaterThan(plain.calls.length);
    // Amber dashed ring + red reticle ticks + one flow packet were added.
    expect(rich.calls.filter((c) => c.op === 'setLineDash').length).toBeGreaterThan(
      plain.calls.filter((c) => c.op === 'setLineDash').length,
    );
  });

  it('keeps the link segment endpoints unchanged by the overlays', () => {
    const { ctx, calls } = recordingContext();
    drawBoard(board(ctx, { weakIds: new Set(['a']), hubIds: new Set(['b']), flow: true }));
    const move = calls.find((c) => c.op === 'moveTo')!;
    const line = calls.find((c) => c.op === 'lineTo')!;
    expect(move.args.slice(0, 2)).toEqual([0, 0]);
    expect(line.args.slice(0, 2)).toEqual([100, 0]);
  });

  it('hides overlays and packets when the board is dimmed (read-only)', () => {
    const { ctx, calls } = recordingContext();
    drawBoard(board(ctx, { dimmed: true, weakIds: new Set(['a']), hubIds: new Set(['b']), flow: true }));
    const base = recordingContext();
    drawBoard(board(base.ctx, { dimmed: true }));
    expect(calls.length).toBe(base.calls.length);
  });
});
