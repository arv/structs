// own.ts on one thread: moving values, shared structs and SharedArrays (as
// code with its types only erased uses them), atomic operations, reference
// counts, and the rest.
import {beforeAll, describe, expect, it} from 'vite-plus/test';
import {logged, own, runtime, threads as T} from './test-heap.ts';

// what a thread's argument, its result or a channel's message goes through
const move = (v: unknown) => {
  const [a, bytes] = own.__message(v);
  return own.__unmessage(a, bytes);
};

describe('moving values', () => {
  it('copies what it moves', () => {
    const v = () => ({
      n: 1.5,
      s: 'héllo 😀',
      a: [1, 'two', {three: 3}],
      t: true,
      f: false,
      nothing: null,
      long: 'x'.repeat(300),
      repeated: ['same', 'same', 'same'],
    });
    expect(move(v())).toEqual(v());
  });

  it('keeps numbers as they are', () => {
    expect(Object.is(move(-0), -0)).toBe(true);
    expect(move(NaN)).toBeNaN();
    expect(move(Infinity)).toBe(Infinity);
    expect(move(2 ** 53)).toBe(2 ** 53);
    expect(move(undefined)).toBeUndefined();
  });

  it('revokes what the sender moved', () => {
    const v = {a: 1};
    move(v);
    expect(() => v.a).toThrow(/used after move/);
  });

  it('sends only plain objects and arrays', () => {
    expect(() => own.__message(new Map())).toThrow(/plain objects and arrays/);
    expect(() => own.__message(1n)).toThrow(/cannot send a bigint/);
    expect(() => own.__message(() => {})).toThrow(/cannot send a function/);
  });

  it('shares a value frozen, deeply', () => {
    const shared = T.share({a: [1, {b: 2}]});
    expect(Object.isFrozen(shared)).toBe(true);
    expect(Object.isFrozen(shared.a[1])).toBe(true);
    expect(move(shared)).toEqual({a: [1, {b: 2}]});
  });
});

describe('shared structs', () => {
  interface P {
    x: number;
    n: number;
    b: boolean;
    s: string;
    u: number;
    next: P | null;
  }
  const P = T.struct(
    {x: T.f64, n: T.i32, b: T.bool, s: T.str, u: T.u8, next: T.ref<P>()},
    'P',
  );

  it('start zeroed', () => {
    const p = new P();
    expect([p.x, p.n, p.b, p.s, p.u, p.next]).toEqual([
      0,
      0,
      false,
      '',
      0,
      null,
    ]);
  });

  it('keep their fields', () => {
    const p = new P();
    p.x = 1.5;
    p.b = true;
    p.s = 'hi';
    p.next = new P();
    p.next.x = 2;
    expect([p.x, p.b, p.s, p.next.x, p.next.next]).toEqual([
      1.5,
      true,
      'hi',
      2,
      null,
    ]);
  });

  it('wrap i32s and u8s as Int32Array and Uint8Array do', () => {
    const p = new P();
    p.n = 2 ** 31;
    expect(p.n).toBe(-(2 ** 31));
    p.u = 256 + 7;
    expect(p.u).toBe(7);
    p.u = -1;
    expect(p.u).toBe(255);
  });
});

describe('SharedArrays', () => {
  it('hold each kind of element', () => {
    const ints = new T.SharedArray(T.i32, 3);
    ints[0] = 2 ** 31 + 5;
    expect([ints.length, ints[0], ints[1]]).toEqual([3, -(2 ** 31) + 5, 0]);
    const bytes = new T.SharedArray(T.u8, 2);
    bytes[0] = 300;
    expect(bytes[0]).toBe(44);
    const flags = new T.SharedArray(Boolean, 2);
    flags[1] = true;
    expect([flags[0], flags[1]]).toEqual([false, true]);
    const names = new T.SharedArray(String, 2);
    names[0] = 'a';
    expect([names[0], names[1]]).toEqual(['a', '']);
    const P = T.struct({x: T.f64}, 'Q');
    const points = new T.SharedArray(P, 2);
    points[1].x = 3;
    expect([points[0].x, points[1].x]).toEqual([0, 3]);
  });

  it('throw on an index out of range', () => {
    const a = new T.SharedArray(Number, 3);
    expect(() => a[3]).toThrow(RangeError);
    expect(() => {
      a[3] = 1;
    }).toThrow(RangeError);
  });
});

describe('atomic operations', () => {
  const W = T.struct({next: T.i32, f: T.f64}, 'W');

  it('act on an i32 field', () => {
    const w = new W();
    expect(T.atomic.add(w, 'next', 1)).toBe(0);
    expect(T.atomic.add(w, 'next', 1)).toBe(1);
    expect(T.atomic.load(w, 'next')).toBe(2);
    expect(T.atomic.compareExchange(w, 'next', 2, 10)).toBe(2);
    expect(w.next).toBe(10);
  });

  it('act on an element of a SharedArray<i32>', () => {
    const a = new T.SharedArray(T.i32, 2);
    expect(T.atomic.add(a, 1, 5)).toBe(0);
    expect(a[1]).toBe(5);
  });

  it('refuse a field that is not an i32', () => {
    expect(() => T.atomic.add(new W(), 'f', 1)).toThrow(/i32 field/);
  });
});

describe('reference counts', () => {
  // as compiled code counts: a struct is an address, owned (+1) when new
  const N = own.__sharedStruct('N', ['v', 'next'], [1]);
  // the i32 index of field `next`
  const next: (a: number) => number = a => (a >> 2) + 2 + 2 * 1;

  it('free a struct, and what it refers to, at count 0', () => {
    const before = T.heapStats();
    const a = own.__newStruct(N),
      b = own.__newStruct(N);
    own.__store(next(a), b); // a.next = b, taking over b's count
    own.__release(a);
    const after = T.heapStats();
    expect(after.allocated - before.allocated).toBe(2);
    expect(after.freed - before.freed).toBe(2);
  });

  it('keep a struct while something holds it', () => {
    const before = T.heapStats();
    const a = own.__newStruct(N);
    own.__retain(a);
    own.__release(a);
    expect(T.heapStats().freed - before.freed).toBe(0);
    own.__release(a);
    expect(T.heapStats().freed - before.freed).toBe(1);
  });

  it('intern strings: one copy each', () => {
    expect(runtime.$internRef('abc')).toBe(runtime.$internRef('abc'));
    expect(own.__str(runtime.$internFind('abc'))).toBe('abc');
  });
});

describe('strings are collected', () => {
  // live blocks, after every deferred decrement and free has been worked off
  const live = () => {
    own.__collect();
    const s = T.heapStats();
    return s.allocated - s.freed;
  };
  // as compiled code stores them: a str field at i32 index (a >> 2) + 2
  const S = own.__sharedStruct('Named', ['name'], [], 's');

  it('a field holds a count on its string, and gives it back', () => {
    const a = own.__newStruct(S),
      before = live();
    for (let i = 0; i < 2000; i++) {
      own.__storeStr((a >> 2) + 2, `name ${i} ${'é'.repeat(i % 3)}`);
      expect(own.__str(runtime.I32[(a >> 2) + 2])).toBe(
        `name ${i} ${'é'.repeat(i % 3)}`,
      );
    }
    expect(live()).toBe(before + 1); // the last one
    own.__storeStr((a >> 2) + 2, '');
    expect(live()).toBe(before);
    own.__storeStr((a >> 2) + 2, 'one more, unique to this test');
    own.__release(a); // the struct goes, and with it its string
    expect(live()).toBe(before - 1);
  });

  it('a SharedArray<string> holds counts on its strings', () => {
    const before = live(),
      xs = new T.SharedArray(String, 100);
    for (let round = 0; round < 20; round++)
      for (let i = 0; i < 100; i++) xs[i] = `element ${round}.${i}`;
    expect(xs[42]).toBe('element 19.42');
    expect(live()).toBe(before + 1 + 100); // the array, its strings
    for (let i = 0; i < 100; i++) xs[i] = '';
    expect(live()).toBe(before + 1);
  });

  it('a message holds counts on its strings and keys until it is read', () => {
    const a = own.__newStruct(S);
    own.__storeStr((a >> 2) + 2, 'known here'); // sent by address
    const before = live();
    for (let i = 0; i < 1000; i++) {
      const sent = {[`key ${i}`]: 'known here', [`other ${i}`]: [`text ${i}`]};
      const [p, bytes] = own.__message(sent);
      expect(own.__unmessage(p, bytes)).toEqual({
        [`key ${i}`]: 'known here',
        [`other ${i}`]: [`text ${i}`],
      });
    }
    expect(live()).toBe(before);
    own.__release(a);
  });

  it('a pinned string stays, counted or not', () => {
    const counted = runtime.$internRef('pinned later, unique to this test'),
      pinned = runtime.$intern('pinned, unique to this test');
    expect(runtime.$intern('pinned later, unique to this test')).toBe(counted);
    own.__release(counted);
    own.__release(runtime.$internRef('pinned, unique to this test'));
    live();
    expect(runtime.$internFind('pinned later, unique to this test')).toBe(
      counted,
    );
    expect(runtime.$internFind('pinned, unique to this test')).toBe(pinned);
  });

  it('an address a string left is never that string again', () => {
    for (let i = 0; i < 200; i++) {
      const a = runtime.$internRef(`gone ${i}`);
      expect(runtime.$str(a)).toBe(`gone ${i}`); // now cached here
      own.__release(a);
      own.__collect();
      expect(runtime.$internFind(`gone ${i}`)).toBe(0);
      const b = runtime.$internRef(`new ${i}`); // the same block, often
      expect(runtime.$str(b)).toBe(`new ${i}`);
      own.__release(b);
    }
  });
});

describe('the rest', () => {
  beforeAll(() => {
    logged.length = 0;
  });

  it('a lock is held until its hold is disposed', async () => {
    const lock = new T.Lock();
    {
      using _ = lock.hold();
    }
    // released at the end of the block, even after a throw
    expect(() => {
      using _ = lock.hold();
      throw new Error('inside');
    }).toThrow('inside');
    {
      using _ = await lock.holdAsync();
    }
    // disposing a hold twice releases the lock once: not someone else's hold
    const state = () =>
      runtime.I32[((lock as unknown as {$cell: number}).$cell >> 2) + 1];
    const first = lock.hold();
    first[Symbol.dispose]();
    const second = lock.hold();
    first[Symbol.dispose]();
    expect(state()).toBe(1);
    second[Symbol.dispose]();
    expect(state()).toBe(0);
  });

  it('a condition wakes a thread that waits, which holds the lock again', async () => {
    const lock = new T.Lock(),
      changed = new T.Condition();
    let ready = false;
    setTimeout(() => {
      ready = true;
      changed.notifyAll();
    }, 5);
    {
      using _ = await lock.holdAsync();
      while (!ready) await changed.waitAsync(lock);
    }
    expect(ready).toBe(true);
    // the lock is free again
    using _ = lock.hold();
  });

  it('log writes a line', () => {
    T.log('hello', 1);
    expect(logged).toEqual(['hello 1\n']);
  });
});
