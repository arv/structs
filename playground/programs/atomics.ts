// Atomic operations act on i32s in shared memory: an i32 field of a struct, or an element of a
// SharedArray<i32>. Each is indivisible, so threads can share a counter with no lock. Here threads
// claim the rows of an image from one counter, so that each row is drawn once whichever thread is
// fastest, draw them into a SharedArray of bytes (u8), and count the pixels at each level into one
// histogram, all together.
import { atomic, i32, log, scope, SharedArray, struct, type Struct, type Thread, u8 } from "threads";

const Work = struct({ next: i32 }); // the next row to claim
type Work = Struct<typeof Work>;

const W = 72, H = 32, LEVELS = 8;

// the gray level, 0 to 255, of pixel x, y: how many steps the point takes to escape (Mandelbrot)
function gray(x: number, y: number): number {
  const cr = x / W * 3 - 2.2, ci = y / H * 2.4 - 1.2;
  let zr = 0, zi = 0, i = 0;
  for (; i < 255 && zr * zr + zi * zi < 4; i++) {
    const t = zr * zr - zi * zi + cr;
    zi = 2 * zr * zi + ci;
    zr = t;
  }
  return i;
}

// runs on a thread: claims rows until none are left, and returns how many it drew
function draw(work: Work, image: SharedArray<u8>, histogram: SharedArray<i32>): number {
  let rows = 0;
  for (let y; (y = atomic.add(work, "next", 1)) < H; rows++) {
    for (let x = 0; x < W; x++) {
      const g = gray(x, y);
      image[y * W + x] = g;
      atomic.add(histogram, g >> 5, 1); // levels of 32
    }
  }
  return rows;
}

// main runs on a worker too: the playground starts it as a thread, so it may block (scope waits for
// the threads it started)
export function main(threadCounts: readonly number[]) {
  const image = new SharedArray(u8, W * H), histogram = new SharedArray(i32, LEVELS);
  for (const threads of threadCounts) {
    const work = new Work();
    for (let l = 0; l < LEVELS; l++) histogram[l] = 0;
    const rows: number[] = [];
    scope(s => {
      const drawing: Thread<number>[] = [];
      for (let t = 0; t < threads; t++) drawing.push(s.spawn(draw, work, image, histogram));
      for (const d of drawing) rows.push(d.join());
    });
    let counted = 0;
    for (let l = 0; l < LEVELS; l++) counted += histogram[l];
    log(`${threads} thread${threads === 1 ? "" : "s"}: rows drawn by each ${rows.join(", ")}; ${counted} of ${W * H} pixels counted`);
  }
  const shades = " .:-=+*#%@";
  for (let y = 0; y < H; y += 2) {
    let line = "";
    for (let x = 0; x < W; x++) line += shades[Math.min(shades.length - 1, image[y * W + x] >> 2)];
    log(line);
  }
}
