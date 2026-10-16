// The types of what the proposal adds to the global object (and what
// @arv/structs exports): SharedArray, Atomics.Mutex, Atomics.Condition, the
// Atomics overloads for Shared Structs, and Reflect.canBeShared.

declare global {
  interface SharedArray<T = unknown> {
    [index: number]: T;
    readonly length: number;
  }
  interface SharedArrayConstructor {
    new <T = unknown>(length?: number): SharedArray<T>;
    new <T = unknown>(...values: T[]): SharedArray<T>;
  }
  var SharedArray: SharedArrayConstructor;

  namespace Atomics {
    // a Mutex: a Shared Struct with no fields
    interface Mutex {
      readonly __mutex?: never;
    }
    interface Condition {
      readonly __condition?: never;
    }
    interface UnlockToken extends Disposable {
      readonly locked: boolean;
      unlock(): boolean;
    }
    interface UnlockTokenConstructor {
      new (): UnlockToken;
      readonly prototype: UnlockToken;
    }
    interface MutexConstructor {
      new (): Mutex;
      readonly UnlockToken: UnlockTokenConstructor;
      lock(mutex: Mutex, unlockToken?: UnlockToken): UnlockToken;
      lockIfAvailable(
        mutex: Mutex,
        timeout: number,
        unlockToken?: UnlockToken,
      ): UnlockToken | null;
    }
    interface ConditionConstructor {
      new (): Condition;
      wait(cv: Condition, mutexUnlockToken: UnlockToken): void;
      waitFor(
        cv: Condition,
        mutexUnlockToken: UnlockToken,
        timeout: number,
        predicate?: () => unknown,
      ): boolean;
      notify(cv: Condition, count?: number): number;
    }
  }

  interface Atomics {
    readonly Mutex: Atomics.MutexConstructor;
    readonly Condition: Atomics.ConditionConstructor;
    load<T extends object, K extends keyof T>(struct: T, field: K): T[K];
    store<T extends object, K extends keyof T>(
      struct: T,
      field: K,
      value: T[K],
    ): T[K];
    exchange<T extends object, K extends keyof T>(
      struct: T,
      field: K,
      value: T[K],
    ): T[K];
    compareExchange<T extends object, K extends keyof T>(
      struct: T,
      field: K,
      expectedValue: T[K],
      replacementValue: T[K],
    ): T[K];
  }

  namespace Reflect {
    function canBeShared(value: unknown): boolean;
  }
}

export declare const SharedArray: SharedArrayConstructor;
export declare const Mutex: Atomics.MutexConstructor;
export declare const Condition: Atomics.ConditionConstructor;
export declare const UnlockToken: Atomics.UnlockTokenConstructor;
export declare function canBeShared(value: unknown): boolean;
// attaches this agent to a heap (agent.ts does, for a worker it starts)
export declare function attach(heap?: SharedArrayBuffer): SharedArrayBuffer;
export declare function heapStats(): {
  size: number;
  used: number;
  strings: number;
};
