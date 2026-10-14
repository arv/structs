// A thread whose module does not load in the worker (threads-worker.ts's
// loader rejects): the worker's preparation of the thread, which its loop
// awaits before the thread, yields the error rather than throwing it, so that
// the thread ends as one that threw and the loop goes on; and the thread's
// arguments, a message with the counts it carried, are dropped. The suite runs
// the runtime on one thread, without a pool loop: the preparation is tested as
// the loop calls it
import {expect, it} from 'vite-plus/test';
import {own, runtime, threads as T} from './test-heap.ts';

function noop(_arg: unknown) {}

it("a module that does not load is the thread's error, and its arguments are dropped", async () => {
  own.fns({noop});
  own.setModuleLoader(async () => {
    throw new Error('no such module here');
  });
  const before = T.heapStats();
  const th = own.spawn(noop, 'an argument, in a block of its own'); // queued: no worker
  expect(T.heapStats().allocated - before.allocated).toBeGreaterThanOrEqual(2);
  const failed = await runtime.$prepare(th.t);
  expect(String(failed)).toMatch(/could not be loaded here/);
  expect(String(failed)).toMatch(/'noop'/);
  expect(String(failed)).toMatch(/no such module here/);
  // the arguments' block is freed; the thread block stays for the joiner
  expect(T.heapStats().freed - before.freed).toBeGreaterThanOrEqual(1);
});

it('a module that loads is loaded once, and the thread is prepared', async () => {
  let loads = 0;
  own.setModuleLoader(async () => {
    loads++;
  });
  const a = own.spawn(noop, 1),
    b = own.spawn(noop, 2);
  expect(await runtime.$prepare(a.t)).toBeNull();
  expect(await runtime.$prepare(b.t)).toBeNull();
  expect(loads).toBe(1);
});
