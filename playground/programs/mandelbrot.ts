// The Mandelbrot set, on as many workers as main is given: each claims the
// next row with Atomics.compareExchange on a shared struct's field, and
// writes the row's count into a SharedArray. The rows are independent, so
// more workers draw it faster: run it on 1, 2, 4 and 8.

import {run} from '@arv/structs/agent';

const WIDTH = 1200, HEIGHT = 800, LIMIT = 500;

shared struct Picture {
  // the next row to draw
  next = 0;
  rows = new SharedArray<number>(HEIGHT);
  // how many rows each worker drew
  drawn = new SharedArray<number>(64);
}

// the iterations of each pixel of row y, added up
function row(y: number): number {
  let total = 0;
  const ci = (y / HEIGHT) * 2.4 - 1.2;
  for (let x = 0; x < WIDTH; x++) {
    const cr = (x / WIDTH) * 3.5 - 2.5;
    let zr = 0, zi = 0, n = 0;
    while (n < LIMIT && zr * zr + zi * zi < 4) {
      const t = zr * zr - zi * zi + cr;
      zi = 2 * zr * zi + ci;
      zr = t;
      n++;
    }
    total += n;
  }
  return total;
}

// on a worker: rows, until there are none
export function draw(picture: Picture, me: number) {
  let mine = 0;
  for (;;) {
    const y = Atomics.load(picture, 'next');
    if (y >= HEIGHT) break;
    if (Atomics.compareExchange(picture, 'next', y, y + 1) !== y) continue;
    picture.rows[y] = row(y);
    mine++;
  }
  picture.drawn[me] = mine;
}

export async function main(workers: number) {
  const picture = new Picture();
  await Promise.all(
    Array.from({length: workers}, (_, me) => run(import.meta.url, 'draw', picture, me)),
  );
  let total = 0;
  for (let y = 0; y < HEIGHT; y++) total += picture.rows[y]!;
  const drawn = Array.from({length: workers}, (_, me) => picture.drawn[me]);
  console.log(`${workers} worker(s), rows drawn by each: ${drawn.join(', ')}`);
  console.log(`iterations in all: ${total}`);
}
