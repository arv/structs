// A shared struct lives in shared memory, and every thread reads and writes the same one, in place.
// Here each thread counts the primes in its own range into its own tally, one of a SharedArray of
// them, and main adds the tallies up once scope has joined the threads (joining orders the threads'
// writes before main's reads).
import { f64, log, scope, SharedArray, struct, type Struct } from "threads";

const Tally = struct({ primes: f64, largest: f64 });
type Tally = Struct<typeof Tally>;

function isPrime(n: number): boolean {
  if (n < 2) return false;
  for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;
  return true;
}

// runs on a thread: the primes in [lo, hi), into its tally
function count(tally: Tally, lo: number, hi: number) {
  for (let n = lo; n < hi; n++) {
    if (isPrime(n)) {
      tally.primes++;
      tally.largest = n;
    }
  }
}

const N = 2_000_000;

// main runs on a worker too: the playground starts it as a thread, so it may block (scope waits for
// the threads it started)
export function main(threadCounts: readonly number[]) {
  for (const threads of threadCounts) {
    const tallies = new SharedArray(Tally, threads), t0 = performance.now();
    scope(s => {
      for (let t = 0; t < threads; t++) s.spawn(count, tallies[t], Math.floor(N * t / threads), Math.floor(N * (t + 1) / threads));
    });
    let primes = 0, largest = 0;
    for (let t = 0; t < threads; t++) {
      primes += tallies[t].primes;
      largest = Math.max(largest, tallies[t].largest);
    }
    log(`${threads} thread${threads === 1 ? "" : "s"}: ${primes} primes below ${N}, the largest ${largest}, in ${(performance.now() - t0).toFixed(0)} ms`);
  }
}
