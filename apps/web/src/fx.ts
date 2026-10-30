/**
 * Game-feel layer: particles, shockwaves, floating text, screen shake and
 * synthesized sound. Purely cosmetic and client-local; nothing here touches
 * game state or the wire protocol.
 */

import type { Camera } from './render';

interface Particle {
  wx: number;
  wy: number;
  ox: number;
  oy: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  color: string;
}

interface Ring {
  wx: number;
  wy: number;
  age: number;
  life: number;
  radius: number;
  color: string;
  width: number;
}

interface Floater {
  wx: number;
  wy: number;
  age: number;
  life: number;
  text: string;
  color: string;
}

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  a: number;
}

const MAX_PARTICLES = 520;
const MAX_FLOATERS = 8;

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export class Fx {
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private floaters: Floater[] = [];
  private motes: Mote[] = [];
  private shakeMag = 0;
  private shakeStart = 0;
  private shakeUntil = 0;
  private calm = reducedMotion();

  constructor() {
    for (let i = 0; i < 46; i++) {
      this.motes.push({
        x: Math.random(),
        y: Math.random(),
        vx: (Math.random() - 0.5) * 0.004,
        vy: -0.002 - Math.random() * 0.006,
        r: 0.6 + Math.random() * 1.4,
        a: 0.08 + Math.random() * 0.2,
      });
    }
  }

  burst(wx: number, wy: number, color: string, count: number, speed = 90, life = 750): void {
    const n = this.calm ? Math.ceil(count / 3) : count;
    for (let i = 0; i < n && this.particles.length < MAX_PARTICLES; i++) {
      const angle = Math.random() * Math.PI * 2;
      const v = speed * (0.25 + Math.random() * 0.85);
      this.particles.push({
        wx,
        wy,
        ox: 0,
        oy: 0,
        vx: Math.cos(angle) * v,
        vy: Math.sin(angle) * v,
        age: 0,
        life: life * (0.6 + Math.random() * 0.6),
        size: 1.2 + Math.random() * 2.2,
        color,
      });
    }
  }

  ring(wx: number, wy: number, color: string, radius = 64, life = 800, width = 2): void {
    if (this.rings.length > 40) this.rings.shift();
    this.rings.push({ wx, wy, age: 0, life, radius, color, width });
  }

  float(wx: number, wy: number, text: string, color: string): void {
    if (this.floaters.length >= MAX_FLOATERS) this.floaters.shift();
    this.floaters.push({ wx, wy, age: 0, life: 1500, text, color });
  }

  shake(magnitude: number, ms: number, now = Date.now()): void {
    if (this.calm) return;
    this.shakeMag = Math.max(this.shakeMag, magnitude);
    this.shakeStart = now;
    this.shakeUntil = now + ms;
  }

  /** Camera shake offset for this frame, in CSS pixels. */
  offset(now: number): { x: number; y: number } {
    if (now >= this.shakeUntil) {
      this.shakeMag = 0;
      return { x: 0, y: 0 };
    }
    const k = (this.shakeUntil - now) / Math.max(1, this.shakeUntil - this.shakeStart);
    const m = this.shakeMag * k * k;
    return { x: (Math.random() - 0.5) * 2 * m, y: (Math.random() - 0.5) * 2 * m };
  }

  update(dtMs: number): void {
    const dt = dtMs / 1000;
    for (const p of this.particles) {
      p.age += dtMs;
      p.ox += p.vx * dt;
      p.oy += p.vy * dt;
      p.vx *= 1 - Math.min(1, 2.2 * dt);
      p.vy *= 1 - Math.min(1, 2.2 * dt);
    }
    this.particles = this.particles.filter((p) => p.age < p.life);
    for (const r of this.rings) r.age += dtMs;
    this.rings = this.rings.filter((r) => r.age < r.life);
    for (const f of this.floaters) f.age += dtMs;
    this.floaters = this.floaters.filter((f) => f.age < f.life);
    for (const m of this.motes) {
      m.x += m.vx * dt * 6;
      m.y += m.vy * dt * 6;
      if (m.y < -0.02) m.y = 1.02;
      if (m.x < -0.02) m.x = 1.02;
      if (m.x > 1.02) m.x = -0.02;
    }
  }

  /** Slow ambient dust behind the network; gives the empty board some life. */
  drawBackdrop(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.save();
    ctx.fillStyle = '#9fd8ff';
    for (const m of this.motes) {
      ctx.globalAlpha = m.a;
      ctx.beginPath();
      ctx.arc(m.x * width, m.y * height, m.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawOverlay(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const sx = (wx: number): number => wx * camera.scale + camera.ox;
    const sy = (wy: number): number => wy * camera.scale + camera.oy;

    ctx.save();
    for (const r of this.rings) {
      const t = r.age / r.life;
      const ease = 1 - (1 - t) * (1 - t);
      ctx.beginPath();
      ctx.arc(sx(r.wx), sy(r.wy), 6 + r.radius * ease, 0, Math.PI * 2);
      ctx.globalAlpha = (1 - t) * 0.85;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width * (1 - t * 0.6);
      ctx.stroke();
    }

    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      const t = p.age / p.life;
      ctx.globalAlpha = Math.max(0, 1 - t) * 0.95;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(sx(p.wx) + p.ox, sy(p.wy) + p.oy, p.size * (1 - t * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    ctx.textAlign = 'center';
    ctx.font = '700 12px ui-sans-serif, system-ui, sans-serif';
    for (const f of this.floaters) {
      const t = f.age / f.life;
      ctx.globalAlpha = t < 0.15 ? t / 0.15 : Math.max(0, 1 - (t - 0.15) / 0.85);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, sx(f.wx), sy(f.wy) - 18 - t * 34);
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Sound: tiny synthesized cues, no audio assets. Starts muted until the first
// user gesture unlocks the AudioContext; the mute choice is remembered.
// ---------------------------------------------------------------------------

const MUTE_KEY = 'mng.muted';

type Wave = OscillatorType;

export class Sfx {
  private audio: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted: boolean;

  constructor() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(MUTE_KEY);
    } catch {
      stored = null;
    }
    this.muted = stored === '1';
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(value: boolean): void {
    this.muted = value;
    try {
      localStorage.setItem(MUTE_KEY, value ? '1' : '0');
    } catch {
      // Not critical.
    }
    if (this.master && this.audio) this.master.gain.setTargetAtTime(value ? 0 : 0.5, this.audio.currentTime, 0.03);
  }

  /** Call from a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (this.audio) {
      if (this.audio.state === 'suspended') void this.audio.resume();
      return;
    }
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      this.audio = new Ctor();
      this.master = this.audio.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.audio.destination);
    } catch {
      this.audio = null;
    }
  }

  private ready(): AudioContext | null {
    if (this.muted || !this.audio || !this.master) return null;
    if (this.audio.state === 'suspended') void this.audio.resume();
    return this.audio;
  }

  private tone(freq: number, at: number, dur: number, type: Wave, gain: number, slideTo?: number): void {
    const a = this.ready();
    if (!a || !this.master) return;
    const t0 = a.currentTime + at;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  private noise(at: number, dur: number, gain: number, cutoff: number): void {
    const a = this.ready();
    if (!a || !this.master) return;
    const t0 = a.currentTime + at;
    const frames = Math.max(1, Math.floor(a.sampleRate * dur));
    const buffer = a.createBuffer(1, frames, a.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = a.createBufferSource();
    src.buffer = buffer;
    const filter = a.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoff, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(60, cutoff / 6), t0 + dur);
    const g = a.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t0);
  }

  request(): void {
    this.tone(660, 0, 0.09, 'sine', 0.12);
  }

  link(): void {
    this.tone(523, 0, 0.1, 'triangle', 0.16);
    this.tone(784, 0.07, 0.16, 'triangle', 0.16);
  }

  restored(): void {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, i * 0.07, 0.2, 'triangle', 0.17));
  }

  warning(): void {
    for (let i = 0; i < 3; i++) {
      this.tone(880, i * 0.34, 0.16, 'square', 0.07);
      this.tone(660, i * 0.34 + 0.17, 0.16, 'square', 0.07);
    }
  }

  strike(): void {
    this.noise(0, 0.7, 0.55, 1800);
    this.tone(110, 0, 0.6, 'sawtooth', 0.22, 38);
  }

  recover(): void {
    [392, 494, 587, 784].forEach((f, i) => this.tone(f, i * 0.09, 0.28, 'sine', 0.16));
  }

  score(grade: string): void {
    const sets: Record<string, number[]> = {
      S: [523, 659, 784, 1047, 1319],
      A: [523, 659, 784, 1047],
      B: [440, 554, 659],
      C: [392, 466, 523],
      D: [330, 294],
    };
    (sets[grade] ?? sets.D ?? []).forEach((f, i) => this.tone(f, i * 0.11, 0.3, 'triangle', 0.17));
  }

  achievement(): void {
    [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, i * 0.08, 0.22, 'sine', 0.15));
  }
}
