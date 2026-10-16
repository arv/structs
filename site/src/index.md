---
title: '@arv/structs'
navTitle: Introduction
description:
  'The TC39 structs proposal for JavaScript today: structs, shared structs,
  SharedArray, Atomics.Mutex and Atomics.Condition, with a compiler for their
  syntax.'
---

@arv/structs is an implementation of the TC39
[structs proposal](https://tc39.es/proposal-structs/) (Stage 2, the December
2024 draft) for JavaScript today: structs, shared structs, Shared Arrays,
`Atomics.Mutex` and `Atomics.Condition`. It has a runtime that follows the
spec's algorithms, and a compiler for the proposal's syntax. In TypeScript, the
compiler also uses the types to make shared struct field access direct.

```js
shared struct Counter {
  count = 0;
  lock = new Atomics.Mutex();
}

const counter = new Counter();
worker.postMessage(counter); // the same object in the worker, not a copy

// in any agent:
{
  using _ = Atomics.Mutex.lock(counter.lock);
  counter.count++;
}
```

You can write programs and run them in your browser, with the compiled
JavaScript side by side, in [the playground](/playground/).

::: warning Status: experimental
This is the `tc39-proposal` branch of
[arv/threads](https://github.com/arv/threads/tree/tc39-proposal). It replaces
the threads library on `main` with something much smaller that stays as close to
the spec as JavaScript allows. See
[Differences from the Spec](/differences-from-the-spec/).
:::

## What's in It

| Spec                              | Here                                                             |
| --------------------------------- | ---------------------------------------------------------------- |
| §1 `struct` declarations          | The compiler lowers them to classes that call the runtime        |
| §2 `shared struct` declarations   | Proxies over one `SharedArrayBuffer`, the heap                   |
| §2.3 `Atomics` on struct fields   | `load`, `store`, `exchange` and `compareExchange` take a struct  |
| §2.4 `Reflect.canBeShared`        | Installed on `Reflect`                                           |
| §3 `SharedArray`                  | A global: a Shared Struct with indexed fields and a fixed length |
| §4 `Atomics.Mutex`, `UnlockToken` | Futex-style locks on heap words; tokens work with `using`        |
| §4 `Atomics.Condition`            | `wait`, `waitFor` (with a timeout and a predicate), `notify`     |

Importing `@arv/structs` installs the globals. The compiler's output imports
`@arv/structs/runtime`, which does it too.

## Where to Next

- [Running It](/running-it/): the Node hook, the CLI and the compiler's API.
- [Structs](/structs/) and [Shared Structs](/shared-structs/): what the syntax
  makes, and how.
- [The Playground](/the-playground/): try it all in your browser.
