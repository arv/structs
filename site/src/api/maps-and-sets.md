---
title: Maps and Sets
description: SharedMap and SharedSet, Map and Set in shared memory.
---

Everything here comes from `"@arv/threads"`.

`new SharedMap<K, V>(entries?)` and `new SharedSet<T>(values?)` are Map and Set
in shared memory. They have the same methods, and the same semantics:

- Keys are compared as SameValueZero. A string is compared by its text, and a
  cell or a shared value by identity.
- Iteration is in insertion order.
- A loop sees what's added while it runs, and skips what's deleted.

Keys and values can be numbers, strings, booleans, null, undefined, cells
(structs, SharedArrays, maps, channels, locks), shared values, or plain objects
and arrays. Plain objects and arrays move in, and are shared from then on.

Each call is atomic. `getOrInsert(key, value)` and `getOrInsertComputed(key, f)`
add a key only if it's missing, so threads that add the same key all get one
value:

```ts
const Count = struct({n: i32});
type Count = Struct<typeof Count>;

function count(counts: SharedMap<string, Count>, words: Shared<string[]>) {
  for (const w of words)
    atomic.add(
      counts.getOrInsertComputed(w, () => new Count()),
      'n',
      1,
    );
}
```
