/**
 * The real draw path, against a recording canvas context.
 *
 * This does not assert pixels, but it does assert that `drawBoard` consumes the
 * current display positions: moving a node changes its arc, and moving either
 * link endpoint changes the drawn segment.
 */

import { describe, expect, it } from 'vitest';
import type { LinkView, NodeView } from '@mng/protocol';
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
      get(_target, property) {
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

function node(id: string, x: number, y: number): NodeView {
  return { id, x, y, name: id, status: 'active', restoredRoutes: 0 };
}

function link(a: string, b: string): LinkView {
  return { id: 'l1', a, b, active: true, starter: false };
}

function options(
  ctx: CanvasRenderingContext2D,
  positions: Map<string, { x: number; y: number }>,
): DrawOptions {
  const camera: Camera = { scale: 1, ox: 0, oy: 0 };
  return {
    ctx,
    nodes: new Map([
      ['a', node('a', 0, 0)],
      ['b', node('b', 100, 0)],
    ]),
    links: new Map([['l1', link('a', 'b')]]),
    positions,
    meId: null,
    targetId: null,
    invalidIds: null,
    pending: [],
    camera,
    width: 400,
    height: 300,
    now: 0,
    dimmed: false,
    pulseUntil: 0,
    highlightId: null,
    highlightUntil: 0,
    worldRadius: 1400,
  };
}

function nodeArcs(calls: Call[]): Call[] {
  return calls.filter(
    (call) => call.op === 'arc' && typeof call.args[2] === 'number' && (call.args[2] as number) < 20,
  );
}

function segment(calls: Call[]): { move: Call; line: Call } {
  return {
    move: calls.find((call) => call.op === 'moveTo')!,
    line: calls.find((call) => call.op === 'lineTo')!,
  };
}

describe('drawBoard uses live positions', () => {
  it('draws a moved node at its new screen point', () => {
    const first = recordingContext();
    drawBoard(options(first.ctx, new Map([['a', { x: 10, y: 20 }], ['b', { x: 100, y: 0 }]])));
    const firstArcs = nodeArcs(first.calls).map((call) => call.args.slice(0, 2));
    expect(firstArcs).toContainEqual([10, 20]);
    expect(firstArcs).toContainEqual([100, 0]);

    const second = recordingContext();
    drawBoard(options(second.ctx, new Map([['a', { x: 60, y: 20 }], ['b', { x: 100, y: 0 }]])));
    const secondArcs = nodeArcs(second.calls).map((call) => call.args.slice(0, 2));
    expect(secondArcs).toContainEqual([60, 20]);
    expect(secondArcs).not.toContainEqual([10, 20]);
  });

  it('redraws the edge from both current endpoints', () => {
    const first = recordingContext();
    drawBoard(options(first.ctx, new Map([['a', { x: 10, y: 20 }], ['b', { x: 100, y: 0 }]])));
    const before = segment(first.calls);
    expect(before.move.args.slice(0, 2)).toEqual([10, 20]);
    expect(before.line.args.slice(0, 2)).toEqual([100, 0]);

    const movedB = recordingContext();
    drawBoard(options(movedB.ctx, new Map([['a', { x: 10, y: 20 }], ['b', { x: 100, y: 80 }]])));
    const afterB = segment(movedB.calls);
    expect(afterB.move.args.slice(0, 2)).toEqual([10, 20]);
    expect(afterB.line.args.slice(0, 2)).toEqual([100, 80]);

    const movedA = recordingContext();
    drawBoard(options(movedA.ctx, new Map([['a', { x: 70, y: -10 }], ['b', { x: 100, y: 80 }]])));
    const afterA = segment(movedA.calls);
    expect(afterA.move.args.slice(0, 2)).toEqual([70, -10]);
    expect(afterA.line.args.slice(0, 2)).toEqual([100, 80]);
  });
});
