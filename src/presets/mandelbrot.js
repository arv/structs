// the original program, as Porffor's threads playground has it
// (github.com/arv/porffor, branch arv/shared-everything-threads,
// threads/playground/presets/2-mandelbrot.js). Thread, Lock and Condition are
// Porffor's. ../mandelbrot.js translates it by hand, and bench.ts and
// overhead.ts measure against it

// Mandelbrot: threads take rows from a shared counter and write them into one
// ordinary JS array, so nothing is copied or posted between them.
const W = 80,
  H = 32,
  SAMPLES = 18,
  MAX_ITER = 2000;

// iterations until (cr, ci) escapes. the + makes each parameter a number, so
// Porffor compiles the loop to plain floating point math
const escape = (cr0, ci0) => {
  const cr = +cr0,
    ci = +ci0;
  let zr = 0,
    zi = 0,
    i = 0;
  while (i < MAX_ITER) {
    const zr2 = zr * zr,
      zi2 = zi * zi;
    if (zr2 + zi2 >= 4) break;
    zi = 2 * zr * zi + ci;
    zr = zr2 - zi2 + cr;
    i++;
  }
  return i;
};

// one row of the picture, averaging SAMPLES x SAMPLES points per character
const row = y0 => {
  const y = +y0,
    out = [];
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let sy = 0; sy < SAMPLES; sy++)
      for (let sx = 0; sx < SAMPLES; sx++)
        sum += escape(
          ((x + sx / SAMPLES) / W) * 3 - 2.1,
          ((y + sy / SAMPLES) / H) * 2.4 - 1.2,
        );
    out.push(sum / (SAMPLES * SAMPLES));
  }
  return out;
};

const render = threads => {
  const rows = new Array(H);
  const next = new Int32Array(new SharedArrayBuffer(4)); // the next row to draw
  const worker = () => {
    for (let y = Atomics.add(next, 0, 1); y < H; y = Atomics.add(next, 0, 1))
      rows[y] = row(y);
  };
  const ts = [];
  for (let i = 0; i < threads; i++) ts.push(new Thread(worker));
  for (const t of ts) t.join();
  return rows;
};

let base = 0,
  rows;
for (const threads of [1, 2, 4, 8]) {
  const t0 = performance.now();
  rows = render(threads);
  const ms = performance.now() - t0;
  if (threads === 1) base = ms;
  console.log(
    `threads ${threads}  ${ms.toFixed(0).padStart(5)} ms  ${(base / ms).toFixed(2)}x`,
  );
}

// draw it with 256-color terminal escapes: a background color per character
const palette = [
  17, 18, 19, 54, 55, 56, 92, 93, 129, 165, 171, 207, 213, 209, 215, 221, 227,
  229, 231,
];
let art = '';
for (const r of rows) {
  let last = -1;
  for (const v of r) {
    const c =
      v >= MAX_ITER - 0.5
        ? 16
        : palette[
            Math.floor(
              (Math.log(1 + v) / Math.log(MAX_ITER)) * (palette.length - 1),
            )
          ];
    if (c !== last) {
      art += `\x1b[48;5;${c}m`;
      last = c;
    }
    art += ' ';
  }
  art += '\x1b[0m\n';
}
console.log(art);
