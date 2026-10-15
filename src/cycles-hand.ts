// cycles of shared structs collected (collectCycles, REFCOUNT.md) while other
// threads race with the collection, written by hand as the compiler emits
// them, to test the runtime:
//   node src/run.ts cycles-hand --threads=4 --check
// --check poisons freed blocks, so a read after free shows up as a bad value.
//
//   shared struct Ring { value: number; check: number; next: Ring | null }
//   shared struct Box { item: Ring | null; done: number; collected: i32 }
//   shared struct Flags { stop: i32; started: i32; ticks: i32 }
//
// a writer keeps replacing box.item with a fresh ring, so that the old one is
// a cycle nothing refers to; a mutator inserts nodes into the ring box.item
// holds and takes them out again; readers walk that ring without counting its
// addresses (valid until their next quiescent point), and now and then hold
// one, counted, across quiescent points; and collectors collect cycles all the
// while. the writer goes on until a collection has freed something, so that
// collections overlap the changes. a node a reader reaches always has its
// ring's value, and nothing is left once the threads are done. then a thread
// that never reaches a quiescent point makes a collection give up: it frees
// nothing, the threads it parked go on, and a later one frees what is left
import {
  F64,
  I32,
  newStruct,
  sharedStruct,
  retain,
  release,
  store,
  countedRef,
  quiescent,
  heapStats,
  collectCycles,
  __collect,
  register,
  log,
  scope,
} from '@arv/threads/own';
import {K_FREE, POISON} from '@arv/threads/runtime';

const Ring = sharedStruct('Ring', ['value', 'check', 'next'], [2]);
const Box = sharedStruct('Box', ['item', 'done', 'collected'], [0], 'rfi');
const Flags = sharedStruct('Flags', ['stop', 'started', 'ticks'], [], 'iii');
// Ring: value F64[(p >> 3) + 1], check F64[(p >> 3) + 2], next I32[(p >> 2) +
// 6]; Box: item I32[(p >> 2) + 2], done F64[(p >> 3) + 2], collected I32[(p >>
// 2) + 6]; Flags: stop I32[(p >> 2) + 2], started + 4, ticks + 6

// function ring(n: number, v: number): Ring, n nodes, the last one's next the
// first
function ring(n: number, v: number) {
  const first = newStruct(Ring);
  let last = first; // borrowed: held by first, or by the field it was stored in
  for (let i = 0; i < n; i++) {
    F64[(last >> 3) + 1] = v;
    F64[(last >> 3) + 2] = 2 * v;
    const p = i === n - 1 ? retain(first) : newStruct(Ring);
    store((last >> 2) + 6, p); // last.next = p, taking over p's count
    last = p;
  }
  return first;
}

// function writer(box: Box, rounds: number): rounds at least, and on until a
// collection has freed something
function writer(box: number, rounds: number) {
  for (let i = 1; i <= rounds || Atomics.load(I32, (box >> 2) + 6) === 0; i++) {
    store((box >> 2) + 2, ring(3 + (i % 5), i)); // box.item = ring(...)
    if (i % 4 === 0) release(ring(2, -i)); // a cycle that was never stored
    quiescent();
  }
  return 0;
}

// function mutator(box: Box, rounds: number): one node in, then one out, of
// the ring box.item holds
function mutator(box: number, rounds: number) {
  for (let i = 0; i < rounds; i++) {
    const t = I32[(box >> 2) + 2]; // box.item, borrowed until the next point
    if (t !== 0) {
      if (i % 2 === 0) {
        // t.next = new Ring(t.value, t.next)
        const n = newStruct(Ring);
        F64[(n >> 3) + 1] = F64[(t >> 3) + 1];
        F64[(n >> 3) + 2] = F64[(t >> 3) + 2];
        store((n >> 2) + 6, retain(I32[(t >> 2) + 6]));
        store((t >> 2) + 6, n);
      } else {
        // t.next = t.next.next
        const next = I32[(t >> 2) + 6];
        if (next !== t) store((t >> 2) + 6, retain(I32[(next >> 2) + 6]));
      }
    }
    quiescent();
  }
  return 0;
}

// the nodes of the ring from t, up to n of them, have its value: 0 if so, else
// 1 (a node freed, or another ring's)
function bad(t: number, n: number) {
  const v = F64[(t >> 3) + 1];
  for (let k = 0, q = t; k < n; k++, q = I32[(q >> 2) + 6])
    if (
      I32[q >> 2] === K_FREE ||
      I32[q >> 2] !== Ring.kind ||
      F64[(q >> 3) + 1] !== v ||
      F64[(q >> 3) + 2] !== 2 * v ||
      v === POISON
    )
      return 1;
  return 0;
}

// function reader(box: Box, rounds: number): number, the number of bad reads
function reader(box: number, rounds: number) {
  let wrong = 0;
  for (let i = 0; i < rounds; i++) {
    // box.item and the nodes after it, read and not counted
    const t = I32[(box >> 2) + 2];
    if (t !== 0) wrong += bad(t, 8);
    if (i % 64 === 0) {
      // held, counted, across quiescent points, where collections run
      const held = retain(I32[(box >> 2) + 2]);
      try {
        for (let k = 0; k < 4; k++) quiescent();
        if (held !== 0) wrong += bad(held, 8);
      } finally {
        release(held);
      }
    }
    quiescent();
  }
  return wrong;
}

// function collector(box: Box): number, the blocks its collections freed
function collector(box: number) {
  let freed = 0,
    x = 0;
  while (F64[(box >> 3) + 2] === 0) {
    const f = collectCycles();
    if (f > 0) Atomics.add(I32, (box >> 2) + 6, f); // box.collected += f
    freed += f;
    for (let k = 0; k < 20000; k++) x += k; // a moment between collections
    quiescent();
  }
  return x === -1 ? -1 : freed;
}

// blocks in use, once what waits has been freed
function live() {
  __collect();
  const s = heapStats();
  return s.allocated - s.freed;
}

function race(readers: number, collectors: number) {
  const before = live();
  const box = newStruct(Box);
  let wrong = 0,
    freed = 0;
  try {
    scope(s => {
      const ws = s.spawn(writer, countedRef(box), 20000),
        ms = s.spawn(mutator, countedRef(box), 40000),
        rs = [],
        cs = [];
      for (let r = 0; r < readers; r++)
        rs.push(s.spawn(reader, countedRef(box), 40000));
      for (let c = 0; c < collectors; c++)
        cs.push(s.spawn(collector, countedRef(box)));
      ws.join();
      ms.join();
      for (const r of rs) wrong += r.join();
      F64[(box >> 3) + 2] = 1; // box.done = 1
      for (const c of cs) freed += c.join();
    });
  } finally {
    release(box); // and so box.item: one more cycle
  }
  const last = collectCycles();
  log(
    `race, ${readers} readers, ${collectors} collectors: bad reads ${wrong}, blocks freed by collections ${freed > 0 ? 'some' : 'none'}, by the last ${last > 0 ? 'some' : 'none'}, blocks left ${live() - before}`,
  );
}

// cycles that only a local refers to stay, on every thread, whatever is
// collected meanwhile
// function holder(rounds: number): number, the number of bad reads
function holder(rounds: number) {
  let wrong = 0;
  const kept = ring(16, 7);
  try {
    for (let i = 0; i < rounds; i++) {
      release(ring(4, i)); // garbage, for the collections
      wrong += bad(kept, 16);
      quiescent();
    }
  } finally {
    release(kept);
  }
  return wrong;
}

function held(threads: number) {
  const before = live();
  let wrong = 0;
  scope(s => {
    const hs = [];
    for (let t = 0; t < threads; t++) hs.push(s.spawn(holder, 5000));
    let collected = 0;
    for (let k = 0; k < 50; k++) collected += collectCycles();
    for (const h of hs) wrong += h.join();
    return collected;
  });
  collectCycles();
  log(
    `held, ${threads} threads: bad reads ${wrong}, blocks left ${live() - before}`,
  );
}

// function spinner(flags: Flags): a loop with no quiescent point, until
// flags.stop
function spinner(flags: number) {
  Atomics.store(I32, (flags >> 2) + 4, 1); // flags.started = 1
  let x = 0;
  while (Atomics.load(I32, (flags >> 2) + 2) === 0) x++;
  return x === -1 ? -1 : 0;
}
// function ticker(flags: Flags): counts its quiescent points, where it parks
// while a collection runs, until flags.stop
function ticker(flags: number) {
  while (Atomics.load(I32, (flags >> 2) + 2) === 0) {
    Atomics.add(I32, (flags >> 2) + 6, 1); // flags.ticks++
    quiescent();
  }
  return 0;
}

function stuck() {
  const before = live(),
    flags = newStruct(Flags);
  let gaveUp = 0,
    goesOn = false,
    after = 0;
  try {
    scope(s => {
      const sp = s.spawn(spinner, countedRef(flags)),
        tk = s.spawn(ticker, countedRef(flags));
      const pause = new Int32Array(new SharedArrayBuffer(4));
      while (Atomics.load(I32, (flags >> 2) + 4) === 0)
        Atomics.wait(pause, 0, 0, 1);
      release(ring(3, 1)); // a cycle to collect
      // the ticker parks; the spinner never does
      gaveUp = collectCycles(200);
      const left = live() - before;
      // the ticker goes on: it was let go
      const ticks = Atomics.load(I32, (flags >> 2) + 6);
      for (let k = 0; k < 1000 && !goesOn; k++) {
        Atomics.wait(pause, 0, 0, 1);
        goesOn = Atomics.load(I32, (flags >> 2) + 6) !== ticks;
      }
      Atomics.store(I32, (flags >> 2) + 2, 1); // flags.stop = 1
      sp.join();
      tk.join();
      return left;
    });
    after = collectCycles();
  } finally {
    release(flags);
  }
  log(
    `stuck: a collection gave up, freeing ${gaveUp}; the parked thread went on: ${goesOn}; the next freed ${after}, blocks left ${live() - before}`,
  );
}

export function main(threadCounts: number[]) {
  for (const n of threadCounts) {
    race(Math.max(1, n - 1), n > 1 ? 2 : 1);
    held(n);
  }
  stuck();
}

register(import.meta.url, {
  ring,
  writer,
  mutator,
  reader,
  collector,
  race,
  holder,
  held,
  spinner,
  ticker,
  stuck,
  main,
});
