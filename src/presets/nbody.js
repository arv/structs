// the original program, as Porffor's threads playground has it
// (github.com/arv/porffor, branch arv/shared-everything-threads,
// threads/playground/presets/3-nbody.js). Thread, Lock and Condition are
// Porffor's. ../nbody.js translates it by hand, and bench.ts and overhead.ts
// measure against it

// N-body gravity: every body is a plain JS object in one shared array. Each
// thread moves its own slice of the bodies but reads every body's position, and
// the threads meet at a barrier (built from a Lock and a Condition) twice a
// step.
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

// a reusable barrier: the last thread to arrive wakes the others
class Barrier {
  constructor(n) {
    this.n = n;
    this.waiting = 0;
    this.round = 0;
    this.lock = new Lock();
    this.cond = new Condition();
  }
  wait() {
    this.lock.hold(() => {
      const round = this.round;
      if (++this.waiting === this.n) {
        this.waiting = 0;
        this.round++;
        this.cond.notifyAll();
      } else while (this.round === round) this.cond.wait(this.lock);
    });
  }
}

// new velocities for bodies [lo, hi), from everyone's positions. the + tells
// Porffor's type inference that a value is a number
const accelerate = (bodies, lo0, hi0) => {
  const lo = +lo0,
    hi = +hi0,
    n = +bodies.length;
  for (let i = lo; i < hi; i++) {
    const b = bodies[i];
    const x = +b.x,
      y = +b.y,
      z = +b.z;
    let ax = 0,
      ay = 0,
      az = 0;
    for (let j = 0; j < n; j++) {
      const o = bodies[j];
      const dx = +o.x - x,
        dy = +o.y - y,
        dz = +o.z - z;
      const d2 = dx * dx + dy * dy + dz * dz + SOFTEN;
      const f = +o.m / (d2 * Math.sqrt(d2));
      ax += dx * f;
      ay += dy * f;
      az += dz * f;
    }
    b.vx += ax * DT;
    b.vy += ay * DT;
    b.vz += az * DT;
  }
};

const move = (bodies, lo0, hi0) => {
  const lo = +lo0,
    hi = +hi0;
  for (let i = lo; i < hi; i++) {
    const b = bodies[i];
    b.x += b.vx * DT;
    b.y += b.vy * DT;
    b.z += b.vz * DT;
  }
};

const energy = bodies => {
  let e = 0;
  for (const b of bodies)
    e += 0.5 * b.m * (b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
  return e;
};

const simulate = threads => {
  const bodies = makeBodies();
  const barrier = new Barrier(threads);
  const ts = [];
  for (let t = 0; t < threads; t++) {
    const lo = Math.floor((BODIES * t) / threads),
      hi = Math.floor((BODIES * (t + 1)) / threads);
    ts.push(
      new Thread(() => {
        for (let s = 0; s < STEPS; s++) {
          accelerate(bodies, lo, hi);
          barrier.wait(); // everyone has read the old positions
          move(bodies, lo, hi);
          barrier.wait(); // everyone has written the new ones
        }
      }),
    );
  }
  for (const t of ts) t.join();
  return energy(bodies);
};

let base = 0;
for (const threads of [1, 2, 4, 8]) {
  const t0 = performance.now();
  const e = simulate(threads);
  const ms = performance.now() - t0;
  if (threads === 1) base = ms;
  // the same answer every time: each body only ever depends on the previous
  // step
  console.log(
    `threads ${threads}  ${ms.toFixed(0).padStart(5)} ms  ${(base / ms).toFixed(2)}x  kinetic energy ${e.toFixed(6)}`,
  );
}
