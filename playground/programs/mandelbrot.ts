// The Mandelbrot set, drawn on as many workers as main is given: each claims
// the next row with Atomics.compareExchange on a shared struct's field, and
// writes the row's values into a SharedArray. The rows are independent, so
// more workers draw it faster: run it on 1, 2, 4 and 8. Then main prints the
// picture, a 256-color background per character.

import {run} from '../../src/runtime/agent.ts';

const W = 80, H = 32, SAMPLES = 18, MAX_ITER = 2000;

shared struct Picture {
  // the next row to draw
  next = 0;
  // the average iterations of each character, row by row
  values = new SharedArray<number>(W * H);
  // how many rows each worker drew
  drawn = new SharedArray<number>(64);
}

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

// one character: the average of SAMPLES x SAMPLES points
function cell(x: number, y: number): number {
  let sum = 0;
  for (let sy = 0; sy < SAMPLES; sy++)
    for (let sx = 0; sx < SAMPLES; sx++)
      sum += escape(((x + sx / SAMPLES) / W) * 3 - 2.1, ((y + sy / SAMPLES) / H) * 2.4 - 1.2);
  return sum / (SAMPLES * SAMPLES);
}

// on a worker: rows, until there are none
export function draw(picture: Picture, me: number) {
  let mine = 0;
  for (;;) {
    const y = Atomics.load(picture, 'next');
    if (y >= H) break;
    if (Atomics.compareExchange(picture, 'next', y, y + 1) !== y) continue;
    for (let x = 0; x < W; x++) picture.values[y * W + x] = cell(x, y);
    mine++;
  }
  picture.drawn[me] = mine;
}

// the colors, from the outside in; the set itself is black
const PALETTE = [
  17, 18, 19, 54, 55, 56, 92, 93, 129, 165, 171, 207, 213, 209, 215, 221, 227,
  229, 231,
];

function print(picture: Picture) {
  let art = '';
  for (let y = 0; y < H; y++) {
    let last = -1;
    for (let x = 0; x < W; x++) {
      const v = picture.values[y * W + x]!;
      const c =
        v >= MAX_ITER - 0.5
          ? 16
          : PALETTE[Math.floor((Math.log(1 + v) / Math.log(MAX_ITER)) * (PALETTE.length - 1))]!;
      if (c !== last) {
        art += `\x1b[48;5;${c}m`;
        last = c;
      }
      art += ' ';
    }
    art += '\x1b[0m\n';
  }
  console.log(art);
}

export async function main(workers: number) {
  const picture = new Picture();
  await Promise.all(
    Array.from({length: workers}, (_, me) => run(import.meta.url, 'draw', picture, me)),
  );
  const drawn = Array.from({length: workers}, (_, me) => picture.drawn[me]);
  console.log(`${workers} worker(s), rows drawn by each: ${drawn.join(', ')}`);
  print(picture);
}
