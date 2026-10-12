# JS-to-JS threads on workers

> **Disclaimer:** this was mostly done iterating with the help of Claude Code (Claude Opus 5.5).

Prototypes of compiling JavaScript to JavaScript for threads, running on Web Workers and node
`worker_threads` with a SharedArrayBuffer, instead of compiling it to C and then to WebAssembly as
[Porffor's threads][porffor-threads] and its [playground][porffor-playground] do. V8 objects cannot
cross workers, so the question is what to do with objects. Two designs are here:

- **Shared everything, publish on escape:** the threads model of Porffor's
  [threads/README.md][porffor-threads-readme]. An object stays an ordinary V8 object until another thread can reach it, then moves into a
  SharedArrayBuffer heap. Code that shares nothing runs at plain V8 speed, but reading a shared
  object costs about 17x.
- **Own and shared values:** a value is owned by one thread and moved across, deeply immutable and
  copied once per thread that reads it, or an explicit cell. Ordinary code is plain JS with nothing
  per access, and N-body on 8 threads runs 4x faster than plain single-threaded JS. Programs are
  plain TypeScript against [threads.d.ts](threads.d.ts); a checker built on a fork of tsgo proves
  the ownership rules in CI, and a bundler plugin compiles shared structs to typed-array accesses.

Measured on an Apple M5 Pro (6 fast and 12 slower cores) with node 24.18 and Chrome 154.

This started in Porffor's repository, as `threads/escape-proto` on top of its threads work. The own
and shared design grew into [playground/](playground): its runtime, the threads-check checker and
the playground carry on from the files here (and from `app/`, the playground's first page, in this
repository's history), and are where the work goes on.

[porffor-threads]: https://github.com/arv/porffor/tree/arv/shared-everything-threads/threads
[porffor-playground]: https://github.com/arv/porffor/tree/arv/shared-everything-threads/threads/playground
[porffor-threads-readme]: https://github.com/arv/porffor/blob/arv/shared-everything-threads/threads/README.md

[TUTORIAL.md](TUTORIAL.md) walks through writing, checking and running a small program, and how each
step works.

## Setup

The repository is a pnpm workspace on [Vite+](https://viteplus.dev) (`vp`): the prototype here at the
root, and [playground/](playground) and its checker. Vite+ brings Vite, Oxlint and a task runner,
and runs pnpm at the version `packageManager` names. You need Node 22.18 or later (24.11 or later on
Node 24).

```sh
pnpm install                # once, at the root
vp dev                      # the playground; TSGO=<tsgo-fork>/built/local/tsgo for the compiled JavaScript
vp build                    # the playground's production build
vp fmt                      # Oxfmt, over the whole workspace
vp lint                     # Oxlint, type-aware, over the whole workspace
vp check                    # formatting, lint and types, as CI would
vp run -r typecheck         # tsc in every package
```

`vp` is the CLI of the `vite-plus` dev dependency: `pnpm vp <command>`, or plain `vp` with Vite+'s
[global CLI](https://viteplus.dev/guide/).

## Running

```sh
node run.js nbody                  # on node: nbody, mandelbrot, basic, nbody-own
node run.js nbody --threads=1,1,8  # the thread counts the program runs with
node chrome.js nbody-own           # in Chrome, on Web Workers (needs playwright-core)
node chrome.js nbody --trace=t.json && node trace-summary.js t.json
node bench.js                      # every configuration, median of 5 runs
node overhead.js                   # the translation against the same code untranslated
```

`chrome.js` drives the installed Google Chrome through playwright-core, a dev dependency (or the
install `PLAYWRIGHT_CORE` points at, its `node_modules/playwright-core`). Its `--trace` records a
DevTools performance trace with every worker's CPU samples, which DevTools' Performance panel opens.

`bench.js`, `overhead.js` and `chrome.js --wasm` compare with Porffor's own builds of the same
programs, so they need a Porffor checkout on branch `arv/shared-everything-threads` of
[arv/porffor](https://github.com/arv/porffor): `PORFFOR=/path/to/porffor`, or `../porffor` beside
this repository.

The TypeScript programs (`*.ts`) are checked by stock tsc and by the ownership checker, and compiled
by the tsgo fork (branch `own-shared`, built with `go build -o built/local/tsgo ./cmd/tsgo`):

```sh
vp run typecheck                                               # types: stock TypeScript
<tsgo-fork>/built/local/tsgo own check -p tsconfig.json --ownRuntime ./threads.js   # ownership, for CI
<tsgo-fork>/built/local/tsgo -p tsconfig.json --ownRuntime ./threads.js            # emit build/ts
node run.js build/ts/nbody-struct.js
```

## Files

| File | What it is |
|---|---|
| [`playground/`](playground) | the own and shared design as it goes on: runtime, checker, playground ([its README](playground/README.md)) |
| `runtime.js` | the shared heap: allocator, value words, strings, shapes, handles, ownership and handover, Lock, Condition, the worker pool |
| `expand.js` | turns the access macros of a hand translation into what a transform would emit |
| `nbody.js`, `mandelbrot.js`, `basic.js` | the playground's presets, and a small example, translated by hand for publish on escape |
| `threads.js`, `threads.d.ts` | the API programs import: own and shared values, shared structs, channels, in plain TypeScript |
| `own.js`, `own.d.ts` | own and shared values on top of the runtime, and the types of the earlier syntax |
| `nbody-own.js` | N-body written by hand for own and shared values |
| `nbody-cells.js` | the same with the positions in a shared typed-array cell instead of snapshots: nothing copied per step |
| `nbody-struct.ts` | N-body in TypeScript with a `SharedArray` of shared structs, which the fork lays out in the shared heap |
| `nbody-ts.ts`, `tsconfig.json` | the same with ordinary objects, moved and shared |
| `chan.js`, `chan.d.ts` | Go-style goroutines and channels on own and shared values, and the types of the earlier syntax |
| `mandelbrot-chan.ts`, `nbody-chan.ts`, `nbody-chan-struct.ts`, `pipeline.ts` | the presets with channels (N-body copying plain objects, and over shared structs), and a small example of what channels cost |
| `REFCOUNT.md`, `refcount.ts`, `refcount-hand.js` | reference counting for shared structs and SharedArrays: the design, its test, and the test written by hand as the compiler emits it |
| `tutorial.ts` | the example of [TUTORIAL.md](TUTORIAL.md) |
| `run.js`, `worker.js` | run a program on node `worker_threads` |
| `chrome.js`, `index.html`, `page.js`, `web-worker.js`, `wasm.html` | run a program, or a Porffor Wasm build, in Chrome |
| `bench.js`, `overhead.js`, `trace-summary.js` | the measurements |

## Shared everything, publish on escape

The hand translations follow the rules a transform would apply:

- **Property access is plain JS.** A shared object's handle has a prototype per shape, with a
  getter and a setter per slot. A local object that moves to the shared heap turns into the same
  kind of view of its copy. So the engine's own inline caches tell local and shared objects apart.
  Elements, and names an array also has (`length`, `push`...), check `$fwd` first, because a local
  array that moved keeps its own length and elements.
- **Storing a local object somewhere shared publishes it.** The store copies the object, and what it
  reaches, into the heap. That store always runs on the owning thread, so moving it needs no handover.
- **Closures keep the variables they capture in environment objects,** so a closure can move with its
  variables.
- **Loop back-edges are clean points,** where a thread hands over the objects others asked for.

Shared objects follow the threads design: one 8-byte value word per slot, readers that never lock, a
lock word per object owned by the thread that made it, and handover at clean points.

| one thread, against plain V8 | cost |
|---|---|
| N-body on local objects | 1.04x (1.00x without the clean-point polls) |
| Mandelbrot | 0.91x (top-level constants are inlined) |
| N-body on shared objects | 16.8x |

Shared reads are slow mostly because TurboFan stops inlining the getters once a function's inlining
budget runs out; with a larger budget (a V8 flag) N-body on shared objects is 6.8x. A clean-point
poll costs little here, but in a tight loop over objects it can cost up to 2.5x, because it stops
TurboFan from peeling the loop.

## Own and shared values

```js
import { fns, spawn, share, Barrier, Slots } from './own.js';

const t = spawn(worker, id, slice, board, barrier); // slice moves to the thread; cells pass by reference
const back = t.join();                              // the thread's result moves back
const snap = share(obj);                            // obj is deeply frozen now; any thread reads its own copy
board.set(i, snap); barrier.wait();                 // cells: the explicit shared, mutable state
slice[0].x;                                         // after the move: throws "own: used after move"
```

A moved value is copied into the shared heap once, and the sender's objects are revoked. A shared
value is written once, and each thread that reads it makes its own frozen copy on first use. Cells
(`Barrier`, `Slots`, shared structs) live in the shared heap and synchronize. The ownership checker
proves what `own.js` checks at run time (moved objects unused, shared ones unchanged). The compiler
emits the function table `spawn` needs (`__register`) and lowers shared structs (`__sharedStruct`).

## Plain TypeScript, a bundler plugin and a checker

```ts
import { Barrier, f64, scope, SharedArray, struct, type Struct, type Sending, type Shared } from "threads";

const Body = struct({ x: f64, y: f64, vx: f64, vy: f64, m: f64 });   // a shared struct
type Body = Struct<typeof Body>;

function worker(lo: number, hi: number, bodies: SharedArray<Body>, barrier: Barrier) { ... }
function count(points: Sending<Point[]>, centers: Shared<Point[]>): Sending<number[]> { ... }
```

The model is plain TypeScript ([threads.d.ts](threads.d.ts)), so tsc, editors, linters and
formatters take programs as they are. `Sending<T>` (to TypeScript, just T) marks a value whose
ownership moves, `Shared<T>` (deeply readonly, so tsc already rejects most writes) a value every
thread may read, `consume(x)` the end of a variable's life, and the `Cell` interface the shared,
mutable kinds: Barrier, Slots, Channel, Thread, SharedArray and structs, declared with `struct({...})`
(or `struct<I>({...})` with an interface, for a struct that refers to itself). Two tools add what the
types cannot say:

- **The ownership checker,** `tsgo own check -p tsconfig.json --ownRuntime <the runtime module>`,
  runs in CI like a linter. It reports only ownership errors (use after send, an alias of something
  sent, a write to a shared value, sending what the caller still holds) and leaves type errors to tsc.
- **The bundler plugin** (the playground's
  [runtime/vite-plugin-threads.js](playground/runtime/vite-plugin-threads.js), for Vite) compiles
  each module with the tsgo fork: struct fields become typed-array accesses on shared memory, struct
  references are counted, and every module registers the functions threads may run, keyed by its
  path so the page's bundle and the workers' agree. It sets the headers that make the page
  cross-origin isolated on the dev and preview servers.

A page imports `threads/heap` first (the shared memory, which the runtime's views need at load), then
calls `await run(f, ...args)`: f runs on a pool of Web Workers and its result moves back, and the
page's own thread, which may not block, waits asynchronously. A worker loads a thread's module the
first time a thread needs it, so the page's own entry module never runs there. That side of a page is
the playground's ([runtime/heap.js](playground/runtime/heap.js),
[runtime/browser.js](playground/runtime/browser.js)), on a runtime that grew out of the files here.

**With the types only erased** (node's type stripping, no compiler), a program still runs, given one
added line that registers its top-level functions, which is how a thread finds the one it runs. The
runtime's own checks stand in for the checker: a use after move throws. Code that moves and shares
plain objects runs at the same speed (Mandelbrot: 713/349/180/99 ms against 712/341/180/97 compiled,
node). Shared structs do not: each one is then a handle, its fields accessors, a SharedArray a Proxy,
and N-body takes 1820/971/498/301 ms against 29/15/8/6. The compiler is what makes shared structs fast,
and the checker what makes ownership safe before the program runs.

## Goroutines and channels

```ts
const jobs = new Channel<number>(H), results = new Channel<Drawn>(H);
for (let t = 0; t < threads; t++) go(worker, jobs, results);  // goroutines: pool threads, never joined
for (let y = 0; y < H; y++) jobs.send(y);
jobs.close();                                                // workers' `for (const y of jobs)` ends
```

[chan.js](chan.js) is Go's model on own and shared values: `go`, buffered and unbuffered channels,
`close`, range over a channel, and `select`. A channel is a cell, and a value sent on it moves, so
the checker proves the sender never uses it again, as it does for `spawn`. Threads share nothing
but channels: no data races, unlike Go, whose goroutines share memory. The receiver frees each
message, so nothing in the shared heap outlives it and no collector is needed. A goroutine is a
whole worker, so it is heavy, and one blocked on a channel holds its worker. One that throws prints
its error, since nothing joins it.

A plain object is copied into its message, since V8 objects cannot cross workers. A shared struct
or SharedArray is sent as its address: the compiler passes it with a count (`__ref`, see
[REFCOUNT.md](REFCOUNT.md)), the receiver owns what it gets, and `send` moves it, so using it, or a
local alias of it, after sending is a compile error. Transferable ArrayBuffers would also avoid the
copy, but only through `postMessage`, which a goroutine blocked in `recv()` never sees.

What it costs ([pipeline.ts](pipeline.ts), node): about 600 ns a message on a buffered channel, an
unbuffered round trip 1.2 us (a waiter spins briefly before it sleeps), and an array of 100,000
numbers 0.8 ms copied against 0.2 ms moved by address, which is mostly filling it. Mandelbrot,
with a channel of rows to draw, scales as well as anything else (next section). N-body copying its
positions through main each step is several times slower than shared structs; with the bodies in a
SharedArray of shared structs and channels in the barriers' place (Go's way: share memory, order it
with channels) it matches the barriers up to 4 threads, and is a little slower on 8, where main
relays every phase. Channels suit pipelines and pools of jobs; shared typed layouts suit loops over
shared data, and channels can order those too.

## Results

N-body, 800 bodies, 30 steps, median of 5 runs, warm pass (each worker's JIT warmed up), ms:

| Threads | 1 | 2 | 4 | 8 |
|---|---|---|---|---|
| TypeScript, `SharedArray` of shared structs (typed layout), node | 28 | 15 | 8 | 6 |
| TypeScript, `SharedArray` of shared structs (typed layout), Chrome | 31 | 17 | 8 | 6 |
| Own and shared values, positions in a shared cell, node | 27 | 14 | 8 | 6 |
| Own and shared values, positions in a shared cell, Chrome | 28 | 15 | 7 | 5 |
| TypeScript, moved and shared objects, compiled by the fork, Chrome | 35 | 21 | 11 | 14 |
| Own and shared values, Chrome | 35 | 21 | 12 | 13 |
| Own and shared values, node | 32 | 20 | 16 | 16 |
| Goroutines and channels over shared structs, node | 29 | 15 | 8 | 10 |
| Goroutines and channels over shared structs, Chrome | 29 | 17 | 10 | 9 |
| Goroutines and channels, copying plain objects, Chrome | 92 | 52 | 30 | 24 |
| Goroutines and channels, copying plain objects, node | 99 | 60 | 45 | 28 |
| Shared everything, Chrome | 426 | 223 | 126 | 85 |
| Shared everything, node | 443 | 227 | 123 | 81 |
| Porffor native | 143 | 76 | 40 | 29 |
| Porffor Wasm, Chrome | 883 | 455 | 231 | 130 |
| Plain V8, no threads | 25 | | | |

Mandelbrot, which computes on thread-local numbers, ms:

| Threads | 1 | 2 | 4 | 8 |
|---|---|---|---|---|
| Shared everything, node | 675 | 345 | 177 | 92 |
| Goroutines and channels, node | 712 | 341 | 180 | 97 |
| Goroutines and channels, Chrome | 750 | 383 | 196 | 103 |
| Shared everything, Chrome | 689 | 352 | 177 | 93 |
| Porffor native | 657 | 328 | 167 | 88 |
| Porffor Wasm, Chrome | 1130 | 573 | 293 | 156 |
| Plain V8, no threads | 737 | | | |

With snapshots, own and shared N-body stops scaling past 4 threads: every thread copies all 800
positions each step, which does not shrink with more threads. Shared typed layouts copy nothing: the
positions in a shared cell, or the bodies in a `SharedArray` of `shared struct`s that the compiler
lays out, reach 4.5-5.6x on 8 threads. The ceiling on this machine is about 6.4x, with the work handed
out in chunks: past 6 threads, a thread runs on a slower core and every step waits for it at the
barrier.

The compiler checks a `SharedArray` index against the length, and an index out of range reads
`__OOB[i]`, a Proxy that throws, rather than calling a function: in Chrome, a call on the failure path,
though never taken, made the typed-layout version 1.6x slower (51/29/16/13 ms). The compiler drops the
check where the index is provably in range, `A[i]` in `for (let i = 0; i < A.length; i++)` with
neither `A` nor `i` assigned anywhere else, as in N-body's inner loop.

## What the prototypes leave out

- **Little is freed in the shared heap.** Shared structs and SharedArrays are reference counted
  ([REFCOUNT.md](REFCOUNT.md)), cycles of them leak, and a channel's receiver frees each message.
  Moved data, shared values and the publish-on-escape heap are never freed.
- **Ordering relies on V8 in practice, not on the spec.** Plain SharedArrayBuffer accesses are taken
  to behave as relaxed atomics, there are no 8-byte release stores, and NaN payloads are kept intact
  when copied through typed arrays. All three hold in V8 today; the JS memory model does not promise
  any of them.
- **Only part of the language.** Shared `Map` and `Set` are missing. Typed arrays are limited to
  `Int32Array` over a shared buffer. `own.js` cannot send cycles, and shared struct fields are
  numbers only.

## License

Copyright 2026 Erik Arvidsson. Licensed under the [Apache License 2.0](LICENSE).
