// playground/programs/nbody-parallel.ts (a thousand bodies, 50 steps) on
// shared Wasm GC structs: main posts the one Bodies array to each worker,
// which updates its share of the bodies in place. The barrier is plain
// Atomics on a SharedArrayBuffer (ours is a Mutex and a Condition, which is
// Atomics.wait underneath too). Like par-ours.js, main(8) runs once to warm
// up; the workers are kept between runs.
//
//   node --experimental-wasm-shared experiments/wasm-shared/par-wasm.js [wasm|js|xjs]
//
//   wasm  accelerate() in Wasm, called from JS once a body
//   js    accelerate() in JS, through the accessors on typed refs
//   xjs   accelerate() in JS, through the accessors on shared externrefs

import {isMainThread, parentPort, Worker} from 'node:worker_threads';
import {instantiate} from './body-module.js';

const N = 1000,
  STEPS = 50,
  DT = 0.001,
  SOFTENING = 0.01;
const w = instantiate({shared: true});

function arrive(sync, parties) {
  const generation = Atomics.load(sync, 1);
  if (Atomics.add(sync, 0, 1) === parties - 1) {
    Atomics.store(sync, 0, 0);
    Atomics.add(sync, 1, 1);
    Atomics.notify(sync, 1);
  } else {
    while (Atomics.load(sync, 1) === generation)
      Atomics.wait(sync, 1, generation);
  }
}

function accessors(x) {
  const g = f => w[`${x}get_${f}`],
    s = f => w[`${x}set_${f}`];
  return {
    at: w[`${x}bodies_get`],
    gx: g('x'),
    gy: g('y'),
    gz: g('z'),
    gvx: g('vx'),
    gvy: g('vy'),
    gvz: g('vz'),
    gm: g('mass'),
    sx: s('x'),
    sy: s('y'),
    sz: s('z'),
    svx: s('vx'),
    svy: s('vy'),
    svz: s('vz'),
  };
}

function simulator(mode) {
  const {at, gx, gy, gz, gvx, gvy, gvz, gm, sx, sy, sz, svx, svy, svz} =
    accessors(mode === 'xjs' ? 'x' : '');
  const accelerate =
    mode === 'wasm'
      ? (bodies, i) => w.accelerate(bodies, i, N, DT, SOFTENING)
      : (bodies, i) => {
          const a = at(bodies, i);
          let ax = 0,
            ay = 0,
            az = 0;
          const x = gx(a),
            y = gy(a),
            z = gz(a);
          for (let j = 0; j < N; j++) {
            const b = at(bodies, j);
            const dx = gx(b) - x,
              dy = gy(b) - y,
              dz = gz(b) - z;
            const d2 = dx * dx + dy * dy + dz * dz + SOFTENING;
            const f = gm(b) / (d2 * Math.sqrt(d2));
            ax += dx * f;
            ay += dy * f;
            az += dz * f;
          }
          svx(a, gvx(a) + ax * DT);
          svy(a, gvy(a) + ay * DT);
          svz(a, gvz(a) + az * DT);
        };
  const move = (bodies, i) => {
    const a = at(bodies, i);
    sx(a, gx(a) + gvx(a) * DT);
    sy(a, gy(a) + gvy(a) * DT);
    sz(a, gz(a) + gvz(a) * DT);
  };
  return (bodies, from, to, sync, parties) => {
    for (let step = 0; step < STEPS; step++) {
      for (let i = from; i < to; i++) accelerate(bodies, i);
      arrive(sync, parties);
      for (let i = from; i < to; i++) move(bodies, i);
      arrive(sync, parties);
    }
  };
}

if (!isMainThread) {
  const simulates = {};
  parentPort.on('message', ({mode, bodies, from, to, sync, parties}) => {
    (simulates[mode] ??= simulator(mode))(bodies, from, to, sync, parties);
    parentPort.postMessage('done');
  });
} else {
  const mode = process.argv[2] ?? 'wasm';
  const pool = Array.from(
    {length: 8},
    () => new Worker(new URL(import.meta.url)),
  );
  const {at, gx, gy, gz, gvx, gvy, gvz, gm} = accessors('');

  function energy(bodies) {
    let e = 0;
    for (let i = 0; i < N; i++) {
      const a = at(bodies, i);
      e += 0.5 * gm(a) * (gvx(a) * gvx(a) + gvy(a) * gvy(a) + gvz(a) * gvz(a));
      for (let j = i + 1; j < N; j++) {
        const b = at(bodies, j);
        const dx = gx(a) - gx(b),
          dy = gy(a) - gy(b),
          dz = gz(a) - gz(b);
        e -=
          (gm(a) * gm(b)) / Math.sqrt(dx * dx + dy * dy + dz * dz + SOFTENING);
      }
    }
    return e;
  }

  async function main(workers) {
    let seed = 42;
    const random = () =>
      (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const bodies = w.new_bodies(N);
    for (let i = 0; i < N; i++) {
      // (the order nbody-parallel.ts draws them in)
      const x = random() * 2 - 1,
        y = random() * 2 - 1,
        z = random() * 2 - 1,
        mass = random() / N;
      w.bodies_set(bodies, i, w.new_body(x, y, z, 0, 0, 0, mass));
    }
    const sync = new Int32Array(new SharedArrayBuffer(8));
    const before = energy(bodies);
    const t = performance.now();
    await Promise.all(
      pool.slice(0, workers).map(
        (worker, k) =>
          new Promise(resolve => {
            worker.once('message', resolve);
            worker.postMessage({
              mode,
              bodies,
              sync,
              parties: workers,
              from: Math.floor((k * N) / workers),
              to: Math.floor(((k + 1) * N) / workers),
            });
          }),
      ),
    );
    const ms = performance.now() - t;
    return {
      ms,
      energy: `${before.toFixed(9)} before, ${energy(bodies).toFixed(9)} after`,
    };
  }

  await main(8);
  const times = [];
  let energies;
  for (const n of [1, 2, 4, 8]) {
    const r = await main(n);
    times.push([n, r.ms]);
    energies = r.energy;
  }
  const base = times[0][1];
  console.log(`energy: ${energies}`);
  console.log(
    `wasm-shared (${mode}): ` +
      times
        .map(
          ([n, ms]) => `${n}: ${ms.toFixed(0)} ms (${(base / ms).toFixed(2)}x)`,
        )
        .join('  '),
  );
  process.exit(0);
}
