---
title: 'The Prototypes: JS-to-JS Threads on Workers'
navTitle: The Prototypes
description:
  The prototypes this grew out of in Porffor's threads work, and what they
  found.
---

::: note Disclaimer

This was mostly done by iterating with the help of Claude Code (Claude Opus
5.5).

:::

This page is about the prototypes this project grew out of, and what they found.
They compile JavaScript to JavaScript for threads, and they run on Web Workers
and node `worker_threads` with a SharedArrayBuffer. [Porffor's
threads][porffor-threads] and its [playground][porffor-playground] take a
different route: they compile JavaScript to C, and then to WebAssembly.

V8 objects can't cross workers, so the big question is what to do with objects.
We tried two designs:

- **Shared everything, publish on escape.** This is the threads model from
  Porffor's [threads/README.md][porffor-threads-readme]. An object stays an
  ordinary V8 object until another thread can reach it. At that point, it moves
  into a SharedArrayBuffer heap. Code that shares nothing runs at plain V8
  speed, but reading a shared object costs about 17x. Its code is no longer in
  this repository, but the tag [`publish-on-escape`][publish-on-escape] has it.
- **Own and shared values.** A value is one of three things: owned by one thread
  and moved across, deeply immutable and copied once per thread that reads it,
  or an explicit cell. Ordinary code is plain JS, with nothing extra per access.
  N-body on 8 threads runs 4x faster than plain single-threaded JS. Programs are
  plain TypeScript, written against
  [threads.d.ts](https://github.com/arv/threads/blob/main/src/runtime/threads.d.ts).
  A checker on TypeScript 7.1's API proves the ownership rules in CI, and a
  bundler plugin compiles shared structs to typed-array accesses.

We measured on an Apple M5 Pro (6 fast and 12 slower cores) with node 24.18 and
Chrome 154.

This work started in Porffor's repository, as `threads/escape-proto`, on top of
its threads work. The own and shared design then grew into the runtime
([src/runtime/](https://github.com/arv/threads/tree/main/src/runtime)), the
threads-check checker
([src/checker/](https://github.com/arv/threads/tree/main/src/checker)) and the
[playground](/the-playground/). That's where the work goes on.

[porffor-threads]:
  https://github.com/arv/porffor/tree/arv/shared-everything-threads/threads
[porffor-playground]:
  https://github.com/arv/porffor/tree/arv/shared-everything-threads/threads/playground
[porffor-threads-readme]:
  https://github.com/arv/porffor/blob/arv/shared-everything-threads/threads/README.md
[publish-on-escape]: https://github.com/arv/threads/tree/publish-on-escape

[The tutorial](/tutorial/) walks you through writing, checking and running a
small program, and explains how each step works. To set up the repository, see
[Development](/repository/#development).

## Running the Prototypes

You run a program on node with `src/run.ts`, or in Chrome with `src/chrome.ts`:

```sh
node src/run.ts nbody-own                  # on node: nbody-own, nbody-cells, refcount-hand
node src/run.ts nbody-own --threads=1,1,8  # the thread counts the program runs with
node src/chrome.ts nbody-own               # in Chrome, on Web Workers (needs playwright-core)
node src/chrome.ts nbody-own --trace=t.json && node src/trace-summary.ts t.json
node src/bench.ts                          # every configuration, median of 5 runs
```

A program is either one of the programs in `src/`, given by name, or a module,
given by path. Its imports of `@arv/threads` resolve to the runtime. On node, a
resolve hook takes care of that. In Chrome, the test server rewrites the
imports.

`chrome.ts` drives the installed Google Chrome through playwright-core. It uses
the playwright-core dev dependency, or the install that `PLAYWRIGHT_CORE` points
at (its `node_modules/playwright-core`). With `--trace`, it records a DevTools
performance trace with every worker's CPU samples. You can open that trace in
DevTools' Performance panel.

`bench.ts` measures against the original programs in
[src/presets/](https://github.com/arv/threads/tree/main/src/presets), run on
plain V8. These are the programs that Porffor's playground has as presets.

The TypeScript programs (`*.ts`) go through two tools. Stock tsc checks them,
and threads-check checks their ownership and compiles them:

```sh
vp run typecheck                                                           # types: stock TypeScript
node src/checker/cli.ts -p tsconfig.programs.json --runtime @arv/threads   # ownership
vp run build-programs                                                      # ownership, and emit build/ts
node src/run.ts build/ts/nbody-struct.js
```

## Files

The code is in [src/](https://github.com/arv/threads/tree/main/src). That's the
runtime, the ownership checker, and the prototype's programs and scripts, which
run on the runtime.
[playground/](https://github.com/arv/threads/tree/main/playground) is the
playground ([its page](/the-playground/)), with a page, its programs, and its
Vite config.

Here's what each file is for:

| File                                                                         | What it is                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presets/`                                                                   | The original programs, in plain JavaScript with threads. The measurements compare against these.                                                                          |
| `runtime/runtime.ts`                                                         | The shared heap: the allocator, free lists, interned strings, deferred decrements and the worker pool.                                                                    |
| `runtime/threads.ts`, `threads.d.ts`                                         | The API that programs import, in plain TypeScript: own and shared values, shared structs, channels, maps and locks.                                                       |
| `runtime/own.ts`                                                             | Own and shared values on top of the runtime, plus shared structs and SharedArrays, Lock and Condition.                                                                    |
| `runtime/chan.ts`                                                            | Go-style goroutines and channels on own and shared values.                                                                                                                |
| `runtime/maps.ts`                                                            | SharedMap and SharedSet.                                                                                                                                                  |
| `runtime/heap.ts`, `browser.ts`, `threads-worker.ts`                         | A page's side: its shared memory, `start()` and `await run(f, ...args)`, and its pool of Web Workers.                                                                     |
| `runtime/vite-plugin-threads.ts`                                             | The bundler plugin. It compiles with threads-check, registers thread functions, serves the playground's compiles and sets cross-origin isolation.                         |
| `runtime/compiled.ts`                                                        | What the plugin and the playground's page both do with compiled code.                                                                                                     |
| [`checker/`](https://github.com/arv/threads/tree/main/src/checker)           | threads-check, the ownership checker and the compiler, built on TypeScript 7.1's API.                                                                                     |
| `nbody-own.ts`                                                               | N-body, written by hand for own and shared values.                                                                                                                        |
| `nbody-cells.ts`                                                             | The same, with the positions in a shared typed-array cell instead of snapshots, so nothing is copied per step.                                                            |
| `nbody-struct.ts`                                                            | N-body in TypeScript with a `SharedArray` of shared structs, which the compiler lays out in the shared heap.                                                              |
| `nbody-ts.ts`, `tsconfig.programs.json`                                      | The same, with ordinary objects that are moved and shared.                                                                                                                |
| `mandelbrot-chan.ts`, `nbody-chan.ts`, `nbody-chan-struct.ts`, `pipeline.ts` | The presets with channels (N-body both copying plain objects and over shared structs), plus a small example of what channels cost.                                        |
| `REFCOUNT.md`, `refcount.ts`, `refcount-hand.ts`, `cycles-hand.ts`           | Reference counting for shared structs and SharedArrays: the design, its test, that test written by hand the way the compiler emits it, and cycles collected under a race. |
| `tutorial.ts`                                                                | The example from [TUTORIAL.md](/tutorial/).                                                                                                                               |
| `async-main.ts`                                                              | An async `main`, which run.test.ts runs.                                                                                                                                  |
| `run.ts`, `worker.ts`, `program.ts`                                          | Run a program on node `worker_threads`.                                                                                                                                   |
| `chrome.ts`, `index.html`, `page.ts`, `web-worker.ts`                        | Run a program in Chrome.                                                                                                                                                  |
| `bench.ts`, `trace-summary.ts`                                               | The measurements.                                                                                                                                                         |

## Shared Everything, Publish on Escape

This was the first design. We tried it and set it aside. Its runtime,
`expand.ts` and the hand translations are at the tag
[`publish-on-escape`][publish-on-escape].

We translated the programs by hand, following the rules a transform would apply:

- **Property access is plain JS.** A shared object's handle has a prototype per
  shape, with a getter and a setter per slot. A local object that moves to the
  shared heap turns into the same kind of view of its copy. That way, the
  engine's own inline caches tell local and shared objects apart. Elements, and
  names that an array also has (`length`, `push`...), check `$fwd` first. That's
  because a local array that moved keeps its own length and elements.
- **Storing a local object somewhere shared publishes it.** The store copies the
  object, and what it reaches, into the heap. That store always runs on the
  owning thread, so moving the object needs no handover.
- **Closures keep the variables they capture in environment objects.** That way,
  a closure can move with its variables.
- **Loop back-edges are clean points.** At a clean point, a thread hands over
  the objects that other threads asked for.

Shared objects follow the threads design:

- one 8-byte value word per slot
- readers that never lock
- a lock word per object owned by the thread that made it
- handover at clean points

Here's how it performed on one thread:

| One thread, against plain V8 | Cost                                        |
| ---------------------------- | ------------------------------------------- |
| N-body on local objects      | 1.04x (1.00x without the clean-point polls) |
| Mandelbrot                   | 0.91x (top-level constants are inlined)     |
| N-body on shared objects     | 16.8x                                       |

Shared reads are slow mostly because TurboFan stops inlining the getters once a
function's inlining budget runs out. With a larger budget (a V8 flag), N-body on
shared objects comes down to 6.8x.

A clean-point poll costs little here. In a tight loop over objects, though, it
can cost up to 2.5x, because it stops TurboFan from peeling the loop.

Own and shared values, in the next section, do better. They don't need the
shared heap's objects or their handover, so they replaced this design.

## Own and Shared Values

This is the design that grew into the runtime. Here's what it looks like:

```js
import {spawn, share} from './own.ts';

const t = spawn(worker, id, slice, board, barrier); // slice moves to the thread; cells pass by reference
const back = t.join(); // the thread's result moves back
const snap = share(obj); // obj is deeply frozen now; any thread reads its own copy
board.set(i, snap); // a SharedMap: a cell, the explicit shared, mutable state
wait(barrier); // a struct holding a Lock and a Condition: cells too
slice[0].x; // after the move: throws "own: used after move"
```

Each kind of value works a little differently:

- **Moved values.** A moved value is copied into the shared heap once, and the
  sender's objects are revoked.
- **Shared values.** A shared value is written once. Each thread that reads it
  makes its own frozen copy on first use.
- **Cells.** Cells (shared structs, maps, locks and conditions) live in the
  shared heap and synchronize.

`own.ts` checks at run time that moved objects go unused and shared ones stay
unchanged. The ownership checker proves the same thing. The compiler emits the
function table that `spawn` needs (`register`), and it lowers shared structs
(`__sharedStruct`).

## Plain TypeScript, a Bundler Plugin and a Checker

```ts
import { f64, Lock, scope, SharedArray, struct, type Struct, type Sending, type Shared } from "@arv/threads";

const Body = struct({ x: f64, y: f64, vx: f64, vy: f64, m: f64 });   // a shared struct
type Body = Struct<typeof Body>;

function worker(lo: number, hi: number, bodies: SharedArray<Body>, lock: Lock) { ... }
function count(points: Sending<Point[]>, centers: Shared<Point[]>): Sending<number[]> { ... }
```

The model is plain TypeScript
([threads.d.ts](https://github.com/arv/threads/blob/main/src/runtime/threads.d.ts)),
so tsc, editors, linters and formatters all take programs as they are. A few
names carry the ownership rules:

- **`Sending<T>`** marks a value whose ownership moves. To TypeScript, it's just
  T.
- **`Shared<T>`** marks a value every thread may read. It's deeply readonly, so
  tsc already rejects most writes.
- **`consume(x)`** marks the end of a variable's life.
- **The `Cell` interface** marks the shared, mutable kinds: Lock, Condition,
  Channel, Thread, SharedArray and structs. You declare a struct with
  `struct({...})`. For a struct that refers to itself, you use
  `struct<I>({...})` with an interface.

Two tools add what the types can't say:

- **The ownership checker,**
  `threads-check -p tsconfig.json --runtime @arv/threads`, runs in CI like a
  linter. It reports only ownership errors and leaves type errors to tsc. The
  ownership errors are use after send, an alias of something sent, a write to a
  shared value, and sending what the caller still holds.
- **The bundler plugin**
  ([runtime/vite-plugin-threads.ts](https://github.com/arv/threads/blob/main/src/runtime/vite-plugin-threads.ts),
  for Vite) compiles each module with threads-check's compiler. Struct fields
  become typed-array accesses on shared memory, and struct references are
  counted. Every module registers the functions threads may run, keyed by its
  path so that the page's bundle and the workers' agree. The plugin also sets
  the headers that make the page cross-origin isolated on the dev and preview
  servers.

A page imports `@arv/threads/heap` first. That's the shared memory, which the
runtime's views need at load. Then the page calls `await run(f, ...args)`. `f`
runs on a pool of Web Workers, and its result moves back. The page's own thread
may not block, so it waits asynchronously. A worker loads a thread's module the
first time a thread needs it, so the page's own entry module never runs there.
That side of a page is
[runtime/heap.ts](https://github.com/arv/threads/blob/main/src/runtime/heap.ts)
and
[runtime/browser.ts](https://github.com/arv/threads/blob/main/src/runtime/browser.ts),
which the playground uses.

### With the Types Only Erased

A program still runs with its types only erased, through node's type stripping
and no compiler. It needs one added line that registers its top-level functions,
which is how a thread finds the one it runs. The runtime's own checks stand in
for the checker, so a use after move throws.

Code that moves and shares plain objects runs at the same speed. On node,
Mandelbrot takes 713/349/180/99 ms, against 712/341/180/97 ms compiled.

Shared structs don't keep up. Each one is then a handle with accessors for its
fields, and a SharedArray is a Proxy. N-body takes 1820/971/498/301 ms, against
29/15/8/6.

The compiler is what makes shared structs fast, and the checker is what makes
ownership safe before the program runs.

## Goroutines and Channels

```ts
const jobs = new Channel<number>(H),
  results = new Channel<Drawn>(H);
for (let t = 0; t < threads; t++) go(worker, jobs, results); // goroutines: pool threads, never joined
for (let y = 0; y < H; y++) jobs.send(y);
jobs.close(); // workers' `for (const y of jobs)` ends
```

[chan.ts](https://github.com/arv/threads/blob/main/src/runtime/chan.ts) is Go's
model on own and shared values. It has `go`, buffered and unbuffered channels,
`close`, range over a channel, and `select`.

A channel is a cell, and a value sent on it moves. So the checker proves that
the sender never uses the value again, as it does for `spawn`. Threads that
share nothing but channels have no data races, unlike Go's goroutines, which
share memory. The receiver frees each message, so nothing in the shared heap
outlives it.

Goroutines come in two weights:

- **A goroutine of a plain function** is a whole worker, so it's heavy. One
  that's blocked on a channel holds its worker.
- **A goroutine of an async function** is light. It's one of many on a worker,
  and each one waits with `await`.

A goroutine that throws prints its error, since nothing joins it.

A plain object is copied into its message, since V8 objects can't cross workers.
A shared struct or SharedArray is sent as its address. The compiler passes it
with a count (`__countedRef`, see [Reference Counting](/reference-counting/)),
and the receiver owns what it gets. `send` moves it, so using it after sending,
or using a local alias of it, is a compile error. Transferable ArrayBuffers
would also avoid the copy, but only through `postMessage`, which a goroutine
blocked in `recv()` never sees.

### What Channels Cost

Here's what channels cost on node, measured with
[pipeline.ts](https://github.com/arv/threads/blob/main/src/pipeline.ts):

- **Buffered channels.** A message costs about 600 ns.
- **Unbuffered channels.** A round trip costs 1.2 us. A waiter spins briefly
  before it sleeps.
- **Large messages.** An array of 100,000 numbers takes 0.8 ms copied, against
  0.2 ms moved by address. Most of that is filling the array.

Mandelbrot, with a channel of rows to draw, scales as well as anything else (see
the next section).

N-body that copies its positions through main each step is several times slower
than shared structs. N-body can also follow Go's way: share memory, and order it
with channels. With the bodies in a SharedArray of shared structs, and channels
in the barriers' place, it matches the barriers up to 4 threads. It's a little
slower on 8, where main relays every phase.

Channels suit pipelines and pools of jobs. Shared typed layouts suit loops over
shared data, and channels can order those too.

## Results

All times here are in ms.

The first benchmark is N-body with 800 bodies and 30 steps. Each number is the
median of 5 runs, on a warm pass (each worker's JIT warmed up). The shared
everything rows were measured at the [`publish-on-escape`][publish-on-escape]
tag.

| Threads                                                            | 1   | 2   | 4   | 8   |
| ------------------------------------------------------------------ | --- | --- | --- | --- |
| TypeScript, `SharedArray` of shared structs (typed layout), node   | 28  | 15  | 8   | 6   |
| TypeScript, `SharedArray` of shared structs (typed layout), Chrome | 31  | 17  | 8   | 6   |
| Own and shared values, positions in a shared cell, node            | 27  | 14  | 8   | 6   |
| Own and shared values, positions in a shared cell, Chrome          | 28  | 15  | 7   | 5   |
| TypeScript, moved and shared objects, compiled by the fork, Chrome | 35  | 21  | 11  | 14  |
| Own and shared values, Chrome                                      | 35  | 21  | 12  | 13  |
| Own and shared values, node                                        | 32  | 20  | 16  | 16  |
| Goroutines and channels over shared structs, node                  | 29  | 15  | 8   | 10  |
| Goroutines and channels over shared structs, Chrome                | 29  | 17  | 10  | 9   |
| Goroutines and channels, copying plain objects, Chrome             | 92  | 52  | 30  | 24  |
| Goroutines and channels, copying plain objects, node               | 99  | 60  | 45  | 28  |
| Shared everything, Chrome                                          | 426 | 223 | 126 | 85  |
| Shared everything, node                                            | 443 | 227 | 123 | 81  |
| Porffor native                                                     | 143 | 76  | 40  | 29  |
| Porffor Wasm, Chrome                                               | 883 | 455 | 231 | 130 |
| Plain V8, no threads                                               | 25  |     |     |     |

The Porffor rows are Porffor's own builds of the presets, measured in its
repository. `bench.ts` doesn't build them.

The second benchmark is Mandelbrot, which computes on thread-local numbers:

| Threads                         | 1    | 2   | 4   | 8   |
| ------------------------------- | ---- | --- | --- | --- |
| Shared everything, node         | 675  | 345 | 177 | 92  |
| Goroutines and channels, node   | 712  | 341 | 180 | 97  |
| Goroutines and channels, Chrome | 750  | 383 | 196 | 103 |
| Shared everything, Chrome       | 689  | 352 | 177 | 93  |
| Porffor native                  | 657  | 328 | 167 | 88  |
| Porffor Wasm, Chrome            | 1130 | 573 | 293 | 156 |
| Plain V8, no threads            | 737  |     |     |     |

### What the Numbers Show

With snapshots, own and shared N-body stops scaling past 4 threads. Every thread
copies all 800 positions each step, and that work doesn't shrink with more
threads.

Shared typed layouts copy nothing. That's true both of the positions in a shared
cell and of the bodies in a `SharedArray` of `shared struct`s that the compiler
lays out. Both reach 4.5-5.6x on 8 threads.

The ceiling on this machine is about 6.4x, with the work handed out in chunks.
Past 6 threads, a thread runs on a slower core, and every step waits for it at
the barrier.

The compiler checks a `SharedArray` index against the length. An index out of
range reads `__outOfBounds[i]`, a Proxy that throws, rather than calling a
function. There's a reason for that. In Chrome, a call on the failure path made
the typed-layout version 1.6x slower (51/29/16/13 ms), even though it was never
taken.

The compiler drops the check where the index is provably in range: `A[i]` in
`for (let i = 0; i < A.length; i++)`, with neither `A` nor `i` assigned anywhere
else. N-body's inner loop is just that case.

## What the Prototypes Leave Out

The prototypes don't cover everything. Here's what they leave out:

- **Not everything is freed in the shared heap.** Shared structs, SharedArrays,
  maps and strings are reference counted
  ([Reference Counting](/reference-counting/)), and cycles of them are freed
  only by `collectCycles()`. A moved value is freed once it's read. Shared
  values, channels, locks and conditions are never freed.
- **Ordering relies on V8 in practice, not on the spec.** Plain
  SharedArrayBuffer accesses are taken to behave as relaxed atomics. There are
  no 8-byte release stores. NaN payloads are kept intact when copied through
  typed arrays. All three hold in V8 today, but the JS memory model doesn't
  promise any of them.
- **Only part of the language is covered.** `own.ts` can't send cycles. A shared
  struct's fields are numbers, booleans, strings, and references to structs,
  SharedArrays, channels, locks and conditions.
