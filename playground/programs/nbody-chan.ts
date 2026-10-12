// Porffor's threads/playground/presets/3-nbody.js with goroutines and channels (chan.js). Each goroutine owns
// its slice of the bodies. Every step it sends its positions to main, and main sends everyone's back,
// shared once; at the end each slice moves back to main. No barrier and no shared mutable state:
// the channels order everything. Messages are tagged with the sender, so the positions keep body
// order and the arithmetic is the preset's.
import { Channel, go, log, partition, type Sending, share, type Shared, take } from "threads";

type Body = { x: number; y: number; z: number; vx: number; vy: number; vz: number; m: number };
type Pos = { x: number; y: number; z: number; m: number };
type Positions = { t: number; pos: Pos[] };
type Slice = { t: number; bodies: Body[] };

const BODIES = 800, STEPS = 30, DT = 0.001, SOFTEN = 0.01;

function makeBodies(): Sending<Body[]> {
  let seed = 1;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const bodies: Body[] = [];
  for (let i = 0; i < BODIES; i++)
    bodies.push({ x: random() * 2 - 1, y: random() * 2 - 1, z: random() * 2 - 1, vx: 0, vy: 0, vz: 0, m: 0.5 + random() });
  return bodies;
}

// new velocities for this goroutine's bodies, from everyone's positions (in body order)
function accelerate(mine: Body[], all: Shared<Pos[]>) {
  const n = all.length;
  for (let i = 0; i < mine.length; i++) {
    const b = mine[i];
    const x = b.x, y = b.y, z = b.z;
    let ax = 0, ay = 0, az = 0;
    for (let j = 0; j < n; j++) {
      const o = all[j];
      const dx = o.x - x, dy = o.y - y, dz = o.z - z;
      const d2 = dx * dx + dy * dy + dz * dz + SOFTEN;
      const f = o.m / (d2 * Math.sqrt(d2));
      ax += dx * f; ay += dy * f; az += dz * f;
    }
    b.vx += ax * DT; b.vy += ay * DT; b.vz += az * DT;
  }
}

function move(mine: Body[]) {
  for (const b of mine) { b.x += b.vx * DT; b.y += b.vy * DT; b.z += b.vz * DT; }
}

function energy(bodies: Body[]): number {
  let e = 0;
  for (const b of bodies) e += 0.5 * b.m * (b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
  return e;
}

// a goroutine: sends its positions on `gather`, gets everyone's on `scatter`, and when done moves its
// bodies back on `done`
function worker(t: number, mine: Sending<Body[]>, gather: Channel<Positions>,
  scatter: Channel<Shared<Pos[]>>, done: Channel<Slice>) {
  for (let s = 0; s < STEPS; s++) {
    gather.send({ t, pos: mine.map(b => ({ x: b.x, y: b.y, z: b.z, m: b.m })) });
    accelerate(mine, scatter.recv()!);
    move(mine);
  }
  done.send({ t, bodies: mine });
}

function simulate(threads: number): number {
  const gather = new Channel<Positions>(threads), done = new Channel<Slice>(threads);
  const scatter: Channel<Shared<Pos[]>>[] = [];
  const parts = partition(makeBodies(), threads);
  for (let t = 0; t < threads; t++) {
    const ch = new Channel<Shared<Pos[]>>(1);
    scatter.push(ch);
    go(worker, t, take(parts, t), gather, ch, done);
  }
  for (let s = 0; s < STEPS; s++) {
    const slots: Pos[][] = [];
    for (let k = 0; k < threads; k++) {
      const m = gather.recv()!;
      slots[m.t] = m.pos;
    }
    const all = share(slots.flat()); // written once; each goroutine reads its own copy
    for (const ch of scatter) ch.send(all);
  }
  const slices: Body[][] = [];
  for (let k = 0; k < threads; k++) {
    const m = done.recv()!;
    slices[m.t] = m.bodies;
  }
  return energy(slices.flat());
}

// the thread counts come from the runner (the playground), so a benchmark can repeat them
export function main(threadCounts: readonly number[]) {
  let base = 0;
  for (const threads of threadCounts) {
    const t0 = performance.now();
    const e = simulate(threads);
    const ms = performance.now() - t0;
    if (threads === 1) base = ms;
    log(`threads ${threads}  ${ms.toFixed(0).padStart(5)} ms  ${(base / ms).toFixed(2)}x  kinetic energy ${e.toFixed(6)}`);
  }
}
