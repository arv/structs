# own-threads

Threads for JavaScript, in plain TypeScript. Real parallelism on Web Workers and a
`SharedArrayBuffer`, with a programming model you can reason about: every value is owned by one
thread, shared read-only, or a cell built for sharing, and a checker proves you follow the rules.

```ts
import { Barrier, f64, scope, SharedArray, struct, type Struct } from "own-threads";

const Body = struct({ x: f64, y: f64, vx: f64, vy: f64, m: f64 }); // lives in shared memory
type Body = Struct<typeof Body>;

function step(bodies: SharedArray<Body>, lo: number, hi: number, barrier: Barrier) {
  for (let i = lo; i < hi; i++) bodies[i].x += bodies[i].vx;     // every thread, the same memory
  barrier.wait();
}

export function main(threads: number) {
  const bodies = new SharedArray(Body, 800), barrier = new Barrier(threads);
  scope(s => {
    for (let t = 0; t < threads; t++) s.spawn(step, bodies, Math.floor(t * 800 / threads), Math.floor((t + 1) * 800 / threads), barrier);
  });
}
```

> **Status: experimental.** The API, the checker and the runtime work and are tested, but the
> compiler that lays shared structs out in shared memory is a fork of TypeScript 7 that is not
> published yet. See [Status](#status).

Try it in the browser, with the compiled JavaScript side by side:
[arv/threads-playground](https://github.com/arv/threads-playground).

## The model

A thread is a worker with its own JavaScript heap, and objects cannot cross between heaps. So every
value is one of three kinds:

| Kind | In the types | Crosses threads by | For |
|---|---|---|---|
| Owned | ordinary types; `Sending<T>` where it moves | moving: copied once, and the sender loses it | work a thread does alone, and its result |
| Shared | `Shared<T>`, deeply readonly | being frozen: every thread reads its own copy, made once | tables, settings, lookups |
| Cell | `struct(...)`, `SharedArray`, `Barrier`, `Slots`, `Channel` | not at all: one copy in shared memory | data many threads read and write in place, and what orders them |

Code inside a thread is plain JavaScript on plain objects, at full speed. The cost is at the
crossings, and the types say where they are.

```ts
import { log, share, spawn, type Sending, type Shared } from "own-threads";

type Order = { id: number; items: number[] };

// the order moves to the thread: it owns it now, and may change it
function total(order: Sending<Order>): Sending<number> {
  order.items.push(5);
  return order.items.reduce((sum, x) => sum + x, 0);
}

// rates are shared: frozen, and read by any number of threads
function convert(amount: number, rates: Shared<Record<string, number>>, to: string): Sending<number> {
  return amount * rates[to];
}

export function main() {
  const order = { id: 1, items: [10, 20, 30] };
  log(spawn(total, order).join());  // 65; using `order` here is an error
  const rates = share({ USD: 1, EUR: 0.92, SEK: 10.5 });
  log(spawn(convert, 100, rates, "EUR").join());
}
```

Threads can also talk the way Go does: `go(f, ...args)` starts a goroutine, and a `Channel<T>` moves
values between threads in order (`send`, `recv`, `for (const v of channel)`, `select`).

## Install

```sh
npm install own-threads
npm install --save-dev own-threads-check   # the ownership checker
```

own-threads needs [Vite](https://vite.dev) 7, Node 22.13 or later, and a browser with
`SharedArrayBuffer`.

## Set up

**1. The Vite plugin** compiles your TypeScript, registers the functions threads run, and sets the
cross-origin isolation headers that `SharedArrayBuffer` needs on the dev and preview servers.

```js
// vite.config.mjs
import threads from "own-threads/vite";

export default {
  plugins: [threads({ tsgo: "/path/to/TypeScript/tsc/built/local/tsgo" })],
};
```

**2. The page** imports the shared memory first, then runs functions on the pool of workers. `main`
runs on a worker too, so it may block (join a thread, wait on a barrier, receive from a channel); the
page only awaits its result.

```ts
// main.ts, the page's entry module
import "own-threads/heap";            // first: the shared memory, before anything uses it
import { run } from "own-threads/browser";
import { main } from "./app.ts";

console.log(await run(main, 8));
```

**3. The checker** runs in CI like a linter. It reports what TypeScript's types cannot see: a value
used after it was sent, an alias of something sent, sending what the caller still holds, a write to a
shared value through a cast.

```sh
npx own-threads-check -p tsconfig.json --runtime own-threads
```

```
app.ts(23,16): error TS96007: 'order' cannot be sent: it may be referenced by the caller. Declare the parameter 'Sending<T>' to take ownership.
```

**In production**, your server must send `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`.

## API

All from `"own-threads"`, unless noted.

**Owned and shared values**

| | |
|---|---|
| `Sending<T>` | A value that moves: the receiver owns it, and the sender must not use it again. |
| `Shared<T>` | A deeply readonly value any number of threads may read. |
| `share(value)` | Freezes a value the caller owns, deeply, into a `Shared<T>`. |
| `consume(value)` | Ends a value's lifetime, for the checker. |

**Threads**

| | |
|---|---|
| `spawn(f, ...args)` | Starts `f` on a thread. Owned arguments move; shared values and cells are shared. |
| `thread.join()`, `thread.joinAsync()` | Waits for the thread; its result moves back. |
| `scope(s => ...)` | Structured threads: joins every thread `s.spawn` started before it returns. |
| `partition(items, parts)`, `take(items, i)` | Splits an owned array into owned parts; takes one element out. |
| `new Barrier(n)` | `wait()` blocks until `n` threads have called it. |
| `new Slots<T>(n)` | One slot per thread to publish a shared value into; everyone reads all slots. |

**Goroutines and channels**

| | |
|---|---|
| `go(f, ...args)` | Starts `f` on a thread of its own. Nothing waits for it. |
| `new Channel<T>(capacity = 0)` | `send(value)` moves a value in, `recv()` takes the next one out, `close()`; iterable. |
| `select(...channels)` | Waits for the first channel with a value: `[index, value]`. |

**Shared memory**: data many threads read and write in place, with no copying. Reads and writes are
not ordered between threads: a `Barrier`, a `Channel` or joining a thread orders them.

| | |
|---|---|
| `struct({ x: f64, done: bool, name: str, next: ref<T>() })` | A shared struct type; `new S()` makes a zeroed one. `Struct<typeof S>` is its values' type. |
| `f64`, `bool`, `str`, `ref<T>()` | Field kinds: a number, a boolean (a byte), a string (interned), a reference to a struct or SharedArray (or null). |
| `new SharedArray(Number \| Boolean \| String \| S, length)` | A fixed-length array of numbers, booleans, strings or structs, stored inline. |

Structs and SharedArrays are reference counted and freed when no thread can reach them. A struct
that refers to its own type is declared with an interface:

```ts
interface Node { value: number; next: Node | null }
const Node = struct<Node>({ value: f64, next: ref<Node>() });
```

**The page** (`"own-threads/browser"`): `start({ workers, check, onLog })` starts the pool (one
worker per core by default; `run` starts it if needed), `run(f, ...args)` runs `f` on a thread and
resolves with its result, `stop()`.

**Odds and ends**: `log(...args)` prints a line from any thread; `heapStats()` reports shared memory
in use and blocks allocated and freed.

## Performance

On an Apple M5 Pro, ms on 1, 2, 4 and 8 threads:

| | |
|---|---|
| N-body, 800 bodies in shared structs (plain V8 on one thread: 25) | 29, 15, 8, 6 |
| Mandelbrot on goroutines and channels | 712, 341, 180, 97 |
| A sieve of Eratosthenes on a `SharedArray<boolean>` of 10 million | 76, 56, 40, 37 |

Values cross threads about as fast as JSON would carry them, and are read back faster: moving 50,000
parsed JSON requests costs about 1.1 times `JSON.stringify` to write and a third of `JSON.parse` to
read. Each distinct set of keys is written once per message, strings repeated in a value are written
once, and ASCII text is stored a byte per character.

## Status

- **The compiler is a fork.** Shared structs and SharedArrays are compiled to typed-array reads and
  writes (`b.x` becomes `__F64[(b >> 3) + 1]`), and their references are counted, by a fork of
  TypeScript 7.0.2 that is not published yet; the plugin's `tsgo` option names its binary. With
  types only erased, programs still run, and a use after move still throws, but each struct is a
  handle behind accessors, about 50 times slower.
- **The checker needs no fork.** own-threads-check runs on stock TypeScript 7.1's API.
- Shared memory is a fixed 256 MB. Structs and SharedArrays are reference counted, but cycles of them
  leak. A moved value (a thread's arguments and result, a channel's message) is freed once it is
  read; shared values and interned strings are never freed.
- A thread runs a top-level function: closures do not cross threads.
- A goroutine is a whole worker: one per core is fine, thousands are not.
- Moving revokes the values moved, so using them throws; `start({ check: true })` revokes everything
  inside them too.

## License

Copyright 2026 Erik Arvidsson. Licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).
