// examples/nbody/nbody.ts (1M steps of five bodies) on the structs of
// body-module.js, and on plain objects for scale. The JS of advance() is the
// same in each: what a compiler lowering shared structs to Wasm GC would
// emit, a call to an exported accessor for each field access.
//
//   plain         plain JS objects, an Array
//   typed         JS, through the accessors on typed refs (get_x, ...)
//   x             JS, through the accessors on externrefs (xget_x, ...)
//   wasm          advance() and energy() themselves in Wasm
// each of the last three with -shared (shared struct types) or without.
//
//   node --experimental-wasm-shared experiments/wasm-shared/nbody.js typed-shared [steps]

import {FIELDS, instantiate} from './body-module.js';

const which = process.argv[2] ?? 'typed-shared';
const steps = Number(process.argv[3] ?? 1_000_000);
const SOLAR_MASS = 4 * Math.PI * Math.PI;
const DAYS = 365.24;
const N = 5;
const INIT = [
  [0, 0, 0, 0, 0, 0, 1],
  [
    4.8414314424647209, -1.16032004402742839, -1.03622044471123109e-1,
    1.66007664274403694e-3, 7.69901118419740425e-3, -6.90460016972063023e-5,
    9.54791938424326609e-4,
  ],
  [
    8.34336671824457987, 4.12479856412430479, -4.03523417114321381e-1,
    -2.76742510726862411e-3, 4.99852801234917238e-3, 2.30417297573763929e-5,
    2.85885980666130812e-4,
  ],
  [
    1.2894369562139131e1, -1.51111514016986312e1, -2.23307578892655734e-1,
    2.96460137564761618e-3, 2.3784717395948095e-3, -2.96589568540237556e-5,
    4.36624404335156298e-5,
  ],
  [
    1.53796971148509165e1, -2.59193146099879641e1, 1.79258772950371181e-1,
    2.68067772490389322e-3, 1.62824170038242295e-3, -9.5159225451971587e-5,
    5.15138902046611451e-5,
  ],
].map(([x, y, z, vx, vy, vz, m]) => [
  x,
  y,
  z,
  vx * DAYS,
  vy * DAYS,
  vz * DAYS,
  m * SOLAR_MASS,
]);

// The bodies, and accessors on them: at(bodies, i), and get.f(b) / set.f(b, v)
function structs() {
  if (which === 'plain') {
    const bodies = INIT.map(([x, y, z, vx, vy, vz, mass]) => ({
      x,
      y,
      z,
      vx,
      vy,
      vz,
      mass,
    }));
    const get = Object.fromEntries(
      FIELDS.map(f => [f, new Function('b', `return b.${f}`)]),
    );
    const set = Object.fromEntries(
      FIELDS.map(f => [f, new Function('b', 'v', `b.${f} = v`)]),
    );
    return {bodies, at: (a, i) => a[i], get, set};
  }
  const w = instantiate({shared: which.endsWith('-shared')});
  const bodies = w.new_bodies(N);
  INIT.forEach((v, i) => w.bodies_set(bodies, i, w.new_body(...v)));
  const x = which.startsWith('x') ? 'x' : '';
  const get = Object.fromEntries(FIELDS.map(f => [f, w[`${x}get_${f}`]]));
  const set = Object.fromEntries(FIELDS.map(f => [f, w[`${x}set_${f}`]]));
  return {bodies, at: w[`${x}bodies_get`], get, set, w};
}

const {bodies, at, get, set, w} = structs();
const {x: gx, y: gy, z: gz, vx: gvx, vy: gvy, vz: gvz, mass: gm} = get;
const {x: sx, y: sy, z: sz, vx: svx, vy: svy, vz: svz} = set;

function offset() {
  let px = 0,
    py = 0,
    pz = 0;
  for (let i = 0; i < N; i++) {
    const b = at(bodies, i);
    px += gvx(b) * gm(b);
    py += gvy(b) * gm(b);
    pz += gvz(b) * gm(b);
  }
  const sun = at(bodies, 0);
  svx(sun, -px / SOLAR_MASS);
  svy(sun, -py / SOLAR_MASS);
  svz(sun, -pz / SOLAR_MASS);
}

function advance(dt) {
  for (let i = 0; i < N; i++) {
    const a = at(bodies, i);
    for (let j = i + 1; j < N; j++) {
      const b = at(bodies, j);
      const dx = gx(a) - gx(b),
        dy = gy(a) - gy(b),
        dz = gz(a) - gz(b);
      const d2 = dx * dx + dy * dy + dz * dz;
      const mag = dt / (d2 * Math.sqrt(d2));
      const am = gm(a) * mag,
        bm = gm(b) * mag;
      svx(a, gvx(a) - dx * bm);
      svy(a, gvy(a) - dy * bm);
      svz(a, gvz(a) - dz * bm);
      svx(b, gvx(b) + dx * am);
      svy(b, gvy(b) + dy * am);
      svz(b, gvz(b) + dz * am);
    }
  }
  for (let i = 0; i < N; i++) {
    const b = at(bodies, i);
    sx(b, gx(b) + dt * gvx(b));
    sy(b, gy(b) + dt * gvy(b));
    sz(b, gz(b) + dt * gvz(b));
  }
}

function energy() {
  let e = 0;
  for (let i = 0; i < N; i++) {
    const a = at(bodies, i);
    e += 0.5 * gm(a) * (gvx(a) * gvx(a) + gvy(a) * gvy(a) + gvz(a) * gvz(a));
    for (let j = i + 1; j < N; j++) {
      const b = at(bodies, j);
      const dx = gx(a) - gx(b),
        dy = gy(a) - gy(b),
        dz = gz(a) - gz(b);
      e -= (gm(a) * gm(b)) / Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
  }
  return e;
}

offset();
const inWasm = which.startsWith('wasm');
console.log((inWasm ? w.energy(bodies, N) : energy()).toFixed(9));
const start = performance.now();
if (inWasm) for (let i = 0; i < steps; i++) w.advance(bodies, 0.01, N);
else for (let i = 0; i < steps; i++) advance(0.01);
const ms = performance.now() - start;
console.log((inWasm ? w.energy(bodies, N) : energy()).toFixed(9));
console.log(`${which}: ${steps} steps in ${ms.toFixed(0)} ms`);
