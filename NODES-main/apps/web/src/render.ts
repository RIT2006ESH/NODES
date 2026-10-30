/**
 * Canvas renderer. World coordinates are server-authoritative; the renderer
 * reads the current (smoothed) positions and draws edges between them. Links
 * are IDs, never fixed-length lines.
 */

import type { LinkView, NodeView } from '@mng/protocol';

export interface Camera {
  scale: number;
  ox: number;
  oy: number;
}

export interface WorldPoint {
  x: number;
  y: number;
}

export interface EdgeGeometry {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  worldLength: number;
  screenLength: number;
}

export interface PendingLink {
  readonly a: string;
  readonly b: string;
  readonly at: number;
}

const PALETTE = ['#69d5ff', '#82e8cc', '#468dff', '#9cb8ff', '#ffc66d', '#8fe3cf'];

export function toScreen(camera: Camera, x: number, y: number): { x: number; y: number } {
  return { x: x * camera.scale + camera.ox, y: y * camera.scale + camera.oy };
}

export function toWorld(camera: Camera, x: number, y: number): { x: number; y: number } {
  return { x: (x - camera.ox) / camera.scale, y: (y - camera.oy) / camera.scale };
}

/**
 * Edge geometry is derived from the two endpoint positions every frame. Moving
 * either endpoint moves the line; nothing about the edge's identity depends on
 * its length.
 */
export function edgeGeometry(a: WorldPoint, b: WorldPoint, camera: Camera): EdgeGeometry {
  const p = toScreen(camera, a.x, a.y);
  const q = toScreen(camera, b.x, b.y);
  return {
    ax: p.x,
    ay: p.y,
    bx: q.x,
    by: q.y,
    worldLength: Math.hypot(a.x - b.x, a.y - b.y),
    screenLength: Math.hypot(p.x - q.x, p.y - q.y),
  };
}

export function fitCamera(
  nodes: Iterable<NodeView>,
  width: number,
  height: number,
  positions?: ReadonlyMap<string, WorldPoint>,
): Camera {
  const list = positions ? [...positions.values()] : [...nodes].map((n) => ({ x: n.x, y: n.y }));
  if (list.length === 0) return { scale: 1, ox: width / 2, oy: height / 2 };

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of list) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }

  const padding = Math.min(width, height) * 0.12 + 24;
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const scale = Math.max(
    0.05,
    Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY, 3.2),
  );
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  return { scale, ox: width / 2 - cx * scale, oy: height / 2 - cy * scale };
}

export function pickNode(
  nodes: Iterable<NodeView>,
  camera: Camera,
  sx: number,
  sy: number,
  threshold = 26,
  positions?: ReadonlyMap<string, WorldPoint>,
): NodeView | null {
  let best: NodeView | null = null;
  let bestDist = threshold * threshold;
  for (const node of nodes) {
    const point = positions?.get(node.id) ?? node;
    const p = toScreen(camera, point.x, point.y);
    const dx = p.x - sx;
    const dy = p.y - sy;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = node;
    }
  }
  return best;
}

function componentIndex(links: LinkView[], nodes: Map<string, NodeView>): Map<string, number> {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root) as string;
    return root;
  };

  for (const id of nodes.keys()) parent.set(id, id);
  for (const link of links) {
    if (!link.active) continue;
    const ra = find(link.a);
    const rb = find(link.b);
    if (ra !== rb) parent.set(ra, rb);
  }

  const index = new Map<string, number>();
  const order: string[] = [];
  for (const id of nodes.keys()) {
    const root = find(id);
    let i = index.get(root);
    if (i === undefined) {
      i = order.length % PALETTE.length;
      order.push(root);
      index.set(root, i);
    }
    index.set(id, i);
  }
  return index;
}

export interface DrawOptions {
  readonly ctx: CanvasRenderingContext2D;
  readonly nodes: Map<string, NodeView>;
  readonly links: Map<string, LinkView>;
  readonly positions: ReadonlyMap<string, WorldPoint>;
  readonly meId: string | null;
  /** The node selected as the target of a connection request. */
  readonly targetId: string | null;
  readonly invalidIds: ReadonlySet<string> | null;
  /** Outgoing pending requests, drawn as dashed indicators, never as edges. */
  readonly pending: readonly PendingLink[];
  readonly camera: Camera;
  readonly width: number;
  readonly height: number;
  readonly now: number;
  readonly dimmed: boolean;
  readonly pulseUntil: number;
  /** Accepted links that should receive a short event-driven energy pulse. */
  readonly pulseLinks?: ReadonlyMap<string, number>;
  readonly pulseSegments?: readonly { a: string; b: string; at: number }[];
  readonly pulseStartedAt?: number;
  readonly pulseUnreachable?: ReadonlySet<string>;
  readonly failurePreviewId?: string;
  readonly failurePreviewComponents?: ReadonlyMap<string, number>;
  /** Briefly highlighted after a search or leaderboard selection. */
  readonly highlightId: string | null;
  readonly highlightUntil: number;
  readonly worldRadius: number;
  /** Single points of failure in the largest group; drawn as amber warning rings. */
  readonly weakIds?: ReadonlySet<string>;
  /** Likely Hub-strike targets, drawn as red reticles during Warning. */
  readonly hubIds?: ReadonlySet<string>;
  /** Ambient data packets travelling along live links. */
  readonly flow?: boolean;
  /** Drawn under the network (ambient dust). */
  readonly backdrop?: (ctx: CanvasRenderingContext2D) => void;
}

function hash01(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

export function drawBoard(options: DrawOptions): void {
  const { ctx, nodes, links, meId, camera, now, dimmed, positions } = options;

  ctx.save();
  ctx.clearRect(0, 0, options.width, options.height);

  // A restrained technical grid gives the shared world spatial depth without
  // adding DOM layers or per-particle animation work.
  ctx.save();
  ctx.fillStyle = 'rgba(105, 213, 255, 0.035)';
  const grid = 72;
  for (let x = 0; x < options.width; x += grid) ctx.fillRect(x, 0, 1, options.height);
  for (let y = 0; y < options.height; y += grid) ctx.fillRect(0, y, options.width, 1);
  ctx.restore();

  options.backdrop?.(ctx);

  const linkList = [...links.values()];
  const comp = componentIndex(linkList, nodes);

  // World boundary: makes long edges and movement limits legible at any zoom.
  const centre = toScreen(camera, 0, 0);
  ctx.beginPath();
  ctx.arc(centre.x, centre.y, options.worldRadius * camera.scale, 0, Math.PI * 2);
  ctx.setLineDash([2, 9]);
  ctx.strokeStyle = 'rgba(127, 215, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);

  const edgeWidth = Math.max(1, Math.min(2, 1.1 * Math.sqrt(Math.max(0.08, camera.scale))));

  // Links: recompute both endpoints from their current positions every frame.
  for (const link of linkList) {
    const a = nodes.get(link.a);
    const b = nodes.get(link.b);
    if (!a || !b) continue;
    const geometry = edgeGeometry(
      positions.get(link.a) ?? a,
      positions.get(link.b) ?? b,
      camera,
    );
    const idx = comp.get(link.a) ?? 0;
    const previewIncident = options.failurePreviewId === link.a || options.failurePreviewId === link.b;

    ctx.beginPath();
    ctx.moveTo(geometry.ax, geometry.ay);
    ctx.lineTo(geometry.bx, geometry.by);
    if (link.active) {
      ctx.strokeStyle = PALETTE[idx] as string;
      ctx.globalAlpha = previewIncident ? 0.04 : dimmed ? 0.16 : 0.48;
      ctx.lineWidth = edgeWidth;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Ambient traffic: a faint packet drifts along every live link so a healthy
      // network visibly hums and a cut one visibly goes quiet.
      if (options.flow && !dimmed && linkList.length <= 260) {
        const t = (now / 2600 + hash01(link.id)) % 1;
        const dir = hash01(link.id + 'd') > 0.5 ? t : 1 - t;
        ctx.beginPath();
        ctx.arc(
          geometry.ax + (geometry.bx - geometry.ax) * dir,
          geometry.ay + (geometry.by - geometry.ay) * dir,
          1.7,
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = PALETTE[idx] as string;
        ctx.globalAlpha = 0.7;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      const pulseEnd = options.pulseLinks?.get(link.id) ?? 0;
      if (pulseEnd > now) {
        const progress = 1 - (pulseEnd - now) / 900;
        const px = geometry.ax + (geometry.bx - geometry.ax) * progress;
        const py = geometry.ay + (geometry.by - geometry.ay) * progress;
        ctx.save();
        ctx.beginPath();
        ctx.arc(px, py, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = '#d9fbff';
        ctx.shadowColor = '#69d5ff';
        ctx.shadowBlur = 16;
        ctx.globalAlpha = 0.95;
        ctx.fill();
        ctx.restore();
      }

      // Starter links are server assistance, not player actions: mark them
      // with a small midpoint dot so the board is honest about its history.
      if (link.starter) {
        ctx.beginPath();
        ctx.arc(
          (geometry.ax + geometry.bx) / 2,
          (geometry.ay + geometry.by) / 2,
          2,
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = PALETTE[idx] as string;
        ctx.globalAlpha = dimmed ? 0.18 : 0.55;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    } else {
      ctx.setLineDash([3, 5]);
      ctx.strokeStyle = 'rgba(255, 154, 166, 0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Nodes: draw everyone first, the local player last so they are never hidden.
  const radius = Math.max(4, Math.min(11, 3.4 + camera.scale * 2.2));
  const ordered = [...nodes.values()].sort((a, b) => Number(a.id === meId) - Number(b.id === meId));
  for (const node of ordered) {
    const point = positions.get(node.id) ?? node;
    const p = toScreen(camera, point.x, point.y);
    const isMe = node.id === meId;
    const r = isMe ? radius + 3 : radius;
    const idx = comp.get(node.id) ?? 0;
      const colour = PALETTE[idx] as string;
    const disabled = node.status === 'disabled';
    const faded = options.invalidIds?.has(node.id) ?? false;
    const isTarget = options.targetId === node.id;
    const pulseElapsed = options.pulseStartedAt === undefined ? -1 : now - options.pulseStartedAt;
    const pulseArrived = options.pulseSegments?.some((segment) => segment.b === node.id && pulseElapsed >= segment.at + 260) ?? false;
    const pulseLost = options.pulseUnreachable?.has(node.id) ?? false;
    const previewRemoved = options.failurePreviewId === node.id;
    const previewGroup = options.failurePreviewComponents?.get(node.id);

    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    if (disabled) {
      ctx.fillStyle = 'rgba(90, 100, 125, 0.5)';
      ctx.fill();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = 'rgba(255, 140, 150, 0.7)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = colour;
      ctx.globalAlpha = previewRemoved ? 0.12 : dimmed ? 0.3 : faded ? 0.22 : 0.92;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(6, 10, 20, 0.85)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // Keep the local network readable against the atmospheric world.
    if (!disabled && !dimmed) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2);
      ctx.strokeStyle = colour;
      ctx.globalAlpha = isMe ? 0.5 : 0.2;
      ctx.lineWidth = isMe ? 2 : 1;
      ctx.stroke();
      ctx.restore();
    }

    // The selected target of a connection request, distinct from "You".
    if (isTarget) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + (isMe ? 8 : 4), 0, Math.PI * 2);
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = 'rgba(255, 206, 107, 0.95)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (pulseArrived) {
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 7 + Math.sin(now / 80) * 2, 0, Math.PI * 2);
      ctx.strokeStyle = '#82e8cc'; ctx.globalAlpha = .7; ctx.lineWidth = 1.5; ctx.stroke(); ctx.globalAlpha = 1;
    }
    if (pulseLost) {
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
      ctx.setLineDash([2, 3]); ctx.strokeStyle = '#ffc66d'; ctx.globalAlpha = .75; ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    if (options.failurePreviewComponents && previewGroup !== undefined && !previewRemoved) {
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = previewGroup % 2 ? '#ffc66d' : '#468dff'; ctx.globalAlpha = .28; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
    }

    // Strategy overlay: amber = removing this node would split the group
    // (a single point of failure); red reticle = what a Hub strike would hunt.
    if (!disabled && !dimmed && options.weakIds?.has(node.id)) {
      const wobble = 1 + 0.1 * Math.sin(now / 260 + hash01(node.id) * 6);
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, (r + 7) * wobble, 0, Math.PI * 2);
      ctx.setLineDash([3, 4]);
      ctx.lineDashOffset = -now / 70;
      ctx.strokeStyle = '#ffc66d';
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.restore();
    }
    if (!disabled && !dimmed && options.hubIds?.has(node.id)) {
      const o = r + 11 + Math.sin(now / 140) * 1.5;
      const tick = 5;
      ctx.save();
      ctx.strokeStyle = '#ff667d';
      ctx.lineWidth = 1.6;
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        ctx.moveTo(p.x + dx * o, p.y + dy * o);
        ctx.lineTo(p.x + dx * (o - tick), p.y + dy * (o - tick));
      }
      ctx.stroke();
      ctx.restore();
    }

    // Search/leaderboard discovery highlight. This is purely visual: it does
    // not select a request target or create a connection.
    if (options.highlightId === node.id && now < options.highlightUntil) {
      const pulse = 1 + 0.12 * Math.sin(now / 110);
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, (r + 12) * pulse, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(127, 215, 255, 0.95)';
      ctx.lineWidth = 2;
      ctx.shadowColor = 'rgba(127, 215, 255, 0.85)';
      ctx.shadowBlur = 16;
      ctx.stroke();
      ctx.restore();
    }

    if (isMe) {
      const pulse = now < options.pulseUntil ? 1 + 0.35 * Math.sin((options.pulseUntil - now) / 90) : 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, (r + 4) * pulse, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = 'rgba(232, 238, 252, 0.95)';
      ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('You', p.x, p.y - r - 9);
    } else if (r > 7.5 && nodes.size <= 80) {
      ctx.fillStyle = faded ? 'rgba(232, 238, 252, 0.28)' : 'rgba(232, 238, 252, 0.62)';
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(node.name, p.x, p.y - r - 5);
    }
    if (!isMe && node.presence === 'offline' && !dimmed) {
      ctx.beginPath();
      ctx.arc(p.x + r * 0.7, p.y - r * 0.7, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ff667d';
      ctx.fill();
    }
  }

  // One lightweight signal per discovered tree edge. It only uses real active links.
  if (options.pulseSegments && options.pulseStartedAt !== undefined) {
    const elapsed = now - options.pulseStartedAt;
    for (const segment of options.pulseSegments) {
      const progress = (elapsed - segment.at) / 260;
      if (progress < 0 || progress > 1) continue;
      const liveLink = [...links.values()].find((link) => link.active && ((link.a === segment.a && link.b === segment.b) || (link.a === segment.b && link.b === segment.a)));
      if (!liveLink) continue;
      const a = nodes.get(segment.a); const b = nodes.get(segment.b);
      if (!a || !b) continue;
      const geometry = edgeGeometry(positions.get(segment.a) ?? a, positions.get(segment.b) ?? b, camera);
      ctx.save(); ctx.beginPath(); ctx.arc(geometry.ax + (geometry.bx - geometry.ax) * progress, geometry.ay + (geometry.by - geometry.ay) * progress, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#d9fbff'; ctx.shadowColor = '#69d5ff'; ctx.shadowBlur = 14; ctx.fill(); ctx.restore();
    }
  }

  // Outgoing requests: a dashed indicator, deliberately unlike an accepted edge.
  for (const pending of options.pending) {
    const a = nodes.get(pending.a);
    const b = nodes.get(pending.b);
    if (!a || !b) continue;
    const geometry = edgeGeometry(
      positions.get(pending.a) ?? a,
      positions.get(pending.b) ?? b,
      camera,
    );
    ctx.beginPath();
    ctx.moveTo(geometry.ax, geometry.ay);
    ctx.lineTo(geometry.bx, geometry.by);
    ctx.setLineDash([2, 8]);
    ctx.lineDashOffset = -(now / 45) % 10;
    ctx.strokeStyle = 'rgba(255, 206, 107, 0.9)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }

  ctx.restore();
}
