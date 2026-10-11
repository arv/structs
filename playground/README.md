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

You need Node 22.13 or later, a recent Chrome (or another browser with SharedArrayBuffer), and the
compiler: a fork of TypeScript 7.0.2 (microsoft/TypeScript, its Go compiler in `tsc/`, branch
`own-shared`), built with `go build -o built/local/tsgo ./cmd/tsgo` in its `tsc/` directory. The fork is
not published yet.

```sh
npm install
TSGO=/path/to/TypeScript/tsc/built/local/tsgo npm run dev
```

Open the address Vite prints. Pick a program, edit it, and see:

- the JavaScript the fork compiles it to, with what the compiler added highlighted;
- the same program with its types only erased, which still runs;
- the ownership checker's errors and tsc's;
- its output, run on a pool of Web Workers (Run).

The dev server compiles, so a production build (`npm run build`) shows the page but cannot compile.

## The model

Each thread is a worker with its own JavaScript heap, and objects cannot cross between heaps. So every
value is one of three kinds:

| Kind | In types | Crosses threads by | For |
|---|---|---|---|
| Owned | ordinary types; `Sending<T>` where it moves | moving: copied once, the sender loses it | work a thread does alone, and its result |
| Shared | `Shared<T>`, deeply readonly | copied once per reader; never changes | tables, settings |
| Cell | `Cell`: structs from `struct(...)`, `SharedArray`, `Barrier`, `Slots`, `Channel` | not at all: one copy in shared memory | data many threads read and write, and what orders them |

Code inside a thread is plain JavaScript on plain objects. The cost is at the crossings. Threads can
also talk Go's way: `go(f, ...args)`, `new Channel<T>(n)`, `send`, `recv`, `for (const v of ch)`,
`select`. A value sent on a channel moves; a struct or SharedArray goes as its address.

The whole API, with doc comments, is [runtime/threads.d.mts](runtime/threads.d.mts).

## Three tools

- **tsc** (`npm run typecheck`) checks the types. `Shared<T>` is deeply readonly, so it already rejects
  most writes to shared values.
- **The ownership checker** (`npm run own-check`, `tsgo own check`) runs in CI like a linter. It reports
  what tsc cannot see: a use after a value was sent, an alias of something sent, sending what the
  caller still holds, writing to a shared value through a cast.
- **The compile** (the fork, through the Vite plugin, [runtime/vite-plugin-threads.mjs](runtime/vite-plugin-threads.mjs))
  erases the types and leaves the code alone, except that struct fields become typed-array reads
  (`b.x` is `__F64[(b >> 3) + 1]`), references to structs are counted so shared memory is freed
  ([docs/refcount.md](docs/refcount.md)), and top-level functions are registered so a worker can find the
  one a thread runs.

With the types only erased, a program still runs, given that one registration line, and the runtime's
own checks stand in for the checker (a use after move throws). Plain objects are as fast as compiled;
shared structs are about 50 times slower, since each is then a handle behind accessors.

## Programs

[programs/](programs): N-body four ways (shared structs with a barrier, shared structs with channels,
moving and sharing objects, channels copying objects), Mandelbrot on channels, the nearest-centers
example, what channels cost, reference counting under a race, and the mistakes the checker catches.
Each exports `main(threadCounts)`.

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
| `runtime/vite-plugin-threads.mjs` | compiles with the fork, registers thread functions, serves the playground's compiles, sets cross-origin isolation |
| `index.html`, `main.ts` | the playground, with [microlighter](https://github.com/davatron5000/microlighter) for the code |

## Limits

- A page needs cross-origin isolation (the COOP and COEP headers) for SharedArrayBuffer. The dev server
  sends them; a production server must too.
- Shared memory is a fixed 256 MB. Structs and SharedArrays are reference counted, but cycles of them
  leak, and moved and shared values are never freed.
- A thread runs a top-level function; closures do not cross threads.
- A goroutine is a whole worker: one per core is fine, thousands are not.

This grew out of an experiment in [Porffor](https://github.com/CanadaHonk/porffor)'s threads work,
compiling JavaScript to JavaScript for threads instead of to C and WebAssembly.
