---
title: Status
description: What works, and the real limits it has today.
---

@arv/threads is experimental, and it has real limits. Here's where things stand
today:

- **The compiler needs no fork.** @arv/threads-check compiles shared structs and
  SharedArrays to typed-array reads and writes (`b.x` becomes
  `__F64[(b >> 3) + 1]`), and counts their references, on stock TypeScript 7.1's
  API. It edits each module's TypeScript, and OXC (Vite's, or its own) strips
  the types. With types only erased, programs still run, but shared structs are
  much slower (see
  [Performance](/performance/#compiled-or-with-the-types-only-erased)).
- **The playground still compiles with a fork in the browser.** TypeScript 7.1's
  API runs in Node only: it starts tsgo, and has no WebAssembly build. So the
  playground's build compiles programs with a fork of TypeScript 7.0.2,
  [arv/threads-checker](https://github.com/arv/threads-checker), built to
  WebAssembly. Its dev server compiles with threads-check. The fork emits the
  same code, and the Vite plugin still compiles with it when its `tsgo` option
  names the fork's binary (build it with
  `go build -o built/local/tsgo ./cmd/tsgo`).
- **The checker needs no fork either.** @arv/threads-check checks ownership on
  the same API.
- **Shared memory is a fixed 256 MB, and not everything in it is freed.**
  Structs, SharedArrays and maps are reference counted, and `collectCycles()`
  frees cycles of them, stopping every thread for a moment. Nothing calls it on
  its own yet. Channels, locks and conditions are never freed. A moved value (a
  thread's arguments and result, or a channel's message) is freed once it's
  read, but shared values are never freed. Strings are interned, one copy each,
  and counted. A string is freed once no field, element, map or message refers
  to it.
- **Closures don't cross threads.** A thread runs a top-level function.
- **A SharedMap or SharedSet has one lock.** Every call takes it for a moment,
  so threads that change one map all the time wait for each other. A thread with
  many changes should make them in a Map of its own, and merge once.
- **Goroutines have limits.** A goroutine of a plain function is a whole worker.
  One per core is fine, but thousands are not. Async goroutines are light but
  cooperative. One that computes without awaiting holds up the others on its
  worker, and none moves to another worker once it has started.
- **Moving revokes.** The values you move are revoked, so using them throws.
  With `start({ check: true })`, everything inside them is revoked too.

[Reference Counting](/reference-counting/#limits) explains what is freed and
when, and the limits of counting.
