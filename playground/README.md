# Threads playground

Threads for JavaScript, in plain TypeScript, on Web Workers and a SharedArrayBuffer, and a playground
that shows what they compile to.

> Written iterating with Claude Code (Claude Opus 5.5).

```ts
import { Barrier, f64, scope, SharedArray, struct, type Struct } from "threads";

const Body = struct({ x: f64, y: f64, vx: f64, vy: f64, m: f64 }); // in shared memory
type Body = Struct<typeof Body>;

function worker(lo: number, hi: number, bodies: SharedArray<Body>, barrier: Barrier) {
  for (let i = lo; i < hi; i++) bodies[i].vx += bodies[i].x;      // every thread, the same memory
  barrier.wait();
}

const bodies = new SharedArray(Body, 800), barrier = new Barrier(8);
scope(s => { for (let t = 0; t < 8; t++) s.spawn(worker, t * 100, t * 100 + 100, bodies, barrier); });
```

## Try it

You need Node 22.13 or later, a recent Chrome (or another browser with SharedArrayBuffer), and, for
the compiled JavaScript, a fork of TypeScript 7.0.2 (microsoft/TypeScript, its Go compiler in `tsc/`,
branch `own-shared`), built with `go build -o built/local/tsgo ./cmd/tsgo` in its `tsc/` directory. The
fork is not published yet. The ownership checker needs no fork: it is [checker/](checker), on stock
TypeScript 7.1, which `npm install` sets up as a workspace.

```sh
npm install
TSGO=/path/to/TypeScript/tsc/built/local/tsgo npm run dev
```

Open the address Vite prints. Pick a program and edit it in Monaco, with TypeScript's hover types,
completions and errors from the threads API, and see:

- the JavaScript the fork compiles it to, with what the compiler added marked;
- the same program with its types only erased, which still runs;
- the ownership checker's errors (threads-check's), as squiggles in the editor and in a list;
- its output, run on a pool of Web Workers (Run). `main` runs on a worker too, started like any other
  thread, so it may block (`join`, `recv`, a barrier); the page itself never blocks, it only awaits
  `main`'s result.

The dev server compiles, so a production build (`npm run build`) shows the page but cannot compile.

## The model

Each thread is a worker with its own JavaScript heap, and objects cannot cross between heaps. So every
value is one of three kinds:

| Kind | In types | Crosses threads by | For |
|---|---|---|---|
| Owned | ordinary types; `Sending<T>` where it moves | moving: copied once, the sender loses it | work a thread does alone, and its result |
| Shared | `Shared<T>`, deeply readonly | copied once per reader; never changes | tables, settings |
| Cell | `Cell`: structs from `struct(...)`, `SharedArray`, `Barrier`, `Slots`, `Channel` | not at all: one copy in shared memory | data many threads read and write, and what orders them |

A struct's fields are numbers (`f64`), 32-bit integers (`i32`), bytes (`u8`), booleans (`bool`),
strings (`str`) and references to other structs, SharedArrays and Channels (`ref<T>()`); a
SharedArray holds any of these but references, or structs, inline. A channel in a struct lets any
thread that can reach the struct wait on it, as Go code waits on a channel kept in a struct. `atomic.add(work, "next", 1)` and the other
operations of `Atomics` act on an `i32` field (or an element of a `SharedArray<i32>`), so threads can
share a counter, claim work or wait for each other with no lock. What is stored into an `i32` or a `u8`
must be an integer: integer arithmetic, which wraps, or an explicit conversion (`Math.round(x)`,
`x | 0`), as asm.js required, but not a number that may have a fraction, which the store would
truncate with no sign. Strings in shared memory are interned: each distinct string is stored once, a field
holds its address, and each thread decodes it once. A string that occurs more than once in a moved or
shared value is copied once, and one a thread has read from a `str` field crosses as its address.

Code inside a thread is plain JavaScript on plain objects. The cost is at the crossings. Threads can
also talk Go's way: `go(f, ...args)`, `new Channel<T>(n)`, `send`, `recv`, `for (const v of ch)`,
`select`. A value sent on a channel moves; a struct or SharedArray goes as its address.

The whole API, with doc comments, is [runtime/threads.d.mts](runtime/threads.d.mts).

## Three tools

- **tsc** (`npm run typecheck`) checks the types. `Shared<T>` is deeply readonly, so it already rejects
  most writes to shared values.
- **The ownership checker**, `threads-check` ([checker/](checker), `npm run own-check`), runs in CI like
  a linter. It reports what tsc cannot see: a use after a value was sent, an alias of something sent,
  sending what the caller still holds, writing to a shared value through a cast, a number that may
  not be an integer stored into an `i32` or a `u8`. It is built on stock
  TypeScript 7.1's public API, so it needs no fork; its tests compare it with the fork's `tsgo own
  check`, which it replaces. The playground's dev server runs it too, with one TypeScript session kept
  open.
- **The compile** (the fork, through the Vite plugin, [runtime/vite-plugin-threads.mjs](runtime/vite-plugin-threads.mjs))
  erases the types and leaves the code alone, except that struct fields become typed-array reads
  (`b.x` is `__F64[(b >> 3) + 1]`), references to structs are counted so shared memory is freed
  ([docs/refcount.md](docs/refcount.md)), and top-level functions are registered so a worker can find the
  one a thread runs.

With the types only erased, a program still runs, given that one registration line, and the runtime's
own checks stand in for the checker: using a moved value throws (and with `start({ check: true })`,
so does using anything that was in it). Plain objects are as fast as compiled;
shared structs are about 50 times slower, since each is then a handle behind accessors.

## Programs

[programs/](programs) starts with the basics, one idea each: hello, threads; moving a value to a
thread; sharing a value; a shared struct; a SharedArray of booleans (a sieve); strings in shared
memory; atomics (claiming work, and counting together); a channel pipeline; a pool of workers on
channels. Then the bigger examples: N-body four ways
(shared structs with a barrier, shared structs with channels, moving and sharing objects, channels
copying objects), Mandelbrot on channels, JSON parsed on threads, the nearest-centers example, what
channels cost, reference counting under a race, a growable `SharedVector` written in user space on
the API above, and the mistakes the checker catches. Each exports `main(threadCounts)`.

Values cross threads about as fast as JSON would carry them, and are read back faster. On one thread
(Node 24), 50,000 log requests, each with a nested object and an array, are written as a message in
about 1.1 times as long as `JSON.stringify` takes, and read back in about a third of the time
`JSON.parse` takes (a shared value, whose objects are frozen: 1.5 and a half). A message names each
distinct set of keys once (a shape: the keys' interned addresses), the reader makes all of a shape's
objects with one constructor, and a string repeated in a value is written once and decoded once. An
ASCII string is stored a byte per char, a long one written with `TextEncoder.encodeInto` and read with
`TextDecoder` (they take no views of shared memory, so the bytes go through a thread's own buffer):
23 MB of JSON text crosses in about 7 ms.

Measured on an Apple M5 Pro, ms on 1/2/4/8 threads:

| | Compiled | Types erased |
|---|---|---|
| N-body, shared structs (plain V8, 1 thread: 25) | 29 / 15 / 8 / 6 | 1820 / 971 / 498 / 301 |
| Mandelbrot, channels | 712 / 341 / 180 / 97 | 713 / 349 / 180 / 99 |

## Layout

| Path | What |
|---|---|
| `runtime/threads.mjs`, `threads.d.mts` | the API |
| `runtime/own.mjs`, `chan.mjs`, `runtime.mjs` | own and shared values and cells; goroutines and channels; the shared heap, its allocator and the worker pool |
| `runtime/heap.mjs`, `browser.mjs`, `threads-worker.mjs` | a page's side: its shared memory, `start()` and `await run(f, ...args)`, its pool of Web Workers |
| `runtime/vite-plugin-threads.mjs` | compiles with the fork, registers thread functions, serves the playground's compiles (with threads-check's errors), sets cross-origin isolation |
| `checker/` | threads-check, the ownership checker, on TypeScript 7.1's API |
| `index.html`, `main.ts` | the playground, on [Monaco](https://github.com/microsoft/monaco-editor) |

## Limits

- A page needs cross-origin isolation (the COOP and COEP headers) for SharedArrayBuffer. The dev server
  sends them; a production server must too.
- Shared memory is a fixed 256 MB. Structs and SharedArrays are reference counted, but cycles of them
  leak. Channels are never freed. A moved value (a thread's arguments and result, a channel's message) is freed once it is read,
  but shared values are never freed, and neither are interned strings: a `str` field suits labels and
  names better than an endless stream of distinct text.
- A thread runs a top-level function; closures do not cross threads.
- A goroutine is a whole worker: one per core is fine, thousands are not.

This grew out of an experiment in [Porffor](https://github.com/CanadaHonk/porffor)'s threads work,
compiling JavaScript to JavaScript for threads instead of to C and WebAssembly.

## License

Copyright 2026 Erik Arvidsson. Licensed under the [Apache License 2.0](LICENSE).
