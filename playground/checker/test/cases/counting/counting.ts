// Errors of reference counting: what the emit cannot count (ownLayoutRefCountErrors, in the plain API).
import { f64, ref, struct, type SharedArray, type Struct } from "threads";

interface Node { value: number; next: Node | null }
const Node = struct<Node>({ value: f64, next: ref<Node>() });
type NodeValue = Struct<typeof Node>;

let current: Node | null = null;             // a module's variable, which functions capture
export function setCurrent(n: Node) {
  current = n;                               // error: captured and reassigned
}
export function readCurrent() {
  return current;
}

export function captured(head: Node) {
  let n = head;
  const f = () => n.value;
  n = new Node();                            // error: captured and reassigned
  return f;
}

export function containers(n: Node, list: Node[]) {
  const array = [n];                         // error: an address in an ordinary array
  const object = { n };                      // error: in an ordinary object
  const named = { node: n };                 // error
  list[0] = n;                               // error
  const holder: { node: Node | null } = { node: null };
  holder.node = n;                           // error
  const boxed: unknown[] = [n];              // a handle: fine
  const mixed = [n, 1];                      // a handle (the element type is not a struct): fine
  const either = [Math.random() > 0.5 ? n : null];
  return [array, object, named, boxed, mixed, either];
}

export class Holder {
  node: Node = new Node();                   // error
  constructor(public other: Node) {}         // error
}

export function destructuring(pair: { a: Node; b: number }, list: Node[]) {
  const { a, b } = pair;                     // error: a
  let x: Node | null = null;
  [x] = list;                                // error
  for (const n of list) {}                   // error: a for-of variable
  let m: Node | null = null;
  for (m of list) {}                         // error
  return [a, b, x, m];
}

export function members(n: Node) {
  const o = { get value() { return n.value; } };   // error: a method captures n
  class C { v = n.value; }                          // error: a class captures n
  const arrow = () => n.value;                      // fine
  return [o, C, arrow];
}

export function* generator(n: Node) {         // error: a generator runs after its caller's borrow ends
  yield n.value;
}

export function rest(...nodes: Node[]) {      // error: the arguments are stored in an ordinary array
  return nodes.length;
}

export function values(v: NodeValue, a: SharedArray<number>) {
  const pair = [v, a];                        // error
  const tagged = { v: v as NodeValue };        // error
  const zero = { v: null };                    // fine
  return [pair, tagged, zero];
}

// Fields of `struct(...)`: numbers or references.
const Bad = struct({
  x: f64,
  name: "x" as any,                          // error (any is not a field)
  0: f64,                                    // error: a numeric name
});
const NotLiteral = struct(Object.create(null));   // error: not an object literal
export { Bad, NotLiteral };
