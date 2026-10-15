// What threads-check compiles differently from the fork, which gets these
// wrong (compile.test.ts tests them, and emit-compare.ts knows they differ).
import {f64, SharedArray, struct, type Struct} from 'threads';

const Node = struct({value: f64});
type Node = Struct<typeof Node>;

function read(n: Node): number {
  return n.value;
}

// an arrow whose concise body is a closure, with an owned parameter's
// default: the default still runs
export const later =
  (p: Node = new Node()) =>
  () =>
    p.value;

// defaults run left to right: b's sees a's
export function ordered(a: Node = new Node(), b: Node = a): boolean {
  return a === b;
}

// a default with temporaries of its own runs in the body, which declares them
export function counted(n = read(new Node())): number {
  return n;
}

// the array is read before the index that assigns it
export function receiver(a: SharedArray<number>, b: SharedArray<number>) {
  return a[((a = b), 0)];
}

// a scalar element type's expression still runs
let calls = 0;
export function made(n: number): SharedArray<number> {
  return new SharedArray((calls++, Number), n);
}
export const madeCalls = () => calls;

// a class's heritage is a full expression: the array it reads before the
// index that assigns it is released
let first = new SharedArray(Number, 1);
const second = new SharedArray(Number, 1);
export let element = 0;
class Base {}
export class Derived extends ((element = first[((first = second), 0)]), Base) {}

// a default that moves after an optional parameter: the parameter stays
// optional, so the types still strip
export function afterOptional(o?: Node, p: Node = new Node(), q: Node = p) {
  return q === p && o === undefined;
}
