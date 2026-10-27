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

// what `race` writes to a field: Numbers and BigInts, which share no bits
export const RACED = [1.5, -2.25, -(2n ** 60n), 2n ** 60n - 1n, 12345n, -1n];

// writes RACED to `o.v` over and over, or reads it and counts the values it
// sees that nobody wrote
export function race(o: {v: unknown}, n: number, writes: boolean) {
  let wrong = 0;
  for (let i = 0; i < n; i++)
    if (writes) o.v = RACED[i % RACED.length];
    else if (!RACED.includes(o.v as number | bigint)) wrong++;
  return wrong;
}
