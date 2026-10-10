// threads/playground/presets/3-nbody.js written for own and shared values (own.mjs): plain JS,
// no translation. each thread owns its slice of the bodies (moved in, moved back by join).
// every step each thread shares a frozen snapshot of its positions; the others read their own
// copies of it. the board of snapshots and the barrier are the only shared mutable state
import { fns, spawn, share, Barrier, Slots, log } from './own.mjs';

const BODIES = 800, STEPS = 30, DT = 0.001, SOFTEN = 0.01;

const makeBodies = () => {
  let seed = 1;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const bodies = [];
  for (let i = 0; i < BODIES; i++)
    bodies.push({ x: random() * 2 - 1, y: random() * 2 - 1, z: random() * 2 - 1, vx: 0, vy: 0, vz: 0, m: 0.5 + random() });
  return bodies;
};

// new velocities for this thread's bodies, from everyone's positions (all: every snapshot, in
// body order)
const accelerate = (mine, all) => {
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
};

const move = mine => {
  for (const b of mine) { b.x += b.vx * DT; b.y += b.vy * DT; b.z += b.vz * DT; }
};

const energy = bodies => {
  let e = 0;
  for (const b of bodies) e += 0.5 * b.m * (b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
  return e;
};

// a thread: its own slice, the board, and the barrier
const worker = (t, mine, board, barrier) => {
  for (let s = 0; s < STEPS; s++) {
    board.set(t, share(mine.map(b => ({ x: b.x, y: b.y, z: b.z, m: b.m }))));
    barrier.wait(); // everyone has shared their positions
    const all = [];
    for (let k = 0; k < board.length; k++) for (const o of board.get(k)) all.push(o);
    accelerate(mine, all);
    barrier.wait(); // everyone has read them, so the board can change
    move(mine);
  }
  return mine;
};
fns({ worker });

const simulate = threads => {
  let bodies = makeBodies();
  const board = new Slots(threads), barrier = new Barrier(threads);
  const ts = [];
  for (let t = 0; t < threads; t++) {
    const lo = Math.floor(BODIES * t / threads), hi = Math.floor(BODIES * (t + 1) / threads);
    ts.push(spawn(worker, t, bodies.slice(lo, hi), board, barrier)); // the slice moves to the thread
  }
  bodies = ts.flatMap(th => th.join()); // and back
  return energy(bodies);
};

export function main(threadCounts) {
  let base = 0;
  for (const threads of threadCounts) {
    const t0 = performance.now();
    const e = simulate(threads);
    const ms = performance.now() - t0;
    if (threads === 1) base = ms;
    log(`threads ${threads}  ${ms.toFixed(0).padStart(5)} ms  ${(base / ms).toFixed(2)}x  kinetic energy ${e.toFixed(6)}`);
  }
}
