// Corners of the analysis: exports, narrowing, classes, generics, spreads, async code.
import { Channel, consume, f64, go, ref, scope, share, SharedArray, spawn, struct, type Sending, type Shared, type Struct } from "threads";

interface Node { value: number; next: Node | null }
const Node = struct<Node>({ value: f64, next: ref<Node>() });
const Point = struct({ x: f64, y: f64 });
type Point = Struct<typeof Point>;
declare const flag: boolean;
declare function use(...xs: unknown[]): void;
declare const ch: Channel<number[]>;

// An exported variable of top-level code is read through its local symbol.
export let exported = [1];
ch.send(exported);
use(exported);
let local = [1];
ch.send(local);
use(local);                                   // error

// Narrowed handles.
function isNode(x: unknown): x is Node { return x !== null; }
export function narrowed(u: unknown, list: unknown[]) {
  if (isNode(u)) {
    const pair = [u];                         // a handle: fine
    const obj = { u };                        // fine
    list.push(u);
    return [pair, obj];
  }
  return [];
}

// Classes and accessors.
export class Holder {
  #items: number[] = [];
  get items() { return this.#items; }
  set items(v: number[]) { this.#items = v; }
  give(c: Channel<number[]>) { c.send(this.#items); }   // error: this is the caller's
  static make(): Sending<Holder> { return new Holder(); }
}

// Constructors with Sending parameters, and consume in a new.
class Owner {
  constructor(public xs: Sending<number[]>) {}
}
export function owners() {
  const xs = [1];
  const o = new Owner(xs);
  use(xs);                                    // error: sent to Owner
  const ys = [2];
  const p = new Owner(consume(ys));
  use(ys);                                    // error: consumed
  return [o, p];
}

// Spread arguments to a rest parameter of Sending values.
export function spreads(args: [number[], number[]]) {
  const mine: [number[]] = [[1]];
  spawn((a: number[]) => a.length, ...mine);
  use(mine);                                  // error: sent to spawn
  spawn((a: number[], b: number[]) => a.length + b.length, ...args);   // error: the caller's
}

// Generic calls: a counted value through `identity` is a fresh one.
function identity<T>(x: T): T { return x; }
export function generic(c: Channel<Node>) {
  const n = new Node();
  const m = identity(n);
  c.send(n);
  return m.value;                             // not reported: not tracked through the call
}

// Async functions and awaits.
async function makeNode(): Promise<Node> { return new Node(); }
export async function asyncs(c: Channel<Node>) {
  const n = await makeNode();
  c.send(n);
  return n.value;                             // error: sent
}

// Optional calls, tagged templates, typeof, in, instanceof.
declare function tag(strings: TemplateStringsArray, ...values: unknown[]): number[];
export function misc(o: { f?: (x: Sending<number[]>) => void }, p: Point) {
  const xs = [1];
  o.f?.(xs);
  use(xs);                                    // error: sent
  const t = tag`${p} and ${xs}`;
  ch.send(t);
  use(typeof p, "x" in p, p instanceof Object, `${p}`);
  return t;                                   // error: sent
}

// Destructured parameters with defaults, and mutually recursive local functions.
export function params({ a = [1], b }: { a?: number[]; b: number[] }, [c]: number[][] = [[2]]) {
  function even(n: number): boolean { return n === 0 || odd(n - 1) || a.length > 0; }
  function odd(n: number): boolean { return n !== 0 && even(n - 1); }
  ch.send(b);                                 // error: the caller's
  ch.send(c!);                                // error: the caller's
  return even(3);
}

// SharedArrays of structs: elements alias their array.
export function arrays(c: Channel<SharedArray<Point>>) {
  const points = new SharedArray(Point, 3);
  const first = points[0]!;
  const nums = new SharedArray(Number, 3);
  nums[0] = first.x;
  c.send(points);
  go((q: Point) => use(q), first);            // error: first is in points' block
  return nums.length;
}

// Shared values from share() and Shared<T> declarations.
const table: Shared<number[]> = share([1, 2]);
export function tables(rows: Shared<number[]>[]) {
  for (const row of rows) row.push(1);        // error
  rows[0]!.push(2);                           // error
  (table as number[]).push(3);                // error
  return scope((s) => s.spawn((t: Shared<number[]>) => t.length, table));
}

// Labeled blocks, for-in, comma, void and delete.
export function statements(o: Record<string, number[]>) {
  const xs = [1];
  block: {
    if (flag) break block;
    ch.send(xs);
  }
  use(xs);                                    // error: may have been sent
  for (const k in o) {
    void ch.send(o[k]!);                      // error: the caller's
    delete o[k];
  }
  const ys = [2];
  const zs = (use(ys), ys);
  ch.send(zs);
  return ys;                                  // error: shares objects with zs
}

// Object literal methods take their parameter and return types from the literal's contextual type.
interface Handler { take(xs: Sending<number[]>): void; give(): Sending<number[]> }
declare function register(h: Handler): void;
export function methods(c: Channel<number[]>, mine: number[]) {
  register({
    take(xs) { c.send(xs); },                 // fine: xs is Sending
    give() { return mine; },                  // error: the caller's
  });
}

// The fork resolves a reference to an exported function or class to its local export symbol, whose
// value it takes for a captured one: the result of calling it cannot be sent (a false positive,
// kept for parity).
export function makeArray(): number[] { return [1]; }
function makeLocal(): number[] { return [1]; }
export function callsExported(c: Channel<number[]>) {
  const xs = makeArray();
  c.send(xs);                                 // error (the fork's): captured from an outer scope
  const ys = makeLocal();
  c.send(ys);                                 // fine
}
