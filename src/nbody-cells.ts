// presets/nbody.js for own and shared values (own.ts), with the positions in a
// shared Float64Array cell instead of shared snapshots: plain JS, no
// translation. each thread owns its slice of the bodies (moved in, moved back
// by join). every step it writes its bodies' positions into the cell, and after
// a barrier everyone reads all of them in place: nothing is copied per step
import {fns, spawn, Barrier, sharedFloat64Array, log} from '@arv/threads/own';

interface Body {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  m: number;
}

const BODIES = 800,
  STEPS = 30,
  DT = 0.001,
  SOFTEN = 0.01;

const makeBodies = () => {
  let seed = 1;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const bodies = [];
  for (let i = 0; i < BODIES; i++)
    bodies.push({
      x: random() * 2 - 1,
      y: random() * 2 - 1,
      z: random() * 2 - 1,
      vx: 0,
      vy: 0,
      vz: 0,
      m: 0.5 + random(),
    });
  return bodies;
};

// new velocities for this thread's bodies, from everyone's positions: [x, y, z,
// m] per body
const accelerate = (mine: Body[], pos: Float64Array) => {
  const n = pos.length >> 2;
  for (let i = 0; i < mine.length; i++) {
    const b = mine[i];
    const x = b.x,
      y = b.y,
      z = b.z;
    let ax = 0,
      ay = 0,
      az = 0;
    for (let j = 0; j < n; j++) {
      const k = j << 2;
      const dx = pos[k] - x,
        dy = pos[k + 1] - y,
        dz = pos[k + 2] - z;
      const d2 = dx * dx + dy * dy + dz * dz + SOFTEN;
      const f = pos[k + 3] / (d2 * Math.sqrt(d2));
      ax += dx * f;
      ay += dy * f;
      az += dz * f;
    }
    b.vx += ax * DT;
    b.vy += ay * DT;
    b.vz += az * DT;
  }
};

const move: (mine: Body[]) => void = mine => {
  for (const b of mine) {
    b.x += b.vx * DT;
    b.y += b.vy * DT;
    b.z += b.vz * DT;
  }
};

const energy: (bodies: Body[]) => number = bodies => {
  let e = 0;
  for (const b of bodies)
    e += 0.5 * b.m * (b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
  return e;
};

// a thread: the first body index of its slice, the slice it owns, the positions
// cell, the barrier
const worker: (
  lo: number,
  mine: Body[],
  pos: Float64Array,
  barrier: Barrier,
) => Body[] = (lo, mine, pos, barrier) => {
  for (let s = 0; s < STEPS; s++) {
    for (let i = 0; i < mine.length; i++) {
      const b = mine[i],
        k = (lo + i) << 2;
      pos[k] = b.x;
      pos[k + 1] = b.y;
      pos[k + 2] = b.z;
      pos[k + 3] = b.m;
    }
    barrier.wait(); // every position is written
    accelerate(mine, pos);
    barrier.wait(); // everyone has read them, so they can change
    move(mine);
  }
  return mine;
};
fns({worker});

const simulate: (threads: number) => number = threads => {
  const bodies = makeBodies();
  const pos = sharedFloat64Array(BODIES * 4),
    barrier = new Barrier(threads);
  const ts = [];
  for (let t = 0; t < threads; t++) {
    const lo = Math.floor((BODIES * t) / threads),
      hi = Math.floor((BODIES * (t + 1)) / threads);
    // the slice moves to the thread
    ts.push(spawn(worker, lo, bodies.slice(lo, hi), pos, barrier));
  }
  return energy(ts.flatMap(th => th.join())); // and back
};

export function main(threadCounts: number[]) {
  let base = 0;
  for (const threads of threadCounts) {
    const t0 = performance.now();
    const e = simulate(threads);
    const ms = performance.now() - t0;
    if (threads === 1) base = ms;
    log(
      `threads ${threads}  ${ms.toFixed(0).padStart(5)} ms  ${(base / ms).toFixed(2)}x  kinetic energy ${e.toFixed(6)}`,
    );
  }
}
