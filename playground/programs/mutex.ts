// Atomics.Mutex: workers count together, each increment under the lock. An
// UnlockToken unlocks it at the end of its `using` block.

import {run} from '../../src/runtime/agent.ts';

shared struct Counter {
  count = 0;
  lock = new Atomics.Mutex();
}

export function count(counter: Counter, n: number) {
  for (let i = 0; i < n; i++) {
    using _ = Atomics.Mutex.lock(counter.lock);
    counter.count++;
  }
}

export async function main(workers: number) {
  const counter = new Counter();
  const each = 100_000;
  await Promise.all(
    Array.from({length: workers}, () =>
      run(import.meta.url, 'count', counter, each),
    ),
  );
  console.log(`${workers} workers counted to ${counter.count} (${workers * each} expected)`);
}
