// The runtime on a thread that cannot block, as a page's main thread cannot:
// Atomics.wait throws as the runtime loads, so it takes the thread for one.
// atomic.wait there refuses before it waits, naming the alternative, and the
// thread is left as it was; so do join() and scope(), with a TypeError, and a
// channel's recvOk as its recv does
import {afterAll, expect, it} from 'vite-plus/test';

const atomics = Atomics as unknown as {wait: typeof Atomics.wait};
const wait = atomics.wait;
let waits = 0;
atomics.wait = (() => {
  waits++;
  throw new TypeError('Atomics.wait cannot be called in this context');
}) as typeof Atomics.wait;
afterAll(() => {
  atomics.wait = wait;
});

const g = globalThis as {__escapeSab?: SharedArrayBuffer};
g.__escapeSab = new SharedArrayBuffer(16 << 20);
const runtime = await import('./runtime.ts');
runtime.attach(
  g.__escapeSab,
  {},
  () => {},
  () => {},
);
runtime.threadBegin(1);
const T = await import('./threads.ts');

it('atomic.wait refuses on a thread that cannot block, before it waits', () => {
  expect(runtime.CAN_BLOCK).toBe(false);
  const QS_1 = 2048 + 8 + 5, // thread 1's quiescent state (T_QS of its entry)
    IDLE = 1;
  const W = T.struct({n: T.i32}, 'Waited');
  const w = new W();
  const before = waits;
  expect(() => T.atomic.wait(w, 'n', 0, 0)).toThrow(
    /atomic\.wait\(\) would block the page's main thread/,
  );
  expect(waits).toBe(before); // refused before Atomics.wait
  expect(runtime.I32[QS_1]).not.toBe(IDLE); // left running
});

function noop() {}

it('join() and scope() refuse on a thread that cannot block, with a TypeError', () => {
  T.fns({noop});
  const th = T.spawn(noop); // queued: no worker runs it
  expect(() => th.join()).toThrow(TypeError);
  expect(() => th.join()).toThrow(
    /join\(\) would block the page's main thread, which cannot block: use await joinAsync\(\)/,
  );
  expect(() => T.scope(() => {})).toThrow(TypeError);
});

it("a channel's recvOk refuses there, naming recvOkAsync", async () => {
  const ch = new T.Channel(1);
  await ch.sendAsync(1);
  expect(() => ch.recvOk()).toThrow(
    /a channel's recvOk\(\) would block the page's main thread, which cannot block: use await recvOkAsync\(\)/,
  );
  expect(await ch.recvOkAsync()).toStrictEqual([1, true]); // left in the channel
});
