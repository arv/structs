// reference counting (REFCOUNT.md), written by hand as the compiler emits it,
// to test the runtime:
//   node src/run.ts refcount-hand --check
// --check poisons freed blocks, so a read after free shows up as a bad value.
//
//   shared struct Node { value: number; check: number; next: Node | null }
//   shared struct Box { item: Node | null }
//
// churn: builds and drops a 1000-node list 200 times; the heap stops growing
// once the free lists hold a list's worth of blocks. race: one thread keeps
// replacing box.item with a fresh node while others read box.item and its
// fields without counting the address (valid until their next quiescent point),
// and now and then hold one, counted, across a quiescent point
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
  __collect,
  register,
  log,
  scope,
} from '@arv/threads/own';
import {K_FREE, POISON} from '@arv/threads/runtime';

const Node = sharedStruct('Node', ['value', 'check', 'next'], [2]);
const Box = sharedStruct('Box', ['item'], [0]);
// Node: value F64[(p >> 3) + 1], check F64[(p >> 3) + 2], next I32[(p >> 2) +
// 6]; Box: item I32[(p >> 2) + 2]
// a Node's handle, as uncompiled code uses it (see handles)
interface NodeHandle {
  $cell: number;
  value: number;
  check: number;
  next: NodeHandle | null;
}

// function makeList(n: number): Node | null
function makeList(n: number) {
  let head = 0,
    t;
  try {
    for (let i = 0; i < n; i++) {
      const node = newStruct(Node);
      try {
        F64[(node >> 3) + 1] = i;
        F64[(node >> 3) + 2] = 2 * i;
        store((node >> 2) + 6, retain(head)); // node.next = head
        t = head;
        head = retain(node);
        release(t); // head = node
      } finally {
        release(node);
      }
      quiescent(); // the loop stores a reference field
    }
    return ((t = head), (head = 0), t); // head's count moves out
  } finally {
    release(head);
  }
}

// function sum(head: Node | null): number
function sum(head: number) {
  let s = 0,
    n = retain(head),
    t; // n is reassigned: an owned local
  try {
    while (n !== 0) {
      s += F64[(n >> 3) + 1];
      t = n;
      n = retain(I32[(n >> 2) + 6]);
      release(t); // n = n.next
      quiescent(); // the loop reads a reference field
    }
  } finally {
    release(n);
  }
  return s;
}

function churn() {
  const before = heapStats();
  let total = 0;
  for (let round = 0; round < 200; round++) {
    const list = makeList(1000);
    try {
      total += sum(list);
    } finally {
      release(list);
    }
    if (round % 40 === 0 || round === 199)
      log(
        `churn round ${String(round).padStart(3)}: heap ${heapStats().heapBytes >> 10} KiB`,
      );
  }
  const after = heapStats();
  log(
    `churn: sum ${total}, blocks allocated ${after.allocated - before.allocated}, freed ${after.freed - before.freed}`,
  );
}

// function writer(box: Box, rounds: number)
function writer(box: number, rounds: number) {
  for (let i = 1; i <= rounds; i++) {
    const node = newStruct(Node);
    try {
      F64[(node >> 3) + 1] = i;
      F64[(node >> 3) + 2] = 2 * i;
      store((box >> 2) + 2, retain(node)); // box.item = node
    } finally {
      release(node);
    }
    quiescent();
  }
  return 0;
}

// function reader(box: Box, rounds: number): number, the number of bad reads
function reader(box: number, rounds: number) {
  let bad = 0,
    x = 0;
  for (let i = 0; i < rounds; i++) {
    // by hand: box.item read once and not counted, its fields read with no call
    // in between. the compiler counts a local like this; the runtime has to
    // keep it valid until the next quiescent point
    const t = I32[(box >> 2) + 2];
    if (t !== 0) {
      const v = F64[(t >> 3) + 1];
      for (let k = 0; k < 64; k++) x += k;
      const c = F64[(t >> 3) + 2];
      if (I32[t >> 2] === K_FREE || v === POISON || c !== 2 * v) bad++;
    }
    if (i % 128 === 0) {
      // held, counted, across quiescent points
      const held = retain(I32[(box >> 2) + 2]);
      try {
        if (held !== 0) {
          const v = F64[(held >> 3) + 1];
          for (let k = 0; k < 8; k++) quiescent();
          if (I32[held >> 2] === K_FREE || F64[(held >> 3) + 2] !== 2 * v)
            bad++;
        }
      } finally {
        release(held);
      }
    }
    quiescent();
  }
  return x === -1 ? -1 : bad;
}

function race(readers: number) {
  const box = newStruct(Box);
  try {
    const before = heapStats();
    const bad = scope(s => {
      const ws = s.spawn(writer, countedRef(box), 200000);
      const rs = [];
      for (let r = 0; r < readers; r++)
        rs.push(s.spawn(reader, countedRef(box), 400000));
      ws.join();
      return rs.reduce((sum, th) => sum + th.join(), 0);
    });
    __collect();
    const after = heapStats();
    log(
      `race, ${readers} readers: bad reads ${bad}, heap grew ${(after.heapBytes - before.heapBytes) >> 10} KiB, blocks allocated ${after.allocated - before.allocated}, freed ${after.freed - before.freed}, pending ${after.pending}`,
    );
  } finally {
    release(box);
  }
}

// handles: uncompiled code uses the struct class; each handle holds a count
// until V8 collects it and the registry gives it back, which a worker does
// between threads
function handles(n: number) {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const node = new Node() as NodeHandle;
    node.value = i;
    node.next = new Node() as NodeHandle;
    sum += node.value + node.next.value;
  }
  return sum;
}

export function main(threadCounts: number[]) {
  churn();
  for (const n of threadCounts) race(Math.max(1, n - 1));
  const h0 = heapStats();
  scope(s => {
    s.spawn(handles, 100000).join();
  });
  // the worker finalizes its handles when V8 collects them: wait up to 2 s for
  // it
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  let h1 = heapStats();
  for (let k = 0; k < 40 && h1.freed - h0.freed < 200000; k++) {
    Atomics.wait(sleep, 0, 0, 50);
    h1 = heapStats();
  }
  log(
    `handles: blocks allocated ${h1.allocated - h0.allocated}, freed ${h1.freed - h0.freed} by the worker's registry`,
  );
  __collect();
  const s = heapStats();
  log(
    `end: blocks allocated ${s.allocated}, freed ${s.freed}, live ${s.allocated - s.freed}, pending ${s.pending}`,
  );
}

register(import.meta.url, {
  makeList,
  sum,
  churn,
  writer,
  reader,
  race,
  handles,
  main,
});
