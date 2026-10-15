// Threads for JavaScript in plain TypeScript: own and shared values, shared
// structs, channels, maps, locks and conditions.
//
// Code written against these types is ordinary TypeScript: tsc, editors,
// linters and formatters accept it as it is. Two tools add what the types
// cannot say:
//   - the ownership checker (@arv/threads-check) runs in CI like a linter and
//     proves the rules below: nothing is used after it is sent, and shared
//     values never change;
//   - the bundler plugin (@arv/threads/vite) compiles with threads-check:
//     shared structs and SharedArrays become typed-array
//     accesses on shared memory, their references are counted, and each
//     module registers the functions threads run.
//
// Every value a thread touches is one of three kinds:
//   - owned, the default: an ordinary object only one thread can reach.
//     `Sending<T>` moves it: the caller gives it up and the receiver owns it;
//   - shared: `Shared<T>` , deeply immutable, so any number of threads may read
//     it;
//   - a cell: shared and mutable, but only through what synchronizes it (Lock,
//     Condition, Channel), or, for shared structs and SharedArrays, in place,
//     ordered by one of those.

// Lock.hold() returns a Disposable, for `using`
/// <reference lib="esnext.disposable" />

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
 * A value whose ownership moves, on a parameter or a result: the caller must
 * not use it, or anything it reaches, afterwards. The ownership checker
 * enforces this; to TypeScript it is just T.
 */
export type Sending<T> = T;

/**
 * A deeply immutable value, which any number of threads may read. To TypeScript
 * it is deeply readonly.
 */
export type Shared<T> = T extends Cell | ((...args: any[]) => any)
  ? T
  : T extends object
    ? {readonly [K in keyof T]: Shared<T[K]>}
    : T;

/**
 * Ends `x` 's lifetime: its value, and what it reaches, moves to the caller. At
 * run time, `x` itself.
 */
export declare function consume<T>(x: T): Sending<T>;

/**
 * Freezes a value the caller owns into a deeply immutable value every thread
 * can read.
 */
export declare function share<T>(value: Sending<T>): Shared<T>;

// ---- shared structs ----

/**
 * A field of a shared struct, declared with `f64` , `i32` , `u8` , `bool` ,
 * `str` or `ref<T>()` .
 */
export interface Field<T> {
  readonly [fieldBrand]: T;
}
/** A number field: an f64 in shared memory. */
export declare const f64: Field<number>;

/**
 * A 32-bit integer: a number, which the field or element it is stored in keeps
 * as an Int32Array would (2 ** 31 as -(2 ** 31)). Atomic operations act on i32s
 * (see `atomic` ). The ownership checker requires an integer of a value stored
 * into one (or passed or returned as one): integer arithmetic, which wraps, but
 * not a number that may have a fraction, which must be converted explicitly, as
 * with Math.round(x), Math.trunc(x) or x | 0.
 */
export type i32 = number & {readonly [int32Brand]?: never};
/**
 * An 8-bit unsigned integer: a number, kept as a Uint8Array would (256 as 0,
 * and -1 as 255). As an i32's, its values must be integers.
 */
export type u8 = number & {readonly [uint8Brand]?: never};
/**
 * The field of an integer, which a SharedArray also takes as its element type.
 */
export interface IntegerField<T, K extends 'i32' | 'u8'> extends Field<T> {
  readonly kind: K;
}
/**
 * An i32 field: a 32-bit integer in shared memory, which atomic operations act
 * on.
 */
export declare const i32: IntegerField<i32, 'i32'>;
/** A u8 field: a byte in shared memory. */
export declare const u8: IntegerField<u8, 'u8'>;
/** A boolean field: a byte in shared memory, 0 or 1. */
export declare const bool: Field<boolean>;
/**
 * A string field: the address of the string's one copy in shared memory.
 * Strings are interned, so each distinct string is stored once, and each thread
 * decodes it once. A string is freed once no field, SharedArray element, map or
 * message refers to it.
 */
export declare const str: Field<string>;
/**
 * A reference field: a shared struct, a SharedArray, a Channel, a Lock or a
 * Condition, or null. A channel, a lock and a condition live as long as the
 * program, so a struct can hand one to any thread:
 * `struct({ lock: ref<Lock>(), changed: ref<Channel<void>>() })` .
 */
export declare function ref<T>(): Field<T | null>;

/**
 * What `struct(...)` returns: `new S()` makes a zeroed struct in shared memory.
 */
export interface StructType<T> {
  new (): T & Cell;
  readonly fields: readonly string[];
}
/** The value type of a struct type: `type Body = Struct<typeof Body>`. */
export type Struct<S> = S extends StructType<infer T> ? T & Cell : never;

/**
 * Declares a shared struct: fields at fixed places in shared memory, which
 * every thread reads and writes in place. Reads and writes are not ordered
 * between threads: a Lock or a Channel orders them.
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
): StructType<{
  -readonly [K in keyof F]: F[K] extends Field<infer V> ? V : never;
}>;
export declare function struct<T>(fields: {
  [K in keyof T]-?: Field<T[K]>;
}): StructType<T>;

/**
 * A fixed-length array in shared memory: of numbers (`Number`), of i32s
 * (`i32`), of bytes (`u8`), of booleans (`Boolean`, a byte each), of strings
 * (`String`, interned as `str` fields are), or of shared structs stored inline.
 * Every thread reads and writes the same elements, with no copying; a Lock, a
 * Channel or an atomic operation orders them.
 */
export interface SharedArray<T, L = ElementLayout<T>> extends Cell {
  readonly length: number;
  [index: number]: T;
  /**
   * Not there at run time: L keeps SharedArrays of numbers, i32s and u8s apart,
   * whose elements TypeScript would otherwise let one stand for another, though
   * they are stored differently. (A property of type ElementLayout<T> would
   * not: TypeScript relates two SharedArrays by T alone.)
   */
  readonly [layoutBrand]?: L;
}
/**
 * How a SharedArray of T stores its elements, as far as telling numbers, i32s
 * and u8s apart goes.
 */
type ElementLayout<T> = typeof int32Brand extends keyof T
  ? 'i32'
  : typeof uint8Brand extends keyof T
    ? 'u8'
    : 'other';
export declare const SharedArray: {
  new (type: NumberConstructor, length: number): SharedArray<number>;
  new (type: BooleanConstructor, length: number): SharedArray<boolean>;
  new (type: StringConstructor, length: number): SharedArray<string>;
  new (type: IntegerField<i32, 'i32'>, length: number): SharedArray<i32>;
  new (type: IntegerField<u8, 'u8'>, length: number): SharedArray<u8>;
  new <T>(type: StructType<T>, length: number): SharedArray<T & Cell>;
};

// ---- atomic operations ----

/** The fields of a struct type S that are i32s. */
export type I32Fields<S> = {
  [K in keyof S]-?: typeof int32Brand extends keyof S[K] ? K : never;
}[keyof S];

/**
 * An atomic operation on an element of a SharedArray<i32>, or on an i32 field
 * of a shared struct (whose value may be typed by an interface, without Cell:
 * the ownership checker makes sure it is a shared struct).
 */
export interface AtomicOperation<A extends unknown[], R> {
  (array: SharedArray<i32>, index: number, ...args: A): R;
  <S extends object>(struct: S, field: I32Fields<S>, ...args: A): R;
}

/**
 * Atomic operations, which `Atomics` performs: on an element of a
 * SharedArray<i32>, or on an i32 field of a shared struct, named by a string
 * literal. Each is indivisible, and orders the reads and writes around it as a
 * lock would. Compiled, a call is that `Atomics` call, on the i32 itself:
 *
 *     const Work = struct({ next: i32, done: i32 });
 *     // claims item i
 *     for (let i; (i = atomic.add(work, "next", 1)) < n; ) process(i);
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
  /**
   * Stores the bitwise and of the i32 and `value` , and returns the old value.
   */
  readonly and: AtomicOperation<[value: i32], i32>;
  /**
   * Stores the bitwise or of the i32 and `value` , and returns the old value.
   */
  readonly or: AtomicOperation<[value: i32], i32>;
  /**
   * Stores the bitwise xor of the i32 and `value` , and returns the old value.
   */
  readonly xor: AtomicOperation<[value: i32], i32>;
  /** Stores `value`, and returns the old value. */
  readonly exchange: AtomicOperation<[value: i32], i32>;
  /**
   * Stores `replacement` if the i32 is `expected` , and returns the old value
   * either way.
   */
  readonly compareExchange: AtomicOperation<
    [expected: i32, replacement: i32],
    i32
  >;
  /**
   * Waits while the i32 is `value` , until notify() wakes the thread or
   * `timeout` ms pass. Not on a page's main thread, which must not block, nor
   * in an async function, which shares its worker.
   */
  readonly wait: AtomicOperation<
    [value: i32, timeout?: number],
    'ok' | 'not-equal' | 'timed-out'
  >;
  /**
   * Wakes up to `count` threads waiting on the i32 (all of them by default);
   * returns how many it woke.
   */
  readonly notify: AtomicOperation<[count?: number], number>;
}
export declare const atomic: Atomic;

// ---- threads ----

/**
 * A thread; joining it moves the thread's result back. If the thread threw,
 * joining it throws an Error that says what it threw (`TypeError: x is not a
 * function`), whose `cause` has the stack where the thread threw: an Error is
 * not shared, so what a thread threw crosses as text. A thread that is never
 * joined is reclaimed, with its result, once its Thread is collected: when V8
 * collects it, which is in its own time and only between tasks. A thread whose
 * result nobody wants is a goroutine: `go` starts one, and frees it as it ends.
 * A Thread stays on the thread that spawned it, which joins it: it is not a
 * cell, and is not sent or shared.
 */
export interface Thread<R> {
  /**
   * Waits for the thread, from a thread that may block (not a page's main
   * thread).
   */
  join(): Sending<R>;
  /**
   * Waits for the thread without blocking: for a page's main thread, or an
   * async function.
   */
  joinAsync(): Promise<Sending<R>>;
}

/**
 * Starts `f` on a thread. Every argument is sent: owned values move, shared
 * values and cells are shared. An async function's thread is light: a worker
 * runs it among many others (see `go` ). Join the thread: one that is not is
 * reclaimed only once its Thread is collected, so a loop that spawns without
 * joining holds on to memory until then. `go` is the form to fire and forget.
 */
export declare function spawn<A extends unknown[], R>(
  f: (...args: A) => Promise<Sending<R>>,
  ...args: Sending<A>
): Thread<R>;
export declare function spawn<A extends unknown[], R>(
  f: (...args: A) => Sending<R>,
  ...args: Sending<A>
): Thread<R>;

/**
 * Spawns threads that cannot outlive the scope, in its body: once the body
 * returns, a spawn throws. Its threads are joined with `join()` , or by the
 * scope as the body returns; `joinAsync()` throws on one. Like a Thread, it
 * stays on its thread.
 */
export interface Scope {
  spawn<A extends unknown[], R>(
    f: (...args: A) => Promise<Sending<R>>,
    ...args: Sending<A>
  ): Thread<R>;
  spawn<A extends unknown[], R>(
    f: (...args: A) => Sending<R>,
    ...args: Sending<A>
  ): Thread<R>;
}
/**
 * Runs `body` and joins every thread it spawned before returning. The body must
 * not be async, and scope() throws if it returns a promise: a thread it spawned
 * after an await would outlive the scope. An async function spawns its threads
 * and awaits `joinAsync()` on each.
 */
export declare function scope<R>(body: (s: Scope) => R): R;

/**
 * Registers a module's top-level functions, so that a thread finds the one it
 * runs by module and name: `register(import.meta.url, {main, worker})`, at the
 * module's end. The compiler adds this call to every module that uses the
 * threads API; a program whose types are only erased makes it itself.
 */
export declare function register(
  url: string,
  functions: Record<string, (...args: never[]) => unknown>,
): void;

/**
 * Splits an owned array into `parts` owned, disjoint chunks of nearly equal
 * size; `parts` is a whole number, at least 1 (else a RangeError). Trusted.
 */
export declare function partition<T>(
  items: Sending<T[]>,
  parts: number,
): Sending<T[]>[];
/**
 * Takes element `index` out of an array of owned values, so the caller owns it.
 * Trusted.
 */
export declare function take<T>(items: Sending<T>[], index: number): Sending<T>;

/**
 * A lock: one thread at a time holds it. It protects what several threads
 * change together, such as two fields that must agree. A struct may hold one
 * (`ref<Lock>()`).
 */
export declare class Lock implements Cell {
  readonly [cellBrand]: true;
  constructor();
  /**
   * Blocks until this thread holds the lock. Disposing what it returns
   * releases the lock: `using _ = lock.hold();` holds it to the end of the
   * block.
   */
  hold(): Disposable;
  /**
   * The same in an async function: waits for the lock without blocking.
   * `using _ = await lock.holdAsync();`
   */
  holdAsync(): Promise<Disposable>;
}

/**
 * A condition: a thread that holds a lock waits on it until another thread
 * notifies it. A waiter may also wake without a notify, so it waits in a loop
 * that checks what it waits for:
 *
 *     using _ = lock.hold();
 *     while (!job.done) changed.wait(lock);
 */
export declare class Condition implements Cell {
  readonly [cellBrand]: true;
  constructor();
  /**
   * Releases `lock`, which this thread holds, blocks until notified, and holds
   * `lock` again.
   */
  wait(lock: Lock): void;
  /** The same in an async function: waits without blocking. */
  waitAsync(lock: Lock): Promise<void>;
  /** Wakes one thread that waits. */
  notifyOne(): void;
  /** Wakes every thread that waits. */
  notifyAll(): void;
}

// ---- maps and sets ----

/**
 * A Map in shared memory, which any number of threads read and write: Map's
 * methods, with Map's semantics. Keys are compared as SameValueZero (a string by
 * its text, a cell or a shared value by identity), and iteration is in
 * insertion order: a loop sees entries added while it runs, and skips those
 * deleted before it gets to them. Keys and values are what can be shared: a
 * number, a string, a boolean, null, undefined, a cell (a shared struct, a
 * SharedArray, a Channel, a SharedMap...), a shared value, or a plain object or
 * array, which moves in and is shared (frozen). Each call is atomic, and a loop
 * sees other threads' changes between its steps. Strings are interned, as `str`
 * fields' are.
 */
export declare class SharedMap<K, V> implements Cell {
  readonly [cellBrand]: true;
  constructor(entries?: Sending<Iterable<readonly [K, V]>> | null);
  readonly size: number;
  get(key: K): Shared<V> | undefined;
  has(key: K): boolean;
  set(...entry: Sending<[key: K, value: V]>): this;
  /** The key's value, after adding `value` for it if it has none. */
  getOrInsert(...entry: Sending<[key: K, value: V]>): Shared<V>;
  /**
   * The key's value, after adding `callback(key)` for it if it has none. If
   * another thread adds the key while the callback runs, its value is kept and
   * returned (Map's would be replaced), so threads adding one key get one value.
   */
  getOrInsertComputed(
    ...entry: Sending<[key: K, callback: (key: K) => Sending<V>]>
  ): Shared<V>;
  delete(key: K): boolean;
  clear(): void;
  forEach(
    callback: (value: Shared<V>, key: Shared<K>, map: SharedMap<K, V>) => void,
    thisArg?: unknown,
  ): void;
  keys(): IterableIterator<Shared<K>>;
  values(): IterableIterator<Shared<V>>;
  entries(): IterableIterator<[Shared<K>, Shared<V>]>;
  [Symbol.iterator](): IterableIterator<[Shared<K>, Shared<V>]>;
  readonly [Symbol.toStringTag]: string;
}

/**
 * A Set in shared memory: Set's methods, with Set's semantics, as SharedMap has
 * Map's.
 */
export declare class SharedSet<T> implements Cell {
  readonly [cellBrand]: true;
  constructor(values?: Sending<Iterable<T>> | null);
  readonly size: number;
  has(value: T): boolean;
  add(...value: Sending<[value: T]>): this;
  delete(value: T): boolean;
  clear(): void;
  forEach(
    callback: (value: Shared<T>, value2: Shared<T>, set: SharedSet<T>) => void,
    thisArg?: unknown,
  ): void;
  keys(): IterableIterator<Shared<T>>;
  values(): IterableIterator<Shared<T>>;
  entries(): IterableIterator<[Shared<T>, Shared<T>]>;
  [Symbol.iterator](): IterableIterator<Shared<T>>;
  readonly [Symbol.toStringTag]: string;
}

// ---- goroutines and channels ----

/**
 * A channel: values move through it from thread to thread, in order. A thread
 * that may block uses `send` , `recv` , `recvOk` , `for...of` and `select` ; an
 * async function uses `sendAsync` , `recvAsync` , `recvOkAsync` , `for await`
 * and `selectAsync` , which wait without blocking the worker it shares with
 * others.
 *
 * `recv` gives undefined both for a sent undefined and once the channel is
 * closed: `recvOk` tells them apart, as Go's `v, ok := <-ch` does, and
 * `select` gives the same ok, third (`for...of` ends at the close alone). So a
 * `Channel<void>` signals by `close()` , which wakes every receiver, or is read
 * with `recvOk` .
 */
export declare class Channel<T> implements Cell {
  readonly [cellBrand]: true;
  /** Holds up to `capacity` values; 0, the default, is unbuffered. */
  constructor(capacity?: number);
  /**
   * Moves `value` in: waits while the channel is full, or, unbuffered, until a
   * receiver takes it.
   */
  send(value: Sending<T>): void;
  /**
   * `send` , without blocking: the value moves now, and the promise resolves
   * once it is in (or taken).
   */
  sendAsync(value: Sending<T>): Promise<void>;
  /**
   * The next value, which the caller now owns; waits while empty. Undefined
   * once closed and empty, as for a sent undefined: `recvOk` tells them apart.
   */
  recv(): Sending<T> | undefined;
  /** `recv`, without blocking. */
  recvAsync(): Promise<Sending<T> | undefined>;
  /**
   * `recv` , with whether a value came: `[value, true]` for the next value,
   * which the caller now owns, even an undefined one; `[undefined, false]` once
   * closed and empty. `const [v, ok] = ch.recvOk();` As with `select` , the
   * ownership checker refuses it on a channel of shared structs or
   * SharedArrays, whose count the tuple, an ordinary array, could not hold:
   * `recv` and `for...of` receive those.
   */
  recvOk(): [value: Sending<T> | undefined, ok: boolean];
  /** `recvOk`, without blocking. */
  recvOkAsync(): Promise<[value: Sending<T> | undefined, ok: boolean]>;
  /**
   * No more sends. Receivers still get what is left, then undefined (`recvOk` 's
   * ok false), and loops over the channel end.
   */
  close(): void;
  [Symbol.iterator](): Iterator<T>;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}
/**
 * Starts `f` as a goroutine. Nothing waits for it. A plain function's goroutine
 * is a thread of its own, a whole worker, which may block. An async function's
 * goroutine is light: a worker runs any number of them, each a suspended async
 * function while it waits (`await channel.recvAsync()`). It must not block,
 * which would stop every goroutine on its worker: the ownership checker reports
 * a blocking call in an async function, and the call throws on such a worker.
 */
export declare function go<A extends unknown[]>(
  f: (...args: A) => void | Promise<void>,
  ...args: Sending<A>
): void;
/**
 * Waits until one of the channels has a value or is closed: its index, the
 * value, and whether a value came, as `recvOk` 's ok: `[index, value, true]` ,
 * or `[index, undefined, false]` for a closed channel. Without ok, a sent
 * undefined and a close look the same. The ownership checker refuses it on
 * channels of shared structs or SharedArrays, whose count the tuple, an
 * ordinary array, could not hold.
 */
export declare function select<T>(
  ...channels: Channel<T>[]
): [index: number, value: T | undefined, ok: boolean];
/** `select`, without blocking: for an async function. */
export declare function selectAsync<T>(
  ...channels: Channel<T>[]
): Promise<[index: number, value: T | undefined, ok: boolean]>;

/** Prints a line, synchronously, from any thread. */
export declare function log(...args: unknown[]): void;
/**
 * Shared memory in use, and shared structs and SharedArrays allocated and
 * freed.
 */
export declare function heapStats(): {
  heapBytes: number;
  allocated: number;
  freed: number;
  pending: number;
};
/**
 * Frees the cycles of shared structs, SharedArrays, SharedMaps and SharedSets
 * that nothing outside them refers to, which counting alone never frees, and
 * returns how many blocks it freed. Every other thread stops at its next
 * quiescent point while it runs, and a thread that's waiting stays waiting. If
 * one doesn't stop within `timeout` ms (1000 by default), it frees nothing and
 * returns 0. Called while another thread collects, it waits for that
 * collection and returns 0.
 */
export declare function collectCycles(timeout?: number): number;
