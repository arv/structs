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

  it('keeps an own "__proto__" key a key', () => {
    // JSON.parse makes one; in an object literal it would set the prototype
    const v = JSON.parse('{"__proto__": {"polluted": true}, "x": 1}') as object;
    const r = move(v) as Record<string, unknown>;
    expect(Object.hasOwn(r, '__proto__')).toBe(true);
    expect(r['__proto__']).toEqual({polluted: true});
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
    expect(r.x).toBe(1);
  });

  it('revokes what the sender moved', () => {
    const v = {a: 1};
    move(v);
    expect(() => v.a).toThrow(/used after move/);
  });

  it('lets go of the buffer a large value grew, once it is written', () => {
    const large = {s: 'x'.repeat(1 << 20), n: Array.from({length: 1000})};
    expect(move(large)).toEqual({
      s: 'x'.repeat(1 << 20),
      n: Array.from({length: 1000}),
    });
    // the megabyte grew the buffer past 64K words (512 KiB): it is not kept
    expect(own.__writeBufferWords()).toBeLessThanOrEqual(1 << 16);
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

  it('rejects reentrant writes before they can corrupt the outer value', () => {
    const H = T.struct({n: T.f64}, 'ReentrantWrite'),
      handle = new H(),
      refs = () => runtime.I32[(handle.$cell >> 2) + 1];
    for (const outer of [move, T.share])
      for (const inner of [move, T.share]) {
        const nested = {inner: 1},
          value = [
            123,
            handle,
            {
              get x() {
                inner(nested);
                return 42;
              },
            },
          ],
          before = refs();
        expect(() => outer(value)).toThrow(/already serializing/);
        // Failed writes neither move nor freeze their input, and return the
        // counts they took before the getter ran.
        expect(value[0]).toBe(123);
        expect(Object.isFrozen(value)).toBe(false);
        expect(Object.isFrozen(nested)).toBe(false);
        expect(nested.inner).toBe(1);
        expect(refs()).toBe(before);
        expect(move([123, {x: 42}])).toEqual([123, {x: 42}]);
      }
  });

  it('keeps the outer move depth when a getter catches a reentrant write', () => {
    const nested = {inner: {n: 1}};
    let failure: unknown;
    const value = {
      get x() {
        try {
          own.__message({n: 2}, 1);
        } catch (e) {
          failure = e;
        }
        return nested;
      },
    };
    expect(move(value)).toEqual({x: {inner: {n: 1}}});
    expect(failure).toBeInstanceOf(TypeError);
    // Only value itself moves: the rejected write's depth 1 must not cause
    // nested to be revoked as well.
    expect(nested.inner.n).toBe(1);
  });

  it('reclaims thread blocks and arguments of rejected reentrant spawns', () => {
    function reentrantSpawn(value: number) {
      return value;
    }
    own.register(import.meta.url, {reentrantSpawn});
    const N = own.sharedStruct('ReentrantSpawnArgument', ['n']),
      a = own.newStruct(N),
      pool = runtime.counters(globalThis.__escapeSab!);
    try {
      for (let i = 0; i < 32; i++) {
        const value = {
          get x() {
            const before = T.heapStats();
            expect(() => own.spawn(reentrantSpawn, own.countedRef(a))).toThrow(
              /already serializing/,
            );
            const after = T.heapStats();
            expect(after.allocated - before.allocated).toBe(1);
            expect(after.freed - before.freed).toBe(1);
            expect(runtime.I32[(a >> 2) + 1]).toBe(1);
            return 42;
          },
        };
        expect(move([123, value])).toEqual([123, {x: 42}]);
      }
      expect(runtime.counters(globalThis.__escapeSab!)).toMatchObject({
        live: pool.live,
        queued: pool.queued,
      });
    } finally {
      own.release(a);
    }
  });

  it('continues spawn rollback after a proxy throws on a prototype check', () => {
    function proxySpawn(value: unknown, address: number) {
      return [value, address];
    }
    own.register(import.meta.url, {proxySpawn});
    const N = own.sharedStruct('ProxyRollbackArgument', ['n']),
      a = own.newStruct(N),
      proxy = new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error('prototype trap');
          },
        },
      );
    try {
      const value = {
        get x() {
          const before = T.heapStats();
          expect(() => own.spawn(proxySpawn, proxy, own.countedRef(a))).toThrow(
            /already serializing/,
          );
          const after = T.heapStats();
          expect(after.allocated - before.allocated).toBe(1);
          expect(after.freed - before.freed).toBe(1);
          expect(runtime.I32[(a >> 2) + 1]).toBe(1);
          return 42;
        },
      };
      expect(move([123, value])).toEqual([123, {x: 42}]);
    } finally {
      own.release(a);
    }
  });

  it('preserves the serialization error when a proxy also throws during rollback', () => {
    const original = new Error('original prototype error');
    let calls = 0;
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          if (++calls === 1) throw original;
          throw new Error('rollback prototype error');
        },
      },
    );
    let failure: unknown;
    try {
      own.__message(proxy);
    } catch (e) {
      failure = e;
    }
    expect(failure).toBe(original);
    expect(move({after: 42})).toEqual({after: 42});
  });

  it('propagates errors from an array proxy during normal serialization', () => {
    const original = new Error('second prototype lookup');
    for (const reentrant of [false, true]) {
      let calls = 0;
      const proxy = new Proxy([123], {
        getPrototypeOf() {
          if (++calls === 2) {
            if (reentrant) T.share({nested: 1});
            throw original;
          }
          return {};
        },
      });
      expect(() => move(proxy)).toThrow(
        reentrant ? /already serializing/ : original,
      );
      expect(move([123, {after: 42}])).toEqual([123, {after: 42}]);
    }
  });

  it('preserves the original error when a counted proxy address getter throws', () => {
    const N = own.sharedStruct('ThrowingMessageAddress', ['n']),
      a = own.newStruct(N),
      counted = own.countedRef(a),
      original = new Error('original address error');
    let reads = 0;
    const proxy = new Proxy(counted, {
      get(target, key, receiver) {
        if (key === 'a') {
          if (++reads === 1) throw original;
          throw new Error('rollback address error');
        }
        return Reflect.get(target, key, receiver);
      },
    });
    let failure: unknown;
    try {
      try {
        own.__message(proxy);
      } catch (e) {
        failure = e;
      }
      expect(failure).toBe(original);
      expect(move({after: 42})).toEqual({after: 42});
    } finally {
      // The proxy hides its count's address; its original wrapper still owns it.
      own.release(counted.a);
      own.release(a);
    }
  });

  it('continues spawn rollback after a counted proxy address getter throws', () => {
    function addressProxySpawn(value: unknown, address: number) {
      return [value, address];
    }
    own.register(import.meta.url, {addressProxySpawn});
    const N = own.sharedStruct('ThrowingSpawnAddress', ['n']),
      a = own.newStruct(N),
      b = own.newStruct(N),
      counted = own.countedRef(a),
      proxy = new Proxy(counted, {
        get(target, key, receiver) {
          if (key === 'a') throw new Error('rollback address error');
          return Reflect.get(target, key, receiver);
        },
      });
    try {
      const value = {
        get x() {
          const before = T.heapStats();
          expect(() =>
            own.spawn(addressProxySpawn, proxy, own.countedRef(b)),
          ).toThrow(/already serializing/);
          const after = T.heapStats();
          expect(after.allocated - before.allocated).toBe(1);
          expect(after.freed - before.freed).toBe(1);
          expect(runtime.I32[(b >> 2) + 1]).toBe(1);
          return 42;
        },
      };
      expect(move([123, value])).toEqual([123, {x: 42}]);
    } finally {
      own.release(counted.a);
      own.release(a);
      own.release(b);
    }
  });

  it('reclaims shared blobs when a freeze trap attempts a reentrant write', () => {
    const key = 'reentrantFreezePayload',
      name = runtime.$internRef(key);
    try {
      for (const traps of [
        {
          preventExtensions() {
            T.share({nested: 1});
            return false;
          },
        },
        {
          defineProperty() {
            T.share({nested: 1});
            return false;
          },
        },
      ])
        for (let i = 0; i < 32; i++) {
          const value = new Proxy({[key]: 123}, traps),
            before = T.heapStats();
          expect(() => T.share(value)).toThrow(/already serializing/);
          const after = T.heapStats();
          expect(after.allocated - before.allocated).toBe(1);
          expect(after.freed - before.freed).toBe(1);
          expect(runtime.I32[(name >> 2) + 1]).toBe(1);
        }
      expect(move([123, {x: 42}])).toEqual([123, {x: 42}]);
    } finally {
      own.release(name);
    }
  });

  it('returns counted arguments when reentrant channel sends fail', async () => {
    const N = own.sharedStruct('ReentrantChannelArgument', ['n']),
      a = own.newStruct(N),
      ch = new T.Channel(1);
    try {
      for (const async of [false, true]) {
        let failure: Promise<unknown> | undefined;
        const value = {
          get x() {
            if (async)
              failure = ch
                .sendAsync(own.countedRef(a))
                .catch((e: unknown) => e);
            else
              expect(() => ch.send(own.countedRef(a))).toThrow(
                /already serializing/,
              );
            return 42;
          },
        };
        expect(move([123, value])).toEqual([123, {x: 42}]);
        if (async) expect(await failure).toBeInstanceOf(TypeError);
        expect(runtime.I32[(a >> 2) + 1]).toBe(1);
        await ch.sendAsync(7);
        expect(await ch.recvAsync()).toBe(7);
      }
    } finally {
      own.release(a);
    }
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

  it('declared again are the type declared first', () => {
    // the same name and layout, the same kind: the handles made before are
    // instances of the type, and box gives them back
    const A = T.struct({x: T.f64}, 'Again');
    const p = new A();
    const B = T.struct({x: T.f64}, 'Again');
    expect(B).toBe(A);
    expect(p).toBeInstanceOf(B);
    expect(own.box(p.$cell)).toBe(p);
  });

  it('declared after a struct of their kind was boxed are its type', () => {
    // a struct another thread made, of a type this one has not declared: box
    // declares it from its layout, and a declaration here is that type
    const layout = 'struct ["Elsewhere",["v"],[],""]';
    const a = own.newStruct({
      kind: runtime.$intern(layout),
      size: 16,
    } as Parameters<typeof own.newStruct>[0]);
    const h = own.box(a)!;
    const E = own.sharedStruct('Elsewhere', ['v']);
    expect(h).toBeInstanceOf(E);
    expect(Object.getPrototypeOf(h)).toBe(E.prototype);
    own.release(a);
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

  it('are instances of SharedArray, made new or boxed', () => {
    const P = T.struct({x: T.f64}, 'Elements');
    for (const type of [Number, Boolean, String, T.i32, T.u8, P])
      expect(new T.SharedArray(type, 3)).toBeInstanceOf(T.SharedArray);
    // a compiled SharedArray is an address; boxed, it is the same
    const a = own.newSharedArray(8, 2);
    expect(own.box(a)).toBeInstanceOf(T.SharedArray);
    expect([...(own.box(a) as unknown as Iterable<number>)]).toEqual([0, 0]);
    own.release(a);
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
  const N = own.sharedStruct('N', ['v', 'next'], [1]);
  // the i32 index of field `next`
  const next: (a: number) => number = a => (a >> 2) + 2 + 2 * 1;

  it('free a struct, and what it refers to, at count 0', () => {
    const before = T.heapStats();
    const a = own.newStruct(N),
      b = own.newStruct(N);
    own.store(next(a), b); // a.next = b, taking over b's count
    own.release(a);
    const after = T.heapStats();
    expect(after.allocated - before.allocated).toBe(2);
    expect(after.freed - before.freed).toBe(2);
  });

  it('keep a struct while something holds it', () => {
    const before = T.heapStats();
    const a = own.newStruct(N);
    own.retain(a);
    own.release(a);
    expect(T.heapStats().freed - before.freed).toBe(0);
    own.release(a);
    expect(T.heapStats().freed - before.freed).toBe(1);
  });

  it('a worker nudges a page that holds up freeing', () => {
    // a page (browser.ts) passes a quiescent point when a worker posts it a
    // nudge, and frees what that makes safe. this test is the worker, thread
    // 2, and the page, thread 1, in turn
    const posted: unknown[] = [];
    const nudges = () =>
      posted.filter(m => (m as {type: string}).type === 'nudge').length;
    runtime.attach(
      globalThis.__escapeSab!,
      {nudge: true},
      m => posted.push(m),
      text => logged.push(text),
    );
    runtime.$nudged(); // the page is at a point of its own
    // the worker: a decrement held up by the page's point, and its thread ends
    runtime.threadBegin(2);
    const a = own.newStruct(N),
      b = own.newStruct(N);
    own.store(next(a), b); // a.next = b
    own.store(next(a), 0); // b's decrement waits for every thread's next point
    runtime.threadEnd(); // held up: one nudge, and the queue to the shared list
    expect(nudges()).toBe(1);
    expect(runtime.I32[b >> 2]).toBe(N.kind); // not freed
    // the page gets the nudge: a point, and b is freed from the shared list
    runtime.threadBegin(1);
    runtime.$nudged();
    expect(runtime.I32[b >> 2]).toBe(runtime.K_FREE);
    // more, after the page's point: a nudge of its own, not dropped for the last
    runtime.threadBegin(2);
    const c = own.newStruct(N);
    own.store(next(a), c);
    own.store(next(a), 0);
    runtime.threadEnd();
    expect(nudges()).toBe(2);
    runtime.threadBegin(1);
    runtime.$nudged();
    expect(runtime.I32[c >> 2]).toBe(runtime.K_FREE);
    own.release(a);
    runtime.attach(
      globalThis.__escapeSab!,
      {},
      () => {},
      text => logged.push(text),
    );
  });

  it('a thread ending nudges a page that is not behind, for what it hands off', () => {
    // the page passes a point between the worker's reclaim and its hand-off
    // (here: as it gets the nudge of the reclaim, in the message callback):
    // what the worker then hands off is safe already, and the page's to free,
    // though it is not behind. one nudge more, for that
    const posted: unknown[] = [];
    const nudges = () =>
      posted.filter(m => (m as {type: string}).type === 'nudge').length;
    let asPage: (() => void) | null = null;
    runtime.attach(
      globalThis.__escapeSab!,
      {nudge: true},
      m => {
        posted.push(m);
        if (m.type === 'nudge' && asPage !== null) {
          const f = asPage;
          asPage = null;
          f();
        }
      },
      text => logged.push(text),
    );
    runtime.$nudged(); // the page is at a point of its own
    runtime.threadBegin(2);
    const a = own.newStruct(N),
      b = own.newStruct(N);
    // 2048 decrements of b wait for every thread's next point: the queue's
    // length at which a reclaim nudges (its growth brought the reclaim on)
    for (let k = 0; k < 2048; k++) {
      own.store(next(a), b);
      own.store(next(a), 0);
    }
    asPage = () => {
      // the page's point, its word alone: a reclaim of its own here, on the
      // test's one thread, would work off the worker's queue as the page's
      runtime.threadBegin(1);
      runtime.threadBegin(2);
    };
    runtime.threadEnd(); // a nudge for the reclaim, and one for the hand-off
    expect(nudges()).toBe(2);
    expect(runtime.I32[b >> 2]).toBe(N.kind); // handed off after the point
    runtime.threadBegin(1);
    runtime.$nudged();
    expect(runtime.I32[b >> 2]).toBe(runtime.K_FREE);
    own.release(a);
    runtime.attach(
      globalThis.__escapeSab!,
      {},
      () => {},
      text => logged.push(text),
    );
  });

  it('a nudge that gets to a stopped page leaves it waiting', () => {
    // browser.ts stop(): the page waits, for good or until start(). a nudge a
    // worker posted before gets there after: the page frees what is safe of
    // the shared list, and waits on, as a thread that holds nothing up
    const QS_1 = 2048 + 8 + 5, // thread 1's quiescent state (T_QS of its entry)
      QS_3 = 2048 + 3 * 8 + 5,
      EPOCH = 17, // C_EPOCH
      NEXT_TID = 4, // C_NEXT_TID
      IDLE = 1;
    // threads 2 and 3 are to count as running: the tests' threadBegin(n) does
    // not claim n as a worker does, from the counter the scan goes up to
    if (Atomics.load(runtime.I32, NEXT_TID) < 4)
      Atomics.store(runtime.I32, NEXT_TID, 4);
    runtime.attach(
      globalThis.__escapeSab!,
      {nudge: true},
      () => {},
      text => logged.push(text),
    );
    runtime.$nudged(); // the page is at a point of its own
    runtime.threadBegin(3); // a worker in a long thread, at this point
    runtime.threadBegin(2);
    const a = own.newStruct(N),
      b = own.newStruct(N);
    own.store(next(a), b);
    own.store(next(a), 0);
    runtime.threadEnd(); // b's decrement to the shared list, held up by 3
    runtime.threadBegin(1);
    runtime.$stopped(); // stop()
    expect(runtime.I32[QS_1]).toBe(IDLE);
    expect(runtime.I32[b >> 2]).toBe(N.kind);
    // thread 3 passes a point (one that reclaims nothing), and the nudge of
    // thread 2's end gets to the page
    Atomics.store(runtime.I32, QS_3, Atomics.load(runtime.I32, EPOCH));
    runtime.$nudged();
    expect(runtime.I32[b >> 2]).toBe(runtime.K_FREE);
    expect(runtime.I32[QS_1]).toBe(IDLE); // waiting still
    runtime.threadBegin(3);
    runtime.threadEnd();
    runtime.threadBegin(1);
    own.release(a);
    runtime.attach(
      globalThis.__escapeSab!,
      {},
      () => {},
      text => logged.push(text),
    );
  });

  it('a reclaim nudges the page for a shared list it alone holds up', () => {
    // thread 2 ends while thread 3 is behind: no nudge, as the page's point
    // would free nothing. thread 3 passes a point and reclaims: the list is
    // the page's to free now, and the reclaim nudges, its own queue empty
    const NEXT_TID = 4; // C_NEXT_TID (see the test below)
    if (Atomics.load(runtime.I32, NEXT_TID) < 4)
      Atomics.store(runtime.I32, NEXT_TID, 4);
    const posted: unknown[] = [];
    const nudges = () =>
      posted.filter(m => (m as {type: string}).type === 'nudge').length;
    runtime.attach(
      globalThis.__escapeSab!,
      {nudge: true},
      m => posted.push(m),
      text => logged.push(text),
    );
    runtime.$nudged(); // the page is at a point of its own
    runtime.threadBegin(3); // a worker in a long thread, at this point
    runtime.threadBegin(2);
    const a = own.newStruct(N),
      b = own.newStruct(N);
    own.store(next(a), b);
    own.store(next(a), 0);
    runtime.threadEnd(); // b's decrement to the shared list, held up by 3
    expect(nudges()).toBe(0);
    runtime.threadBegin(3); // thread 3 at a point
    runtime.$waitBegin(); // its reclaim: the page alone holds the list up
    expect(nudges()).toBe(1);
    expect(runtime.I32[b >> 2]).toBe(N.kind);
    runtime.threadBegin(1);
    runtime.$nudged();
    expect(runtime.I32[b >> 2]).toBe(runtime.K_FREE);
    runtime.threadBegin(3);
    runtime.threadEnd();
    runtime.threadBegin(1);
    own.release(a);
    runtime.attach(
      globalThis.__escapeSab!,
      {},
      () => {},
      text => logged.push(text),
    );
  });

  it('a reclaim nudges the page for a queue that stops growing', () => {
    // a thread defers once, and then computes, deferring no more: its queue
    // never reaches the length at which a reclaim nudges. the second reclaim
    // that finds the queue as it was, held up by the page alone, nudges
    const posted: unknown[] = [];
    const nudges = () =>
      posted.filter(m => (m as {type: string}).type === 'nudge').length;
    runtime.attach(
      globalThis.__escapeSab!,
      {nudge: true},
      m => posted.push(m),
      text => logged.push(text),
    );
    runtime.$nudged(); // the page is at a point of its own
    runtime.threadBegin(2);
    const a = own.newStruct(N),
      b = own.newStruct(N);
    own.store(next(a), b);
    own.store(next(a), 0); // b's decrement waits for every thread's next point
    // the points of a loop that computes: one in every 64 reclaims
    const computes = () => {
      for (let k = 0; k < 64; k++) runtime.$quiescent();
    };
    computes(); // a reclaim: held up, the queue as new; no nudge
    expect(nudges()).toBe(0);
    computes(); // a reclaim: the queue as it was; a nudge
    expect(nudges()).toBe(1);
    expect(runtime.I32[b >> 2]).toBe(N.kind);
    runtime.threadBegin(1);
    runtime.$nudged();
    expect(runtime.I32[b >> 2]).toBe(runtime.K_FREE);
    runtime.threadBegin(2);
    runtime.threadEnd();
    runtime.threadBegin(1);
    own.release(a);
    runtime.attach(
      globalThis.__escapeSab!,
      {},
      () => {},
      text => logged.push(text),
    );
  });

  it('a thread that waits hands what is held up to the shared list, and nudges', () => {
    // a thread about to block (a join, a receive, a lock) passes no point of
    // its own until it wakes, which may be never: what its reclaim could not
    // free, held up by the page here, would stay in its queue, which no other
    // thread works off. it hands the queue to the shared list, as a thread
    // that ends does, and nudges the page, which frees it while the thread
    // waits on
    const QS_2 = 2048 + 2 * 8 + 5, // thread 2's quiescent state (T_QS)
      PEND_LEN = 20, // C_PEND_LEN
      IDLE = 1;
    const posted: unknown[] = [];
    const nudges = () =>
      posted.filter(m => (m as {type: string}).type === 'nudge').length;
    runtime.attach(
      globalThis.__escapeSab!,
      {nudge: true},
      m => posted.push(m),
      text => logged.push(text),
    );
    runtime.$nudged(); // the page is at a point of its own
    runtime.threadBegin(2);
    const a = own.newStruct(N),
      b = own.newStruct(N);
    own.store(next(a), b);
    own.store(next(a), 0); // b's decrement waits for every thread's next point
    const shared = Atomics.load(runtime.I32, PEND_LEN);
    runtime.$waitBegin(); // held up by the page: to the shared list, a nudge
    expect(runtime.I32[QS_2]).toBe(IDLE);
    expect(Atomics.load(runtime.I32, PEND_LEN)).toBe(shared + 1);
    expect(T.heapStats().pending).toBe(shared + 1); // none left in its own
    expect(nudges()).toBe(1);
    expect(runtime.I32[b >> 2]).toBe(N.kind); // not freed yet
    // the page gets the nudge: a point, and b is freed from the shared list
    runtime.threadBegin(1);
    runtime.$nudged();
    expect(runtime.I32[b >> 2]).toBe(runtime.K_FREE);
    expect(Atomics.load(runtime.I32, PEND_LEN)).toBe(shared);
    // the thread wakes, and waits again with nothing queued: no nudge
    runtime.threadBegin(2);
    runtime.$waitEnd();
    runtime.$waitBegin();
    expect(runtime.I32[QS_2]).toBe(IDLE);
    expect(nudges()).toBe(1);
    runtime.$waitEnd();
    runtime.threadEnd();
    runtime.threadBegin(1);
    own.release(a);
    runtime.attach(
      globalThis.__escapeSab!,
      {},
      () => {},
      text => logged.push(text),
    );
  });

  it('the epoch wraps, and reclamation goes on', () => {
    // the epoch is an i32: at the last even value before the wrap, a worker
    // defers, the page passes points, and the decrements are applied though
    // every comparison now crosses the wrap
    const EPOCH = 17; // C_EPOCH
    const posted: unknown[] = [];
    const nudges = () =>
      posted.filter(m => (m as {type: string}).type === 'nudge').length;
    runtime.attach(
      globalThis.__escapeSab!,
      {nudge: true},
      m => posted.push(m),
      text => logged.push(text),
    );
    Atomics.store(runtime.I32, EPOCH, 0x7ffffffe);
    runtime.$nudged(); // the page is at a point of its own, the last before
    runtime.threadBegin(2);
    const a = own.newStruct(N),
      b = own.newStruct(N);
    own.store(next(a), b);
    own.store(next(a), 0);
    runtime.threadEnd(); // its reclaim wraps the epoch; b to the shared list
    expect(Atomics.load(runtime.I32, EPOCH)).toBeLessThan(0);
    expect(nudges()).toBe(1);
    expect(runtime.I32[b >> 2]).toBe(N.kind);
    runtime.threadBegin(1);
    runtime.$nudged(); // past the wrap: b is older than the page's point
    expect(runtime.I32[b >> 2]).toBe(runtime.K_FREE);
    // and on, after the wrap
    runtime.threadBegin(2);
    const c = own.newStruct(N);
    own.store(next(a), c);
    own.store(next(a), 0);
    runtime.threadEnd();
    expect(nudges()).toBe(2);
    runtime.threadBegin(1);
    runtime.$nudged();
    expect(runtime.I32[c >> 2]).toBe(runtime.K_FREE);
    own.release(a);
    runtime.attach(
      globalThis.__escapeSab!,
      {},
      () => {},
      text => logged.push(text),
    );
  });

  it('a thread a quarter of the range behind stalls the epoch until it passes a point', () => {
    // a thread that passed no point while the epoch moved a quarter of its
    // range (as by hours of other threads' reclaims): a reclaim makes no new
    // epoch, which would soon take the thread's old word for a newer one, and
    // frees nothing of what the thread may hold; once the thread passes a
    // point, the epoch moves on and the old decrements are freed
    const EPOCH = 17, // C_EPOCH
      NEXT_TID = 4; // C_NEXT_TID
    if (Atomics.load(runtime.I32, NEXT_TID) < 4)
      Atomics.store(runtime.I32, NEXT_TID, 4);
    runtime.attach(
      globalThis.__escapeSab!,
      {nudge: true},
      () => {},
      text => logged.push(text),
    );
    runtime.$nudged();
    runtime.threadBegin(3); // a thread at this point, which it keeps
    const far = (Atomics.load(runtime.I32, EPOCH) + (1 << 30)) | 0;
    Atomics.store(runtime.I32, EPOCH, far);
    runtime.threadBegin(1);
    runtime.$nudged(); // the page, at the new epoch
    runtime.threadBegin(2);
    const a = own.newStruct(N),
      b = own.newStruct(N);
    own.store(next(a), b);
    own.store(next(a), 0); // deferred at the far epoch
    runtime.threadEnd(); // its reclaim: thread 3 is a quarter behind: no new epoch
    expect(Atomics.load(runtime.I32, EPOCH)).toBe(far);
    expect(runtime.I32[b >> 2]).toBe(N.kind);
    runtime.threadBegin(3); // thread 3 passes a point
    runtime.threadBegin(1);
    runtime.$nudged(); // the page's reclaim makes a new epoch again
    expect(Atomics.load(runtime.I32, EPOCH)).toBe((far + 2) | 0);
    runtime.threadBegin(3); // and another point, past the new epoch
    runtime.threadBegin(1);
    runtime.$nudged(); // b is older than every thread's point now
    expect(runtime.I32[b >> 2]).toBe(runtime.K_FREE);
    runtime.threadBegin(3);
    runtime.threadEnd();
    runtime.threadBegin(1);
    own.release(a);
    runtime.attach(
      globalThis.__escapeSab!,
      {},
      () => {},
      text => logged.push(text),
    );
  });

  it('frees, and boxes, a struct whose type another thread declared', () => {
    // its type is not declared here (a worker that never loaded its module):
    // the kind is the address of the layout the declaring thread pinned
    // (a field's name may hold anything: the layout is JSON)
    const kind = runtime.$intern(
      `struct ${JSON.stringify(['Elsewhere', ['v', 'next', 'the name, with a comma'], [1], 'frs'])}`,
    );
    const make = () => {
      const a = runtime.$allocBlock(32); // [kind][count 1] and three fields
      runtime.I32[a >> 2] = kind;
      runtime.I32[(a >> 2) + 1] = 1;
      return a;
    };
    const c = make(),
      d = make();
    runtime.I32[(c >> 2) + 2 + 2] = d; // c.next = d, taking over d's count
    own.storeStr((c >> 2) + 2 + 4, 'named elsewhere, unique to this test');
    const before = T.heapStats().freed;
    own.release(c); // frees c, and so d
    expect(T.heapStats().freed - before).toBe(2);
    own.__collect(); // and the string, a grace period later (with what else waited)
    expect(T.heapStats().freed - before).toBeGreaterThanOrEqual(3);
    const e = make(),
      h = own.box(e) as unknown as {
        'v': number;
        'next': object | null;
        'the name, with a comma': string;
      };
    h.v = 1.5;
    h['the name, with a comma'] = 'boxed';
    expect([h.v, h.next, h['the name, with a comma']]).toEqual([
      1.5,
      null,
      'boxed',
    ]);
    own.release(e); // the handle holds the other count
  });

  it('intern strings: one copy each', () => {
    expect(runtime.$internRef('abc')).toBe(runtime.$internRef('abc'));
    expect(own.strAt(runtime.$internFind('abc'))).toBe('abc');
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
  const S = own.sharedStruct('Named', ['name'], [], 's');

  it('a field holds a count on its string, and gives it back', () => {
    const a = own.newStruct(S),
      before = live();
    for (let i = 0; i < 2000; i++) {
      own.storeStr((a >> 2) + 2, `name ${i} ${'é'.repeat(i % 3)}`);
      expect(own.strAt(runtime.I32[(a >> 2) + 2])).toBe(
        `name ${i} ${'é'.repeat(i % 3)}`,
      );
    }
    expect(live()).toBe(before + 1); // the last one
    own.storeStr((a >> 2) + 2, '');
    expect(live()).toBe(before);
    own.storeStr((a >> 2) + 2, 'one more, unique to this test');
    own.release(a); // the struct goes, and with it its string
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
    const a = own.newStruct(S);
    own.storeStr((a >> 2) + 2, 'known here'); // sent by address
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
    own.release(a);
  });

  it('a pinned string stays, counted or not', () => {
    const counted = runtime.$internRef('pinned later, unique to this test'),
      pinned = runtime.$intern('pinned, unique to this test');
    expect(runtime.$intern('pinned later, unique to this test')).toBe(counted);
    own.release(counted);
    own.release(runtime.$internRef('pinned, unique to this test'));
    live();
    expect(runtime.$internFind('pinned later, unique to this test')).toBe(
      counted,
    );
    expect(runtime.$internFind('pinned, unique to this test')).toBe(pinned);
  });

  it('a lookup finds no string that died', () => {
    // this thread's cache knows the address; the string leaves the table at
    // count 0, but its block stays a grace period. a lookup must not find it:
    // another thread may intern the string again, at another address, which a
    // map's lookup with the dead one would miss
    const a = runtime.$internRef('dies, unique to this test');
    expect(runtime.$internFind('dies, unique to this test')).toBe(a);
    expect(runtime.$internedHere('dies, unique to this test')).toBe(a);
    own.release(a);
    expect(runtime.$internFind('dies, unique to this test')).toBe(0);
    expect(runtime.$internedHere('dies, unique to this test')).toBe(0);
    own.__collect();
  });

  it('a cached string is not taken for one its block is becoming', () => {
    // a thread's cache maps a dead string to its block. as it checks the cache
    // (kind, serial, count), the block is retired and its reuse begun (the new
    // count written, the rest not yet): the check must fail, not take the
    // block, half written, for the dead string
    const s = 'a string that dies mid-check';
    const a = runtime.$internRef(s);
    expect(runtime.$str(a)).toBe(s); // cached here
    own.release(a); // dead, not yet retired
    const atomics = Atomics as unknown as {
      load: (arr: Int32Array, i: number) => number;
    };
    const load = atomics.load;
    let armed = true;
    // at the count's load: the kind and the serial were read, the old
    // string's, and the block is retired and a new string's count written
    // before the count is read; only the serial read again after it shows
    // the block is no longer that string's
    atomics.load = (arr, i) => {
      if (armed && arr === runtime.I32 && i === (a >> 2) + 1) {
        armed = false;
        own.__collect(); // retired
        runtime.I32[(a >> 2) + 1] = 1; // a new string's count, its first word
      }
      return load(arr, i);
    };
    let b = 0;
    try {
      b = runtime.$internRef(s);
    } finally {
      atomics.load = load;
    }
    expect(armed).toBe(false);
    expect(runtime.I32[b >> 2]).toBe(9); // K_STR: a string's block, written
    expect(runtime.$str(b)).toBe(s);
    expect(runtime.$internFind(s)).toBe(b);
    own.release(b);
  });

  it('a cached string is not taken for a block of its serial and another text', () => {
    // a serial comes round again after 2^32 strings: a block of the cached
    // serial, kind and length, even of the same hash, is another string if its
    // text is ("yaczfa" and "glbppa" have one FNV-1a hash)
    const s = 'yaczfa',
      other = 'glbppa';
    const a = runtime.$internRef(s);
    expect(runtime.$str(a)).toBe(s); // cached here, both ways
    const U8 = new Uint8Array(runtime.I32.buffer);
    const at = (i: number) => U8[a + 24 + i]!; // the text after a 24-byte head
    expect(runtime.I32[(a >> 2) + 4]).not.toBe(0); // ASCII, a byte a char
    const write = (t: string) => {
      for (let i = 0; i < t.length; i++) U8[a + 24 + i] = t.charCodeAt(i);
    };
    write(other); // as the block reused for other, its serial come round, is
    let b = 0,
      read = '';
    try {
      expect(String.fromCharCode(...[0, 1, 2, 3, 4, 5].map(at))).toBe(other);
      read = runtime.$str(a);
      b = runtime.$internRef(s);
    } finally {
      write(s);
    }
    expect(read).toBe(other); // the text read, not the cached one
    expect(b).not.toBe(a); // looked up, not taken from the cache
    own.release(a);
    own.release(b);
  });

  it('no string has serial 0, which a retired block has', () => {
    // the serial counter is an i32 and wraps: the string made as it reaches 0
    // takes the next one
    const SERIAL = 15; // C_STR_SERIAL
    const before = Atomics.load(runtime.I32, SERIAL);
    Atomics.store(runtime.I32, SERIAL, -1);
    try {
      const a = runtime.$internRef('a string made as the serials wrap');
      expect(runtime.I32[(a >> 2) + 5]).not.toBe(0);
      own.release(a);
    } finally {
      Atomics.store(runtime.I32, SERIAL, before);
    }
  });

  it('an address a string left is never that string again', () => {
    for (let i = 0; i < 200; i++) {
      const a = runtime.$internRef(`gone ${i}`);
      expect(runtime.$str(a)).toBe(`gone ${i}`); // now cached here
      own.release(a);
      own.__collect();
      expect(runtime.$internFind(`gone ${i}`)).toBe(0);
      const b = runtime.$internRef(`new ${i}`); // the same block, often
      expect(runtime.$str(b)).toBe(`new ${i}`);
      own.release(b);
    }
  });
});

function noop() {}

describe('sizes are checked', () => {
  // a length or a capacity that is not a whole number would make a block of no
  // bytes, or of a negative number of them, over the next block
  it('refuses a SharedArray of a bad length or type', () => {
    expect(() => new T.SharedArray(Number, -3)).toThrow(RangeError);
    expect(() => new T.SharedArray(Number, NaN)).toThrow(RangeError);
    expect(() => new T.SharedArray(Number, 1.5)).toThrow(RangeError);
    expect(
      () => new T.SharedArray(Int32Array as unknown as typeof Number, 4),
    ).toThrow(TypeError);
    expect(
      () => new T.SharedArray('i32' as unknown as typeof Number, 4),
    ).toThrow(TypeError);
    expect(new T.SharedArray(Number, 0).length).toBe(0);
  });
  it('takes a struct type whose layout is declared again', () => {
    // the two share a kind, and the later declaration is the earlier type
    const A = T.struct({x: T.f64}, 'Twin');
    T.struct({x: T.f64}, 'Twin');
    expect(new T.SharedArray(A, 1).length).toBe(1);
  });
  it('refuses a struct type that is not one declared', () => {
    // an object with a size, but not the type registered for a kind
    expect(
      () =>
        new T.SharedArray({size: 16, kind: 0} as unknown as typeof Number, 2),
    ).toThrow(TypeError);
    expect(
      () => new T.SharedArray({size: 16} as unknown as typeof Number, 2),
    ).toThrow(TypeError);
  });
  it('refuses a channel of a bad capacity', () => {
    expect(() => new T.Channel(NaN)).toThrow(RangeError);
    expect(() => new T.Channel(-1)).toThrow(RangeError);
    expect(() => new T.Channel(Infinity)).toThrow(RangeError);
    expect(() => new T.Channel(1.5)).toThrow(RangeError);
    expect(() => own.sharedFloat64Array(1.5)).toThrow(RangeError);
    expect(() => own.sharedFloat64Array(NaN)).toThrow(RangeError);
  });
  it('the allocator refuses sizes that are not positive', () => {
    expect(() => runtime.$alloc(-8)).toThrow(RangeError);
    expect(() => runtime.$alloc(NaN)).toThrow(RangeError);
    expect(() => runtime.$allocBlock(0)).toThrow(RangeError);
    expect(() => own.sharedFloat64Array(-1)).toThrow(RangeError);
    // a fraction would round to no bytes, or to fewer than asked
    expect(() => runtime.$alloc(0.5)).toThrow(/cannot allocate/);
    expect(() => runtime.$alloc(8.5)).toThrow(/cannot allocate/);
    expect(() => runtime.$allocBlock(31.9)).toThrow(/cannot allocate/);
  });
  it('refuses a partition into parts that are not a whole number', () => {
    // a fraction would leave out the tail, and 0, a negative or NaN every item
    const items = Array.from({length: 10}, (_, i) => i + 1);
    for (const parts of [2.5, 0, -1, NaN, Infinity])
      expect(() => T.partition(items, parts)).toThrow(RangeError);
    const parts = T.partition(items, 3);
    expect(parts.map(p => p.length)).toEqual([3, 3, 4]);
    expect(parts.flat()).toEqual(items);
  });
  it('refuses a heap past an i32, or too small, before it writes to it', () => {
    // 2 GiB would wrap the heap's end negative, and every allocation would
    // fail. not a buffer: the check comes first, so nothing is written
    const heapOf = (byteLength: number) => () =>
      runtime.initShared({byteLength} as SharedArrayBuffer);
    expect(heapOf(2 ** 31)).toThrow(RangeError);
    expect(heapOf(2 ** 31)).toThrow(/2047 MB/);
    expect(heapOf(2 ** 31 - 4)).toThrow(RangeError); // not a multiple of 8
    expect(heapOf(1 << 20)).toThrow(RangeError); // the control area alone
    // in MB, as run.ts and page.ts take it: a shift would make 2048 negative
    // and 4096 no bytes
    for (const mb of [2048, 4096, 1.5, 1, 0, -1, NaN])
      expect(() => runtime.sharedHeap(mb)).toThrow(RangeError);
    expect(runtime.sharedHeap(2).byteLength).toBe(2 << 20);
  });
  it('the allocator refuses sizes past an i32, and takes the last one short of it', () => {
    // rounded, a size past 0x7ffffff8 would wrap; the largest accepted size is
    // refused as a size by nothing, only by the heap, which has no room for it
    const thrown = (f: () => void) => {
      try {
        f();
        return '';
      } catch (e) {
        return String(e);
      }
    };
    expect(thrown(() => runtime.$alloc(0x7ffffff9))).toMatch(/cannot allocate/);
    expect(thrown(() => runtime.$alloc(2 ** 31))).toMatch(/cannot allocate/);
    expect(thrown(() => runtime.$alloc(Infinity))).toMatch(/cannot allocate/);
    const last = thrown(() => runtime.$alloc(0x7ffffff8));
    expect(last).toMatch(/RangeError/);
    expect(last).not.toMatch(/cannot allocate/);
  });
});

describe('a thread alone', () => {
  // with no other thread running, what a thread deferred is safe at its next
  // reclaim: no thread may hold an address it read uncounted
  const L = own.sharedStruct('Lone', ['v', 'next'], [1]);
  const nextOf = (a: number) => (a >> 2) + 2 + 2 * 1;
  it('frees what it deferred at its next point', () => {
    const before = T.heapStats().pending;
    const a = own.newStruct(L),
      b = own.newStruct(L);
    own.store(nextOf(a), b);
    own.store(nextOf(a), 0); // b's decrement, deferred
    runtime.$waitBegin(); // a reclaim, and the hand-off of what it kept
    runtime.$waitEnd();
    expect(runtime.I32[b >> 2]).toBe(runtime.K_FREE);
    expect(T.heapStats().pending).toBeLessThanOrEqual(before); // nothing kept
    own.release(a);
  });
});

describe('a wait that throws', () => {
  // Atomics.wait throws where a thread may not block (a page's main thread);
  // the runtime refuses such calls first ($mustNotBlock), but should a wait
  // throw regardless, the thread is left running, not waiting, and a select's
  // records out of its channels' lists. the wait is made to throw here
  const QS_1 = 2048 + 8 + 5, // thread 1's quiescent state (T_QS of its entry)
    IDLE = 1;
  const atomics = Atomics as unknown as {wait: typeof Atomics.wait};
  const throwing = (f: () => void) => {
    const wait = atomics.wait;
    atomics.wait = () => {
      throw new TypeError('cannot block here');
    };
    try {
      f();
    } finally {
      atomics.wait = wait;
    }
  };
  it('a join leaves the thread running', () => {
    // a thread block whose done word is 0: the join waits on it
    const t = runtime.$allocBlock(32);
    throwing(() => expect(() => runtime.threadJoin(t)).toThrow(TypeError));
    expect(runtime.I32[QS_1]).not.toBe(IDLE);
    runtime.$freeBlock(t, 32);
  });

  it('a select leaves the thread running, and no record on its channel', () => {
    const ch = new T.Channel();
    throwing(() => expect(() => T.select(ch)).toThrow(TypeError));
    expect(runtime.I32[QS_1]).not.toBe(IDLE);
    expect(runtime.I32[(ch.$cell >> 2) + 11]).toBe(0); // its list of selects
  });
});

describe('atomic.wait', () => {
  // a thread in atomic.wait is quiescent throughout, as in the runtime's own
  // waits: marked waiting (IDLE) for the wait's length, so that other threads'
  // frees do not wait for it, and running again after
  it('marks the thread waiting while it waits', () => {
    const QS_1 = 2048 + 8 + 5, // thread 1's quiescent state (T_QS of its entry)
      IDLE = 1;
    const W = T.struct({n: T.i32}, 'Waited');
    const w = new W();
    const atomics = Atomics as unknown as {wait: typeof Atomics.wait};
    const wait = atomics.wait;
    let during = -1;
    atomics.wait = (() => {
      during = runtime.I32[QS_1];
      return 'timed-out';
    }) as typeof Atomics.wait;
    try {
      expect(T.atomic.wait(w, 'n', 0, 0)).toBe('timed-out');
    } finally {
      atomics.wait = wait;
    }
    expect(during).toBe(IDLE);
    expect(runtime.I32[QS_1]).not.toBe(IDLE);
  });

  it('leaves the thread running when the wait throws', () => {
    const QS_1 = 2048 + 8 + 5,
      IDLE = 1;
    const W = T.struct({n: T.i32}, 'Waited');
    const w = new W();
    const atomics = Atomics as unknown as {wait: typeof Atomics.wait};
    const wait = atomics.wait;
    atomics.wait = (() => {
      throw new TypeError('cannot block here');
    }) as typeof Atomics.wait;
    try {
      expect(() => T.atomic.wait(w, 'n', 0, 0)).toThrow(TypeError);
    } finally {
      atomics.wait = wait;
    }
    expect(runtime.I32[QS_1]).not.toBe(IDLE);
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

  it('a pool starts again on the same heap after a shutdown', async () => {
    const sab = globalThis.__escapeSab!;
    own.fns({noop});
    own.spawn(noop); // queued: no worker runs here
    expect(runtime.counters(sab)).toMatchObject({
      live: 1,
      queued: 1,
      shutdown: 0,
    });
    runtime.shutdown(sab);
    expect(runtime.counters(sab).shutdown).toBe(1);
    expect(await runtime.resetPool(sab)).toBe(true);
    expect(runtime.counters(sab)).toMatchObject({
      live: 0,
      queued: 0,
      idle: 0,
      shutdown: 0,
    });
    runtime.waitAllThreads(); // returns: nothing lives
    // this thread attached to the pool that was stopped: it may not spawn on
    // the next (a terminated worker may run on), until it attaches again
    expect(() => own.spawn(noop)).toThrow(/the pool was stopped/);
    runtime.attach(
      sab,
      {},
      () => {},
      text => logged.push(text),
    );
    own.spawn(noop);
    expect(runtime.counters(sab)).toMatchObject({live: 1, queued: 1});
  });

  it('fns() refuses a name another function has', () => {
    // its keys are the name alone: spawning either would run the one
    // registered last
    function first() {}
    function second() {}
    own.fns({twice: first});
    own.fns({twice: first}); // the same function again
    expect(() => own.fns({twice: second})).toThrow(/named twice already/);
    expect(() => own.spawn(second)).toThrow(/registers it/);
    // a table is read once: a getter cannot give the check one function and
    // the registration another
    own.fns({once: first});
    let reads = 0;
    own.fns({
      get once() {
        return reads++ === 0 ? first : second;
      },
    });
    expect(() => own.fns({once: second})).toThrow(/named once already/);
    // a module's functions are keyed by its url: should it load again, its
    // new functions are the ones to run
    own.register('mod.ts', {twice: first});
    own.register('mod.ts', {twice: second});
  });

  it('log writes a line', () => {
    T.log('hello', 1);
    expect(logged).toEqual(['hello 1\n']);
  });
});

// last: a thread spawned here is queued for good, as no worker runs here (the
// pool's restart above counts the threads)
describe('threads and scopes', () => {
  it('a scope refuses an async body', () => {
    expect(() => T.scope(async () => {})).toThrow(/must not be async/);
  });

  it('a scope spawns nothing once its body has returned', async () => {
    own.fns({noop});
    // kept past its body, where nothing would join what it spawns
    const kept = T.scope(s => s);
    expect(() => kept.spawn(noop)).toThrow(/this one has returned/);
    // an async body returns at its first await: what it spawns after that
    let late: Promise<void> | undefined;
    expect(() =>
      T.scope(
        s =>
          (late = (async () => {
            await Promise.resolve();
            s.spawn(noop);
          })()),
      ),
    ).toThrow(/must not be async/);
    await expect(late).rejects.toThrow(/this one has returned/);
  });

  it('leaves no unhandled rejection from an async body it refuses', async () => {
    own.fns({noop});
    // the body's spawn after its await throws, in a promise nobody has
    const unhandled: unknown[] = [];
    const note = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', note);
    try {
      expect(() =>
        T.scope(async s => {
          await Promise.resolve();
          s.spawn(noop);
        }),
      ).toThrow(/must not be async/);
      // past the microtasks, after which a rejection is reported unhandled
      await new Promise(resolve => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', note);
    }
    expect(unhandled).toEqual([]);
  });

  it('a Thread or a Scope is not sent, shared or held in a field', () => {
    own.fns({noop});
    const s = T.scope(s => s),
      t = own.spawn(noop); // queued: no worker runs here
    expect(() => own.__message([t])).toThrow(
      /a Thread cannot be sent or shared: join it where it was spawned/,
    );
    expect(() => T.share({t})).toThrow(/a Thread cannot be sent or shared/);
    expect(() => own.__message(s)).toThrow(
      /a Scope cannot be sent or shared: spawn on it in its body/,
    );
    const H = T.struct({t: T.ref()}, 'H'),
      h = new H();
    expect(() => {
      h.t = t;
    }).toThrow(/a Thread is not a cell/);
    expect(h.t).toBe(null);
  });
});
