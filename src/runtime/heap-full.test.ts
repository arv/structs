// the runtime when the shared heap is full: what allocates throws a
// RangeError, with no lock held, so that the thread reports it and the others
// go on; what was being changed is as it was; and what the change was given
// is given back
import {describe, expect, it} from 'vite-plus/test';
import {own, runtime, threads as T} from './test-heap.ts';

// takes every byte: the big allocations, then the rest of this thread's chunk
const fill = () => {
  for (const bytes of [1 << 20, 8])
    for (;;) {
      try {
        runtime.$alloc(bytes);
      } catch {
        break;
      }
    }
};
// a struct's count
const count = (a: number) => runtime.I32[(a >> 2) + 1];
// a struct as compiled code passes it: with a count for the map
const ref = (p: number) => own.countedRef(p) as unknown as number;
// the string table: [kind][capacity][used]... at C_STR_TABLE
const table = () => runtime.I32[14],
  used = () => runtime.I32[(table() >> 2) + 2],
  capacity = () => runtime.I32[(table() >> 2) + 1];
// thread 2's entry in the thread table (C_THREADS + 2 * T_ENTRY): [alive]...
const ALIVE_2 = 2048 + 2 * 8;
// a string of 30 chars: a block of 56 bytes, which no other string here needs
const THIRTY = 'the-2049th-string-of-the-table';

describe('a full heap', () => {
  const N = own.sharedStruct('Full', ['v'], []),
    R = own.sharedStruct('FullRef', ['next'], [0]);
  let known = 0,
    a = 0,
    b = 0,
    c = 0,
    d = 0;
  let m: InstanceType<typeof T.SharedMap<number, number>>,
    s: InstanceType<typeof T.SharedSet<number>>;

  it('is filled, once what the tests need is made', () => {
    known = runtime.$internRef('known before the heap filled');
    m = new T.SharedMap<number, number>();
    s = new T.SharedSet<number>();
    for (let i = 0; i < 8; i++) {
      m.set(i, i); // the first table's capacity: the next entry needs a bigger one
      s.add(i);
    }
    a = own.newStruct(N);
    b = own.newStruct(N);
    c = own.newStruct(R);
    d = own.newStruct(R);
    own.store((c >> 2) + 2, d); // c.next = d, taking over d's count
    // strings until one more would need a bigger table; the last of them
    // freed, so that the next one of its size has a block to take (a size, 30
    // chars, no other string of these tests has)
    for (let i = 0; used() < capacity() / 2 - 1; i++)
      runtime.$internRef(`filler-${String(i).padStart(4, '0')}`);
    own.release(runtime.$internRef(THIRTY.replace('-', '+')));
    expect(used()).toBe(capacity() / 2);
    own.__collect();
    fill();
  });

  it('throws, holds no lock, and leaves a map as it was', () => {
    expect(() => runtime.$internRef('a new string')).toThrow(RangeError);
    // the string lock was released: not a hang
    expect(() => runtime.$internRef('another new string')).toThrow(RangeError);
    expect(runtime.$internRef('known before the heap filled')).toBe(known);
    expect(() => m.set(8, 8)).toThrow(RangeError);
    expect(() => s.add(8)).toThrow(RangeError);
    expect(() => m.clear()).toThrow(RangeError);
    expect(() => s.clear()).toThrow(RangeError);
    // the maps' locks were released, and their entries are as they were
    expect(m.size).toBe(8);
    expect(m.get(3)).toBe(3);
    m.set(3, 30);
    expect(m.get(3)).toBe(30);
    expect([...m.keys()]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(s.size).toBe(8);
    expect(s.has(7)).toBe(true);
    expect(s.delete(7)).toBe(true);
    expect(s.size).toBe(7);
  });

  it('gives back the counts a map could not take', () => {
    expect([count(a), count(b)]).toEqual([1, 1]);
    expect(() => m.set(ref(a), ref(b))).toThrow(RangeError);
    expect([count(a), count(b)]).toEqual([1, 1]);
    expect(() => m.getOrInsert(ref(a), ref(b))).toThrow(RangeError);
    expect([count(a), count(b)]).toEqual([1, 1]);
    expect(() => s.add(ref(a))).toThrow(RangeError);
    expect(count(a)).toBe(1);
  });

  it('shares nothing, and takes no count, when the value does not fit', () => {
    const o = {name: 'known before the heap filled', inner: {n: 1}},
      c0 = count(known); // the string's count: a share would take one
    expect(() => T.share(o)).toThrow(RangeError);
    expect([Object.isFrozen(o), Object.isFrozen(o.inner)]).toEqual([
      false,
      false,
    ]);
    expect(count(known)).toBe(c0);
    // a map's key that cannot be shared: the value's count goes back too
    const k = {} as unknown as number;
    expect(() => m.set(k, ref(b))).toThrow(RangeError);
    expect(Object.isFrozen(k)).toBe(false);
    expect(count(b)).toBe(1);
    expect(() => m.getOrInsert(k, ref(b))).toThrow(RangeError);
    expect(count(b)).toBe(1);
  });

  it('adds no string its table has no room for', () => {
    // the string's block is there (a freed one of its size); the bigger table
    // is not
    expect(THIRTY.length).toBe(30);
    expect(() => runtime.$internRef(THIRTY)).toThrow(RangeError);
    expect(runtime.$internFind(THIRTY)).toBe(0);
  });

  it('ends a thread whose queued decrements it cannot hand off', () => {
    runtime.threadBegin(2);
    own.store((c >> 2) + 2, 0); // d's decrement waits for every thread's next point
    expect(runtime.I32[ALIVE_2]).toBe(1);
    runtime.threadEnd(); // the shared list cannot grow: the queue stays this worker's
    expect(runtime.I32[ALIVE_2]).toBe(0); // not alive for good, holding up freeing
    runtime.threadBegin(1);
  });
});
