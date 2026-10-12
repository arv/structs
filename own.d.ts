// Types for own.js, for programs written in the own/shared TypeScript extension (compiled with the
// tsgo fork, which checks ownership and erases it: see README.md).
//
// `sending T` marks a value whose ownership moves to the receiver: the sender must not use it
// afterwards. `shared T` marks a value any number of threads may read at once, deeply immutable or a
// cell that synchronizes internally (Slots, Barrier, a shared struct).

/** One slot per thread: a thread publishes into its own slot, and everyone reads every slot. */
export interface SlotsCell<T> {
  readonly length: number;
  /** Publishes `value` (a shared value) in slot `index`, replacing what was there. */
  set(index: number, value: T): void;
  /** The value in slot `index`: this thread's own frozen copy of it. */
  get(index: number): shared T;
  /** The arrays in all slots, concatenated in slot order. */
  flat(): shared (T extends readonly (infer E)[] ? E : T)[];
}
export declare const Slots: new <T>(count: number) => shared SlotsCell<T>;

/** A reusable barrier for a fixed number of threads. */
export interface BarrierCell {
  /** Blocks until all threads have called `wait`. */
  wait(): void;
}
export declare const Barrier: new (threads: number) => shared BarrierCell;

/** Freezes a value the caller owns into a deeply immutable value every thread can read. */
export declare function share<T>(value: sending T): shared T;

/** A thread started inside a `scope`; joining it moves the thread's result back. */
export interface Thread<R> {
  join(): sending R;
}

/** Spawns threads that cannot outlive the scope. Every argument is sent to the new thread. */
export interface Scope {
  spawn<A extends unknown[], R>(f: (...args: A) => sending R, ...args: sending A): shared Thread<R>;
}

/** Runs `body` and joins every thread it spawned before returning. */
export declare function scope<R>(body: (s: shared Scope) => R): R;

/** Splits an owned array into `parts` owned, disjoint chunks of nearly equal size. Trusted. */
export declare function partition<T>(items: sending T[], parts: number): (sending T[])[];

/** Takes element `index` out of an array of owned values, so the caller owns it. Trusted. */
export declare function take<T>(items: (sending T)[], index: number): sending T;

/** A shared struct's value as a type: what `new SharedArray(Struct, n)` takes. */
export interface SharedStructType<T> {
  new (): T;
}

/**
 * A fixed-length array in the shared heap, of numbers or of shared structs stored inline. Threads
 * share it with no copying: every thread reads and writes the same elements. Reads and writes are
 * not ordered between threads: use a Barrier (or another cell) to order them.
 */
export interface SharedArray<T> {
  readonly length: number;
  [index: number]: T;
}
export declare const SharedArray: {
  new (type: NumberConstructor, length: number): SharedArray<number>;
  new <T>(type: SharedStructType<T>, length: number): SharedArray<T>;
};

/** Prints a line, synchronously, from any thread. */
export declare function log(...args: unknown[]): void;

/** Runtime support for the typed layouts, which the compiler emits; not called by hand. */
export declare const __F64: Float64Array, __I32: Int32Array;
export declare function __newStruct(type: unknown): number;
export declare function __newSharedArray(type: unknown, length: number): number;
export declare const __OOB: { readonly [index: number]: never };
export declare function __box(address: number): object;
export declare function __unbox(value: unknown): number;
/** Runtime support for reference counting (REFCOUNT.md), which the compiler emits; not called by hand. */
export declare function __retain(address: number): number;
export declare function __release(address: number): void;
export declare function __store(index: number, address: number): number;
export declare function __ref(address: number): unknown;
export declare function __quiescent(): void;
export declare function __hold<F extends Function>(fn: F, ...addresses: number[]): F;
/** The shared heap: bytes in use, blocks allocated and freed, and decrements waiting for quiescent points. */
export declare function __heapStats(): { heapBytes: number; allocated: number; freed: number; pending: number };
/** Runtime support for `shared struct`, which the compiler emits; not called by hand. */
export declare function __sharedStruct(name: string, fields: readonly string[], refs?: readonly number[]): any;
/** Runtime support for spawning: the compiler registers a module's top-level functions. */
export declare function __register(url: string, table: Record<string, Function>): void;
