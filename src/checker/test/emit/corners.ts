// Corners of the lowering, compiled by both compilers and compared
// (emit-compare.ts): owned locals in a loop's head and under a label,
// parameters with defaults, logical assignments, strings, channel fields,
// booleans, i32 and u8 elements, atomics, closures that capture, concise
// bodies that need temporaries, continue in a quiescent loop, a receive loop.
import {
  atomic,
  bool,
  Channel,
  consume,
  f64,
  i32,
  Lock,
  ref,
  scope,
  SharedArray,
  SharedMap,
  str,
  struct,
  u8,
  type Struct,
} from 'threads';

interface Node {
  value: number;
  next: Node | null;
  name: string;
  on: boolean;
}
const Node = struct<Node>({value: f64, next: ref<Node>(), name: str, on: bool});
const Box = struct({item: ref<Node>(), other: ref<Node>(), n: i32, b: u8});
type Box = Struct<typeof Box>;
interface Guard {
  lock: Lock | null;
  count: i32;
}
const Guard = struct<Guard>({lock: ref<Lock>(), count: i32});

export function labeled(head: Node | null): number {
  let s = 0;
  outer: for (let n = head; n !== null; n = n.next) {
    for (let m = n.next; m !== null; m = m.next) {
      if (m.value < 0) continue outer;
      if (m.value === 0) continue;
      s += m.value;
    }
  }
  return s;
}

export function defaults(a: Node = new Node(), b?: Node): Node {
  if (b) a.next = b;
  return a;
}

export function logical(box: Box, other: Node | null): Node | null {
  let x: Node | null = null;
  x ||= new Node();
  x ??= other;
  x &&= other;
  box.item ||= new Node();
  box.item ??= other;
  box.item &&= x;
  return x;
}

export function strings(n: Node, names: SharedArray<string>, i: number) {
  n.name = 'a';
  n.name += 'b';
  n.name ||= 'c';
  n.name ??= 'd';
  names[i] = n.name;
  names[i] += '!';
  const copy = (n.name = 'e');
  return copy + names[i + 1];
}

export function channels(g: Struct<typeof Guard>, l: Lock) {
  g.lock = l;
  const k = (g.lock = new Lock());
  atomic.add(g, 'count', 1);
  return k;
}

export function bytes(
  box: Box,
  flags: SharedArray<boolean>,
  small: SharedArray<u8>,
  ints: SharedArray<i32>,
  i: number,
) {
  box.b = 3;
  box.n = box.b + 1;
  flags[i] = !flags[i + 1];
  flags[i] ||= true;
  flags[i] &&= false;
  small[i] = small[i]! + 1;
  ints[i] = ints[i]! | 0;
  atomic.compareExchange(ints, i * 2, 0, 1);
  for (let j = 0; j < ints.length; j++) ints[j] = j;
  return box.n;
}

export function closures(head: Node): number {
  const list = new Node();
  list.next = head;
  function inner() {
    return list.value + head.value;
  }
  const arrow = () => list.next!.value;
  const concise = (x: Node) => (x.next ?? new Node()).value;
  return inner() + arrow() + concise(list);
}

export function quiescent(box: Box): number {
  let k = 0;
  while (k < 10) {
    k++;
    if (box.item === null) continue;
    k += box.item.value;
  }
  do {
    k--;
  } while (box.item !== null && k > 0);
  return k;
}

export function receive(ch: Channel<Node>): number {
  let s = 0;
  for (const n of ch) s += n.value;
  return s;
}

export function moves(
  map: SharedMap<string, Struct<typeof Node>>,
  n: Struct<typeof Node>,
) {
  const x = map.getOrInsertComputed('k', () => new Node());
  scope(s => {
    s.spawn(receiveOne, consume(n));
  });
  return x.value;
}

function receiveOne(n: Struct<typeof Node>): number {
  return n.value;
}

export function elements(
  nodes: SharedArray<Struct<typeof Node>>,
  i: number,
): number {
  const first = nodes[0]!;
  let t = nodes[i]!.value + nodes[i + 1]!.value;
  for (let j = 0; j < nodes.length; j++) t += nodes[j]!.value;
  return t + first.value;
}

export function returns(a: Node, which: boolean): Node {
  const b = new Node();
  const c = new Node();
  return which ? b : c;
}
