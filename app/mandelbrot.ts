// Mandelbrot on goroutines and channels: a channel of rows to draw and a channel of drawn rows. The
// goroutines share nothing but the channels; each drawn row moves back.
import { Channel, go } from "threads";

export const W = 160, H = 64;
const SAMPLES = 9, MAX_ITER = 2000;

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

function drawRows(jobs: Channel<number>, results: Channel<Drawn>) {
  for (const y of jobs) results.send({ y, values: row(y) });
}

/** Draws the picture with `threads` goroutines; the rows move back to the caller. */
export function render(threads: number): { threads: number; ms: number; rows: number[][] } {
  const t0 = performance.now();
  const jobs = new Channel<number>(H), results = new Channel<Drawn>(H);
  for (let t = 0; t < threads; t++) go(drawRows, jobs, results);
  for (let y = 0; y < H; y++) jobs.send(y);
  jobs.close();
  const rows: number[][] = [];
  for (let k = 0; k < H; k++) {
    const drawn = results.recv()!;
    rows[drawn.y] = drawn.values;
  }
  return { threads, ms: performance.now() - t0, rows };
}

export const maxIterations = MAX_ITER;
