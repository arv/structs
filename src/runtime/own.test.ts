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
      IDLE = 0x7fffffff;
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
    runtime.$waitBegin(); // stop()
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
      IDLE = 0x7fffffff;
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

  it('log writes a line', () => {
    T.log('hello', 1);
    expect(logged).toEqual(['hello 1\n']);
  });
});
