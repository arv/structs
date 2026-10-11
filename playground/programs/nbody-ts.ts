// Porffor's threads/playground/presets/3-nbody.js in plain TypeScript on threads.mjs. The tsgo fork checks it
// (no ownership errors) and emits plain JavaScript for the runtime:
// Each thread owns its slice of the bodies; every step it shares a snapshot of its positions, and the
// others read their own copies. The hot loops are plain TypeScript on plain objects.
import { Barrier, log, partition, scope, type Sending, share, type Shared, Slots, take, type Thread } from "threads";

type Body = { x: number; y: number; z: number; vx: number; vy: number; vz: number; m: number };
type Pos = { x: number; y: number; z: number; m: number };

const BODIES = 800, STEPS = 30, DT = 0.001, SOFTEN = 0.01;

function makeBodies(): Sending<Body[]> {
  let seed = 1;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const bodies: Body[] = [];
  for (let i = 0; i < BODIES; i++)
    bodies.push({ x: random() * 2 - 1, y: random() * 2 - 1, z: random() * 2 - 1, vx: 0, vy: 0, vz: 0, m: 0.5 + random() });
  return bodies;
}

// new velocities for this thread's bodies, from everyone's positions (all: every snapshot, in body order)
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

// a thread: its own slice, the board of snapshots, and the barrier
function worker(t: number, mine: Sending<Body[]>, board: Slots<Pos[]>, barrier: Barrier): Sending<Body[]> {
  for (let s = 0; s < STEPS; s++) {
    board.set(t, share(mine.map(b => ({ x: b.x, y: b.y, z: b.z, m: b.m }))));
    barrier.wait(); // everyone has shared their positions
    accelerate(mine, board.flat());
    barrier.wait(); // everyone has read them, so the board can change
    move(mine);
  }
  return mine;
}

function simulate(threads: number): number {
  const board = new Slots<Pos[]>(threads), barrier = new Barrier(threads);
  return scope(s => {
    const parts = partition(makeBodies(), threads);
    const ts: Thread<Body[]>[] = [];
    for (let t = 0; t < threads; t++) ts.push(s.spawn(worker, t, take(parts, t), board, barrier));
    return energy(ts.flatMap(th => th.join()));
  });
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
