# @arv/threads

Threads for JavaScript, in plain TypeScript. Real parallelism on Web Workers and
a `SharedArrayBuffer`, with a programming model you can reason about: every
value is owned by one thread, shared read-only, or a cell built for sharing, and
a checker proves you follow the rules.

```ts
import {
  Barrier,
  f64,
  scope,
  SharedArray,
  struct,
  type Struct,
} from '@arv/threads';

const Body = struct({x: f64, y: f64, vx: f64, vy: f64, m: f64}); // lives in shared memory
type Body = Struct<typeof Body>;

function step(
  bodies: SharedArray<Body>,
  lo: number,
  hi: number,
  barrier: Barrier,
) {
  for (let i = lo; i < hi; i++) bodies[i].x += bodies[i].vx; // every thread, the same memory
  barrier.wait();
}

export function main(threads: number) {
  const bodies = new SharedArray(Body, 800),
    barrier = new Barrier(threads);
  scope(s => {
    for (let t = 0; t < threads; t++)
      s.spawn(
        step,
        bodies,
        Math.floor((t * 800) / threads),
        Math.floor(((t + 1) * 800) / threads),
        barrier,
      );
  });
}
```

> **Status: experimental.** The API, the checker and the runtime work and are
> tested, but the compiler that lays shared structs out in shared memory is a
> fork of TypeScript 7,
> [arv/threads-checker](https://github.com/arv/threads-checker), that you build
> yourself. See [Status](#status).

Try it in the browser, with the compiled JavaScript side by side:
[the playground](https://github.com/arv/threads/tree/main/playground).

> **Disclaimer:** this was mostly done iterating with the help of Claude Code
> (Claude Opus 5.5).

## The model

A thread is a worker with its own JavaScript heap, and objects cannot cross
between heaps. So every value is one of three kinds:

| Kind   | In the types                                                | Crosses threads by                                       | For                                                             |
| ------ | ----------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| Owned  | ordinary types; `Sending<T>` where it moves                 | moving: copied once, and the sender loses it             | work a thread does alone, and its result                        |
| Shared | `Shared<T>`, deeply readonly                                | being frozen: every thread reads its own copy, made once | tables, settings, lookups                                       |
| Cell   | `struct(...)`, `SharedArray`, `Barrier`, `Slots`, `Channel` | not at all: one copy in shared memory                    | data many threads read and write in place, and what orders them |

Code inside a thread is plain JavaScript on plain objects, at full speed. The
cost is at the crossings, and the types say where they are.

```ts
import {log, share, spawn, type Sending, type Shared} from '@arv/threads';

type Order = {id: number; items: number[]};

// the order moves to the thread: it owns it now, and may change it
function total(order: Sending<Order>): Sending<number> {
  order.items.push(5);
  return order.items.reduce((sum, x) => sum + x, 0);
}

// rates are shared: frozen, and read by any number of threads
function convert(
  amount: number,
  rates: Shared<Record<string, number>>,
  to: string,
): Sending<number> {
  return amount * rates[to];
}

export function main() {
  const order = {id: 1, items: [10, 20, 30]};
  log(spawn(total, order).join()); // 65; using `order` here is an error
  const rates = share({USD: 1, EUR: 0.92, SEK: 10.5});
  log(spawn(convert, 100, rates, 'EUR').join());
}
```

Threads can also talk the way Go does: `go(f, ...args)` starts a goroutine, and
a `Channel<T>` moves values between threads in order (`send`, `recv`,
`for (const v of channel)`, `select`); a struct or a SharedArray sent on one
stays where it is, in shared memory, and the receiver reads the same one. A
goroutine of an async function is light, as Go's are: a worker runs thousands of
them, each waiting with `await` without blocking the others. In Node on an M5
Pro, a goroutine on a worker of its own takes 3.2 ms to start and 8.6 MB; an
async one takes 0.2 µs and about 350 bytes. A blocking call in an async function
would stop every one on its worker, so the checker reports it and the runtime
throws.

```ts
interface Replica {
  position: i32;
  changed: Channel<void> | null;
} // closed, and replaced, on every change
const Replica = struct<Replica>({position: i32, changed: ref<Channel<void>>()});

async function request(
  replica: Replica,
  position: i32,
  answers: Channel<string>,
) {
  for (;;) {
    const changed = replica.changed!;
    if (atomic.load(replica, 'position') >= position) break;
    await changed.recvAsync(); // one of thousands waiting on this worker
  }
  await answers.sendAsync('ready');
}

for (let k = 0; k < 10_000; k++) go(request, replica, (k % 1000) + 1, answers); // 0.2 µs each
```

## Install

```sh
npm install @arv/threads
npm install --save-dev vite @arv/threads-check   # Vite, and the ownership checker
```

@arv/threads needs [Vite](https://vite.dev) 8, or [Vite+](https://viteplus.dev),
which is built on it (with `vite` aliased to Vite+'s core, as this repository's
pnpm-workspace.yaml does), Node 22.13 or later (Vite+ needs 22.18), and a
browser with `SharedArrayBuffer`.

## Set up

**1. The Vite plugin** compiles your TypeScript, registers the functions threads
run, and sets the cross-origin isolation headers that `SharedArrayBuffer` needs
on the dev and preview servers.

```js
// vite.config.ts
import threads from '@arv/threads/vite';

export default {
  plugins: [threads({tsgo: '/path/to/threads-checker/built/local/tsgo'})],
};
```

**2. The page** imports the shared memory first, then runs functions on the pool
of workers. `main` runs on a worker too, so it may block (join a thread, wait on
a barrier, receive from a channel); the page only awaits its result.

```ts
// main.ts, the page's entry module
import '@arv/threads/heap'; // first: the shared memory, before anything uses it
import {run} from '@arv/threads/browser';
import {main} from './app.ts';

console.log(await run(main, 8));
```

**3. The checker** runs in CI like a linter. It reports what TypeScript's types
cannot see: a value used after it was sent, an alias of something sent, sending
what the caller still holds, a write to a shared value through a cast, a number
that may not be an integer stored into an `i32` or a `u8`, a blocking call in an
async function.

```sh
npx @arv/threads-check -p tsconfig.json --runtime @arv/threads
```

```
app.ts(23,16): error TS96007: 'order' cannot be sent: it may be referenced by the caller. Declare the parameter 'Sending<T>' to take ownership.
```

**In production**, your server must send
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`.

## API

All from `"@arv/threads"`, unless noted.

**Owned and shared values**

|                  |                                                                                 |
| ---------------- | ------------------------------------------------------------------------------- |
| `Sending<T>`     | A value that moves: the receiver owns it, and the sender must not use it again. |
| `Shared<T>`      | A deeply readonly value any number of threads may read.                         |
| `share(value)`   | Freezes a value the caller owns, deeply, into a `Shared<T>`.                    |
| `consume(value)` | Ends a value's lifetime, for the checker.                                       |

**Threads**

|                                             |                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `spawn(f, ...args)`                         | Starts `f` on a thread. Owned arguments move; shared values and cells are shared.       |
| `thread.join()`, `thread.joinAsync()`       | Waits for the thread; its result moves back.                                            |
| `scope(s => ...)`                           | Structured threads: joins every thread `s.spawn` started before it returns.             |
| `partition(items, parts)`, `take(items, i)` | Splits an owned array into owned parts; takes one element out.                          |
| `new Barrier(n)`                            | `wait()` blocks until `n` threads have called it; `waitAsync()` waits without blocking. |
| `new Slots<T>(n)`                           | One slot per thread to publish a shared value into; everyone reads all slots.           |

**Goroutines and channels**

|                                                                  |                                                                                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `go(f, ...args)`                                                 | Starts `f` as a goroutine. Nothing waits for it. A plain function gets a thread of its own; an async function is light, one of many on a worker. |
| `new Channel<T>(capacity = 0)`                                   | `send(value)` moves a value in, `recv()` takes the next one out, `close()`; iterable.                                                            |
| `ch.sendAsync(v)`, `ch.recvAsync()`, `for await (const v of ch)` | The same in an async function: waits without blocking its worker.                                                                                |
| `select(...channels)`, `selectAsync(...channels)`                | Waits for the first channel with a value: `[index, value]`.                                                                                      |

**Shared memory**: data many threads read and write in place, with no copying.
Reads and writes are not ordered between threads: a `Barrier`, a `Channel`,
joining a thread or an atomic operation orders them.

|                                                                          |                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `struct({ x: f64, n: i32, done: bool, name: str, next: ref<T>() })`      | A shared struct type; `new S()` makes a zeroed one. `Struct<typeof S>` is its values' type.                                                                                                                                  |
| `f64`, `i32`, `u8`, `bool`, `str`, `ref<T>()`                            | Field kinds: a number, a 32-bit integer, a byte, a boolean, a string (interned), a reference to a struct, a SharedArray or a Channel (or null).                                                                              |
| `new SharedArray(Number \| i32 \| u8 \| Boolean \| String \| S, length)` | A fixed-length array of numbers, i32s, bytes, booleans, strings or structs, stored inline.                                                                                                                                   |
| `atomic.add(s, "field", v)`, `atomic.add(array, i, v)`                   | An atomic operation on an `i32` field or an element of a `SharedArray<i32>`: `load`, `store`, `add`, `sub`, `and`, `or`, `xor`, `exchange`, `compareExchange`, `wait`, `notify`. Compiled, it is that `Atomics` call itself. |

`i32` and `u8` are types too: numbers, kept as an `Int32Array` or a `Uint8Array`
keeps them (2³¹ wraps, and 256 is 0). The checker requires an integer of what is
stored into one: integer arithmetic, or an explicit conversion such as
`Math.round(x)` or `x | 0`, never a number that may have a fraction, which the
store would truncate silently. Threads can claim work from one counter, with no
lock:

```ts
const Work = struct({next: i32});
function worker(work: Struct<typeof Work>, n: number) {
  for (let i; (i = atomic.add(work, 'next', 1)) < n;) process(i); // each item once
}
```

Structs and SharedArrays are reference counted and freed when no thread can
reach them. A struct that refers to its own type is declared with an interface:

```ts
interface Node {
  value: number;
  next: Node | null;
}
const Node = struct<Node>({value: f64, next: ref<Node>()});
```

**Maps and sets**: `new SharedMap<K, V>(entries?)` and
`new SharedSet<T>(values?)` are Map and Set in shared memory, with their methods
and their semantics: keys compared as SameValueZero (a string by its text, a
cell or a shared value by identity), iteration in insertion order, and a loop
that sees what is added while it runs and skips what is deleted. Keys and values
are numbers, strings, booleans, null, undefined, cells (structs, SharedArrays,
channels, maps), shared values, or plain objects and arrays, which move in and
are shared. Each call is atomic, and `getOrInsert(key, value)` and
`getOrInsertComputed(key, f)` add a key only if it is missing, so threads adding
one key get one value:

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

**The page** (`"@arv/threads/browser"`): `start({ workers, check, onLog })`
starts the pool (one worker per core by default; `run` starts it if needed),
`run(f, ...args)` runs `f` on a thread and resolves with its result, `stop()`.

**Odds and ends**: `log(...args)` prints a line from any thread; `heapStats()`
reports shared memory in use and blocks allocated and freed.

## Performance

On an Apple M5 Pro, ms on 1, 2, 4 and 8 threads:

|                                                                   |                   |
| ----------------------------------------------------------------- | ----------------- |
| N-body, 800 bodies in shared structs (plain V8 on one thread: 25) | 29, 15, 8, 6      |
| Mandelbrot on goroutines and channels                             | 712, 341, 180, 97 |
| A sieve of Eratosthenes on a `SharedArray<boolean>` of 10 million | 76, 56, 40, 37    |

Values cross threads about as fast as JSON would carry them, and are read back
faster: moving 50,000 parsed JSON requests costs about 1.1 times
`JSON.stringify` to write and a third of `JSON.parse` to read. Each distinct set
of keys is written once per message, strings repeated in a value are written
once, and ASCII text is stored a byte per character: 23 MB of JSON text crosses
in about 7 ms.

### Compiled, or with the types only erased

The compiler is what makes shared structs fast. A program also runs with its
types only erased (Node's type stripping, say; the Vite plugin needs the
compiler for now), given the one line the compiler would add:
`register(import.meta.url, {main, ...})`, imported from @arv/threads, which
registers its top-level functions so that a thread finds the one it runs. The
checker reads the source, so it reports the same errors either way, and the
runtime still throws on a use after move.

What moves and shares plain objects runs at the same speed either way. Shared
structs and SharedArrays do not: erased, each struct is a handle whose fields
are accessors, and a SharedArray is a Proxy, so N-body is 50 to 60 times slower:

| ms on 1, 2, 4 and 8 threads           | Compiled          | Types erased        |
| ------------------------------------- | ----------------- | ------------------- |
| N-body, 800 bodies in shared structs  | 29, 15, 8, 6      | 1820, 971, 498, 301 |
| Mandelbrot on goroutines and channels | 712, 341, 180, 97 | 713, 349, 180, 99   |

[The playground](https://arv.github.io/threads/playground/) runs every program
both ways (Compiled, Types erased).

## Status

- **The compiler is a fork.** Shared structs and SharedArrays are compiled to
  typed-array reads and writes (`b.x` becomes `__F64[(b >> 3) + 1]`), and their
  references are counted, by a fork of TypeScript 7.0.2,
  [arv/threads-checker](https://github.com/arv/threads-checker), which is not on
  npm: build it with `go build -o built/local/tsgo ./cmd/tsgo`, and the plugin's
  `tsgo` option names the binary. With types only erased, programs still run,
  but shared structs are much slower (see
  [Performance](#compiled-or-with-the-types-only-erased)).
- **The checker needs no fork.** @arv/threads-check runs on stock TypeScript
  7.1's API.
- Shared memory is a fixed 256 MB. Structs and SharedArrays are reference
  counted, but cycles of them leak. Channels are never freed. A moved value (a
  thread's arguments and result, a channel's message) is freed once it is read;
  shared values are never freed. Strings are interned, one copy each, and
  counted: a string goes once no field, element, map or message refers to it.
- A thread runs a top-level function: closures do not cross threads.
- A SharedMap or SharedSet has one lock, which every call takes for a moment:
  threads that change one map all the time wait for each other, so a thread with
  many changes makes them in a Map of its own and merges once.
- A goroutine of a plain function is a whole worker: one per core is fine,
  thousands are not. Async goroutines are light but cooperative: one that
  computes without awaiting holds up the others on its worker, and none moves to
  another worker once it has started.
- Moving revokes the values moved, so using them throws;
  `start({ check: true })` revokes everything inside them too.

## This repository

@arv/threads is developed in [arv/threads](https://github.com/arv/threads):

|                                        |                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| [src/runtime/](src/runtime)            | the runtime: the API, the shared heap, a page's side and the Vite plugin       |
| [src/checker/](src/checker)            | the ownership checker (@arv/threads-check)                                     |
| [playground/](playground)              | a page to write programs in, and see what they compile to and how they run     |
| [TUTORIAL.md](TUTORIAL.md)             | writing, checking and running a small program, and how each step works         |
| [REFCOUNT.md](REFCOUNT.md)             | how shared structs and SharedArrays are reference counted and freed            |
| [docs/prototype.md](docs/prototype.md) | the prototypes this grew out of in Porffor's threads work, and what they found |

### Development

The repository is a pnpm workspace on [Vite+](https://viteplus.dev) (`vp`): the
code in [src/](src) at the root, the checker ([src/checker/](src/checker)), and
the [playground](playground). Vite+ brings Vite, Oxlint and a task runner, and
runs pnpm at the version `packageManager` names. You need Node 22.18 or later
(24.11 or later on Node 24).

```sh
vp install                  # once, at the root
vp dev                      # the playground; TSGO=<threads-checker>/built/local/tsgo for the compiled JavaScript
vp run build-wasm           # the compiler the playground's build runs in the browser (needs Go)
vp build                    # the playground's production build
vp fmt                      # Oxfmt, over the whole workspace
vp lint                     # Oxlint, type-aware, over the whole workspace
vp check                    # formatting, lint and types, as CI would
vp test                     # the unit tests, as CI would
vp run -r typecheck         # tsc in every package
```

The code is TypeScript, and node runs it as it is, its types stripped. Tests sit
next to what they test (`*.test.ts`), and run on Vitest.

`vp` is Vite+'s [global CLI](https://viteplus.dev/guide/). Without it,
`pnpm install` installs, and `pnpm vp <command>` runs the rest, with the
`vite-plus` dev dependency's CLI.

## License

Copyright 2026 Erik Arvidsson. Licensed under the [Apache License 2.0](LICENSE).
