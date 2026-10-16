// N-body on shared structs. TypeScript knows every body is a Body, so the
// compiler reads its fields in shared memory directly: switch to "Proxy only"
// and run it again to see what the Proxy costs.

shared struct Body {
  x: number = 0;
  y: number = 0;
  z: number = 0;
  vx: number = 0;
  vy: number = 0;
  vz: number = 0;
  mass: number = 0;
  constructor(x: number, y: number, z: number, vx: number, vy: number, vz: number, mass: number) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.vx = vx * DAYS;
    this.vy = vy * DAYS;
    this.vz = vz * DAYS;
    this.mass = mass * SOLAR_MASS;
  }
}

const SOLAR_MASS = 4 * Math.PI * Math.PI;
const DAYS = 365.24;

function system(): SharedArray<Body> {
  const bodies = new SharedArray<Body>(
    new Body(0, 0, 0, 0, 0, 0, 1),
    new Body(4.84143144246472090e+00, -1.16032004402742839e+00, -1.03622044471123109e-01, 1.66007664274403694e-03, 7.69901118419740425e-03, -6.90460016972063023e-05, 9.54791938424326609e-04),
    new Body(8.34336671824457987e+00, 4.12479856412430479e+00, -4.03523417114321381e-01, -2.76742510726862411e-03, 4.99852801234917238e-03, 2.30417297573763929e-05, 2.85885980666130812e-04),
    new Body(1.28943695621391310e+01, -1.51111514016986312e+01, -2.23307578892655734e-01, 2.96460137564761618e-03, 2.37847173959480950e-03, -2.96589568540237556e-05, 4.36624404335156298e-05),
    new Body(1.53796971148509165e+01, -2.59193146099879641e+01, 1.79258772950371181e-01, 2.68067772490389322e-03, 1.62824170038242295e-03, -9.51592254519715870e-05, 5.15138902046611451e-05),
  );
  let px = 0, py = 0, pz = 0;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]!;
    px += b.vx * b.mass;
    py += b.vy * b.mass;
    pz += b.vz * b.mass;
  }
  const sun = bodies[0]!;
  sun.vx = -px / SOLAR_MASS;
  sun.vy = -py / SOLAR_MASS;
  sun.vz = -pz / SOLAR_MASS;
  return bodies;
}

function advance(bodies: SharedArray<Body>, dt: number) {
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i]!;
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j]!;
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const mag = dt / (d2 * Math.sqrt(d2));
      const am = a.mass * mag, bm = b.mass * mag;
      a.vx = a.vx - dx * bm;
      a.vy = a.vy - dy * bm;
      a.vz = a.vz - dz * bm;
      b.vx = b.vx + dx * am;
      b.vy = b.vy + dy * am;
      b.vz = b.vz + dz * am;
    }
  }
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]!;
    b.x = b.x + dt * b.vx;
    b.y = b.y + dt * b.vy;
    b.z = b.z + dt * b.vz;
  }
}

function energy(bodies: SharedArray<Body>) {
  let e = 0;
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i]!;
    e += 0.5 * a.mass * (a.vx * a.vx + a.vy * a.vy + a.vz * a.vz);
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j]!;
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      e -= (a.mass * b.mass) / Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
  }
  return e;
}

export function main() {
  const steps = 100_000;
  const bodies = system();
  console.log('energy before:', energy(bodies).toFixed(9));
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) advance(bodies, 0.01);
  console.log('energy after: ', energy(bodies).toFixed(9));
  console.log(`${steps} steps in ${(performance.now() - t0).toFixed(0)} ms`);
}
