---
title: Mutex and Condition
description:
  Atomics.Mutex and Atomics.Condition, shared structs with no fields, and the
  UnlockToken that using unlocks.
---

`Atomics.Mutex` and `Atomics.Condition` are shared structs with no fields, so
they can be stored in another shared struct's fields and sent to workers. A lock
gives an `UnlockToken`, which `using` unlocks at the end of its block. A
Condition waits with that token: it unlocks the Mutex while it waits and locks
it again before it returns.

```js
shared struct Queue {
  items = new SharedArray(16);
  size = 0;
  lock = new Atomics.Mutex();
  changed = new Atomics.Condition();
}

// on a worker: wait until there is something to take
{
  using token = Atomics.Mutex.lock(queue.lock);
  Atomics.Condition.waitFor(queue.changed, token, Infinity, () => queue.size > 0);
  // take an item, then tell the others
  Atomics.Condition.notify(queue.changed);
}
```

`Atomics.load`, `store`, `exchange` and `compareExchange` also take a shared
struct and a field name (§2.3), for lock-free code on its fields. The code is in
[src/runtime/sync.ts](https://github.com/arv/structs/blob/main/src/runtime/sync.ts)
and
[src/runtime/atomics.ts](https://github.com/arv/structs/blob/main/src/runtime/atomics.ts).
