// the pool's ring of threads waiting for a worker, on one thread (nothing takes
// them): what happens when it is full
import {describe, expect, it} from 'vite-plus/test';
import {own, runtime, threads as T} from './test-heap.ts';

// the control words, as runtime.ts lays them out
const C_RING_HEAD = 8,
  C_RING_TAIL = 9,
  C_PENDING = 10,
  C_LIVE = 13,
  C_AQ_LEN = 28,
  RING = 1024;
const word = (i: number) => Atomics.load(runtime.I32, i);
// how many threads wait: the counters wrap, so their difference as an i32
const waiting = () => (word(C_RING_TAIL) - word(C_RING_HEAD)) | 0;
// live blocks of the heap
const live = () => {
  const s = T.heapStats();
  return s.allocated - s.freed;
};

function noop() {}
async function asyncNoop() {}

describe('the ring', () => {
  it('refuses a thread when it is full, and is as it was', () => {
    own.fns({noop, asyncNoop});
    // the counters are about to wrap: a full ring must still be one
    Atomics.store(runtime.I32, C_RING_HEAD, 0x7ffffffd);
    Atomics.store(runtime.I32, C_RING_TAIL, 0x7ffffffd);
    for (let i = 0; i < RING; i++) own.spawn(noop);
    expect(word(C_RING_TAIL)).toBeLessThan(0); // wrapped
    expect(waiting()).toBe(RING);
    const before = live();
    expect(() => own.spawn(noop)).toThrow(/too many threads waiting/);
    // no slot was claimed for the thread refused (a worker would wait on it
    // for good), it is not counted live (main would wait for it for good),
    // and its block and its arguments are freed
    expect(waiting()).toBe(RING);
    expect(word(C_PENDING)).toBe(RING);
    expect(word(C_LIVE)).toBe(RING);
    expect(live()).toBe(before);
  });

  it('refuses an async thread it cannot draft a host for, and takes it back', () => {
    const before = live();
    expect(() => own.spawn(asyncNoop)).toThrow(/too many threads waiting/);
    expect(word(C_AQ_LEN)).toBe(0); // not queued for a host
    expect(word(C_LIVE)).toBe(RING);
    expect(live()).toBe(before);
  });
});
