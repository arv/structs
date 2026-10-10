// threads/playground/presets/2-mandelbrot.js, translated by hand by the rules in README.md.
// the original is quoted above each function
import { $closure, $fns, $newThread, $newSAB, $newTA, $iter, $eq, $log } from './runtime.mjs';

const FN = $fns({ worker });

// const W = 80, H = 32, SAMPLES = 18, MAX_ITER = 2000;
// (top-level consts bound to literals: inlined)

// const escape = (cr0, ci0) => {
//   const cr = +cr0, ci = +ci0;
//   let zr = 0, zi = 0, i = 0;
//   while (i < MAX_ITER) {
//     const zr2 = zr * zr, zi2 = zi * zi;
//     if (zr2 + zi2 >= 4) break;
//     zi = 2 * zr * zi + ci;
//     zr = zr2 - zi2 + cr;
//     i++;
//   }
//   return i;
// };
function escape(cr0, ci0) {
  const cr = +cr0, ci = +ci0;
  let zr = 0, zi = 0, i = 0;
  while (i < 2000) {
    const zr2 = zr * zr, zi2 = zi * zi;
    if (zr2 + zi2 >= 4) break;
    zi = 2 * zr * zi + ci;
    zr = zr2 - zi2 + cr;
    i++;
    $POLL();
  }
  return i;
}

// const row = y0 => {
//   const y = +y0, out = [];
//   for (let x = 0; x < W; x++) {
//     let sum = 0;
//     for (let sy = 0; sy < SAMPLES; sy++) for (let sx = 0; sx < SAMPLES; sx++)
//       sum += escape((x + sx / SAMPLES) / W * 3 - 2.1, (y + sy / SAMPLES) / H * 2.4 - 1.2);
//     out.push(sum / (SAMPLES * SAMPLES));
//   }
//   return out;
// };
export function row(y0) {
  const y = +y0, out = [];
  for (let x = 0; x < 80; x++) {
    let sum = 0;
    for (let sy = 0; sy < 18; sy++) {
      for (let sx = 0; sx < 18; sx++) {
        sum += escape((x + sx / 18) / 80 * 3 - 2.1, (y + sy / 18) / 32 * 2.4 - 1.2);
        $POLL();
      }
      $POLL();
    }
    $C(out, push, sum / (18 * 18));
    $POLL();
  }
  return out;
}

// const render = threads => {
//   const rows = new Array(H);
//   const next = new Int32Array(new SharedArrayBuffer(4)); // the next row to draw
//   const worker = () => {
//     for (let y = Atomics.add(next, 0, 1); y < H; y = Atomics.add(next, 0, 1)) rows[y] = row(y);
//   };
//   const ts = [];
//   for (let i = 0; i < threads; i++) ts.push(new Thread(worker));
//   for (const t of ts) t.join();
//   return rows;
// };
function render(threads) {
  // rows and next are captured by worker, so they live in an environment object
  const env = { rows: new Array(32), next: $newTA(Int32Array, $newSAB(4)) };
  const ts = [];
  for (let i = 0; i < threads; i++) {
    $C(ts, push, $newThread($closure(FN.worker, env)));
    $POLL();
  }
  for (const t of $iter(ts)) {
    $C(t, join);
    $POLL();
  }
  return $G(env, rows);
}

function worker(env) {
  // const bindings it captured: read once per call
  const next = $G(env, next), rows = $G(env, rows);
  for (let y = Atomics.add(next, 0, 1); y < 32; y = Atomics.add(next, 0, 1)) {
    $SI(rows, y, row(y));
    $POLL();
  }
}

// let base = 0, rows;
// for (const threads of [ 1, 2, 4, 8 ]) {
//   const t0 = performance.now();
//   rows = render(threads);
//   const ms = performance.now() - t0;
//   if (threads === 1) base = ms;
//   console.log(`threads ${threads}  ${ms.toFixed(0).padStart(5)} ms  ${(base / ms).toFixed(2)}x`);
// }
//
// const palette = [ 17, 18, 19, 54, 55, 56, 92, 93, 129, 165, 171, 207, 213, 209, 215, 221, 227, 229, 231 ];
// let art = '';
// for (const r of rows) {
//   let last = -1;
//   for (const v of r) {
//     const c = v >= MAX_ITER - 0.5 ? 16 : palette[Math.floor(Math.log(1 + v) / Math.log(MAX_ITER) * (palette.length - 1))];
//     if (c !== last) { art += `\x1b[48;5;${c}m`; last = c; }
//     art += ' ';
//   }
//   art += '\x1b[0m\n';
// }
// console.log(art);
// (the thread counts come from the runner, so a benchmark can repeat them)
export function main(threadCounts) {
  let base = 0, rows;
  for (const threads of $iter(threadCounts)) {
    const t0 = performance.now();
    rows = render(threads);
    const ms = performance.now() - t0;
    if (threads === 1) base = ms;
    $log(`threads ${threads}  ${ms.toFixed(0).padStart(5)} ms  ${(base / ms).toFixed(2)}x`);
    $POLL();
  }

  const palette = [ 17, 18, 19, 54, 55, 56, 92, 93, 129, 165, 171, 207, 213, 209, 215, 221, 227, 229, 231 ];
  let art = '';
  for (const r of $iter(rows)) {
    let last = -1;
    for (const v of $iter(r)) {
      const c = v >= 2000 - 0.5 ? 16 : $GI(palette, Math.floor(Math.log(1 + v) / Math.log(2000) * ($G(palette, length) - 1)));
      if (!$eq(c, last)) { art += `\x1b[48;5;${c}m`; last = c; }
      art += ' ';
      $POLL();
    }
    art += '\x1b[0m\n';
    $POLL();
  }
  $log(art);
}
