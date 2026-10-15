// A spread argument's values go into the parameters from its place on, a
// tuple's each into its own and an array's into the rest, and are checked as
// arguments of their types are: an integer's parameter takes integers. The fork
// does not check what a spread passes.
import { type i32 } from "threads";

function take(k: i32): i32 { return k; }
function takeAll(...ks: i32[]): number { return ks.length; }
const halves = [0.5] as const;
const threes = [3] as const;
declare const numbers: number[];

export function spreads() {
  take(...halves);                 // error: a fraction for an i32
  takeAll(...numbers);             // error: numbers for i32s
  return take(...threes);          // fine: an integer
}
// an iteration's values, whatever iterates them
export function iterated() {
  return takeAll(...new Set<number>([0.5]));  // error: numbers for i32s
}
// the places a spread fills: a tuple's length, none for an empty one, an
// unknown number past an optional element or an iteration
function third(a: number, b: number, c: i32): i32 { return c; }
function second(a: number, b: i32, c: number): i32 { return b; }
const pair = [1, 2] as const;
const none = [] as const;
declare const optional: [number?];
declare function maybeSecond(a: number | undefined, b: i32, c?: number): i32;
export function places() {
  third(...pair, ...halves);       // error: the fraction goes to c
  second(...pair, ...halves);      // fine: b takes the 2
  take(...none, 0.5);              // error: the fraction goes to k
  return maybeSecond(...optional, 0.5, 1);  // error: the fraction may go to b
}
// and where a value is sent
import { type Sending } from "threads";
declare function sendFirst(xs: Sending<number[]>, n?: number): void;
declare function use(...values: unknown[]): void;
export function sentPastEmptySpread() {
  const xs = [1];
  sendFirst(...none, xs);
  use(xs);                         // error: xs was sent
}
// an optional element is at its own place, when it is there, and its
// undefined is no value stored
declare const sparse: [undefined?, number?];
declare function firstInt(first?: i32, second?: number): void;
declare const someInts: [i32?];
declare function maybeTake(k?: i32): void;
export function optionals() {
  firstInt(...sparse);             // fine: the number goes to second
  maybeTake(...someInts);          // fine: an i32, if anything
}
// a rest typed a tuple: its elements' places, then its tail's
declare function headThenInts(...args: [head?: number, ...tail: i32[]]): void;
export function tupleRest() {
  headThenInts(...numbers);        // error: numbers for the i32 tail
}
// a spread of nothing sends nothing, whatever came before it
declare function sink(...values: Sending<number[]>[]): void;
export function emptyAfterUnknown() {
  const lists = [[1]];
  sink(...lists, ...none);         // fine: none passes nothing
}
// a union of tuples, each by its own places
declare const unionArgs: [number, i32] | [number, i32, i32];
declare function numThenInts(...args: [number, i32] | [number, i32, i32]): void;
// an optional element before a rest is there when the rest has elements
declare const optHead: [head?: i32, ...tail: number[]];
declare function sameRest(...args: [head?: i32, ...tail: number[]]): void;
// a rest tuple's tail however far past its elements
declare function longRest(...args: [n0?: number, n1?: number, n2?: number, n3?: number, n4?: number, n5?: number, n6?: number, n7?: number, n8?: number, n9?: number, n10?: number, n11?: number, n12?: number, n13?: number, n14?: number, n15?: number, n16?: number, n17?: number, n18?: number, n19?: number, n20?: number, n21?: number, n22?: number, n23?: number, n24?: number, n25?: number, n26?: number, n27?: number, n28?: number, n29?: number, n30?: number, n31?: number, n32?: number, n33?: number, ...tail: i32[]]): void;
export function forwarded() {
  numThenInts(...unionArgs);       // fine
  sameRest(...optHead);            // fine
  longRest(...numbers);            // error: numbers for the i32 tail
}
// an element after a rest is past the rest's elements, which may be none
declare const trailing: [...i32[], number];
declare function headInt(...values: [head?: i32, ...tail: number[]]): void;
export function afterEmptyRest() {
  headInt(...trailing);            // error: the number may be the head
}
// a generic rest's places are its instantiation's
declare function forward<A extends unknown[]>(...args: A): void;
export function forwardedGenerically() {
  forward<Parameters<typeof longRest>>(...numbers);  // error: numbers for the i32 tail
}
// a rest typed a union of tuples takes the most places of theirs
declare function unionRest(...args: [head?: number, ...tail: i32[]] | [head?: string, ...tail: i32[]]): void;
export function spreadIntoUnionRest() {
  unionRest(...numbers);           // error: numbers for the i32 tail
}
// what is any may hold anything
declare const anyValues: any;
// a generic's rest as an instantiation expression, or a specialized type, has it
const forwardLong = forward<Parameters<typeof longRest>>;
interface Forward<A extends unknown[]> { (...args: A): void }
declare const forwardTyped: Forward<Parameters<typeof longRest>>;
export function instantiated() {
  takeAll(...anyValues);           // error: anything for i32s
  forwardLong(...numbers);         // error: numbers for the i32 tail
  forwardTyped(...numbers);        // error
}
// what a spread sends is its values that reach a Sending parameter: numbers,
// which are no one's, leave it as it was
declare function label(name: number, value: Sending<number>): void;
declare class Labeled { constructor(name: number, value: Sending<number>); }
export function spreadPrimitives() {
  const args: [number, number] = [0, 1];
  label(...args);
  new Labeled(...args);
  use(args);                       // fine
}
// a spread starts where it does, however long it is
declare function headThenSent(head: number[], ...tail: Sending<number[]>): void;
export function objectHeadPrimitiveTail() {
  const args: [number[], ...number[]] = [[1], 2];
  headThenSent(...args);
  use(args);                       // fine: the array goes to head
}
