// JSON on threads. Each thread makes its part of a log of JSON lines (as a server would send it) and
// parses it. Then either the thread sums its part up, and only the totals cross back, or it sends all
// of its parsed requests back for main to sum up.
//
// Parsed JSON crosses threads cheaply where it repeats itself, and JSON does: an object's keys cross
// as the addresses of their one interned copy, main makes every object with the same keys with one
// constructor, and a string that occurs more than once in a thread's result (a service, a method, a
// user) is copied once.
import { log, scope, type Sending, type Thread } from "threads";

type Request = { time: number; service: string; method: string; path: string; status: number; ms: number; user: string };
type Totals = Record<string, { requests: number; errors: number; ms: number }>;

const SERVICES = ["auth", "billing", "search", "upload", "email", "profile", "orders", "catalog"];
const METHODS = ["GET", "GET", "GET", "POST", "PUT", "DELETE"];
const PATHS = ["/api/v1/items", "/api/v1/cart", "/api/v1/session", "/api/v1/search", "/api/v1/user/settings"];
const N = 200_000;

// a made-up number in [0, 1) for request i and draw k: the same whichever thread makes the request
function noise(i: number, k: number): number {
  let h = Math.imul(i * 8 + k, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const pick = <T>(items: readonly T[], x: number): T => items[Math.floor(x * items.length)];

// the log of requests [lo, hi): a line of JSON each
function logText(lo: number, hi: number): string {
  const lines: string[] = [];
  for (let i = lo; i < hi; i++) {
    const request: Request = {
      time: 1_760_000_000_000 + i * 37,
      service: pick(SERVICES, noise(i, 0)),
      method: pick(METHODS, noise(i, 1)),
      path: pick(PATHS, noise(i, 2)),
      status: noise(i, 3) < 0.02 ? 500 : 200,
      ms: Math.round(noise(i, 4) * noise(i, 5) * 400),
      user: `user-${Math.floor(noise(i, 6) * 5000)}`,
    };
    lines.push(JSON.stringify(request));
  }
  return lines.join("\n");
}

// what JSON.parse makes is new: the caller owns it
const parse = (text: string): Sending<Request[]> => text.split("\n").map(line => JSON.parse(line));

function sum(requests: readonly Request[], totals: Totals) {
  for (const r of requests) {
    const t = totals[r.service] ??= { requests: 0, errors: 0, ms: 0 };
    t.requests++;
    if (r.status >= 500) t.errors++;
    t.ms += r.ms;
  }
}

// runs on a thread: parses its part of the log and sums it up
function totalsOf(lo: number, hi: number): Sending<Totals> {
  const totals: Totals = {};
  sum(parse(logText(lo, hi)), totals);
  return totals;
}

// runs on a thread: parses its part of the log and sends the requests back
function requestsOf(lo: number, hi: number): Sending<Request[]> {
  return parse(logText(lo, hi));
}

const show = (totals: Totals) => Object.keys(totals).sort()
  .map(s => `${s} ${totals[s].errors}/${totals[s].requests}`).join(", ");

// main runs on a worker too: the playground starts it as a thread, so it may block (scope waits for
// the threads it started)
export function main(threadCounts: readonly number[]) {
  log(`${N} requests, ${(logText(0, N).length / 1048576).toFixed(1)} MB of JSON`);
  for (const threads of threadCounts) {
    const part = (t: number) => Math.floor(N * t / threads);

    let t0 = performance.now();
    const totals: Totals = {};
    scope(s => {
      const counting: Thread<Totals>[] = [];
      for (let t = 0; t < threads; t++) counting.push(s.spawn(totalsOf, part(t), part(t + 1)));
      for (const c of counting) {
        for (const [service, t] of Object.entries(c.join())) {
          const into = totals[service] ??= { requests: 0, errors: 0, ms: 0 };
          into.requests += t.requests; into.errors += t.errors; into.ms += t.ms;
        }
      }
    });
    const summed = performance.now() - t0;

    t0 = performance.now();
    const again: Totals = {};
    let moving = 0;
    scope(s => {
      const parsing: Thread<Request[]>[] = [];
      for (let t = 0; t < threads; t++) parsing.push(s.spawn(requestsOf, part(t), part(t + 1)));
      for (const p of parsing) {
        const t1 = performance.now(), requests = p.join();
        moving += performance.now() - t1;
        sum(requests, again);
      }
    });
    const sent = performance.now() - t0;

    log(`${threads} thread${threads === 1 ? "" : "s"}: summed on the threads in ${summed.toFixed(0)} ms; ` +
      `requests sent back and summed in main in ${sent.toFixed(0)} ms (${moving.toFixed(0)} ms of it joining); ` +
      `errors ${show(totals)}${show(again) === show(totals) ? "" : " (the two differ!)"}`);
  }
}
