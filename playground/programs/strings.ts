// Strings in shared memory are interned: each distinct string is stored once, and a `str` field (or an
// element of a SharedArray<string>) holds the address of that copy. Writing one interns it; reading one
// gives this thread's copy of the string, decoded the first time and kept. Here threads fill a log in
// shared memory, each its own part, and then count the errors per service in it.
import { f64, log, scope, SharedArray, str, struct, type Struct, type Thread } from "threads";

const Entry = struct({ service: str, level: str, ms: f64 });
type Entry = Struct<typeof Entry>;

const SERVICES = ["auth", "billing", "search", "upload", "email"];
const N = 500_000;

// a made-up number in [0, 1) for entry i and draw k (a hash of them): the same whichever thread fills
// the entry
function noise(i: number, k: number): number {
  let h = Math.imul(i * 4 + k, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// runs on a thread: fills entries [lo, hi)
function fill(entries: SharedArray<Entry>, lo: number, hi: number) {
  for (let i = lo; i < hi; i++) {
    const e = entries[i];
    e.service = SERVICES[Math.floor(noise(i, 0) * SERVICES.length)];
    e.ms = Math.round(noise(i, 1) * noise(i, 2) * 2000);
    e.level = e.ms > 1500 ? "error" : e.ms > 500 ? "warn" : "info";
  }
}

// runs on a thread: the errors per service in entries [lo, hi), in an object its result moves back
function errors(entries: SharedArray<Entry>, lo: number, hi: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let i = lo; i < hi; i++) {
    const e = entries[i];
    if (e.level === "error") counts[e.service] = (counts[e.service] ?? 0) + 1;
  }
  return counts;
}

// main runs on a worker too: the playground starts it as a thread, so it may block (scope waits for
// the threads it started)
export function main(threadCounts: readonly number[]) {
  const entries = new SharedArray(Entry, N);
  for (const threads of threadCounts) {
    const part = (t: number) => Math.floor(N * t / threads), t0 = performance.now();
    scope(s => {
      for (let t = 0; t < threads; t++) s.spawn(fill, entries, part(t), part(t + 1));
    });
    const t1 = performance.now(), total: Record<string, number> = {};
    scope(s => {
      const counting: Thread<Record<string, number>>[] = [];
      for (let t = 0; t < threads; t++) counting.push(s.spawn(errors, entries, part(t), part(t + 1)));
      for (const c of counting) for (const [service, n] of Object.entries(c.join())) total[service] = (total[service] ?? 0) + n;
    });
    log(`${threads} thread${threads === 1 ? "" : "s"}: filled in ${(t1 - t0).toFixed(0)} ms, counted in ${(performance.now() - t1).toFixed(0)} ms; ` +
      `errors ${Object.keys(total).sort().map(k => `${k} ${total[k]}`).join(", ")}`);
  }
}
