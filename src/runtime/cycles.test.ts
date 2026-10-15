// cycles of counted blocks, which counting alone never frees, and the
// collection that does (own.ts collectCycles), on one thread. the blocks are
// made and linked as compiled code does, by address: a handle would hold a
// count until V8 collects it. src/cycles-hand.ts races collections with other
// threads
import {setFlagsFromString} from 'node:v8';
import {runInNewContext} from 'node:vm';
import {describe, expect, it} from 'vite-plus/test';
import {own, runtime, threads as T} from './test-heap.ts';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

// blocks in use, once what waits has been freed
const live = () => {
  own.__collect();
  return T.heapStats().allocated - T.heapStats().freed;
};
// the i32 index of field k of the struct at p
const field = (p: number, k: number) => (p >> 2) + 2 + 2 * k;
// a struct's count
const count = (p: number) => runtime.I32[(p >> 2) + 1];
// p.next = q, as compiled code stores a borrowed q
const link = (p: number, q: number) => own.store(field(p, 0), own.retain(q));

const Node = own.sharedStruct('CycleNode', ['next', 'value'], [0]),
  Named = own.sharedStruct(
    'CycleNamed',
    ['next', 'name', 'leaf'],
    [0, 2],
    'rsr',
  ),
  Leaf = own.sharedStruct('CycleLeaf', ['value']);

// n nodes, each the next one's next: the first one's address, owned
function ring(n: number) {
  const first = own.newStruct(Node);
  let last = first;
  for (let i = 1; i < n; i++) {
    const p = own.newStruct(Node);
    link(last, p);
    if (last !== first) own.release(last);
    last = p;
  }
  link(last, first);
  if (last !== first) own.release(last);
  return first;
}

describe('a cycle', () => {
  it('of two structs, unreachable, is freed', () => {
    const before = live();
    const a = own.newStruct(Node),
      b = own.newStruct(Node);
    link(a, b);
    link(b, a);
    own.release(a);
    own.release(b);
    // counting leaves it: each holds the other
    expect(live() - before).toBe(2);
    expect(own.collectCycles()).toBe(2);
    expect(live()).toBe(before);
  });

  it('of one struct, its own next, is freed', () => {
    const before = live();
    own.release(ring(1));
    expect(own.collectCycles()).toBe(1);
    expect(live()).toBe(before);
  });

  it('of many, with strings and what only they hold, is freed whole', () => {
    const before = live(),
      heap = T.heapStats().heapBytes;
    for (let round = 0; round < 3; round++) {
      // a ring of 200, each with a name and a leaf of its own
      const first = own.newStruct(Named);
      let last = first;
      for (let i = 0; i < 200; i++) {
        const p = i === 199 ? own.retain(first) : own.newStruct(Named);
        own.storeStr(field(last, 1), `cycle node ${i}`);
        const leaf = own.newStruct(Leaf);
        own.store(field(last, 2), leaf); // takes over leaf's count
        own.store(field(last, 0), p); // takes over p's count
        last = p;
      }
      own.release(first);
      expect(runtime.$internFind('cycle node 7')).not.toBe(0);
      // the 200 nodes: the leaves, held from them, are not in the cycle, and
      // go as the nodes give back their counts
      expect(own.collectCycles()).toBe(200);
      expect(live()).toBe(before);
      expect(runtime.$internFind('cycle node 7')).toBe(0);
    }
    // the blocks were reused, round after round
    expect(T.heapStats().heapBytes - heap).toBeLessThan(64 << 10);
  });

  it('a local refers to is not freed', () => {
    const before = live(),
      first = ring(50);
    expect(own.collectCycles()).toBe(0);
    expect(live() - before).toBe(50);
    expect(runtime.I32[first >> 2]).toBe(Node.kind);
    expect(count(first)).toBe(2); // the local's, and its last node's
    own.release(first);
    expect(own.collectCycles()).toBe(50);
    expect(live()).toBe(before);
  });

  it('held from a block outside it that a local holds is not freed', () => {
    const before = live(),
      holder = own.newStruct(Node),
      first = ring(3);
    own.store(field(holder, 0), first); // takes over first's count
    expect(own.collectCycles()).toBe(0);
    expect(live() - before).toBe(4);
    own.release(holder);
    // the holder goes, as counting frees it; the ring stays until collected
    expect(live() - before).toBe(3);
    expect(own.collectCycles()).toBe(3);
    expect(live()).toBe(before);
  });
});

describe('a cycle through a SharedArray', () => {
  const Elem = own.sharedStruct('CycleElem', ['back', 'value'], [0]),
    Holder = own.sharedStruct('CycleHolder', ['array'], [0]);

  it('of its own elements is freed', () => {
    const before = live(),
      a = own.newSharedArray(Elem, 4),
      e = (i: number) => a + 16 + i * Elem.size;
    // each element's back is the next element: a count on the array
    for (let i = 0; i < 4; i++) link(e(i), e((i + 1) % 4));
    expect(own.I32[(a >> 2) + 3]).toBe(5);
    own.release(a);
    expect(own.collectCycles()).toBe(1);
    expect(live()).toBe(before);
  });

  it('and a struct that holds it is freed', () => {
    const before = live(),
      h = own.newStruct(Holder),
      a = own.newSharedArray(Elem, 3);
    own.store(field(h, 0), a); // h.array = a, taking over a's count
    link(a + 16 + 2 * Elem.size, h); // a[2].back = h
    own.release(h);
    expect(own.collectCycles()).toBe(2);
    expect(live()).toBe(before);
  });

  it('an element a local holds keeps it', () => {
    const before = live(),
      h = own.newStruct(Holder),
      a = own.newSharedArray(Elem, 3),
      el = own.retain(a + 16 + Elem.size); // a[1], counted: a count on a
    own.store(field(h, 0), a);
    link(a + 16, h); // a[0].back = h
    own.release(h);
    expect(own.collectCycles()).toBe(0);
    own.release(el);
    expect(own.collectCycles()).toBe(2);
    expect(live()).toBe(before);
  });
});

describe('a cycle through a SharedMap', () => {
  const Owner = own.sharedStruct('CycleOwner', ['map'], [0]);
  // a struct as compiled code passes it to set: with a count for the map
  const ref = (p: number) => own.countedRef(p) as unknown as number;
  // waits for V8 to collect what has no handle left, and the registry to
  // give its count back, until done() holds
  const finalized = async (done: () => boolean) => {
    for (let k = 0; k < 100 && !done(); k++) {
      gc();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(done()).toBe(true);
  };

  it('of a map and a struct is freed once the map has no handle', async () => {
    const before = live();
    // the map holds o, and o holds the map: its handle, made here, is gone
    // once this returns
    const o = own.newStruct(Owner);
    const m = (() => {
      const h = new T.SharedMap<string, number>();
      own.store(field(o, 0), own.retain(h.$cell)); // o.map = h
      h.set('owner', ref(o));
      h.set('more', 1);
      return h.$cell;
    })();
    own.release(o);
    await finalized(() => count(m) === 1);
    // o, the map, its table and its keys' strings
    expect(live() - before).toBe(5);
    expect(own.collectCycles()).toBe(2); // o and the map
    expect(live()).toBe(before);
  });

  it('of a set and its own struct, held as a key, is freed', async () => {
    const before = live(),
      o = own.newStruct(Owner);
    const s = (() => {
      const h = new T.SharedSet<number>();
      own.store(field(o, 0), own.retain(h.$cell));
      h.add(ref(o));
      return h.$cell;
    })();
    own.release(o);
    await finalized(() => count(s) === 1);
    expect(own.collectCycles()).toBe(2);
    expect(live()).toBe(before);
  });
});

describe('a collection', () => {
  it('applies the decrements that wait first', () => {
    const before = live(),
      box = own.newStruct(Node),
      first = ring(4);
    own.store(field(box, 0), first); // box.next = the ring
    own.store(field(box, 0), 0); // and not: the decrement waits
    // the ring is held by nothing now but itself; its count is a decrement
    // too many until what waits is applied, which the collection does
    expect(own.collectCycles()).toBe(4);
    own.release(box);
    expect(live()).toBe(before);
  });

  it('finds nothing when there are no cycles', () => {
    const p = own.newStruct(Node);
    expect(own.collectCycles()).toBe(0);
    own.release(p);
  });
});

describe('a pool reset', () => {
  // runs last: the reset leaves this thread on a pool that was stopped
  it('forgets a waiter of the pool before it, which may wake late', async () => {
    const I32 = runtime.I32,
      NEXT_TID = 4,
      WAKING_2 = 2048 + 2 * 8 + 3; // thread 2's entry: [alive][free][awake][waking]
    // thread 2, a worker of the old pool, waits for a collection to end
    if (I32[NEXT_TID] <= 2) I32[NEXT_TID] = 3;
    I32[WAKING_2] = 1;
    const before = live();
    own.release(ring(3));
    // a collection lets it wake first: it never does, and this one gives up
    expect(own.collectCycles(50)).toBe(0);
    // the pool stops and starts again: thread 2 is the old pool's
    expect(await runtime.resetPool(globalThis.__escapeSab!)).toBe(true);
    expect(I32[WAKING_2]).toBe(0);
    expect(own.collectCycles()).toBe(3);
    // thread 2 wakes late, and clears its own mark: nothing else changes
    I32[WAKING_2] = 0;
    own.release(ring(2));
    expect(own.collectCycles()).toBe(2);
    expect(live()).toBe(before);
  });

  it('keeps a worker that wakes as it resets visible to collections', async () => {
    const I32 = runtime.I32,
      NEXT_TID = 4,
      // threads 2 and 3's entries: [alive][free][awake][waking]
      AWAKE_2 = 2048 + 2 * 8 + 2,
      AWAKE_3 = 2048 + 3 * 8 + 2;
    if (I32[NEXT_TID] <= 3) I32[NEXT_TID] = 4;
    const before = live();
    // thread 2 waits (asleep); thread 3 was terminated awake, and stays so
    I32[AWAKE_2] = 0;
    I32[AWAKE_3] = 1;
    const reset = runtime.resetPool(globalThis.__escapeSab!);
    // thread 2 wakes while the reset waits for thread 3, and runs on
    await new Promise(resolve => setTimeout(resolve, 50));
    I32[AWAKE_2] = 1;
    expect(await reset).toBe(true);
    // thread 3, awake all along, is taken for dead; thread 2 is not
    expect([I32[AWAKE_2], I32[AWAKE_3]]).toEqual([1, 0]);
    own.release(ring(3));
    expect(own.collectCycles(50)).toBe(0); // it waits for thread 2
    I32[AWAKE_2] = 0; // which parks
    expect(own.collectCycles()).toBe(3);
    // a reset with every worker asleep marks none of them, and one that wakes
    // after it is seen
    expect(await runtime.resetPool(globalThis.__escapeSab!)).toBe(true);
    I32[AWAKE_2] = 1;
    own.release(ring(2));
    expect(own.collectCycles(50)).toBe(0);
    I32[AWAKE_2] = 0;
    expect(own.collectCycles()).toBe(2);
    expect(live()).toBe(before);
  });
});
