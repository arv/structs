// A thread that is never joined: once its Thread is collected, the registry
// detaches it, and its block and its result, with the counts the result holds,
// are freed by whichever side comes last, the thread's end or the registry's
// callback. What the callback does (own.ts __abandon) is done here directly,
// before the thread starts, while it runs and after it ends, and the test runs
// the thread on its own thread, as a pool worker would (runtime.ts runThread);
// then the registry itself, with V8's collector run by hand
import {setFlagsFromString} from 'node:v8';
import {runInNewContext} from 'node:vm';
import {describe, expect, it} from 'vite-plus/test';
import {logged, own, runtime, threads as T} from './test-heap.ts';

const state = (t: number) => Atomics.load(runtime.I32, (t + 8) >> 2);
// live blocks of the heap, once what waits to be freed is (a string that died
// goes a grace period later)
const settled = () => {
  own.__collect();
  const s = T.heapStats();
  return s.allocated - s.freed;
};
// thread block t run to its end here, as a pool worker runs it: the end ends
// this thread's entry, which is begun again
const run = (t: number) => {
  runtime.runThread(t, true);
  runtime.threadBegin(1);
};

const P = T.struct({x: T.f64}, 'P');
// a struct that a handle holds, and a result holds a count of besides
const held = new P();
const heldAt = (held as unknown as {$cell: number}).$cell;
const count = (a: number) => runtime.I32[(a >> 2) + 1];
// the struct the last result owned (counted, as compiled code returns one),
// and the thread that runs
let owned = 0,
  current: ReturnType<typeof own.spawn> | null = null;
function result() {
  owned = own.newStruct(P);
  return {owned: own.moved(owned), held, s: 'a string of its own'};
}
function detaching() {
  own.__abandon(current!);
  return result();
}
// a struct whose one handle the thread makes, and lets go of, before it returns
// the struct in its result
let boxedAt = 0;
function boxed() {
  boxedAt = own.newStruct(P);
  const h = own.box(boxedAt);
  own.release(boxedAt); // the handle's count is the one left
  return {h};
}
const THROWN = 'Error: thrown by a thread not joined';
function throwing(): never {
  throw new Error(THROWN.slice('Error: '.length));
}
own.fns({result, detaching, boxed, throwing});

describe('a thread not joined', () => {
  it('detached before it starts: its end frees the block, and drops the result', () => {
    const before = settled();
    const th = own.spawn(result);
    own.__abandon(th);
    expect(state(th.t)).toBe(runtime.DETACHED);
    expect(settled()).toBe(before + 2); // the block, and the arguments
    run(th.t);
    // the counts the result held are given back
    expect(runtime.I32[owned >> 2]).toBe(runtime.K_FREE);
    expect(count(heldAt)).toBe(1); // the handle's
    expect(settled()).toBe(before);
  });

  it('detached while it runs: its end frees the block, and drops the result', () => {
    const before = settled();
    const th = own.spawn(detaching);
    current = th;
    run(th.t);
    expect(runtime.I32[owned >> 2]).toBe(runtime.K_FREE);
    expect(count(heldAt)).toBe(1);
    expect(settled()).toBe(before);
  });

  it('detached after it ends: the block and the result are freed then', () => {
    const before = settled();
    const th = own.spawn(result);
    run(th.t);
    expect(state(th.t)).toBe(runtime.DONE);
    // the result, until it is read or dropped, holds its counts
    expect(runtime.I32[owned >> 2]).toBe(P.kind);
    expect(count(heldAt)).toBe(2);
    own.__abandon(th);
    expect(runtime.I32[owned >> 2]).toBe(runtime.K_FREE);
    expect(count(heldAt)).toBe(1);
    expect(settled()).toBe(before);
  });

  it('what it threw is given back, whichever side drops it, and not printed', () => {
    logged.length = 0;
    const before = settled();
    const ended = own.spawn(throwing);
    run(ended.t);
    // what it threw, held for the join: an interned string (its failure)
    const thrown = runtime.I32[(ended.t + 24) >> 2];
    expect(runtime.$str(thrown)).toContain(THROWN);
    own.__abandon(ended);
    expect(settled()).toBe(before);
    expect(runtime.I32[thrown >> 2]).toBe(runtime.K_FREE);
    const detached = own.spawn(throwing);
    own.__abandon(detached);
    run(detached.t);
    expect(settled()).toBe(before);
    expect(logged).toEqual([]);
  });

  it('a goroutine sends no result, and has what it threw printed', () => {
    logged.length = 0;
    const before = settled();
    const t = own.__start(throwing, [], true);
    expect(state(t)).toBe(runtime.DETACHED);
    run(t);
    expect(logged).toEqual([`a detached thread threw: ${THROWN}\n`]);
    expect(settled()).toBe(before);
  });
});

// V8's collector, by hand: node gives it to a new context once the flag is set
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
// collects, and gives the registries a turn, until `done` (or a while has
// passed)
async function collectUntil(done: () => boolean) {
  for (let k = 0; k < 200 && !done(); k++) {
    gc();
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

describe('the registry', () => {
  it('a spawn loop that joins nothing leaves the heap as it was once its Threads are collected', async () => {
    const before = settled();
    const ts: number[] = [];
    // in a function of its own: no Thread stays reachable from here
    (() => {
      for (let i = 0; i < 100; i++) {
        const th = own.spawn(result);
        ts.push(th.t);
        if (i % 2 === 0) run(th.t); // half end before their Thread goes
      }
    })();
    // the other half, detached, wait for their end: each its block and its
    // arguments
    await collectUntil(() => settled() === before + 100);
    expect(settled()).toBe(before + 100);
    for (let i = 1; i < 100; i += 2) {
      expect(state(ts[i])).toBe(runtime.DETACHED);
      run(ts[i]);
    }
    expect(count(heldAt)).toBe(1);
    expect(settled()).toBe(before);
  });

  it("a result's cell is released though this thread has no handle on it", async () => {
    let th: ReturnType<typeof own.spawn> | null = null;
    (() => {
      th = own.spawn(boxed);
      run(th.t);
    })();
    // the thread's handle is collected: the result's count is the one left
    await collectUntil(() => count(boxedAt) === 1);
    expect(count(boxedAt)).toBe(1);
    // dropped, the result makes no handle of its own, which would keep the
    // struct until it was collected in turn
    own.__abandon(th!);
    expect(runtime.I32[boxedAt >> 2]).toBe(runtime.K_FREE);
  });

  it('a Thread joined leaves its thread alone once it is collected', async () => {
    const before = settled();
    let unjoined = 0;
    (() => {
      const th = own.spawn(result);
      run(th.t);
      const r = th.join() as unknown as {owned: number}; // a counted address
      own.release(r.owned);
      // collected with the joined one: once its block is freed, the registry
      // has had its turn
      const other = own.spawn(result);
      run(other.t);
      unjoined = other.t;
    })();
    await collectUntil(() => runtime.I32[unjoined >> 2] === runtime.K_FREE);
    expect(runtime.I32[unjoined >> 2]).toBe(runtime.K_FREE);
    // nothing freed twice
    expect(count(heldAt)).toBe(1);
    expect(settled()).toBe(before);
  });
});
