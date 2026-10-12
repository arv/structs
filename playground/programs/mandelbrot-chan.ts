// Porffor's threads/playground/presets/2-mandelbrot.js with goroutines and channels (chan.js): a job channel
// of rows to draw, and a result channel of drawn rows. The workers share nothing but the two
// channels; a drawn row moves back to main.
import { Channel, go, log } from "threads";

const W = 80, H = 32, SAMPLES = 18, MAX_ITER = 2000;

// iterations until (cr, ci) escapes
function escape(cr: number, ci: number): number {
  let zr = 0, zi = 0, i = 0;
  while (i < MAX_ITER) {
    const zr2 = zr * zr, zi2 = zi * zi;
    if (zr2 + zi2 >= 4) break;
    zi = 2 * zr * zi + ci;
    zr = zr2 - zi2 + cr;
    i++;
  }
  return i;
}

// one row of the picture, averaging SAMPLES x SAMPLES points per character
function row(y: number): number[] {
  const out: number[] = [];
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let sy = 0; sy < SAMPLES; sy++) for (let sx = 0; sx < SAMPLES; sx++)
      sum += escape((x + sx / SAMPLES) / W * 3 - 2.1, (y + sy / SAMPLES) / H * 2.4 - 1.2);
    out.push(sum / (SAMPLES * SAMPLES));
  }
  return out;
}

type Drawn = { y: number; values: number[] };

// a goroutine: draws the rows that come in on jobs until it is closed
function worker(jobs: Channel<number>, results: Channel<Drawn>) {
  for (const y of jobs) results.send({ y, values: row(y) });
}

function render(threads: number): number[][] {
  const jobs = new Channel<number>(H), results = new Channel<Drawn>(H);
  for (let t = 0; t < threads; t++) go(worker, jobs, results);
  for (let y = 0; y < H; y++) jobs.send(y);
  jobs.close();
  const rows: number[][] = [];
  for (let k = 0; k < H; k++) {
    const drawn = results.recv()!;
    rows[drawn.y] = drawn.values;
  }
  return rows;
}

// the thread counts come from the runner (the playground), so a benchmark can repeat them
export function main(threadCounts: readonly number[]) {
  let base = 0, rows: number[][] = [];
  for (const threads of threadCounts) {
    const t0 = performance.now();
    rows = render(threads);
    const ms = performance.now() - t0;
    if (threads === 1) base = ms;
    log(`threads ${threads}  ${ms.toFixed(0).padStart(5)} ms  ${(base / ms).toFixed(2)}x`);
  }

  // the picture, as the preset draws it: a 256-color background per character
  const palette = [17, 18, 19, 54, 55, 56, 92, 93, 129, 165, 171, 207, 213, 209, 215, 221, 227, 229, 231];
  let art = "";
  for (const r of rows) {
    let last = -1;
    for (const v of r) {
      const c = v >= MAX_ITER - 0.5 ? 16 : palette[Math.floor(Math.log(1 + v) / Math.log(MAX_ITER) * (palette.length - 1))];
      if (c !== last) { art += `\x1b[48;5;${c}m`; last = c; }
      art += " ";
    }
    art += "\x1b[0m\n";
  }
  log(art);
}
