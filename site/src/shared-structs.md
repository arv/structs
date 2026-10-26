---
title: Shared Structs
description:
  Shared structs live in one SharedArrayBuffer that every agent attaches to, and
  each agent sees them through a Proxy whose traps are the spec's.
---

Every agent attaches to one `SharedArrayBuffer` of a fixed size (256 MB, which
is reserved rather than used up front). A Shared Struct is a block in it with a
slot per field. Each agent sees the block through a Proxy whose traps are the
spec's internal methods (§2.1.5 to §2.1.10). There is one Proxy per block per
agent, so `===` holds.

```
a block          [its size and kind][the collector's mark] then what it holds
a shared object  [kind][shape: its keys, interned][slots][..] then 16 bytes per field
a slot           [a tagged word: the value][a Float64, for a Number]
```

A field holds `undefined`, `null`, a boolean, a Number, a string (interned in
the heap), a BigInt, a registered or well-known symbol, or another shared
object. Anything else is a TypeError (`CanBeSharedAcrossAgents`, §2.2.4). A read
never tears: a Number's Float64 is written before its word, and the word is
stored atomically.

A field declared `: number` in TypeScript (not `x?: number`, which may hold
`undefined`) is typed. Its word says Number from the moment the struct is made
and never changes, so the Float64 alone is its value, and writing it anything
but a Number is a TypeError, from compiled code, plain JavaScript,
`Object.defineProperty` and `Atomics` alike. The compiler passes the types to
the runtime (`{key: 'x', value: 0, number: true}`), and they are part of the
struct's shape: two structs with the same keys typed differently have different
shapes. A key is typed only if every declaration of it in the struct and its
parents says `number`.

Mutex and Condition are Shared Structs with no fields. Their internal slots are
heap words that `Atomics.wait` and `Atomics.notify` work on. Blocking where an
agent cannot (a browser's main thread) is a TypeError, as the spec says
(`AgentCanSuspend`).

## Memory

The heap's blocks come from free lists, and a collector frees the shared objects
that no agent can reach, cycles too. It is a mark and sweep, run by the agent
whose allocation finds the heap short, while the other agents carry on: each
agent keeps what it holds in the heap, where the collector sees it. That is the
objects it has a Proxy for, the objects in flight in its messages, and, for
compiled code that holds a struct's address rather than its Proxy, the objects
taken out of a slot while that code may still hold them (until the agent's turn
ends).

An object comes back once no agent holds it and the agents' own garbage
collectors have collected their Proxies on it. A Proxy is kept at least until
its agent's turn ends (a `WeakRef` keeps what it refers to until then), so a
loop that allocates in one synchronous run keeps what it makes until it returns
to its event loop. An engine's collector does not see the heap fill up, so as it
does, each agent in Node runs its own (with V8's `--expose-gc`, set as it runs);
in a browser, the engine's runs when it will. Interned strings, and with them
shapes, BigInts and symbols, are never freed. `heapStats()` says how much is in
use and how many collections have run.

The code is in
[src/runtime/heap.ts](https://github.com/arv/structs/blob/main/src/runtime/heap.ts)
(the heap),
[src/runtime/gc.ts](https://github.com/arv/structs/blob/main/src/runtime/gc.ts)
(the collector) and
[src/runtime/shared.ts](https://github.com/arv/structs/blob/main/src/runtime/shared.ts)
(slots, shapes and the Proxies).
