// Atomics on shared struct fields: compareExchange claims work without a
// lock. Each worker takes the next chunk of a SharedArray, and sums it.

import {run} from '@arv/structs/agent';

shared struct Work {
  next = 0;
  total = 0;
  data = new SharedArray<number>(4096);
}

export function sum(work: Work, chunk: number) {
  let mine = 0;
  for (;;) {
    const start = Atomics.load(work, 'next');
    if (start >= work.data.length) break;
    // claimed if nobody moved it on meanwhile
    if (Atomics.compareExchange(work, 'next', start, start + chunk) !== start) continue;
    let s = 0;
    for (let i = start; i < Math.min(start + chunk, work.data.length); i++) s += work.data[i]!;
    // add it in: retry until the total we read is still the total
    for (let t = Atomics.load(work, 'total'); ; t = Atomics.load(work, 'total'))
      if (Atomics.compareExchange(work, 'total', t, t + s) === t) break;
    mine++;
  }
  return mine;
}

export async function main(workers: number) {
  const work = new Work();
  for (let i = 0; i < work.data.length; i++) work.data[i] = i;
  const chunks = await Promise.all(
    Array.from({length: workers}, () => run(import.meta.url, 'sum', work, 64)),
  );
  console.log('chunks per worker:', chunks.join(', '));
  console.log(`total ${work.total} (${(4096 * 4095) / 2} expected)`);
}
