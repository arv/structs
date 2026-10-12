// SharedMap and SharedSet on one thread: Map's and Set's semantics, checked
// against Map and Set themselves where they can be, and the counts a map holds
// on the cells in it.
import {describe, expect, it} from 'vite-plus/test';
import {own, runtime, threads as T} from './test-heap.ts';

// a struct's or a map's count
const count = (a: number) => runtime.I32[(a >> 2) + 1];
// a Map or a SharedMap: what the same steps leave in each
type Mapish = {
  set(k: unknown, v: unknown): unknown;
  delete(k: unknown): boolean;
  clear(): void;
  entries(): Iterable<[unknown, unknown]>;
};
const both = (steps: (m: Mapish) => unknown) => {
  const plain = new Map(),
    shared = new T.SharedMap();
  expect(steps(shared)).toEqual(steps(plain));
  expect([...shared.entries()]).toEqual([...plain.entries()]);
};

describe('SharedMap', () => {
  it('keeps insertion order, as Map does', () => {
    both(m => {
      m.set('c', 1);
      m.set('a', 2);
      m.set('b', 3);
      m.set('a', 4); // a new value keeps its place
      m.delete('c');
      m.set('c', 5); // deleted and added again: last
      return [...m.entries()];
    });
  });

  it('compares keys as SameValueZero', () => {
    const m = new T.SharedMap<unknown, string>();
    m.set(NaN, 'nan').set(-0, 'zero').set('1', 'string').set(1, 'number');
    m.set(true, 'true').set(null, 'null').set(undefined, 'undefined');
    m.set('', 'empty');
    expect(m.get(NaN)).toBe('nan');
    expect(m.get(0)).toBe('zero');
    expect(Object.is([...m.keys()][1], 0)).toBe(true); // -0 is stored as 0
    expect(m.get('1')).toBe('string');
    expect(m.get(1)).toBe('number');
    expect(m.get(true)).toBe('true');
    expect(m.get(null)).toBe('null');
    expect(m.get(undefined)).toBe('undefined');
    expect(m.get('')).toBe('empty');
    expect(m.size).toBe(8);
    expect(m.has('never stored anywhere')).toBe(false);
  });

  it('holds every value that can be shared', () => {
    const m = new T.SharedMap<string, unknown>();
    const P = T.struct({x: T.f64}, 'MapP');
    const p = new P(),
      array = new T.SharedArray(Number, 3),
      inner = new T.SharedMap<string, number>(),
      shared = T.share({a: [1, {b: 'c'}]});
    p.x = 1.5;
    const values: [string, unknown][] = [
      ['number', 1.25],
      ['minus zero', -0],
      ['nan', NaN],
      ['big', 2 ** 53],
      ['string', 'héllo 😀'],
      ['empty', ''],
      ['true', true],
      ['false', false],
      ['null', null],
      ['undefined', undefined],
      ['struct', p],
      ['array', array],
      ['map', inner],
      ['shared', shared],
    ];
    for (const [k, v] of values) m.set(k, v);
    for (const [k, v] of values) expect(Object.is(m.get(k), v)).toBe(true);
    expect(m.has('undefined')).toBe(true);
    expect(m.get('missing')).toBeUndefined();
  });

  it('finds a cell or a shared value by identity', () => {
    const P = T.struct({x: T.f64}, 'MapKey');
    const p = new P(),
      q = new P(),
      shared = T.share({a: 1});
    const m = new T.SharedMap<unknown, number>([
      [p, 1],
      [shared, 2],
    ]);
    expect(m.get(p)).toBe(1);
    expect(m.get(q)).toBeUndefined();
    expect(m.get(shared)).toBe(2);
    expect(m.get(T.share({a: 1}))).toBeUndefined(); // equal, but another value
    expect(m.get({a: 1})).toBeUndefined();
  });

  it('shares a plain object or array it stores, which moves in', () => {
    const m = new T.SharedMap<string, unknown>(),
      v = {a: [1, {b: 2}]};
    m.set('k', v);
    expect(Object.isFrozen(v)).toBe(true);
    expect(m.get('k')).toBe(v); // this thread's copy is the value itself
    expect(m.get('k')).toEqual({a: [1, {b: 2}]});
  });

  it('refuses what cannot be shared', () => {
    const m = new T.SharedMap<unknown, unknown>();
    expect(() => m.set('k', new Map())).toThrow(/plain objects and arrays/);
    expect(() => m.set('k', () => {})).toThrow(/value is shared/);
    expect(() => m.set(1n, 1)).toThrow(/key is shared/);
    expect(m.has({})).toBe(false);
    expect(m.get({})).toBeUndefined();
    expect(m.delete({})).toBe(false);
    expect(m.size).toBe(0);
  });

  it('loops see what is added and skip what is deleted, as Map’s do', () => {
    both(m => {
      for (const k of ['a', 'b', 'c', 'd']) m.set(k, k);
      const seen: unknown[] = [];
      for (const [k] of m.entries()) {
        seen.push(k);
        if (k === 'a') m.delete('c'); // not seen yet: never seen
        if (k === 'b') m.set('e', 'e'); // added: seen
        if (k === 'd') {
          m.delete('a');
          m.set('a', 'again'); // seen again
        }
      }
      return seen;
    });
  });

  it('a loop survives the table growing, shrinking and clearing', () => {
    both(m => {
      for (let i = 0; i < 4; i++) m.set(i, i);
      const seen: unknown[] = [];
      for (const [k] of m.entries()) {
        seen.push(k);
        if (k === 1) for (let i = 100; i < 300; i++) m.set(i, i); // grows
        if (k === 150) for (let i = 2; i < 290; i++) m.delete(i); // shrinks
        if (k === 295) {
          m.clear();
          m.set('after', 0);
        }
      }
      return seen;
    });
  });

  it('grows and shrinks', () => {
    const m = new T.SharedMap<number, number>(),
      before = T.heapStats();
    for (let i = 0; i < 10000; i++) m.set(i, i * 2);
    expect(m.size).toBe(10000);
    for (let i = 0; i < 10000; i++) expect(m.get(i)).toBe(i * 2);
    for (let i = 0; i < 9990; i++) m.delete(i);
    expect(m.size).toBe(10);
    expect([...m.keys()]).toEqual(Array.from({length: 10}, (_, k) => 9990 + k));
    // the tables it outgrew and shrank out of are freed
    const after = T.heapStats();
    expect(
      after.allocated - after.freed - (before.allocated - before.freed),
    ).toBe(0);
  });

  it('getOrInsert and getOrInsertComputed: the first value stays', () => {
    const m = new T.SharedMap<string, number>([['a', 1]]);
    expect(m.getOrInsert('a', 2)).toBe(1);
    expect(m.getOrInsert('b', 3)).toBe(3);
    let calls = 0;
    expect(m.getOrInsertComputed('a', () => ++calls)).toBe(1);
    expect(calls).toBe(0);
    expect(m.getOrInsertComputed('c', () => ++calls)).toBe(1);
    // as if another thread added the key while the callback ran
    expect(
      m.getOrInsertComputed('d', key => {
        m.set(key, 10);
        return 20;
      }),
    ).toBe(10);
    expect([...m.entries()]).toEqual([
      ['a', 1],
      ['b', 3],
      ['c', 1],
      ['d', 10],
    ]);
  });

  it('forEach, as Map’s', () => {
    const m = new T.SharedMap([
        ['a', 1],
        ['b', 2],
      ]),
      seen: unknown[] = [],
      self = {};
    m.forEach(function (this: unknown, v, k, map) {
      seen.push([v, k, map === m, this === self]);
    }, self);
    expect(seen).toEqual([
      [1, 'a', true, true],
      [2, 'b', true, true],
    ]);
    expect(Object.prototype.toString.call(m)).toBe('[object SharedMap]');
    expect(m).toBeInstanceOf(T.SharedMap);
  });

  it('a message carries a count of the map in it', () => {
    const m = new T.SharedMap<string, number>(),
      c = count(m.$cell);
    const [p, bytes] = own.__message({m});
    expect(count(m.$cell)).toBe(c + 1); // in flight
    const got = own.__unmessage<{m: unknown}>(p, bytes);
    expect(got.m).toBe(m); // this thread's one handle
    expect(count(m.$cell)).toBe(c);
  });
});

describe('as compiled code calls it', () => {
  // compiled code passes a struct as its address, set's arguments as __ref(p)
  // (a count for the map), and reads one back as the address
  const N = own.__sharedStruct('MapRaw', ['v'], []);

  it('keeps an address as that, with a count', () => {
    const a = own.__newStruct(N),
      b = own.__newStruct(N),
      m = new T.SharedMap<string, number>();
    m.set('k', own.__ref(a) as unknown as number);
    expect(m.get('k')).toBe(a);
    expect(count(a)).toBe(2);
    m.set('k', own.__ref(b) as unknown as number); // a's count, given back
    own.__collect();
    expect(count(a)).toBe(1);
    expect(m.getOrInsert('k', own.__ref(a) as unknown as number)).toBe(b);
    expect(count(a)).toBe(1); // not kept: its count given back at once
    const seen: unknown[] = [];
    m.forEach(v => seen.push(v));
    expect(seen).toEqual([b]);
    m.delete('k');
    own.__collect();
    expect(count(b)).toBe(1);
    own.__release(a);
    own.__release(b);
  });

  it('finds a key by its address', () => {
    const a = own.__newStruct(N),
      m = new T.SharedMap<number, string>(),
      s = new T.SharedSet<number>();
    m.set(own.__ref(a) as unknown as number, 'a');
    expect(m.get(a)).toBe('a');
    expect([...m.keys()]).toEqual([a]);
    s.add(own.__ref(a) as unknown as number);
    s.add(own.__ref(a) as unknown as number); // there already
    expect(count(a)).toBe(3);
    expect(s.has(a)).toBe(true);
    m.delete(a);
    s.delete(a);
    own.__collect();
    expect(count(a)).toBe(1);
    own.__release(a);
  });
});

describe('SharedSet', () => {
  type Setish = {
    add(v: unknown): unknown;
    delete(v: unknown): boolean;
    clear(): void;
    values(): Iterable<unknown>;
  };
  const both = (steps: (s: Setish) => unknown) => {
    const plain = new Set(),
      shared = new T.SharedSet();
    expect(steps(shared)).toEqual(steps(plain));
    expect([...shared.values()]).toEqual([...plain.values()]);
  };

  it('keeps insertion order, as Set does', () => {
    both(s => {
      for (const v of ['c', 'a', 'b', 'a', NaN, NaN, 0, -0]) s.add(v);
      s.delete('c');
      s.add('c');
      return [...s.values()];
    });
  });

  it('loops see what is added and skip what is deleted, as Set’s do', () => {
    both(s => {
      for (let i = 0; i < 5; i++) s.add(i);
      const seen: unknown[] = [];
      for (const v of s.values()) {
        seen.push(v);
        if (v === 0) s.delete(3);
        if (v === 1) for (let i = 10; i < 100; i++) s.add(i);
        if (v === 50) for (let i = 4; i < 95; i++) s.delete(i);
      }
      return seen;
    });
  });

  it('has the rest of Set’s methods', () => {
    const s = new T.SharedSet(['a', 'b']);
    expect(s.size).toBe(2);
    expect(s.has('a')).toBe(true);
    expect(s.has('z')).toBe(false);
    expect([...s.entries()]).toEqual([
      ['a', 'a'],
      ['b', 'b'],
    ]);
    expect([...s.keys()]).toEqual(['a', 'b']);
    expect([...s]).toEqual(['a', 'b']);
    const seen: unknown[] = [];
    s.forEach((v, w, set) => seen.push([v, w, set === s]));
    expect(seen).toEqual([
      ['a', 'a', true],
      ['b', 'b', true],
    ]);
    s.clear();
    expect(s.size).toBe(0);
    expect([...s]).toEqual([]);
    expect(Object.prototype.toString.call(s)).toBe('[object SharedSet]');
  });
});

describe('freeing a map', () => {
  it('holds a count on each cell in it, and gives it back', () => {
    const N = own.__sharedStruct('MapN', ['v'], []);
    const a = own.__newStruct(N),
      h = own.__box(a)!;
    own.__release(a); // the handle holds the struct's only count
    expect(count(a)).toBe(1);
    const m = new T.SharedMap<string, unknown>();
    m.set('k', h);
    expect(count(a)).toBe(2);
    m.set('k', h); // the same value again: one count still
    own.__collect();
    expect(count(a)).toBe(2);
    m.delete('k');
    own.__collect(); // the decrement waits for a quiescent point
    expect(count(a)).toBe(1);
    m.set('k', h);
    // the map's count reaches 0, as when its last handle is collected: it
    // gives back what it held, and frees its table and itself. (its handle
    // lives on here, in this thread's cache under an address the heap gives
    // out again, so this test is the file's last)
    const before = T.heapStats();
    own.__release(m.$cell);
    expect(count(a)).toBe(1);
    expect(T.heapStats().freed - before.freed).toBe(2);
  });
});
