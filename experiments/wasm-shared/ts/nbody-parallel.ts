// A copy of playground/programs/nbody-parallel.ts, importing the agent API by
// its package name so that it compiles to experiments/wasm-shared/fast/.
// par-ours.js runs it.
//
// N-body with a thousand bodies, split among as many workers as main is
// given. Each step has two phases, with a barrier after each: every worker
// updates its bodies' velocities from everyone's positions, then moves its
// bodies. The barrier is a Mutex and a Condition in a shared struct. Run it on
// 1, 2, 4 and 8: the energy comes out the same, faster. (Warm up, which is on,
// runs it once first, so that each worker has optimized its hot code.)

import {run} from '@arv/structs/agent';

const N = 1000, STEPS = 50, DT = 0.001, SOFTENING = 0.01;

shared struct Body {
  x: number = 0;
  y: number = 0;
  z: number = 0;
  vx: number = 0;
  vy: number = 0;
  vz: number = 0;
  mass: number = 0;
}

// a barrier for `parties` workers: each waits until all have arrived
shared struct Barrier {
  parties = 0;
  arrived = 0;
  // bumped as the last one arrives, which lets the others go
  generation = 0;
  lock = new Atomics.Mutex();
  all = new Atomics.Condition();
}

function arrive(b: Barrier) {
  using token = Atomics.Mutex.lock(b.lock);
  const generation = b.generation;
  if (++b.arrived === b.parties) {
    b.arrived = 0;
    b.generation = generation + 1;
    Atomics.Condition.notify(b.all);
  } else {
    Atomics.Condition.waitFor(b.all, token, Infinity, () => b.generation !== generation);
  }
}

// one body's velocity, from everyone's positions. The hot loop is a function
// of its own, called for each body: V8 optimizes a function that is called
// often, where a loop in a function called once is optimized only while it
// runs, and thrown away each time it ends
function accelerate(bodies: SharedArray<Body>, i: number) {
  const a = bodies[i]!;
  let ax = 0, ay = 0, az = 0;
  for (let j = 0; j < N; j++) {
    const b = bodies[j]!;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const d2 = dx * dx + dy * dy + dz * dz + SOFTENING;
    const f = b.mass / (d2 * Math.sqrt(d2));
    ax += dx * f;
    ay += dy * f;
    az += dz * f;
  }
  a.vx = a.vx + ax * DT;
  a.vy = a.vy + ay * DT;
  a.vz = a.vz + az * DT;
}

function move(bodies: SharedArray<Body>, i: number) {
  const a = bodies[i]!;
  a.x = a.x + a.vx * DT;
  a.y = a.y + a.vy * DT;
  a.z = a.z + a.vz * DT;
}

// on a worker: bodies [from, to), every step
export function simulate(bodies: SharedArray<Body>, from: number, to: number, barrier: Barrier) {
  for (let step = 0; step < STEPS; step++) {
    for (let i = from; i < to; i++) accelerate(bodies, i);
    arrive(barrier);
    for (let i = from; i < to; i++) move(bodies, i);
    arrive(barrier);
  }
}

function energy(bodies: SharedArray<Body>) {
  let e = 0;
  for (let i = 0; i < N; i++) {
    const a = bodies[i]!;
    e += 0.5 * a.mass * (a.vx * a.vx + a.vy * a.vy + a.vz * a.vz);
    for (let j = i + 1; j < N; j++) {
      const b = bodies[j]!;
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      e -= (a.mass * b.mass) / Math.sqrt(dx * dx + dy * dy + dz * dz + SOFTENING);
    }
  }
  return e;
}

export async function main(workers: number) {
  // the same bodies every run: a linear congruential generator
  let seed = 42;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const bodies = new SharedArray<Body>(N);
  for (let i = 0; i < N; i++) {
    const b = new Body();
    b.x = random() * 2 - 1;
    b.y = random() * 2 - 1;
    b.z = random() * 2 - 1;
    b.mass = random() / N;
    bodies[i] = b;
  }
  const barrier = new Barrier();
  barrier.parties = workers;
  const before = energy(bodies);
  await Promise.all(
    Array.from({length: workers}, (_, w) =>
      run(
        import.meta.url,
        'simulate',
        bodies,
        Math.floor((w * N) / workers),
        Math.floor(((w + 1) * N) / workers),
        barrier,
      ),
    ),
  );
  console.log(`${N} bodies, ${STEPS} steps, ${workers} worker(s)`);
  console.log(`energy: ${before.toFixed(9)} before, ${energy(bodies).toFixed(9)} after`);
}
