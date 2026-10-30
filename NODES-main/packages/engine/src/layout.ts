import type { GameConfig } from '@mng/config';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export function positionFor(index: number, config: GameConfig): Point {
  if (!Number.isInteger(index) || index < 0) throw new Error(`layout index must be >= 0, got ${index}`);
  const r = config.layout.spacing * Math.sqrt(index + 1);
  const theta = index * config.layout.goldenAngle;
  return {
    x: Math.round(Math.cos(theta) * r * 100) / 100,
    y: Math.round(Math.sin(theta) * r * 100) / 100,
  };
}

export function distance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
