// A Thread or a Scope stays on the thread that made it: neither is a cell, and the runtime refuses
// to send or share one, or to store one in a struct's field.
import { Channel, f64, go, partition, ref, scope, share, SharedMap, SharedSet, spawn, struct, type Scope, type Sending, type Shared, type Thread } from "threads";

function inner(): number { return 1; }
function joiner(t: Thread<number>): number { return t.join(); }
function spawner(s: Scope): void { s.spawn(inner); }
function outer(): Thread<number> { return spawn(inner); }
async function later(): Promise<Thread<number>> { return spawn(inner); }
function holder(h: { ts: Thread<number>[] }): void { h.ts[0]!.join(); }

export function sent(ch: Channel<Thread<number>>, m: SharedMap<string, Thread<number>>) {
  spawn(joiner, spawn(inner));               // error: a thread's argument
  spawn(spawner, scope(s => s));             // error: a Scope, kept past its body
  go(holder, { ts: [spawn(inner)] });        // error: in a goroutine's argument, nested
  ch.send(spawn(inner));                     // error: a channel's message
  m.set("t", spawn(inner));                  // error: a map's value
  share([spawn(inner)]);                     // error: shared
  spawn(outer).join();                       // error: a thread's result, which moves to the joiner
  spawn(later);                              // error: an async thread's result
}

interface Holder { t: Thread<number> | null; x: number }
const Holder = struct<Holder>({ t: ref<Thread<number>>(), x: f64 }); // error: no field holds a Thread (as the fork says)

export function fine(ts: Sending<Thread<number>[]>, s: Scope) {
  const kept = [spawn(inner), s.spawn(inner)]; // fine: an ordinary array on this thread
  partition(ts, 2);                          // fine: split on this thread
  spawn(inner).join();                       // fine: joined where it was spawned
  return kept.map(t => t.join());
}

// From the review: a Thread or a Scope behind a type parameter's constraint or in an intersection,
// a map's or a set's entries iterated, a map's computed value, and a tuple spread into arguments.
export function constrained<T extends Thread<number>, S extends Scope>(t: Sending<T>, s: Sending<S>) {
  share(t);                                  // error: a Thread, as T's constraint says
  share({ s });                              // error: a Scope, as S's constraint says
}
export function intersected() {
  share(Object.assign(spawn(inner), { tag: 1 })); // error: a Thread, with more
  share(Object.assign(scope(s => s), { tag: 1 })); // error: a Scope, with more
}
export function iterated(m: SharedMap<string, Thread<number>>) {
  new SharedSet(new Set([spawn(inner)]));    // error: a set's values, shared one by one
  new SharedMap(new Map([["t", spawn(inner)]])); // error: a map's entries, shared one by one
  m.getOrInsertComputed("t", () => spawn(inner)); // error: a computed value, shared
  new SharedSet(new Set([1]));               // fine
}
declare const toSpawn: [typeof joiner, Thread<number>];
declare const toGo: [typeof holder, { ts: Thread<number>[] }];
declare const toScope: [typeof spawner, Scope];
export function spreads(s: Scope) {
  spawn(...toSpawn);                         // error: a thread's argument, spread
  go(...toGo);                               // error: a goroutine's argument, spread
  s.spawn(...toScope);                       // error: a Scope, spread
  spawn(joiner, ...[spawn(inner)] as const); // error: spread after an argument
}

// From the second review: an interface that extends a Thread or a Scope, and an iterable that holds a
// Thread beside what its iteration gives, which is all a set takes.
interface LocalThread extends Thread<number> { readonly local?: true }
interface LocalScope extends Scope { readonly local?: true }
export function inherited(t: Sending<LocalThread>, s: Sending<LocalScope>) {
  share(t);                                  // error: a Thread, as LocalThread extends one
  share([s]);                                // error: a Scope, as LocalScope extends one
}
export function iteratedOnly() {
  const values = { thread: spawn(inner), *[Symbol.iterator]() { yield 1; } };
  return new SharedSet(values);              // fine: only what its iteration gives is shared
}

// From the third review: a mapped view of a Thread or a Scope, an overloaded callback whose other
// overload returns a Thread, and a spread of a union of tuples (into a generic rest: TypeScript
// refuses one into a tuple's, as `m.set(...entry)`, TS2556).
export function views(t: Sending<Readonly<Thread<number>>>, s: Sending<Readonly<Scope>>, p: Sending<Partial<Thread<number>>>) {
  share(t);                                  // error: a Thread, read only
  share(s);                                  // error: a Scope, read only
  share(p);                                  // error: a Thread, in part
}
declare function computed(key: string): Thread<number>;
declare function computed(key: number): number;
export function overloads(m: SharedMap<number, number>, n: SharedMap<string, Thread<number>>) {
  m.getOrInsertComputed(1, computed);        // fine: called with a number, it returns a number
  n.getOrInsertComputed("t", computed);      // error: called with a string, it returns a Thread
}
function pair(t: Thread<number>, n?: number): number { return t.join() + (n ?? 0); }
export function unionSpread(both: Sending<[Thread<number>] | [Thread<number>, number]>) {
  spawn(pair, ...both);                      // error: a thread's argument, in either tuple
}

// From the fourth review: a mapped view of a constrained type parameter or of an intersection, one
// of Shared<T>, whose properties are a Thread's own, and a mapped type that makes something else of
// a Thread's properties, which is checked by what it makes.
type Flags<T> = { [K in keyof T]: T[K] extends (...args: any[]) => any ? boolean : string };
export function sourced<T extends Thread<number>, S extends Scope>(t: Sending<Readonly<T>>, s: Sending<Readonly<S>>) {
  share(t);                                  // error: a Thread, as T's constraint says
  share(s);                                  // error: a Scope, as S's constraint says
}
export function viewsOfMore(t: Sending<Readonly<Thread<number> & { tag: number }>>, s: Sending<Partial<Scope & { tag: number }>>, u: Sending<Shared<Thread<number>>>) {
  share(t);                                  // error: a Thread, with more
  share(s);                                  // error: a Scope, with more
  share(u);                                  // error: a Thread, shared
}
export function transformed(flags: Sending<Flags<Thread<number>>>) {
  share(flags);                              // fine: booleans, made of a Thread's properties
}
