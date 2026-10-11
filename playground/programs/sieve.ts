// A SharedArray of booleans holds one byte per element, in shared memory. Here the threads run a sieve
// of Eratosthenes over one array of N flags: each crosses out the multiples of the small primes in its
// own part of the array, so no two threads write the same element, and main counts what is left once
// scope has joined them.
import { log, scope, share, type Shared, SharedArray } from "threads";

const N = 10_000_000;

// the primes up to limit, with an ordinary sieve on this thread
function smallPrimes(limit: number): number[] {
  const crossed = new Uint8Array(limit + 1), primes: number[] = [];
  for (let p = 2; p <= limit; p++) {
    if (crossed[p]) continue;
    primes.push(p);
    for (let m = p * p; m <= limit; m += p) crossed[m] = 1;
  }
  return primes;
}

// runs on a thread: crosses out the multiples of the primes in [lo, hi)
function crossOut(composite: SharedArray<boolean>, primes: Shared<number[]>, lo: number, hi: number) {
  for (const p of primes) {
    for (let m = Math.max(p * p, Math.ceil(lo / p) * p); m < hi; m += p) composite[m] = true;
  }
}

// main runs on a worker too: the playground starts it as a thread, so it may block (scope waits for
// the threads it started)
export function main(threadCounts: readonly number[]) {
  const primes = share(smallPrimes(Math.floor(Math.sqrt(N)))); // every thread reads the same list
  for (const threads of threadCounts) {
    const composite = new SharedArray(Boolean, N), t0 = performance.now();
    scope(s => {
      for (let t = 0; t < threads; t++) s.spawn(crossOut, composite, primes, Math.floor(N * t / threads), Math.floor(N * (t + 1) / threads));
    });
    let count = 0;
    for (let i = 2; i < composite.length; i++) if (!composite[i]) count++;
    log(`${threads} thread${threads === 1 ? "" : "s"}: ${count} primes below ${N}, in ${(performance.now() - t0).toFixed(0)} ms`);
  }
}
