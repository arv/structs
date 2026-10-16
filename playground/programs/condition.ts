// Atomics.Condition: a bounded queue. Producers wait while it is full,
// consumers while it is empty; each tells the other side when it changes it.

import {run} from '@arv/structs/agent';

shared struct Queue {
  items = new SharedArray<number>(4);
  head = 0;
  size = 0;
  lock = new Atomics.Mutex();
  changed = new Atomics.Condition();
}

export function produce(q: Queue, from: number, n: number) {
  for (let i = 0; i < n; i++) {
    using token = Atomics.Mutex.lock(q.lock);
    Atomics.Condition.waitFor(q.changed, token, Infinity, () => q.size < q.items.length);
    q.items[(q.head + q.size) % q.items.length] = from * 1000 + i;
    q.size++;
    Atomics.Condition.notify(q.changed);
  }
}

export function consume(q: Queue, n: number) {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    using token = Atomics.Mutex.lock(q.lock);
    Atomics.Condition.waitFor(q.changed, token, Infinity, () => q.size > 0);
    sum += q.items[q.head]!;
    q.head = (q.head + 1) % q.items.length;
    q.size--;
    Atomics.Condition.notify(q.changed);
  }
  return sum;
}

export async function main(workers: number) {
  const q = new Queue();
  const producers = Math.max(1, workers - 1), each = 200;
  const done = Array.from({length: producers}, (_, p) =>
    run(import.meta.url, 'produce', q, p, each),
  );
  const sum = await run(import.meta.url, 'consume', q, producers * each);
  await Promise.all(done);
  let expected = 0;
  for (let p = 0; p < producers; p++)
    for (let i = 0; i < each; i++) expected += p * 1000 + i;
  console.log(`${producers} producers, 1 consumer: sum ${sum} (${expected} expected)`);
}
