// Threads for JavaScript in plain TypeScript: own and shared values, shared structs, and channels.
//
// Code written against these types is ordinary TypeScript: tsc, editors, linters and formatters
// accept it as it is. Two tools add what the types cannot say:
//   - the ownership checker (`tsgo own check`, from the tsgo fork) runs in CI like a linter and
//     proves the rules below: nothing is used after it is sent, and shared values never change;
//   - the bundler plugin (vite-plugin-threads.mjs) compiles shared structs and SharedArrays to
//     typed-array accesses on shared memory, counts their references, and registers the functions
//     threads run.
//
// Every value a thread touches is one of three kinds:
//   - owned, the default: an ordinary object only one thread can reach. `Sending<T>` moves it: the
//     caller gives it up and the receiver owns it;
//   - shared: `Shared<T>`, deeply immutable, so any number of threads may read it;
//   - a cell: shared and mutable, but only through what synchronizes it (Barrier, Slots, Channel), or,
//     for shared structs and SharedArrays, in place, ordered by one of those.

declare const cellBrand: unique symbol;
declare const fieldBrand: unique symbol;

/** A cell: shared and mutable. Any number of threads may hold the same one. */
export interface Cell {
  readonly [cellBrand]: true;
}

/**
 * A value whose ownership moves, on a parameter or a result: the caller must not use it, or anything
 * it reaches, afterwards. The ownership checker enforces this; to TypeScript it is just T.
 */
export type Sending<T> = T;

/** A deeply immutable value, which any number of threads may read. To TypeScript it is deeply readonly. */
export type Shared<T> = T extends Cell | ((...args: any[]) => any) ? T
  : T extends object ? { readonly [K in keyof T]: Shared<T[K]> }
  : T;

/** Ends `x`'s lifetime: its value, and what it reaches, moves to the caller. At run time, `x` itself. */
export declare function consume<T>(x: T): Sending<T>;

/** Freezes a value the caller owns into a deeply immutable value every thread can read. */
export declare function share<T>(value: Sending<T>): Shared<T>;

// ---- shared structs ----

/** A field of a shared struct, declared with `f64`, `bool` or `ref<T>()`. */
export interface Field<T> {
  readonly [fieldBrand]: T;
}
/** A number field: an f64 in shared memory. */
export declare const f64: Field<number>;
/** A boolean field: a byte in shared memory, 0 or 1. */
export declare const bool: Field<boolean>;
/** A reference field: a shared struct or a SharedArray, or null. */
export declare function ref<T>(): Field<T | null>;

/** What `struct(...)` returns: `new S()` makes a zeroed struct in shared memory. */
export interface StructType<T> {
  new (): T & Cell;
  readonly fields: readonly string[];
}
/** The value type of a struct type: `type Body = Struct<typeof Body>`. */
export type Struct<S> = S extends StructType<infer T> ? T & Cell : never;

/**
 * Declares a shared struct: fields at fixed places in shared memory, which every thread reads and
 * writes in place. Reads and writes are not ordered between threads: a Barrier or a Channel orders
 * them.
 *
 *     const Body = struct({ x: f64, y: f64, m: f64 });
 *     type Body = Struct<typeof Body>;
 *
 * A struct that refers to its own type is declared with an interface:
 *
 *     interface Node { value: number; next: Node | null }
 *     const Node = struct<Node>({ value: f64, next: ref<Node>() });
 */
export declare function struct<F extends Record<string, Field<any>>>(
  fields: F,
): StructType<{ -readonly [K in keyof F]: F[K] extends Field<infer V> ? V : never }>;
export declare function struct<T>(fields: { [K in keyof T]-?: Field<T[K]> }): StructType<T>;

/**
 * A fixed-length array in shared memory, of numbers, of booleans (a byte each) or of shared structs
 * stored inline. Every thread reads and writes the same elements, with no copying; a Barrier or a
 * Channel orders them.
 */
export interface SharedArray<T> extends Cell {
  readonly length: number;
  [index: number]: T;
}
export declare const SharedArray: {
  new (type: NumberConstructor, length: number): SharedArray<number>;
  new (type: BooleanConstructor, length: number): SharedArray<boolean>;
  new <T>(type: StructType<T>, length: number): SharedArray<T & Cell>;
};

// ---- threads ----

/** A thread; joining it moves the thread's result back. */
export interface Thread<R> extends Cell {
  /** Waits for the thread, from a thread that may block (not a page's main thread). */
  join(): Sending<R>;
  /** Waits for the thread without blocking: for a page's main thread. */
  joinAsync(): Promise<Sending<R>>;
}

/** Starts `f` on a thread. Every argument is sent: owned values move, shared values and cells are shared. */
export declare function spawn<A extends unknown[], R>(f: (...args: A) => Sending<R>, ...args: Sending<A>): Thread<R>;

/** Spawns threads that cannot outlive the scope. */
export interface Scope extends Cell {
  spawn<A extends unknown[], R>(f: (...args: A) => Sending<R>, ...args: Sending<A>): Thread<R>;
}
/** Runs `body` and joins every thread it spawned before returning. */
export declare function scope<R>(body: (s: Scope) => R): R;

/** Splits an owned array into `parts` owned, disjoint chunks of nearly equal size. Trusted. */
export declare function partition<T>(items: Sending<T[]>, parts: number): Sending<T[]>[];
/** Takes element `index` out of an array of owned values, so the caller owns it. Trusted. */
export declare function take<T>(items: Sending<T>[], index: number): Sending<T>;

/** A reusable barrier for a fixed number of threads. */
export declare class Barrier implements Cell {
  readonly [cellBrand]: true;
  constructor(threads: number);
  /** Blocks until all threads have called `wait`. */
  wait(): void;
}

/** One slot per thread: a thread publishes a shared value into its slot, and everyone reads every slot. */
export declare class Slots<T> implements Cell {
  readonly [cellBrand]: true;
  constructor(count: number);
  readonly length: number;
  set(index: number, value: Shared<T>): void;
  get(index: number): Shared<T> | undefined;
  /** The arrays in all slots, concatenated in slot order. */
  flat(): Shared<T extends readonly (infer E)[] ? E[] : T[]>;
}

// ---- goroutines and channels ----

/** A channel: values move through it from thread to thread, in order. */
export declare class Channel<T> implements Cell {
  readonly [cellBrand]: true;
  /** Holds up to `capacity` values; 0, the default, is unbuffered. */
  constructor(capacity?: number);
  /** Moves `value` in: waits while the channel is full, or, unbuffered, until a receiver takes it. */
  send(value: Sending<T>): void;
  /** The next value, which the caller now owns; waits while empty. Undefined once closed and empty. */
  recv(): Sending<T> | undefined;
  /** No more sends. Receivers still get what is left. */
  close(): void;
  [Symbol.iterator](): Iterator<T>;
}
/** Starts `f` on a thread of its own, a goroutine. Nothing waits for it. */
export declare function go<A extends unknown[]>(f: (...args: A) => void, ...args: Sending<A>): void;
/** Waits until one of the channels has a value or is closed: its index and the value (undefined if closed). */
export declare function select<T>(...channels: Channel<T>[]): [index: number, value: T | undefined];

/** Prints a line, synchronously, from any thread. */
export declare function log(...args: unknown[]): void;
/** Shared memory in use, and shared structs and SharedArrays allocated and freed. */
export declare function heapStats(): { heapBytes: number; allocated: number; freed: number; pending: number };
