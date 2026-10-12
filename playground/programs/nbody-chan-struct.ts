// Porffor's threads/playground/presets/3-nbody.js with goroutines and channels over shared memory: the bodies
// are a SharedArray of shared structs, as in nbody-struct.ts, which every goroutine reads and writes
// in place, each only its own slice. Channels take the barriers' place: after each phase a goroutine
// reports on `done` and waits for main on its `next`, which is Go's way (share memory, and order it
// with channels). Nothing is copied.
import { Channel, f64, go, log, SharedArray, struct, type Struct } from "threads";

const Body = struct({ x: f64, y: f64, z: f64, vx: f64, vy: f64, vz: f64, m: f64 });
type Body = Struct<typeof Body>;

const BODIES = 800, STEPS = 30, DT = 0.001, SOFTEN = 0.01;

function makeBodies(): SharedArray<Body> {
  let seed = 1;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const bodies = new SharedArray(Body, BODIES);
  for (let i = 0; i < BODIES; i++) {
    const b = bodies[i];
    b.x = random() * 2 - 1; b.y = random() * 2 - 1; b.z = random() * 2 - 1;
    b.vx = 0; b.vy = 0; b.vz = 0;
    b.m = 0.5 + random();
  }
  return bodies;
}

// new velocities for bodies [lo, hi), from everyone's positions
function accelerate(bodies: SharedArray<Body>, lo: number, hi: number) {
  const n = bodies.length;
  for (let i = lo; i < hi; i++) {
    const b = bodies[i];
    const x = b.x, y = b.y, z = b.z;
    let ax = 0, ay = 0, az = 0;
    for (let j = 0; j < n; j++) {
      const o = bodies[j];
      const dx = o.x - x, dy = o.y - y, dz = o.z - z;
      const d2 = dx * dx + dy * dy + dz * dz + SOFTEN;
      const f = o.m / (d2 * Math.sqrt(d2));
      ax += dx * f; ay += dy * f; az += dz * f;
    }
    b.vx += ax * DT; b.vy += ay * DT; b.vz += az * DT;
  }
}

function move(bodies: SharedArray<Body>, lo: number, hi: number) {
  for (let i = lo; i < hi; i++) {
    const b = bodies[i];
    b.x += b.vx * DT; b.y += b.vy * DT; b.z += b.vz * DT;
  }
}

function energy(bodies: SharedArray<Body>): number {
  let e = 0;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    e += 0.5 * b.m * (b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
  }
  return e;
}

// a goroutine: its slice [lo, hi) of the shared bodies. after each phase it reports on `done` and
// waits on `next` until every goroutine has reported
function worker(lo: number, hi: number, bodies: SharedArray<Body>, done: Channel<number>, next: Channel<number>) {
  for (let s = 0; s < STEPS; s++) {
    accelerate(bodies, lo, hi);
    done.send(lo);
    next.recv(); // everyone has read the old positions
    move(bodies, lo, hi);
    done.send(lo);
    next.recv(); // everyone has written the new ones
  }
}

function simulate(threads: number): number {
  const bodies = makeBodies(), done = new Channel<number>(threads);
  const nexts: Channel<number>[] = [];
  for (let t = 0; t < threads; t++) {
    const next = new Channel<number>(1);
    nexts.push(next);
    go(worker, Math.floor(BODIES * t / threads), Math.floor(BODIES * (t + 1) / threads), bodies, done, next);
  }
  for (let phase = 0; phase < 2 * STEPS; phase++) {
    for (let k = 0; k < threads; k++) done.recv();
    for (const next of nexts) next.send(phase);
  }
  return energy(bodies);
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
