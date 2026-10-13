// The N-body preset (src/presets/nbody.js) with its bodies in a SharedArray of
// shared structs: the preset's own code, nearly, with typed layouts. The tsgo
// fork lays `Body` out as 7 numbers in the shared heap and compiles
// `bodies[i].x` to a typed-array read, so threads share the bodies with no
// copying: each thread writes only its own slice, and the barriers order the
// reads and the writes.
import {
  Condition,
  f64,
  i32,
  Lock,
  log,
  ref,
  scope,
  SharedArray,
  struct,
  type Struct,
} from '@arv/threads';

const Body = struct({
  x: f64,
  y: f64,
  z: f64,
  vx: f64,
  vy: f64,
  vz: f64,
  m: f64,
});
type Body = Struct<typeof Body>;

const BODIES = 800,
  STEPS = 30,
  DT = 0.001,
  SOFTEN = 0.01;

function makeBodies(): SharedArray<Body> {
  let seed = 1;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const bodies = new SharedArray(Body, BODIES);
  for (let i = 0; i < BODIES; i++) {
    const b = bodies[i];
    b.x = random() * 2 - 1;
    b.y = random() * 2 - 1;
    b.z = random() * 2 - 1;
    b.vx = 0;
    b.vy = 0;
    b.vz = 0;
    b.m = 0.5 + random();
  }
  return bodies;
}

// new velocities for bodies [lo, hi), from everyone's positions
function accelerate(bodies: SharedArray<Body>, lo: number, hi: number) {
  const n = bodies.length;
  for (let i = lo; i < hi; i++) {
    const b = bodies[i];
    const x = b.x,
      y = b.y,
      z = b.z;
    let ax = 0,
      ay = 0,
      az = 0;
    for (let j = 0; j < n; j++) {
      const o = bodies[j];
      const dx = o.x - x,
        dy = o.y - y,
        dz = o.z - z;
      const d2 = dx * dx + dy * dy + dz * dz + SOFTEN;
      const f = o.m / (d2 * Math.sqrt(d2));
      ax += dx * f;
      ay += dy * f;
      az += dz * f;
    }
    b.vx += ax * DT;
    b.vy += ay * DT;
    b.vz += az * DT;
  }
}

function move(bodies: SharedArray<Body>, lo: number, hi: number) {
  for (let i = lo; i < hi; i++) {
    const b = bodies[i];
    b.x += b.vx * DT;
    b.y += b.vy * DT;
    b.z += b.vz * DT;
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

// a barrier for n threads, from a Lock and a Condition, as the preset builds
// its own: wait(b) returns once all n have called it
const Barrier = struct({
  n: i32,
  waiting: i32,
  round: i32,
  lock: ref<Lock>(),
  changed: ref<Condition>(),
});
type Barrier = Struct<typeof Barrier>;

function newBarrier(n: number): Barrier {
  const b = new Barrier();
  b.n = n | 0;
  b.lock = new Lock();
  b.changed = new Condition();
  return b;
}

function wait(b: Barrier) {
  const lock = b.lock!,
    changed = b.changed!;
  using _ = lock.hold();
  const round = b.round;
  if (++b.waiting === b.n) {
    b.waiting = 0;
    b.round = round + 1;
    changed.notifyAll();
  } else while (b.round === round) changed.wait(lock);
}

// a thread: its slice [lo, hi) of the shared bodies, and the barrier
function worker(
  lo: number,
  hi: number,
  bodies: SharedArray<Body>,
  barrier: Barrier,
) {
  for (let s = 0; s < STEPS; s++) {
    accelerate(bodies, lo, hi);
    wait(barrier); // everyone has read the old positions
    move(bodies, lo, hi);
    wait(barrier); // everyone has written the new ones
  }
}

function simulate(threads: number): number {
  const bodies = makeBodies(),
    barrier = newBarrier(threads);
  scope(s => {
    for (let t = 0; t < threads; t++)
      s.spawn(
        worker,
        Math.floor((BODIES * t) / threads),
        Math.floor((BODIES * (t + 1)) / threads),
        bodies,
        barrier,
      );
  });
  return energy(bodies);
}

// the thread counts come from the runner (the playground), so a benchmark can
// repeat them
export function main(threadCounts: readonly number[]) {
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
