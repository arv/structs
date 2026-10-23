// Atomics.Mutex, its UnlockToken, and Atomics.Condition (§4): Shared Structs
// with no fields, whose internal slots are words in the heap.
//
//   a Mutex      [0 kind][4 state: 0 free, 1 locked, 2 locked with waiters]
//                [8 the agent that holds it, or 0][12]
//   a Condition  [0 kind][4 a sequence number, bumped by each notify][8][12]
//
// Waiting is Atomics.wait on those words. A Mutex is not fair: a waiter woken
// competes with an agent that just arrived (the spec's waiter list is a queue).

import {A, AGENT, CAN_BLOCK, I32} from './heap.ts';
import {addressOf, create, K_CONDITION, K_MUTEX} from './shared.ts';

// RequireInternalSlot(o, [[MutexWaiterList]]): the Mutex's state word
function mutexWord(o: unknown) {
  const a = addressOf(o);
  if (a === undefined || I32[a >> 2] !== K_MUTEX)
    throw new TypeError('structs: not an Atomics.Mutex');
  return (a >> 2) + 1;
}

function conditionWord(o: unknown) {
  const a = addressOf(o);
  if (a === undefined || I32[a >> 2] !== K_CONDITION)
    throw new TypeError('structs: not an Atomics.Condition');
  return (a >> 2) + 1;
}

const ACQUIRED = 0,
  DEADLOCK = 1,
  TIMED_OUT = 2;

// LockMutex (§4.1.2), `w` its state word
function lockMutex(w: number, ms: number) {
  if (A.compareExchange(I32, w, 0, 1) === 0) {
    I32[w + 1] = AGENT;
    return ACQUIRED;
  }
  if (A.load(I32, w + 1) === AGENT) return DEADLOCK;
  if (ms === 0) return TIMED_OUT;
  const until = Date.now() + ms;
  while (A.exchange(I32, w, 2) !== 0) {
    const left = until - Date.now();
    if (left <= 0) return TIMED_OUT;
    A.wait(I32, w, 2, left);
  }
  I32[w + 1] = AGENT;
  return ACQUIRED;
}

// UnlockMutex (§4.1.3)
function unlockMutex(w: number) {
  I32[w + 1] = 0;
  if (A.sub(I32, w, 1) !== 1) {
    A.store(I32, w, 0);
    A.notify(I32, w, 1);
  }
}

// a timeout argument as milliseconds (§4.3.3 step 4)
function millis(timeout: unknown) {
  if (typeof timeout !== 'number')
    throw new TypeError('structs: the timeout must be a Number');
  if (Number.isNaN(timeout) || timeout === Infinity) return Infinity;
  return timeout === -Infinity ? 0 : Math.max(timeout, 0);
}

function mustSuspend() {
  if (!CAN_BLOCK)
    throw new TypeError(
      'structs: this agent cannot block (AgentCanSuspend is false: a browser main thread, say)',
    );
}

// [[LockedMutex]] of a token (TypeError for anything else), and
// UnlockTokenCreateIfNeeded (§4.1.1): the class's, which see its private name
let mutexOf: (token: unknown) => number;
let holding: (
  token: UnlockToken | undefined,
  w: number,
  mutex: unknown,
) => UnlockToken;

// Atomics.Mutex.UnlockToken (§4.4)
export class UnlockToken {
  // [[LockedMutex]]: the state word of the Mutex it holds, or 0 for empty
  #mutex = 0;
  // and the Mutex, which this agent holds so that the collector keeps it
  #held: unknown = undefined;

  get locked() {
    return this.#held !== undefined;
  }

  unlock() {
    const w = this.#mutex;
    if (w === 0) return false;
    this.#mutex = 0;
    unlockMutex(w);
    this.#held = undefined;
    return true;
  }

  [Symbol.dispose]() {
    const w = this.#mutex;
    if (w === 0) return;
    this.#mutex = 0;
    unlockMutex(w);
    this.#held = undefined;
  }

  static {
    mutexOf = token => {
      if (typeof token !== 'object' || token === null || !(#mutex in token))
        throw new TypeError('structs: not an Atomics.Mutex.UnlockToken');
      return (token as UnlockToken).#mutex;
    };
    holding = (token, w, mutex) => {
      token ??= new UnlockToken();
      token.#mutex = w;
      token.#held = mutex;
      return token;
    };
  }
}
Object.defineProperty(UnlockToken.prototype, Symbol.toStringTag, {
  value: 'Atomics.Mutex.UnlockToken',
  configurable: true,
});

// a token argument that may be given: it must hold nothing
function freeToken(token: unknown) {
  if (token !== undefined && mutexOf(token) !== 0)
    throw new TypeError('structs: the UnlockToken already holds a Mutex');
  return token as UnlockToken | undefined;
}

// Atomics.Mutex ( ) (§4.2.1)
export const Mutex = function Mutex() {
  if (new.target === undefined)
    throw new TypeError("Constructor Atomics.Mutex requires 'new'");
  return create(K_MUTEX, 0, 0);
} as unknown as MutexConstructor;

Object.assign(Mutex, {
  UnlockToken,
  // Atomics.Mutex.lock ( mutex [ , unlockToken ] ) (§4.3.2)
  lock(mutex: unknown, unlockToken?: unknown) {
    const w = mutexWord(mutex);
    const token = freeToken(unlockToken);
    mustSuspend();
    if (lockMutex(w, Infinity) === DEADLOCK)
      throw new TypeError('structs: this agent already holds the Mutex');
    return holding(token, w, mutex);
  },
  // Atomics.Mutex.lockIfAvailable ( mutex, timeout [ , unlockToken ] )
  // (§4.3.3)
  lockIfAvailable(mutex: unknown, timeout: unknown, unlockToken?: unknown) {
    const w = mutexWord(mutex);
    const token = freeToken(unlockToken);
    const ms = millis(timeout);
    if (ms !== 0) mustSuspend();
    const result = lockMutex(w, ms);
    if (result === DEADLOCK)
      throw new TypeError('structs: this agent already holds the Mutex');
    return result === ACQUIRED ? holding(token, w, mutex) : null;
  },
});

// Atomics.Condition ( ) (§4.5.1)
export const Condition = function Condition() {
  if (new.target === undefined)
    throw new TypeError("Constructor Atomics.Condition requires 'new'");
  return create(K_CONDITION, 0, 0);
} as unknown as ConditionConstructor;

// the Mutex a token holds, which a wait needs
function heldBy(token: unknown) {
  const w = mutexOf(token);
  if (w === 0) throw new TypeError('structs: the UnlockToken holds no Mutex');
  return w;
}

Object.assign(Condition, {
  // Atomics.Condition.wait ( cv, mutexUnlockToken ) (§4.6.1)
  wait(cv: unknown, mutexUnlockToken: unknown) {
    const c = conditionWord(cv);
    const m = heldBy(mutexUnlockToken);
    mustSuspend();
    // a notify after the unlock changes the number, and the wait returns
    const seq = A.load(I32, c);
    unlockMutex(m);
    A.wait(I32, c, seq);
    lockMutex(m, Infinity);
    return undefined;
  },
  // Atomics.Condition.waitFor ( cv, mutexUnlockToken, timeout [ , predicate ] )
  // (§4.6.2)
  waitFor(
    cv: unknown,
    mutexUnlockToken: unknown,
    timeout: unknown,
    predicate?: unknown,
  ) {
    const c = conditionWord(cv);
    const m = heldBy(mutexUnlockToken);
    const ms = millis(timeout);
    if (predicate !== undefined && typeof predicate !== 'function')
      throw new TypeError('structs: the predicate must be callable');
    mustSuspend();
    const until = Date.now() + ms;
    let satisfied = false;
    for (;;) {
      if (predicate !== undefined) satisfied = !!(predicate as Function)();
      if (satisfied) return true;
      const left = until - Date.now();
      if (left <= 0) return false;
      const seq = A.load(I32, c);
      unlockMutex(m);
      const result = A.wait(I32, c, seq, left);
      lockMutex(m, Infinity);
      satisfied = result !== 'timed-out';
      if (predicate === undefined) return satisfied;
    }
  },
  // Atomics.Condition.notify ( cv [ , count ] ) (§4.6.3)
  notify(cv: unknown, count?: unknown) {
    const c = conditionWord(cv);
    if (count === undefined) count = Infinity;
    if (
      typeof count !== 'number' ||
      (!Number.isInteger(count) && count !== Infinity)
    )
      throw new TypeError('structs: the count must be an integral Number');
    A.add(I32, c, 1);
    return A.notify(
      I32,
      c,
      count === Infinity ? undefined : Math.max(count, 0),
    );
  },
});

export interface MutexConstructor {
  new (): Mutex;
  readonly UnlockToken: typeof UnlockToken;
  lock(mutex: Mutex, unlockToken?: UnlockToken): UnlockToken;
  lockIfAvailable(
    mutex: Mutex,
    timeout: number,
    unlockToken?: UnlockToken,
  ): UnlockToken | null;
}
export interface Mutex {
  readonly __mutex?: never;
}
export interface ConditionConstructor {
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
export interface Condition {
  readonly __condition?: never;
}
