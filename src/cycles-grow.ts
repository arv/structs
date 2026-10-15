// collections of cycles while the pool grows, written by hand as the compiler
// emits it, to test the runtime:
//   node src/run.ts cycles-grow --pool=2 --check
// this module makes blocks as it loads, on every worker: a ring it keeps, and
// cycles it drops. a worker that starts while collections run loads it then,
// and must take part in them from before that (runtime.ts $workerJoin), or a
// collection would see counts and blocks change under it. --check poisons
// freed blocks, so a read of one shows up as a bad value.
//
//   shared struct Node { value: number; next: Node | null }
//   shared struct Flag { done: i32; collected: i32 }
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
  collectCycles,
  register,
  log,
  scope,
} from '@arv/threads/own';
import {K_FREE} from '@arv/threads/runtime';

const Node = sharedStruct('GrowNode', ['value', 'next'], [1]);
const Flag = sharedStruct('GrowFlag', ['done', 'collected'], [], 'ii');
// Node: value F64[(p >> 3) + 1], next I32[(p >> 2) + 4]; Flag: done I32[(p >>
// 2) + 2], collected I32[(p >> 2) + 4]

// function ring(n: number, v: number): Node, n nodes, the last one's next the
// first
function ring(n: number, v: number) {
  const first = newStruct(Node);
  let last = first;
  for (let i = 0; i < n; i++) {
    F64[(last >> 3) + 1] = v;
    const p = i === n - 1 ? retain(first) : newStruct(Node);
    store((last >> 2) + 4, p);
    last = p;
  }
  return first;
}

// made as the module loads: kept for good, and dropped
const KEPT = ring(64, 42);
for (let i = 0; i < 200; i++) release(ring(4, -1));

// 0 if the 64 nodes from t are all whole and 42, else 1
function bad(t: number) {
  for (let k = 0, q = t; k < 64; k++, q = I32[(q >> 2) + 4])
    if (
      I32[q >> 2] === K_FREE ||
      I32[q >> 2] !== Node.kind ||
      F64[(q >> 3) + 1] !== 42
    )
      return 1;
  return 0;
}

// function worker(rounds: number): number, the number of bad reads of this
// worker's own kept ring
function worker(rounds: number) {
  let wrong = 0;
  for (let i = 0; i < rounds; i++) {
    release(ring(3, i));
    wrong += bad(KEPT);
    quiescent();
  }
  return wrong;
}

// function collector(flag: Flag): collects until flag.done, and until a
// collection has freed something
function collector(flag: number) {
  while (
    Atomics.load(I32, (flag >> 2) + 2) === 0 ||
    Atomics.load(I32, (flag >> 2) + 4) === 0
  ) {
    const f = collectCycles();
    if (f > 0) Atomics.add(I32, (flag >> 2) + 4, f);
    quiescent();
  }
  return 0;
}

export function main() {
  const flag = newStruct(Flag);
  let wrong = 0,
    collected = 0;
  try {
    scope(s => {
      const c = s.spawn(collector, countedRef(flag));
      // more threads than workers, at once: the pool grows while the collector
      // runs, and each new worker loads this module
      const ws = [];
      for (let t = 0; t < 24; t++) ws.push(s.spawn(worker, 2000));
      for (const w of ws) wrong += w.join();
      Atomics.store(I32, (flag >> 2) + 2, 1);
      c.join();
    });
    collected = Atomics.load(I32, (flag >> 2) + 4);
  } finally {
    release(flag);
  }
  log(
    `grow: bad reads ${wrong}, collections freed ${collected > 0 ? 'some' : 'none'}, main's kept ring whole: ${bad(KEPT) === 0}`,
  );
}

register(import.meta.url, {ring, worker, collector, main});
