# JS-to-JS threads on workers

> **Disclaimer:** this was mostly done iterating with the help of Claude Code (Claude Opus 5.5),
> disclosed per Porffor's [AI policy](../../AI_POLICY.md).

Prototypes of compiling JavaScript to JavaScript for threads, running on Web Workers and node
`worker_threads` with a SharedArrayBuffer, instead of compiling it to C and then to WebAssembly as
[threads](../README.md) and the [playground](../playground) do. V8 objects cannot cross workers,
so the question is what to do with objects. Two designs are here:

- **Shared everything, publish on escape:** the threads model of [threads/README.md](../README.md).
  An object stays an ordinary V8 object until another thread can reach it, then moves into a
  SharedArrayBuffer heap. Code that shares nothing runs at plain V8 speed, but reading a shared
  object costs about 17x.
- **Own and shared values:** a value is owned by one thread and moved across, deeply immutable and
  copied once per thread that reads it, or an explicit cell. Ordinary code is plain JS with nothing
  per access, and N-body on 4 threads runs 2x faster than plain single-threaded JS. A TypeScript
  extension checks the ownership rules at compile time, in a fork of tsgo.

Measured on an Apple M5 Pro (6 fast and 12 slower cores) with node 24.18 and Chrome 154.

[TUTORIAL.md](TUTORIAL.md) walks through writing, checking and running a small program in the
TypeScript extension, and how each step works.

## Running

```sh
node threads/escape-proto/run.mjs nbody                  # on node: nbody, mandelbrot, basic, nbody-own
node threads/escape-proto/run.mjs nbody --threads=1,1,8  # the thread counts the program runs with
node threads/escape-proto/chrome.mjs nbody-own           # in Chrome, on Web Workers (needs playwright-core)
node threads/escape-proto/chrome.mjs nbody --trace=t.json && node threads/escape-proto/trace-summary.mjs t.json
node threads/escape-proto/bench.mjs                      # every configuration, median of 5 runs
node threads/escape-proto/overhead.mjs                   # the translation against the same code untranslated
```

`chrome.mjs` drives the installed Google Chrome through Playwright: `npm i playwright-core`, or
point `PLAYWRIGHT_CORE` at an install's `node_modules/playwright-core`. Its `--trace` records a
DevTools performance trace with every worker's CPU samples, which DevTools' Performance panel opens.

Programs written in the TypeScript extension compile with the tsgo fork (branch `own-shared`), then
run like the others:

```sh
<tsgo-fork>/built/local/tsgo -p threads/escape-proto/tsconfig.json
node threads/escape-proto/run.mjs threads/escape-proto/build/ts/nbody-ts.mjs
```

## Files

| File | What it is |
|---|---|
| `runtime.mjs` | the shared heap: allocator, value words, strings, shapes, handles, ownership and handover, Lock, Condition, the worker pool |
| `expand.mjs` | turns the access macros of a hand translation into what a transform would emit |
| `nbody.mjs`, `mandelbrot.mjs`, `basic.mjs` | the playground's presets, and a small example, translated by hand for publish on escape |
| `own.mjs`, `own.d.mts` | own and shared values on top of the runtime, and their TypeScript types |
| `nbody-own.mjs` | N-body written by hand for own and shared values |
| `nbody-cells.mjs` | the same with the positions in a shared typed-array cell instead of snapshots: nothing copied per step |
| `nbody-struct.mts` | N-body in the TypeScript extension with `SharedArray<Body>` of `shared struct`s, which the fork lays out in the shared heap |
| `nbody-ts.mts`, `tsconfig.json` | the same program in the TypeScript extension, for the tsgo fork |
| `tutorial.mts` | the example of [TUTORIAL.md](TUTORIAL.md) |
| `run.mjs`, `worker.mjs` | run a program on node `worker_threads` |
| `chrome.mjs`, `index.html`, `page.mjs`, `web-worker.mjs`, `wasm.html` | run a program, or a Porffor Wasm build, in Chrome |
| `bench.mjs`, `overhead.mjs`, `trace-summary.mjs` | the measurements |

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
import { fns, spawn, share, Barrier, Slots } from './own.mjs';

const t = spawn(worker, id, slice, board, barrier); // slice moves to the thread; cells pass by reference
const back = t.join();                              // the thread's result moves back
const snap = share(obj);                            // obj is deeply frozen now; any thread reads its own copy
board.set(i, snap); barrier.wait();                 // cells: the explicit shared, mutable state
slice[0].x;                                         // after the move: throws "own: used after move"
```

A moved value is copied into the shared heap once, and the sender's objects are revoked. A shared
value is written once, and each thread that reads it makes its own frozen copy on first use. Cells
(`Barrier`, `Slots`, shared structs) live in the shared heap and synchronize. The TypeScript
extension's checker proves what `own.mjs` checks at run time (moved objects unused, shared ones
unchanged). Its compiler emits the function table `spawn` needs (`__register`) and lowers
`shared struct`s (`__sharedStruct`).

## Results

N-body, 800 bodies, 30 steps, median of 5 runs, warm pass (each worker's JIT warmed up), ms:

| Threads | 1 | 2 | 4 | 8 |
|---|---|---|---|---|
| TypeScript, `SharedArray` of `shared struct`s (typed layout), node | 33 | 17 | 9 | 7 |
| Own and shared values, positions in a shared cell, node | 26 | 14 | 7 | 5 |
| Own and shared values, positions in a shared cell, Chrome | 28 | 15 | 7 | 5 |
| TypeScript extension, compiled by the fork, Chrome | 35 | 21 | 11 | 14 |
| Own and shared values, Chrome | 35 | 21 | 12 | 13 |
| Own and shared values, node | 32 | 20 | 16 | 16 |
| Shared everything, Chrome | 426 | 223 | 126 | 85 |
| Shared everything, node | 443 | 227 | 123 | 81 |
| Porffor native | 143 | 76 | 40 | 29 |
| Porffor Wasm, Chrome | 883 | 455 | 231 | 130 |
| Plain V8, no threads | 25 | | | |

Mandelbrot, which computes on thread-local numbers, ms:

| Threads | 1 | 2 | 4 | 8 |
|---|---|---|---|---|
| Shared everything, node | 675 | 345 | 177 | 92 |
| Shared everything, Chrome | 689 | 352 | 177 | 93 |
| Porffor native | 657 | 328 | 167 | 88 |
| Porffor Wasm, Chrome | 1130 | 573 | 293 | 156 |
| Plain V8, no threads | 737 | | | |

With snapshots, own and shared N-body stops scaling past 4 threads: every thread copies all 800
positions each step, which does not shrink with more threads. Shared typed layouts copy nothing: the
positions in a shared cell, or the bodies in a `SharedArray` of `shared struct`s that the compiler
lays out, reach 4.6-5x on 8 threads. The ceiling on this machine is about 6.4x, with the work handed
out in chunks: past 6 threads, a thread runs on a slower core and every step waits for it at the
barrier. In Chrome, the typed-layout version is slower (51/29/16/13 ms) because its bounds check calls
`__oob`, and V8 keeps that loop from being fully optimized; throwing through a Proxy index instead
brings it to 29/15/8/7 ms.

## What the prototypes leave out

- **No collector for the shared heap.** Local objects are V8's, but nothing moved into the shared heap,
  shared or sent is ever freed.
- **Ordering relies on V8 in practice, not on the spec.** Plain SharedArrayBuffer accesses are taken
  to behave as relaxed atomics, there are no 8-byte release stores, and NaN payloads are kept intact
  when copied through typed arrays. All three hold in V8 today; the JS memory model does not promise
  any of them.
- **Only part of the language.** Shared `Map` and `Set` are missing. Typed arrays are limited to
  `Int32Array` over a shared buffer. `own.mjs` cannot send cycles, and shared struct fields are
  numbers only.
