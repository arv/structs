// Porffor's threads/playground/presets/3-nbody.js, translated by hand by the rules in README.md.
// the original is quoted above each function
import { $closure, $fns, $class, $new, $newThread, $newLock, $newCond, $iter, $eq, $log } from './runtime.mjs';

const FN = $fns({ Barrier_ctor, Barrier_wait, Barrier_wait_hold, thread_body });

// const BODIES = 800, STEPS = 30, DT = 0.001, SOFTEN = 0.01;
// (top-level consts bound to literals: inlined)

// const makeBodies = () => {
//   let seed = 1;
//   const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
//   const bodies = [];
//   for (let i = 0; i < BODIES; i++)
//     bodies.push({ x: random() * 2 - 1, y: random() * 2 - 1, z: random() * 2 - 1, vx: 0, vy: 0, vz: 0, m: 0.5 + random() });
//   return bodies;
// };
export function makeBodies() {
  // seed is captured by random, so it lives in an environment object
  const env = { seed: 1 };
  const bodies = [];
  for (let i = 0; i < 800; i++) {
    $C(bodies, push, { x: random(env) * 2 - 1, y: random(env) * 2 - 1, z: random(env) * 2 - 1, vx: 0, vy: 0, vz: 0, m: 0.5 + random(env) });
    $POLL();
  }
  return bodies;
}
// only ever called directly, so no function value: just its environment
function random(env) {
  return $S(env, seed, ($G(env, seed) * 16807) % 2147483647) / 2147483647;
}

// class Barrier {
//   constructor(n) {
//     this.n = n; this.waiting = 0; this.round = 0;
//     this.lock = new Lock(); this.cond = new Condition();
//   }
//   wait() {
//     this.lock.hold(() => {
//       const round = this.round;
//       if (++this.waiting === this.n) { this.waiting = 0; this.round++; this.cond.notifyAll(); }
//       else while (this.round === round) this.cond.wait(this.lock);
//     });
//   }
// }
function Barrier_ctor(env, thiz, n) {
  $S(thiz, n, n); $S(thiz, waiting, 0); $S(thiz, round, 0);
  $S(thiz, lock, $newLock()); $S(thiz, cond, $newCond());
}
function Barrier_wait(env, thiz) {
  // the arrow captures this
  const env1 = { thiz };
  const lock = $G(thiz, lock);
  $C(lock, hold, $closure(FN.Barrier_wait_hold, env1));
}
function Barrier_wait_hold(env) {
  const thiz = $G(env, thiz);
  const round = $G(thiz, round);
  const waiting = $S(thiz, waiting, $G(thiz, waiting) + 1);
  if ($eq(waiting, $G(thiz, n))) {
    $S(thiz, waiting, 0);
    $S(thiz, round, $G(thiz, round) + 1);
    const cond = $G(thiz, cond);
    $C(cond, notifyAll);
  } else {
    while ($eq($G(thiz, round), round)) {
      const cond = $G(thiz, cond), lock = $G(thiz, lock);
      $C(cond, wait, lock);
      $POLL();
    }
  }
}
const Barrier = $class(FN.Barrier_ctor, { wait: FN.Barrier_wait });

// const accelerate = (bodies, lo0, hi0) => {
//   const lo = +lo0, hi = +hi0, n = +bodies.length;
//   for (let i = lo; i < hi; i++) {
//     const b = bodies[i];
//     const x = +b.x, y = +b.y, z = +b.z;
//     let ax = 0, ay = 0, az = 0;
//     for (let j = 0; j < n; j++) {
//       const o = bodies[j];
//       const dx = +o.x - x, dy = +o.y - y, dz = +o.z - z;
//       const d2 = dx * dx + dy * dy + dz * dz + SOFTEN;
//       const f = +o.m / (d2 * Math.sqrt(d2));
//       ax += dx * f; ay += dy * f; az += dz * f;
//     }
//     b.vx += ax * DT; b.vy += ay * DT; b.vz += az * DT;
//   }
// };
export function accelerate(bodies, lo0, hi0) {
  const lo = +lo0, hi = +hi0, n = +$G(bodies, length);
  for (let i = lo; i < hi; i++) {
    const b = $GI(bodies, i);
    const x = +$G(b, x), y = +$G(b, y), z = +$G(b, z);
    let ax = 0, ay = 0, az = 0;
    for (let j = 0; j < n; j++) {
      const o = $GI(bodies, j);
      const dx = +$G(o, x) - x, dy = +$G(o, y) - y, dz = +$G(o, z) - z;
      const d2 = dx * dx + dy * dy + dz * dz + 0.01;
      const f = +$G(o, m) / (d2 * Math.sqrt(d2));
      ax += dx * f; ay += dy * f; az += dz * f;
      $POLL();
    }
    $S(b, vx, $G(b, vx) + ax * 0.001); $S(b, vy, $G(b, vy) + ay * 0.001); $S(b, vz, $G(b, vz) + az * 0.001);
    $POLL();
  }
}

// const move = (bodies, lo0, hi0) => {
//   const lo = +lo0, hi = +hi0;
//   for (let i = lo; i < hi; i++) {
//     const b = bodies[i];
//     b.x += b.vx * DT; b.y += b.vy * DT; b.z += b.vz * DT;
//   }
// };
export function move(bodies, lo0, hi0) {
  const lo = +lo0, hi = +hi0;
  for (let i = lo; i < hi; i++) {
    const b = $GI(bodies, i);
    $S(b, x, $G(b, x) + $G(b, vx) * 0.001); $S(b, y, $G(b, y) + $G(b, vy) * 0.001); $S(b, z, $G(b, z) + $G(b, vz) * 0.001);
    $POLL();
  }
}

// const energy = bodies => {
//   let e = 0;
//   for (const b of bodies) e += 0.5 * b.m * (b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
//   return e;
// };
export function energy(bodies) {
  let e = 0;
  for (const b of $iter(bodies)) {
    e += 0.5 * $G(b, m) * ($G(b, vx) * $G(b, vx) + $G(b, vy) * $G(b, vy) + $G(b, vz) * $G(b, vz));
    $POLL();
  }
  return e;
}

// const simulate = threads => {
//   const bodies = makeBodies();
//   const barrier = new Barrier(threads);
//   const ts = [];
//   for (let t = 0; t < threads; t++) {
//     const lo = Math.floor(BODIES * t / threads), hi = Math.floor(BODIES * (t + 1) / threads);
//     ts.push(new Thread(() => {
//       for (let s = 0; s < STEPS; s++) {
//         accelerate(bodies, lo, hi);
//         barrier.wait(); // everyone has read the old positions
//         move(bodies, lo, hi);
//         barrier.wait(); // everyone has written the new ones
//       }
//     }));
//   }
//   for (const t of ts) t.join();
//   return energy(bodies);
// };
function simulate(threads) {
  // bodies and barrier are captured by the thread functions
  const env = { bodies: makeBodies(), barrier: $new(Barrier, threads) };
  const ts = [];
  for (let t = 0; t < threads; t++) {
    // lo and hi are per iteration: a block environment whose parent is env
    const env1 = { $p: env, lo: Math.floor(800 * t / threads), hi: Math.floor(800 * (t + 1) / threads) };
    $C(ts, push, $newThread($closure(FN.thread_body, env1)));
    $POLL();
  }
  for (const t of $iter(ts)) {
    $C(t, join);
    $POLL();
  }
  const bodies = $G(env, bodies);
  return energy(bodies);
}
function thread_body(env) {
  // const bindings it captured: read once per call
  const lo = $G(env, lo), hi = $G(env, hi), p = $G(env, $p);
  const bodies = $G(p, bodies), barrier = $G(p, barrier);
  for (let s = 0; s < 30; s++) {
    accelerate(bodies, lo, hi);
    $C(barrier, wait);
    move(bodies, lo, hi);
    $C(barrier, wait);
    $POLL();
  }
}

// let base = 0;
// for (const threads of [ 1, 2, 4, 8 ]) {
//   const t0 = performance.now();
//   const e = simulate(threads);
//   const ms = performance.now() - t0;
//   if (threads === 1) base = ms;
//   console.log(`threads ${threads}  ${ms.toFixed(0).padStart(5)} ms  ${(base / ms).toFixed(2)}x  kinetic energy ${e.toFixed(6)}`);
// }
// (the thread counts come from the runner, so a benchmark can repeat them)
export function main(threadCounts) {
  let base = 0;
  for (const threads of $iter(threadCounts)) {
    const t0 = performance.now();
    const e = simulate(threads);
    const ms = performance.now() - t0;
    if (threads === 1) base = ms;
    $log(`threads ${threads}  ${ms.toFixed(0).padStart(5)} ms  ${(base / ms).toFixed(2)}x  kinetic energy ${$C(e, toFixed, 6)}`);
    $POLL();
  }
}
