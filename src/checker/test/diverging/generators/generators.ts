// Generators: a yielded or returned counted value goes into an IteratorResult, an ordinary object.
import { f64, ref, struct } from "threads";

interface Node { value: number; next: Node | null }
const Node = struct<Node>({ value: f64, next: ref<Node>() });

export function* gen(): Generator<Node, Node, void> {
  const n = new Node();
  yield n;                                   // error: yielded
  return new Node();                         // error: a generator's result
}
export async function* agen() {
  yield new Node();                          // error: yielded
}
export function* numbers(): Generator<number, number> {
  yield 1;                                   // fine: not counted
  return 2;
}
export function plain(): Node {
  return new Node();                         // fine: a function's result is counted
}
export async function* awaited() {
  yield Promise.resolve(new Node());         // error: yielded, once awaited
  return Promise.resolve(new Node());        // error: a generator's result, once awaited
}
declare function isNode(u: unknown): u is Node;
export async function* narrowed(u: unknown) {
  if (isNode(u)) yield u;                    // fine: a handle, boxed, with a count of its own
}
export function* outer(): Generator<Node, Node, void> {
  return yield* gen();                       // fine: delegated, the inner generator's to report
}
export function* outerToo(): Generator<Node, Node, void> {
  return (yield* gen());                     // fine: the same, in parentheses
}
