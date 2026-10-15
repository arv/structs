// The page's API on a page, with stand-ins for its Web Workers, which start at
// once and run nothing: what start() does with its options, and what stop()
// leaves, before a pool started and once one did
import {expect, it} from 'vite-plus/test';

const g = globalThis as {__escapeSab?: SharedArrayBuffer; Worker?: unknown};
g.__escapeSab = new SharedArrayBuffer(16 << 20);
// a pool worker: ready as soon as it is given the heap
const made: StandIn[] = [];
let failNext = false; // the next worker's module does not load
class StandIn {
  onmessage: ((e: {data: unknown}) => void) | null = null;
  onerror: unknown = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  constructor() {
    made.push(this);
  }
  postMessage() {
    const fails = failNext;
    failNext = false;
    queueMicrotask(() =>
      fails
        ? (this.onerror as ((e: {message: string}) => void) | null)?.({
            message: '',
          })
        : this.onmessage?.({data: {type: 'ready'}}),
    );
  }
  terminate() {
    this.terminated = true;
  }
}
g.Worker = StandIn;
const browser = await import('./browser.ts');
const runtime = await import('./runtime.ts');
const own = await import('./own.ts');
const sab = g.__escapeSab;
// thread 1's quiescent state (T_QS of its entry), as runtime.ts lays it out
const QS_1 = 2048 + 8 + 5,
  IDLE = 1;

function noop() {}
own.fns({noop});

it('stop() before start() leaves the heap alone', () => {
  browser.stop();
  expect(runtime.counters(sab).shutdown).toBe(0);
});

it('start() takes options once: a later start() with others throws', async () => {
  // as run() starts it
  const started = browser.start();
  expect(browser.start()).toBe(started);
  expect(browser.start({check: false})).toBe(started); // the default's own
  expect(() =>
    browser.start({workers: navigator.hardwareConcurrency + 1}),
  ).toThrow(/already started/);
  expect(() => browser.start({onLog: () => {}})).toThrow(/already started/);
  await started;
  expect(made).toHaveLength(navigator.hardwareConcurrency);
});

it('after stop(), a spawn throws, and the page stays idle', () => {
  browser.stop();
  expect(made.every(w => w.terminated)).toBe(true);
  expect(runtime.I32[QS_1]).toBe(IDLE);
  // the page's onMessage would drop the worker it asks for, and the next
  // start's reset clear the queue: the thread would be lost
  expect(() => own.spawn(noop)).toThrow(/the pool was stopped/);
  expect(runtime.counters(sab)).toMatchObject({live: 0, queued: 0});
  expect(runtime.I32[QS_1]).toBe(IDLE);
});

it('start() after stop() takes options again', async () => {
  const lines: string[] = [],
    before = made.length;
  await browser.start({workers: 1, onLog: text => lines.push(text)});
  expect(made).toHaveLength(before + 1);
  made.at(-1)!.onmessage!({data: {type: 'out', text: 'hello'}});
  expect(lines).toEqual(['hello']);
  own.spawn(noop);
  expect(runtime.counters(sab)).toMatchObject({live: 1, queued: 1});
});

it('a worker whose module does not load fails start() with that cause', async () => {
  browser.stop();
  failNext = true;
  await expect(browser.start({workers: 1})).rejects.toThrow(
    'threads: a worker failed to start: its module did not load',
  );
  browser.stop();
});

for (const event of ['crash', 'error', 'messageerror'] as const)
  it(`a worker's ${event} after ready fails pending runs and stops the pool`, async () => {
    await browser.start({workers: 1});
    const worker = made.at(-1)!,
      runs = [browser.run(noop), browser.run(noop)],
      failures = Promise.all(runs.map(p => p.catch((e: unknown) => e)));
    // Let run() queue its thread and register for the pool's failures.
    await Promise.resolve();
    if (event === 'crash')
      worker.onmessage!({
        data: {type: 'crash', message: 'worker gone', stack: 'worker stack'},
      });
    else if (event === 'error')
      (worker.onerror as (e: {message: string}) => void)({
        message: 'worker gone',
      });
    else worker.onmessageerror!();
    for (const error of await failures) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(
        event === 'messageerror' ? /message.*could not read/ : /worker gone/,
      );
      if (event === 'crash')
        expect(((error as Error).cause as Error).stack).toBe('worker stack');
    }
    expect(made.every(w => w.terminated)).toBe(true);
    expect(runtime.counters(sab).shutdown).toBe(1);
    expect(() => own.spawn(noop)).toThrow(/the pool was stopped/);
    await browser.start({workers: 1});
    expect(made.at(-1)!.terminated).toBe(false);
    // An error from the stopped pool must not shut down its replacement.
    worker.onmessage!({data: {type: 'crash', message: 'late crash'}});
    (worker.onerror as (e: {message: string}) => void)({message: 'late error'});
    expect(runtime.counters(sab).shutdown).toBe(0);
    expect(made.at(-1)!.terminated).toBe(false);
    browser.stop();
  });

it('fails pending runs when a worker requested by grow cannot start', async () => {
  await browser.start({workers: 1});
  const worker = made.at(-1)!,
    failure = browser.run(noop).catch((e: unknown) => e);
  await Promise.resolve();
  failNext = true;
  worker.onmessage!({data: {type: 'grow'}});
  expect(await failure).toMatchObject({
    message: 'threads: a worker failed to start: its module did not load',
  });
  expect(made.every(w => w.terminated)).toBe(true);
  expect(runtime.counters(sab).shutdown).toBe(1);
});

it('processes a late worker nudge to reclaim what became safe after stop', async () => {
  await browser.start({workers: 1});
  const worker = made.at(-1)!,
    N = own.sharedStruct('LateShutdownNudge', ['next'], [0]),
    QS_3 = 2048 + 3 * 8 + 5,
    EPOCH = 17,
    NEXT_TID = 4;
  // Simulate two workers: thread 3 holds up what thread 2 defers.
  if (runtime.I32[NEXT_TID] < 4) runtime.I32[NEXT_TID] = 4;
  runtime.threadBegin(3);
  runtime.threadBegin(2);
  const a = own.newStruct(N),
    b = own.newStruct(N);
  own.store((a >> 2) + 2, b);
  own.store((a >> 2) + 2, 0);
  runtime.threadEnd();
  runtime.threadBegin(1);
  browser.stop();
  expect(runtime.I32[b >> 2]).toBe(N.kind);
  // The other worker passes a point after stop's reclaim, then the queued
  // nudge arrives from the terminated worker of the old generation.
  Atomics.store(runtime.I32, QS_3, Atomics.load(runtime.I32, EPOCH));
  worker.onmessage!({data: {type: 'nudge'}});
  expect(runtime.I32[b >> 2]).toBe(runtime.K_FREE);
  expect(runtime.I32[QS_1]).toBe(IDLE);
  runtime.threadBegin(3);
  runtime.threadEnd();
  runtime.threadBegin(1);
  own.release(a);
});

it('stays awake once stopped, so a collection a stopped worker runs on waits for it', async () => {
  // thread 1's awake word, the word that names the thread that collects, and
  // thread 2's entry, as runtime.ts lays them out
  const AWAKE_1 = 2048 + 8 + 2,
    C_GC = 23,
    ENTRY_2 = 2048 + 2 * 8;
  await browser.start({workers: 1});
  // a worker of the pool is collecting as the page stops it, and runs on
  Atomics.store(runtime.I32, C_GC, ENTRY_2);
  browser.stop(); // the page cannot wait for the collection: it returns
  // quiescent, and awake: the collection waits for the page, which goes on
  // running tasks that change counts, and gives up rather than scan
  expect(runtime.I32[QS_1]).toBe(IDLE);
  expect(runtime.I32[AWAKE_1]).toBe(1);
  // a nudge the worker posted before the stop: a point, and still awake
  runtime.$nudged();
  expect(runtime.I32[AWAKE_1]).toBe(1);
  const S = own.sharedStruct('StoppedPage', ['next'], [0]),
    a = own.newStruct(S);
  own.store((a >> 2) + 2, own.retain(a));
  own.release(a);
  // the worker was terminated in its collection: the next start's reset ends
  // it, and the page is the pool's again
  await browser.start({workers: 1});
  expect(runtime.I32[C_GC]).toBe(0);
  expect(runtime.I32[AWAKE_1]).toBe(1);
  expect(own.collectCycles()).toBe(1);
  browser.stop();
});
