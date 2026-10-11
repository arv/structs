// Reference counting (REFCOUNT.md) as the tsgo fork emits it: the compiler counts the references to
// shared structs, so a block is freed (and its memory reused) when nothing refers to it any more.
// churn: builds and drops a 1000-node list 200 times on one thread; the heap stops growing once the
// free lists hold a list's worth of blocks. race: one thread keeps replacing box.item with a fresh
// node while the others read box.item and its fields, pass it to a function, and now and then hold
// one in a local across a call that reaches quiescent points. A node whose check is not twice its
// value was freed and reused under its reader.
import { f64, heapStats, log, ref, scope, struct, type Struct, type Thread } from "threads";

interface Node { value: number; check: number; next: Node | null }
const Node = struct<Node>({ value: f64, check: f64, next: ref<Node>() });
const Box = struct({ item: ref<Node>() });
type Box = Struct<typeof Box>;

function makeList(n: number): Node | null {
  let head: Node | null = null;
  for (let i = 0; i < n; i++) {
    const node = new Node();
    node.value = i;
    node.check = 2 * i;
    node.next = head;
    head = node;
  }
  return head;
}

function sum(head: Node | null): number {
  let s = 0;
  for (let n = head; n !== null; n = n.next) s += n.value;
  return s;
}

function churn() {
  const before = heapStats();
  let total = 0;
  for (let round = 0; round < 200; round++) {
    const list = makeList(1000);
    total += sum(list);
    if (round % 20 === 0 || round === 199) log(`churn round ${String(round).padStart(3)}: heap ${heapStats().heapBytes >> 10} KiB`);
  }
  const after = heapStats();
  log(`churn: sum ${total}, blocks allocated ${after.allocated - before.allocated}, freed ${after.freed - before.freed}`);
}

// replaces box.item with a fresh node, `rounds` times: the old node's decrement waits for every
// thread's next quiescent point
function writer(box: Box, rounds: number): number {
  for (let i = 1; i <= rounds; i++) {
    const node = new Node();
    node.value = i;
    node.check = 2 * i;
    box.item = node;
    if (i % 50000 === 0) log(`writer at ${i}: heap ${heapStats().heapBytes >> 10} KiB, decrements pending ${heapStats().pending}`);
  }
  return 0;
}

// 1 if a node was freed and reused under its reader
function broken(node: Node | null): number {
  return node === null || node.check === 2 * node.value ? 0 : 1;
}

// reaches a quiescent point on every iteration (its loop reads a reference field)
function spin(box: Box, k: number): number {
  let seen = 0;
  for (let j = 0; j < k; j++) if (box.item !== null) seen++;
  return seen;
}

function reader(box: Box, rounds: number): number {
  let errors = 0;
  for (let i = 0; i < rounds; i++) {
    const item = box.item;                // retained: the local owns a count
    if (item !== null && item.check !== 2 * item.value) errors++;
    errors += broken(box.item);           // retained around the call
    if (i % 128 === 0 && item !== null) { // held across quiescent points
      const v = item.value;
      spin(box, 8);
      if (item.check !== 2 * v) errors++;
    }
  }
  return errors;
}

function race(readers: number) {
  const box = new Box();
  const before = heapStats();
  const errors = scope(s => {
    const w = s.spawn(writer, box, 200000);
    const rs: Thread<number>[] = [];
    for (let r = 0; r < readers; r++) rs.push(s.spawn(reader, box, 400000));
    w.join();
    let total = 0;
    for (const th of rs) total += th.join();
    return total;
  });
  box.item = null;
  const after = heapStats();
  log(`race, ${readers} readers: errors ${errors}, heap grew ${(after.heapBytes - before.heapBytes) >> 10} KiB, blocks allocated ${after.allocated - before.allocated}, freed ${after.freed - before.freed}, decrements pending ${after.pending}`);
}

// the thread counts come from the runner (the playground): a race per count, with a writer and
// count - 1 readers
export function main(threadCounts: readonly number[]) {
  churn();
  for (const threads of threadCounts) race(Math.max(1, threads - 1));
  const s = heapStats();
  log(`end: blocks allocated ${s.allocated}, freed ${s.freed}, allocated - freed ${s.allocated - s.freed}, decrements pending ${s.pending}`);
}
