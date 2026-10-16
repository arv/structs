// Four workers count to a million together: a shared struct holds the count,
// a Mutex orders the increments, and a Condition says when all are done.
//
//   node --import @arv/structs/register examples/counter/main.js

import {startWorker} from '@arv/structs/agent';

shared struct Tally {
  count = 0;
  done = 0;
  mutex = new Atomics.Mutex();
  allDone = new Atomics.Condition();
}

const WORKERS = 4, EACH = 250_000;
const tally = new Tally();
const workers = [];
for (let i = 0; i < WORKERS; i++) {
  const w = startWorker(new URL('./worker.js', import.meta.url));
  w.postMessage({tally, n: EACH});
  workers.push(w);
}

{
  using lock = Atomics.Mutex.lock(tally.mutex);
  Atomics.Condition.waitFor(tally.allDone, lock, Infinity, () => tally.done === WORKERS);
}
console.log(`count: ${tally.count} (expected ${WORKERS * EACH})`);
for (const w of workers) w.terminate();
