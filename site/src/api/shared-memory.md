---
title: Shared Memory
description:
  Shared structs, SharedArrays and atomics, which many threads read and write in
  place.
---

Everything here comes from `"@arv/threads"`.

Shared memory holds data that many threads read and write in place, with no
copying. Reads and writes aren't ordered between threads. A `Lock`, a `Channel`,
joining a thread, or an atomic operation is what orders them.

|                                                                          |                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `struct({ x: f64, n: i32, done: bool, name: str, next: ref<T>() })`      | A shared struct type. `new S()` makes a zeroed one, and `Struct<typeof S>` is the type of its values.                                                                                                                             |
| `f64`, `i32`, `u8`, `bool`, `str`, `ref<T>()`                            | Field kinds: a number, a 32-bit integer, a byte, a boolean, a string (interned), and a reference to a struct, a SharedArray, a Channel, a Lock or a Condition (or null).                                                          |
| `new SharedArray(Number \| i32 \| u8 \| Boolean \| String \| S, length)` | A fixed-length array of numbers, i32s, bytes, booleans, strings or structs, stored inline.                                                                                                                                        |
| `atomic.add(s, "field", v)`, `atomic.add(array, i, v)`                   | An atomic operation on an `i32` field or on an element of a `SharedArray<i32>`: `load`, `store`, `add`, `sub`, `and`, `or`, `xor`, `exchange`, `compareExchange`, `wait` and `notify`. Compiled, it's that `Atomics` call itself. |

## Integers

`i32` and `u8` are types too. They're numbers, kept the way an `Int32Array` or a
`Uint8Array` keeps them, so 2³¹ wraps and 256 is 0.

The checker requires that what you store into one is an integer. That means
integer arithmetic, or an explicit conversion such as `Math.round(x)` or
`x | 0`. A number that may have a fraction isn't allowed, because the store
would truncate it silently.

## Atomics and Locks

With an atomic counter, threads can claim work with no lock:

```ts
const Work = struct({next: i32});
function worker(work: Struct<typeof Work>, n: number) {
  for (let i; (i = atomic.add(work, 'next', 1)) < n;) process(i); // Claims each item once.
}
```

A lock turns several reads and writes into one step. A struct can hold its own
lock, just as it can hold a channel, and `using` releases the lock at the end of
the block:

```ts
const Account = struct({balance: f64, deposits: i32, lock: ref<Lock>()});

function deposit(account: Struct<typeof Account>, amount: number) {
  using _ = account.lock!.hold();
  account.balance += amount;
  account.deposits++;
}
```

## Freeing, and Structs That Refer to Themselves

Structs and SharedArrays are reference counted, and they're freed when no thread
can reach them. To declare a struct that refers to its own type, use an
interface:

```ts
interface Node {
  value: number;
  next: Node | null;
}
const Node = struct<Node>({value: f64, next: ref<Node>()});
```

[Reference Counting](/reference-counting/) explains how they're counted and
freed.
