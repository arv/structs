// An idle pool worker with handles to finalize gives its event loop a turn now
// and then, so that V8 may run the registries: FINALIZE ms (50) after it went
// idle, twice as long after each turn that finalized nothing, up to POLL
// (1000), and FINALIZE again once a turn finalizes something or a thread comes.
// And what the registries deferred meanwhile is freed, or handed on, as at a
// thread's end. The test runs the pool's loop on its own thread, its wait for
// work made to time out at once, and records the waits' timeouts
import {setFlagsFromString} from 'node:v8';
import {runInNewContext} from 'node:vm';
import {expect, it} from 'vite-plus/test';
import {own, runtime, threads as T} from './test-heap.ts';

// the control words, as runtime.ts lays them out
const C_PENDING = 10,
  C_SHUTDOWN = 12;
// V8's collector, by hand: node gives it to a new context once the flag is set
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

function noop() {}
function throwing(): never {
  throw new Error('thrown by a thread not joined');
}
own.fns({noop, throwing});

// the pool's loop, run here until at(n), called at its nth wait for work,
// says to shut down: the waits' timeouts. a thread the loop runs makes this
// thread a worker of its own, which is thread 1 again after, and the pool runs
// again
async function loop(at: (n: number) => boolean) {
  const timeouts: number[] = [];
  const atomics = Atomics as unknown as {wait: typeof Atomics.wait};
  const wait = atomics.wait;
  atomics.wait = ((a: Int32Array, i: number, v: number, timeout?: number) => {
    if (a !== runtime.I32 || i !== C_PENDING) return wait(a, i, v, timeout);
    timeouts.push(timeout ?? Infinity);
    if (at(timeouts.length)) Atomics.store(runtime.I32, C_SHUTDOWN, 1);
    return 'timed-out';
  }) as typeof Atomics.wait;
  try {
    await runtime.poolLoop();
  } finally {
    atomics.wait = wait;
    runtime.threadBegin(1);
    Atomics.store(runtime.I32, C_SHUTDOWN, 0);
  }
  return timeouts;
}

it('an idle worker waits longer while nothing is finalized', async () => {
  const H = T.struct({x: T.f64}, 'Held');
  // handles to finalize: the worker gives its event loop turns. one goes
  // later, the other stays
  let goes: object | null = new H();
  const stays = new H();
  let th: ReturnType<typeof own.spawn> | null = null;
  const timeouts = await loop(n => {
    if (n === 7) th = own.spawn(noop); // work comes
    if (n === 10) {
      goes = null; // a handle to finalize
      gc();
    }
    return n === 16;
  });
  // nothing finalized: each wait twice the last, up to a second
  expect(timeouts.slice(0, 7)).toEqual([50, 100, 200, 400, 800, 1000, 1000]);
  // a thread: from the start again
  expect(timeouts.slice(7, 10)).toEqual([50, 100, 200]);
  // a handle finalized: from the start again, at the turn that finalized it
  // or the next
  expect(timeouts.slice(10, 12)).toContain(50);
  expect(goes).toBeNull();
  expect(stays).toBeInstanceOf(H);
  th!.join();
});

it('an idle worker frees what its registries deferred', async () => {
  // a thread that throws, which the loop runs, and its Thread, not joined:
  // once the worker, idle, has it collected, the thread's error, a string,
  // dies, and its block waits a grace period, in the worker's queue. the
  // Thread is made in a function of its own, and held by an object alone, so
  // that no frame holds it once it is let go
  const held = (() => {
    const th = own.spawn(throwing);
    return {th: th as object | null, t: th.t};
  })();
  let thrown = 0;
  // the program's main thread, in a wait, holds nothing up
  runtime.$waitBegin();
  await loop(n => {
    if (n === 1) thrown = runtime.I32[(held.t + 24) >> 2]; // the thread ran
    held.th = null;
    gc();
    return n === 8;
  });
  expect(held.th).toBeNull();
  // the block, by the registry; the string, by the worker after the turn
  expect(runtime.I32[held.t >> 2]).toBe(runtime.K_FREE);
  expect(runtime.I32[thrown >> 2]).toBe(runtime.K_FREE);
  expect(T.heapStats().pending).toBe(0);
});
