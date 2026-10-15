# @arv/threads

@arv/threads brings real threads to JavaScript, in plain TypeScript. Your code
runs in parallel on Web Workers that share memory through a `SharedArrayBuffer`.

You also get a programming model you can reason about. Every value is owned by
one thread, shared read-only, or a cell built for sharing. A checker proves that
your code follows those rules.

Here's a quick taste:

```ts
import {f64, scope, SharedArray, struct, type Struct} from '@arv/threads';

const Body = struct({x: f64, y: f64, vx: f64, vy: f64, m: f64}); // Lives in shared memory.
type Body = Struct<typeof Body>;

function step(bodies: SharedArray<Body>, lo: number, hi: number) {
  for (let i = lo; i < hi; i++) bodies[i].x += bodies[i].vx; // Every thread sees the same memory.
}

export function main(threads: number) {
  const bodies = new SharedArray(Body, 800);
  scope(s => {
    for (let t = 0; t < threads; t++)
      s.spawn(
        step,
        bodies,
        Math.floor((t * 800) / threads),
        Math.floor(((t + 1) * 800) / threads),
      );
  }); // Joins every thread it started.
}
```

> **Status: experimental.** The API, the checker, the compiler and the runtime
> work, and they're tested. The compiler, which lays shared structs out in
> shared memory, is part of @arv/threads-check, on stock TypeScript 7.1. Only
> the playground's in-browser compiler is still a fork of TypeScript 7. See
> [Status](#status).

You can try it in the browser, with the compiled JavaScript side by side, in
[the playground](https://arv.github.io/threads/playground/). Its source is in
[playground/](playground).

This README, the tutorial and the design notes are also a docs site, at
[arv.github.io/threads](https://arv.github.io/threads/). Its source is in
[site/](site).

> **Disclaimer:** This project was mostly built by iterating with the help of
> Claude Code (Claude Opus 5.5).

## The Model

A thread is a worker with its own JavaScript heap, and objects can't cross
between heaps. That's why every value is one of three kinds:

| Kind   | In the types                                                 | How it crosses threads                                        | Use it for                                                      |
| ------ | ------------------------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------- |
| Owned  | Ordinary types, and `Sending<T>` where it moves              | It moves. It's copied once, and the sender loses it.          | Work a thread does alone, and its result                        |
| Shared | `Shared<T>`, which is deeply readonly                        | It's frozen. Every thread reads its own copy, made once.      | Tables, settings and lookups                                    |
| Cell   | `struct(...)`, `SharedArray`, `SharedMap`, `Lock`, `Channel` | It doesn't. There's only one copy, and it's in shared memory. | Data many threads read and write in place, and what orders them |

Code inside a thread is plain JavaScript on plain objects, so it runs at full
speed. The cost is at the crossings, and the types tell you where they are.

```ts
import {log, share, spawn, type Sending, type Shared} from '@arv/threads';

type Order = {id: number; items: number[]};

// The order moves to the thread. The thread owns it now, and may change it.
function total(order: Sending<Order>): Sending<number> {
  order.items.push(5);
  return order.items.reduce((sum, x) => sum + x, 0);
}

// The rates are shared. They're frozen, and any thread can read them.
function convert(
  amount: number,
  rates: Shared<Record<string, number>>,
  to: string,
): Sending<number> {
  return amount * rates[to];
}

export function main() {
  const order = {id: 1, items: [10, 20, 30]};
  log(spawn(total, order).join()); // 65. Using `order` here is an error.
  const rates = share({USD: 1, EUR: 0.92, SEK: 10.5});
  log(spawn(convert, 100, rates, 'EUR').join());
}
```

### Go-Style Concurrency

Threads can also talk to each other the way Go does. `go(f, ...args)` starts a
goroutine, and a `Channel<T>` moves values between threads in order. You can
`send` and `recv`, loop with `for (const v of channel)`, and wait on several
channels with `select`.

When you send a struct or a SharedArray on a channel, it stays where it is, in
shared memory. The receiver reads the same one.

`recv()` returns undefined both for a sent undefined and once the channel is
closed. To tell the two apart, use `const [v, ok] = channel.recvOk()`, just like
Go's `v, ok := <-ch`. `select` gives you the same ok, as its third element. So a
`Channel<void>` either signals by `close()`, which wakes every receiver, or is
read with `recvOk()`.

A goroutine of an async function is light, just like Go's are. One worker can
run thousands of them, and each one waits with `await` without blocking the
others. Here's what each kind costs in Node on an M5 Pro:

| Goroutine              | Time to start | Memory          |
| ---------------------- | ------------- | --------------- |
| On a worker of its own | 3.2 ms        | 8.6 MB          |
| Of an async function   | 0.2 µs        | About 350 bytes |

A blocking call in an async function would stop every goroutine on its worker.
So the checker reports it, and the runtime throws.

```ts
interface Replica {
  position: i32;
  changed: Channel<void> | null;
} // Closed, and replaced, on every change.
const Replica = struct<Replica>({position: i32, changed: ref<Channel<void>>()});

async function request(
  replica: Replica,
  position: i32,
  answers: Channel<string>,
) {
  for (;;) {
    const changed = replica.changed!;
    if (atomic.load(replica, 'position') >= position) break;
    await changed.recvAsync(); // One of thousands waiting on this worker.
  }
  await answers.sendAsync('ready');
}

for (let k = 0; k < 10_000; k++) go(request, replica, (k % 1000) + 1, answers); // 0.2 µs each
```

## Install

Install the runtime, and add Vite and threads-check (the ownership checker and
the compiler) as dev dependencies:

```sh
npm install @arv/threads
npm install --save-dev vite @arv/threads-check   # Vite, and the checker and compiler
```

@arv/threads needs:

- [Vite](https://vite.dev) 8, or [Vite+](https://viteplus.dev), which is built
  on it. With Vite+, alias `vite` to Vite+'s core, as this repository's
  pnpm-workspace.yaml does.
- Node 22.13 or later. Vite+ needs 22.18.
- A browser with `SharedArrayBuffer`.

The runtime that the page and its workers run (`@arv/threads`,
`@arv/threads/heap` and `@arv/threads/browser`) is TypeScript, and Vite compiles
it as it bundles the page. What Node runs (the Vite plugin, and
@arv/threads-check) is JavaScript.

## Set Up

Setting up takes three steps: the Vite plugin, the page, and the checker. In
production, your server also needs to send two headers.

### 1. The Vite Plugin

The Vite plugin compiles your TypeScript with @arv/threads-check, and registers
the functions that threads run. It also sets the cross-origin isolation headers
that `SharedArrayBuffer` needs on the dev and preview servers.

```js
// vite.config.ts
import threads from '@arv/threads/vite';

export default {
  plugins: [threads()],
};
```

| Option       | Default           | What it does                                                                                                                                                                                                  |
| ------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsconfig`   | `'tsconfig.json'` | The project that threads-check compiles, relative to Vite's root.                                                                                                                                             |
| `runtime`    | `'@arv/threads'`  | The module that programs import the runtime from.                                                                                                                                                             |
| `playground` | `false`           | When true, the dev server compiles programs that the page sends it (`POST /__threads/compile`), as the playground's does.                                                                                     |
| `checker`    | `null`            | The path of threads-check's entry module, if it's not the @arv/threads-check installed beside the plugin.                                                                                                     |
| `tsgo`       | `undefined`       | The tsgo fork's binary (see [Status](#status)). When set, the fork compiles instead of threads-check, and the plugin serves what it emits.                                                                    |
| `args`       | `[]`              | Used with `tsgo`. More arguments for tsgo. They come after the plugin's own: `-p`, `--ownRuntime`, `--outDir`, `--rootDir`, `--sourceMap`, `--noEmit false`, `--noEmitOnError false` and `--tsBuildInfoFile`. |

threads-check compiles each module of that project. The plugin hands Vite each
one's TypeScript with the compiler's edits, and a source map, and Vite strips
the types. It leaves any other module to Vite, which erases its types and
registers none of its functions, so no thread can run them. The project needs
to:

- Include the page's modules and the modules its threads run, all under the
  tsconfig's directory.
- Resolve imports the way a bundler does (`"module": "esnext"`,
  `"moduleResolution": "bundler"`), so that `@arv/threads` is the API's
  declarations.
- Be the app's project. `"noEmit": true`, as Vite's templates have, is fine:
  threads-check compiles whatever the tsconfig says. But a tsconfig.json made
  only of references (also from Vite's templates) compiles nothing, so name the
  project itself (`tsconfig: 'tsconfig.app.json'`).

Thread modules may be `.ts`, `.mts` or `.tsx`.

Type errors don't stop the build. tsc reports them, and the checker reports the
ownership errors.

### 2. The Page

The page imports the shared memory first, then runs functions on the pool of
workers. `main` runs on a worker too, so it may block: it can join a thread,
wait on a condition, or receive from a channel. The page only awaits its result.

Keep the functions that threads run out of the page's entry module. A worker
loads a function's module to find it, and `start()`, `run()` and `stop()` throw
when they're called there.

```ts
// main.ts, the page's entry module
import '@arv/threads/heap'; // First: it creates the shared memory.
import {run} from '@arv/threads/browser';
import {main} from './app.ts';

console.log(await run(main, 8));
```

### 3. The Checker

The checker runs in CI, like a linter. It reports what TypeScript's types can't
see:

- A value used after it was sent.
- An alias of something sent.
- Sending what the caller still holds.
- A write to a shared value through a cast.
- A number that may not be an integer, stored into an `i32` or a `u8`.
- A blocking call in an async function.

Here's how you run it, and what an error looks like:

```sh
npx @arv/threads-check -p tsconfig.json --runtime @arv/threads
```

```
app.ts(23,16): error TS96007: 'order' cannot be sent: it may be referenced by the caller. Declare the parameter 'Sending<T>' to take ownership.
```

To compile a project without Vite, for Node say, `threads-check compile` writes
each of its files as JavaScript, into the tsconfig's `outDir` or the one you
name. It reports the same errors as a check, and type errors too:

```sh
npx @arv/threads-check compile -p tsconfig.json --runtime @arv/threads --outDir build
```

### In Production

In production, your server must send these two headers:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

A host that can't send them, such as GitHub Pages, can have a service worker add
them. That's what the playground does
([coi-sw.js](playground/public/coi-sw.js)).

## API

Everything here comes from `"@arv/threads"` unless noted.

### Owned and Shared Values

|                  |                                                                                 |
| ---------------- | ------------------------------------------------------------------------------- |
| `Sending<T>`     | A value that moves. The receiver owns it, and the sender must not use it again. |
| `Shared<T>`      | A deeply readonly value that any number of threads may read.                    |
| `share(value)`   | Freezes a value the caller owns, deeply, into a `Shared<T>`.                    |
| `consume(value)` | Ends a value's lifetime, for the checker.                                       |

### Threads

|                                             |                                                                                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spawn(f, ...args)`                         | Starts `f` on a thread. Owned arguments move, and shared values and cells are shared. The Thread it returns stays here: it isn't sent or shared.                      |
| `thread.join()`, `thread.joinAsync()`       | Waits for the thread, and its result moves back. If the thread threw, it throws an Error that says what the thread threw, whose `cause` has the thread's stack.       |
| `scope(s => ...)`                           | Structured threads. It joins every thread that `s.spawn` started before it returns. The body isn't async.                                                             |
| `partition(items, parts)`, `take(items, i)` | `partition` splits an owned array into owned parts, and `take` takes one element out.                                                                                 |
| `register(import.meta.url, {f, ...})`       | Registers a module's top-level functions, so a thread finds the one it runs. The compiler adds this call for you, and a program that runs uncompiled calls it itself. |
| `new Lock()`                                | `using _ = lock.hold()` holds the lock until the end of the block, and `await lock.holdAsync()` waits for it without blocking.                                        |
| `new Condition()`                           | `wait(lock)` releases the lock until another thread calls `notifyOne()` or `notifyAll()`, then holds it again. `waitAsync(lock)` waits without blocking.              |

### Goroutines and Channels

|                                                                                      |                                                                                                                                                           |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `go(f, ...args)`                                                                     | Starts `f` as a goroutine, and nothing waits for it. A plain function gets a thread of its own, and an async function is light, one of many on a worker.  |
| `new Channel<T>(capacity = 0)`                                                       | `send(value)` moves a value in, `recv()` takes the next one out (undefined once closed, as for a sent undefined), and `close()` closes it. It's iterable. |
| `ch.recvOk()`                                                                        | `recv()`, plus whether a value came: `[value, true]`, or `[undefined, false]` once the channel is closed and empty.                                       |
| `ch.sendAsync(v)`, `ch.recvAsync()`, `ch.recvOkAsync()`, `for await (const v of ch)` | The same, for an async function. They wait without blocking the worker.                                                                                   |
| `select(...channels)`, `selectAsync(...channels)`                                    | Waits for the first channel that has a value or is closed, and gives `[index, value, ok]`. ok is false for a closed channel.                              |

### Shared Memory

Shared memory holds data that many threads read and write in place, with no
copying. Reads and writes aren't ordered between threads. A `Lock`, a `Channel`,
joining a thread, or an atomic operation is what orders them.

|                                                                          |                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `struct({ x: f64, n: i32, done: bool, name: str, next: ref<T>() })`      | A shared struct type. `new S()` makes a zeroed one, and `Struct<typeof S>` is the type of its values.                                                                                                                             |
| `f64`, `i32`, `u8`, `bool`, `str`, `ref<T>()`                            | Field kinds: a number, a 32-bit integer, a byte, a boolean, a string (interned), and a reference to a struct, a SharedArray, a Channel, a Lock or a Condition (or null).                                                          |
| `new SharedArray(Number \| i32 \| u8 \| Boolean \| String \| S, length)` | A fixed-length array of numbers, i32s, bytes, booleans, strings or structs, stored inline.                                                                                                                                        |
| `atomic.add(s, "field", v)`, `atomic.add(array, i, v)`                   | An atomic operation on an `i32` field or on an element of a `SharedArray<i32>`: `load`, `store`, `add`, `sub`, `and`, `or`, `xor`, `exchange`, `compareExchange`, `wait` and `notify`. Compiled, it's that `Atomics` call itself. |

`i32` and `u8` are types too. They're numbers, kept the way an `Int32Array` or a
`Uint8Array` keeps them, so 2³¹ wraps and 256 is 0.

The checker requires that what you store into one is an integer. That means
integer arithmetic, or an explicit conversion such as `Math.round(x)` or
`x | 0`. A number that may have a fraction isn't allowed, because the store
would truncate it silently.

With an atomic counter, threads can claim work with no lock:

```ts
const Work = struct({next: i32});
function worker(work: Struct<typeof Work>, n: number) {
  for (let i; (i = atomic.add(work, 'next', 1)) < n;) process(i); // Claims each item once.
}
```

A lock turns several reads and writes into one step. A struct can hold its own
lock, just as it can hold a channel, and `using` releases the lock at the end of
the block:

```ts
const Account = struct({balance: f64, deposits: i32, lock: ref<Lock>()});

function deposit(account: Struct<typeof Account>, amount: number) {
  using _ = account.lock!.hold();
  account.balance += amount;
  account.deposits++;
}
```

Structs and SharedArrays are reference counted, and they're freed when no thread
can reach them. To declare a struct that refers to its own type, use an
interface:

```ts
interface Node {
  value: number;
  next: Node | null;
}
const Node = struct<Node>({value: f64, next: ref<Node>()});
```

### Maps and Sets

`new SharedMap<K, V>(entries?)` and `new SharedSet<T>(values?)` are Map and Set
in shared memory. They have the same methods, and the same semantics:

- Keys are compared as SameValueZero. A string is compared by its text, and a
  cell or a shared value by identity.
- Iteration is in insertion order.
- A loop sees what's added while it runs, and skips what's deleted.

Keys and values can be numbers, strings, booleans, null, undefined, cells
(structs, SharedArrays, maps, channels, locks), shared values, or plain objects
and arrays. Plain objects and arrays move in, and are shared from then on.

Each call is atomic. `getOrInsert(key, value)` and `getOrInsertComputed(key, f)`
add a key only if it's missing, so threads that add the same key all get one
value:

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

### The Page

The page's API comes from `"@arv/threads/browser"`:

- `start({ workers, check, onLog })` starts the pool, with one worker per core
  by default.
- `run(f, ...args)` runs `f` on a thread and resolves with its result.
- `stop()` stops the pool.

The pool's options are the ones the first `start()` was given. If the pool
hasn't started, `run` starts it with the defaults. So a page that wants other
options calls `start` before its first `run`. A later `start` with other options
throws.

`stop()` terminates the workers, along with the threads they ran, and fails the
runs that are waiting. After that, a spawn throws until `start()` starts a new
pool on the same heap. That's also how you recover a stuck pool, such as one
with a thread that never ends: call `stop()`, then `start()` again.

### Odds and Ends

`log(...args)` prints a line from any thread. `heapStats()` reports the shared
memory in use, and the blocks allocated and freed. `collectCycles()` frees
cycles of shared structs, SharedArrays and maps, which counting alone never
frees, and returns how many blocks it freed. Every other thread stops at its
next quiescent point while it runs (see [REFCOUNT.md](REFCOUNT.md#cycles)).

## Performance

Here's how long a few programs take on an Apple M5 Pro:

| Program                                                           | ms on 1, 2, 4 and 8 threads |
| ----------------------------------------------------------------- | --------------------------- |
| N-body, 800 bodies in shared structs (plain V8 on one thread: 25) | 29, 15, 8, 6                |
| Mandelbrot on goroutines and channels                             | 712, 341, 180, 97           |
| A sieve of Eratosthenes on a `SharedArray<boolean>` of 10 million | 76, 56, 40, 37              |

Values cross threads about as fast as JSON would carry them, and they're read
back faster. Moving 50,000 parsed JSON requests costs about 1.1 times
`JSON.stringify` to write, and a third of `JSON.parse` to read. A few things
keep it fast:

- Each distinct set of keys is written once per message.
- Strings that repeat within a value are written once.
- ASCII text is stored at one byte per character.

All told, 23 MB of JSON text crosses in about 7 ms.

### Compiled, or With the Types Only Erased

The compiler is what makes shared structs fast. But a program also runs with its
types only erased, by Node's type stripping for example. (The Vite plugin always
compiles.) All it needs is the one line the compiler would add:
`register(import.meta.url, {main, ...})`, imported from @arv/threads. That line
registers the module's top-level functions, so that a thread finds the one it
runs.

The checker reads the source, so it reports the same errors either way. The
runtime still throws on a use after move.

Code that moves and shares plain objects runs at the same speed either way.
Shared structs and SharedArrays don't. With types erased, each struct is a
handle whose fields are accessors, and a SharedArray is a Proxy. That makes
N-body 50 to 60 times slower:

| ms on 1, 2, 4 and 8 threads           | Compiled          | Types erased        |
| ------------------------------------- | ----------------- | ------------------- |
| N-body, 800 bodies in shared structs  | 29, 15, 8, 6      | 1820, 971, 498, 301 |
| Mandelbrot on goroutines and channels | 712, 341, 180, 97 | 713, 349, 180, 99   |

[The playground](https://arv.github.io/threads/playground/) runs every program
both ways (Compiled and Types erased), so you can compare them yourself.

## Status

@arv/threads is experimental, and it has real limits. Here's where things stand
today:

- **The compiler needs no fork.** @arv/threads-check compiles shared structs and
  SharedArrays to typed-array reads and writes (`b.x` becomes
  `__F64[(b >> 3) + 1]`), and counts their references, on stock TypeScript 7.1's
  API. It edits each module's TypeScript, and OXC (Vite's, or its own) strips
  the types. With types only erased, programs still run, but shared structs are
  much slower (see [Performance](#compiled-or-with-the-types-only-erased)).
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

## This Repository

@arv/threads is developed in [arv/threads](https://github.com/arv/threads).
Here's what's in it:

|                                        |                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| [src/runtime/](src/runtime)            | The runtime: the API, the shared heap, a page's side and the Vite plugin       |
| [src/checker/](src/checker)            | The ownership checker and the compiler (@arv/threads-check)                    |
| [playground/](playground)              | A page to write programs in, and see what they compile to and how they run     |
| [site/](site)                          | The docs site, which GitHub Pages publishes with the playground                |
| [TUTORIAL.md](TUTORIAL.md)             | Writing, checking and running a small program, and how each step works         |
| [REFCOUNT.md](REFCOUNT.md)             | How shared structs and SharedArrays are reference counted and freed            |
| [docs/prototype.md](docs/prototype.md) | The prototypes this grew out of in Porffor's threads work, and what they found |

### Development

The repository is a pnpm workspace on [Vite+](https://viteplus.dev) (`vp`). It
holds the code in [src/](src) at the root, the checker and compiler
([src/checker/](src/checker)), the [playground](playground), and the docs site
([site/](site)). Vite+ brings Vite, Oxlint and a task runner, and it runs pnpm
at the version that `packageManager` names. You need Node 22.18 or later (24.11
or later on Node 24).

```sh
vp install                  # Once, at the root
vp dev                      # The playground; TSGO=<threads-checker>/built/local/tsgo to compile with the fork
vp run build-programs       # The programs the scripts run (tsconfig.programs.json), into build/ts/
vp run build-wasm           # The fork's compiler the playground's build runs in the browser (needs Go)
vp build                    # The playground's production build
vp run threads-site#dev     # The docs site, served as you edit it
vp run threads-site#build   # The docs site's static build, into site/dist/
vp fmt                      # Oxfmt, over the whole workspace
vp lint                     # Oxlint, type-aware, over the whole workspace
vp check                    # Formatting, lint and types, as CI would
vp test                     # The unit tests, as CI would
vp run -r build-dist        # Each package's dist/, as pnpm pack builds it
vp run test-pack            # The packages packed and installed in a project, and a page on them in Chrome; with TSGO, compiled by the fork too
vp run -r typecheck         # tsc in every package
```

`vp` is Vite+'s [global CLI](https://viteplus.dev/guide/). If you don't have it,
run `pnpm install` to install, and `pnpm vp <command>` for everything else. That
uses the CLI from the `vite-plus` dev dependency.

The code is TypeScript, and Node runs it as it is, with its types stripped.
Tests sit next to the code they test (`*.test.ts`), and run on Vitest.

### Releasing

A release is a version tag:

1. Set the same `version` in package.json and src/checker/package.json, and
   merge that.
2. Push `vX.Y.Z` on that commit.

The Release workflow
([.github/workflows/release.yml](.github/workflows/release.yml)) checks, tests
and packs both packages. Then it publishes them to npm with provenance, by
trusted publishing: each package's settings on npmjs.com name this repository
and release.yml as its trusted publisher, so no token is needed. A new trusted
publisher setting expires unless a publish succeeds within 48 hours, so add it
just before the tag it's for.

## License

Copyright 2026 Erik Arvidsson. Licensed under the [Apache License 2.0](LICENSE).
