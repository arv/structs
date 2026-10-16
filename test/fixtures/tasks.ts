// Functions test/agents.test.ts runs on workers, with run().

export function add(tally: {count: number; mutex: Atomics.Mutex}, n: number) {
  for (let i = 0; i < n; i++) {
    using _ = Atomics.Mutex.lock(tally.mutex);
    tally.count++;
  }
  return 'added';
}

export async function later(x: number) {
  await new Promise(resolve => setTimeout(resolve, 10));
  return x * 2;
}

export function fail() {
  throw new RangeError('it failed');
}
