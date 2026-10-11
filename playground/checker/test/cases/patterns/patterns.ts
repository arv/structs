// Object destructuring assignments: the fork's own check panics on them (checkOwnRefCounts calls
// Elements() on the object literal pattern), so this case is compared with test/expected only.
import { f64, ref, struct } from "threads";

interface Node { value: number; next: Node | null }
const Node = struct<Node>({ value: f64, next: ref<Node>() });

export function patterns(pair: { a: Node; b: number }, holder: { node: Node | null }) {
  let a: Node | null = null;
  let b = 0;
  ({ a, b } = pair);                         // error: a
  ({ a: holder.node } = pair);               // error: node
  ({ b, ...holder } = { b: 1, node: null }); // fine
  return [a, b];
}
