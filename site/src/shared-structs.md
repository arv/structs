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
a shared object  [kind][shape: its keys, interned][..][..] then 16 bytes per field
a slot           [a tagged word: the value][a Float64, for a Number]
```

A field holds `undefined`, `null`, a boolean, a Number, a string (interned in
the heap), a BigInt, a registered or well-known symbol, or another shared
object. Anything else is a TypeError (`CanBeSharedAcrossAgents`, §2.2.4). A read
never tears: a Number's Float64 is written before its word, and the word is
stored atomically.

Mutex and Condition are Shared Structs with no fields. Their internal slots are
heap words that `Atomics.wait` and `Atomics.notify` work on. Blocking where an
agent cannot (a browser's main thread) is a TypeError, as the spec says
(`AgentCanSuspend`).

The code is in
[src/runtime/heap.ts](https://github.com/arv/structs/blob/main/src/runtime/heap.ts)
(the heap) and
[src/runtime/shared.ts](https://github.com/arv/structs/blob/main/src/runtime/shared.ts)
(slots, shapes and the Proxies).
