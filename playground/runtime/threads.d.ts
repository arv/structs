// Threads for JavaScript in plain TypeScript: own and shared values, shared structs, and channels.
//
// Code written against these types is ordinary TypeScript: tsc, editors, linters and formatters
// accept it as it is. Two tools add what the types cannot say:
//   - the ownership checker (`tsgo own check`, from the tsgo fork) runs in CI like a linter and
//     proves the rules below: nothing is used after it is sent, and shared values never change;
//   - the bundler plugin (vite-plugin-threads.js) compiles shared structs and SharedArrays to
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
declare const int32Brand: unique symbol;
declare const uint8Brand: unique symbol;
declare const layoutBrand: unique symbol;

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

/** A field of a shared struct, declared with `f64`, `i32`, `u8`, `bool`, `str` or `ref<T>()`. */
export interface Field<T> {
  readonly [fieldBrand]: T;
}
/** A number field: an f64 in shared memory. */
export declare const f64: Field<number>;

/**
 * A 32-bit integer: a number, which the field or element it is stored in keeps as an Int32Array would
 * (2 ** 31 as -(2 ** 31)). Atomic operations act on i32s (see `atomic`). The ownership checker
 * requires an integer of a value stored into one (or passed or returned as one): integer arithmetic,
 * which wraps, but not a number that may have a fraction, which must be converted explicitly, as with
 * Math.round(x), Math.trunc(x) or x | 0.
 */
export type i32 = number & { readonly [int32Brand]?: never };
/** An 8-bit unsigned integer: a number, kept as a Uint8Array would (256 as 0, and -1 as 255). As an i32's, its values must be integers. */
export type u8 = number & { readonly [uint8Brand]?: never };
/** The field of an integer, which a SharedArray also takes as its element type. */
export interface IntegerField<T, K extends "i32" | "u8"> extends Field<T> {
  readonly kind: K;
}
/** An i32 field: a 32-bit integer in shared memory, which atomic operations act on. */
export declare const i32: IntegerField<i32, "i32">;
/** A u8 field: a byte in shared memory. */
export declare const u8: IntegerField<u8, "u8">;
/** A boolean field: a byte in shared memory, 0 or 1. */
export declare const bool: Field<boolean>;
/**
 * A string field: the address of the string's one copy in shared memory. Strings are interned, so
 * each distinct string is stored once, and each thread decodes it once. They are never freed.
 */
export declare const str: Field<string>;
/**
 * A reference field: a shared struct, a SharedArray or a Channel, or null. A channel lives as long as
 * the program, so a struct can hand one to any thread: `struct({ changed: ref<Channel<void>>() })`.
 */
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
 * A fixed-length array in shared memory: of numbers (`Number`), of i32s (`i32`), of bytes (`u8`), of
 * booleans (`Boolean`, a byte each), of strings (`String`, interned as `str` fields are), or of shared
 * structs stored inline. Every thread reads and writes the same elements, with no copying; a Barrier,
 * a Channel or an atomic operation orders them.
 */
export interface SharedArray<T, L = ElementLayout<T>> extends Cell {
  readonly length: number;
  [index: number]: T;
  /**
   * Not there at run time: L keeps SharedArrays of numbers, i32s and u8s apart, whose elements
   * TypeScript would otherwise let one stand for another, though they are stored differently. (A
   * property of type ElementLayout<T> would not: TypeScript relates two SharedArrays by T alone.)
   */
  readonly [layoutBrand]?: L;
}
/** How a SharedArray of T stores its elements, as far as telling numbers, i32s and u8s apart goes. */
type ElementLayout<T> = typeof int32Brand extends keyof T ? "i32" : typeof uint8Brand extends keyof T ? "u8" : "other";
export declare const SharedArray: {
  new (type: NumberConstructor, length: number): SharedArray<number>;
  new (type: BooleanConstructor, length: number): SharedArray<boolean>;
  new (type: StringConstructor, length: number): SharedArray<string>;
  new (type: IntegerField<i32, "i32">, length: number): SharedArray<i32>;
  new (type: IntegerField<u8, "u8">, length: number): SharedArray<u8>;
  new <T>(type: StructType<T>, length: number): SharedArray<T & Cell>;
};

// ---- atomic operations ----

/** The fields of a struct type S that are i32s. */
export type I32Fields<S> = { [K in keyof S]-?: typeof int32Brand extends keyof S[K] ? K : never }[keyof S];

/**
 * An atomic operation on an element of a SharedArray<i32>, or on an i32 field of a shared struct
 * (whose value may be typed by an interface, without Cell: the ownership checker makes sure it is a
 * shared struct).
 */
export interface AtomicOperation<A extends unknown[], R> {
  (array: SharedArray<i32>, index: number, ...args: A): R;
  <S extends object>(struct: S, field: I32Fields<S>, ...args: A): R;
}

/**
 * Atomic operations, which `Atomics` performs: on an element of a SharedArray<i32>, or on an i32 field
 * of a shared struct, named by a string literal. Each is indivisible, and orders the reads and writes
 * around it as a lock would. Compiled, a call is that `Atomics` call, on the i32 itself:
 *
 *     const Work = struct({ next: i32, done: i32 });
 *     for (let i; (i = atomic.add(work, "next", 1)) < n; ) process(i);   // claims item i
 */
export interface Atomic {
  /** The i32's value. */
  readonly load: AtomicOperation<[], i32>;
  /** Stores `value`, and returns it. */
  readonly store: AtomicOperation<[value: i32], i32>;
  /** Adds `value`, and returns the old value. */
  readonly add: AtomicOperation<[value: i32], i32>;
  /** Subtracts `value`, and returns the old value. */
  readonly sub: AtomicOperation<[value: i32], i32>;
  /** Stores the bitwise and of the i32 and `value`, and returns the old value. */
  readonly and: AtomicOperation<[value: i32], i32>;
  /** Stores the bitwise or of the i32 and `value`, and returns the old value. */
  readonly or: AtomicOperation<[value: i32], i32>;
  /** Stores the bitwise xor of the i32 and `value`, and returns the old value. */
  readonly xor: AtomicOperation<[value: i32], i32>;
  /** Stores `value`, and returns the old value. */
  readonly exchange: AtomicOperation<[value: i32], i32>;
  /** Stores `replacement` if the i32 is `expected`, and returns the old value either way. */
  readonly compareExchange: AtomicOperation<[expected: i32, replacement: i32], i32>;
  /**
   * Waits while the i32 is `value`, until notify() wakes the thread or `timeout` ms pass. Not on a
   * page's main thread, which must not block, nor in an async function, which shares its worker.
   */
  readonly wait: AtomicOperation<[value: i32, timeout?: number], "ok" | "not-equal" | "timed-out">;
  /** Wakes up to `count` threads waiting on the i32 (all of them by default); returns how many it woke. */
  readonly notify: AtomicOperation<[count?: number], number>;
}
export declare const atomic: Atomic;

// ---- threads ----

/** A thread; joining it moves the thread's result back. */
export interface Thread<R> extends Cell {
  /** Waits for the thread, from a thread that may block (not a page's main thread). */
  join(): Sending<R>;
  /** Waits for the thread without blocking: for a page's main thread, or an async function. */
  joinAsync(): Promise<Sending<R>>;
}

/**
 * Starts `f` on a thread. Every argument is sent: owned values move, shared values and cells are shared.
 * An async function's thread is light: a worker runs it among many others (see `go`).
 */
export declare function spawn<A extends unknown[], R>(f: (...args: A) => Promise<Sending<R>>, ...args: Sending<A>): Thread<R>;
export declare function spawn<A extends unknown[], R>(f: (...args: A) => Sending<R>, ...args: Sending<A>): Thread<R>;

/** Spawns threads that cannot outlive the scope. */
export interface Scope extends Cell {
  spawn<A extends unknown[], R>(f: (...args: A) => Promise<Sending<R>>, ...args: Sending<A>): Thread<R>;
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
  /** Waits, without blocking, until all threads have called `wait` or `waitAsync`: for an async function. */
  waitAsync(): Promise<void>;
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

/**
 * A channel: values move through it from thread to thread, in order. A thread that may block uses
 * `send`, `recv`, `for...of` and `select`; an async function uses `sendAsync`, `recvAsync`, `for await`
 * and `selectAsync`, which wait without blocking the worker it shares with others.
 */
export declare class Channel<T> implements Cell {
  readonly [cellBrand]: true;
  /** Holds up to `capacity` values; 0, the default, is unbuffered. */
  constructor(capacity?: number);
  /** Moves `value` in: waits while the channel is full, or, unbuffered, until a receiver takes it. */
  send(value: Sending<T>): void;
  /** `send`, without blocking: the value moves now, and the promise resolves once it is in (or taken). */
  sendAsync(value: Sending<T>): Promise<void>;
  /** The next value, which the caller now owns; waits while empty. Undefined once closed and empty. */
  recv(): Sending<T> | undefined;
  /** `recv`, without blocking. */
  recvAsync(): Promise<Sending<T> | undefined>;
  /** No more sends. Receivers still get what is left. */
  close(): void;
  [Symbol.iterator](): Iterator<T>;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}
/**
 * Starts `f` as a goroutine. Nothing waits for it. A plain function's goroutine is a thread of its
 * own, a whole worker, which may block. An async function's goroutine is light: a worker runs any
 * number of them, each a suspended async function while it waits (`await channel.recvAsync()`). It
 * must not block, which would stop every goroutine on its worker: the ownership checker reports a
 * blocking call in an async function, and the call throws on such a worker.
 */
export declare function go<A extends unknown[]>(f: (...args: A) => void | Promise<void>, ...args: Sending<A>): void;
/** Waits until one of the channels has a value or is closed: its index and the value (undefined if closed). */
export declare function select<T>(...channels: Channel<T>[]): [index: number, value: T | undefined];
/** `select`, without blocking: for an async function. */
export declare function selectAsync<T>(...channels: Channel<T>[]): Promise<[index: number, value: T | undefined]>;

/** Prints a line, synchronously, from any thread. */
export declare function log(...args: unknown[]): void;
/** Shared memory in use, and shared structs and SharedArrays allocated and freed. */
export declare function heapStats(): { heapBytes: number; allocated: number; freed: number; pending: number };
