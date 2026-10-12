# Tutorial: threads with own and shared values

This walks through [tutorial.ts](tutorial.ts): a program that splits 200,000 random points across
threads and counts which of three centers each point is nearest to. It is plain TypeScript against
[threads.d.ts](threads.d.ts): stock tsc checks its types, the ownership checker its ownership, and
the tsgo fork (branch `own-shared`) compiles it to run on [threads.js](threads.js). The ideas
behind it are in [README.md](README.md).

You need the fork built (`go build -o built/local/tsgo ./cmd/tsgo` in it), TypeScript, and node 22 or
later. To run in Chrome as well, you also need `playwright-core`.

## 1. Write the program

Every value a thread touches is one of three kinds, and the types say which:

- **Owned**, the default: an ordinary object only one thread can reach. `Sending<T>` moves ownership.
  The caller gives the value up, and the receiver owns it.
- **Shared**: `Shared<T>`, deeply immutable, so any number of threads may read it at once.
- **A cell**: shared _and_ mutable, but only through what synchronizes it (`Barrier`, `Slots`, a
  `Channel`), or in place for shared structs and SharedArrays, ordered by one of those.

To TypeScript, `Sending<T>` is just `T` and `Shared<T>` is a deeply readonly `T`, so the program is
ordinary TypeScript.

The thread function takes its own points and reads the shared centers:

```ts
function countNearest(
  points: Sending<Point[]>,
  centers: Shared<Point[]>,
): Sending<number[]> {
  const counts = centers.map(() => 0);
  for (const p of points) {
    /* plain loops over plain objects: find the nearest center */ counts[
      best
    ]++;
  }
  return counts;
}
```

`main` makes the data and hands it out:

```ts
const centers = share([
  {x: 0.25, y: 0.25},
  {x: 0.75, y: 0.25},
  {x: 0.5, y: 0.75},
]);
const totals = scope(s => {
  const parts = partition(randomPoints(200_000), threads); // one owned array per thread
  const ts: Thread<number[]>[] = [];
  for (let t = 0; t < threads; t++)
    ts.push(s.spawn(countNearest, take(parts, t), centers));
  const sums = centers.map(() => 0);
  for (const th of ts)
    th.join().forEach((n, c) => {
      sums[c] += n;
    });
  return sums;
});
```

- `share(...)` turns a value you own into a shared one. The literal is fresh, so nothing else can
  change it.
- `partition` splits an owned array into owned parts, and `take(parts, t)` moves one part out.
- `s.spawn(f, ...args)` starts `f` on a thread. The arguments are `Sending`, so part `t` moves to its
  thread while `centers`, being shared, is just passed along.
- `th.join()` moves the thread's result back.
- `scope` joins every thread it started before it returns, so no thread outlives the data it uses.

## 2. Check it and compile it

```sh
tsc -p tsconfig.json --noEmit                                       # types
/path/to/tsgo-own/built/local/tsgo own check -p tsconfig.json --ownRuntime ./threads.js
/path/to/tsgo-own/built/local/tsgo -p tsconfig.json --ownRuntime ./threads.js
```

The first is stock TypeScript. The second is the ownership checker, which runs in CI like a linter:
it reports only ownership errors and exits 1 if there are any. It follows each value's region,
meaning the objects reachable from it, through the function, and rejects any use of a region after
it was moved, a write to a shared value, and moving anything the code doesn't own. The third compiles
to `build/ts`; a web page uses the bundler plugin instead (see [README.md](README.md)). Three typical
mistakes:

```ts
const points = randomPoints(1000);
s.spawn(countNearest, points, centers);
log(points.length); // 1. points moved to the thread
(centers[0] as Point).x = 0.5; // 2. centers is shared
s.spawn(countNearest, mine, centers); // 3. mine belongs to the caller
```

```
mistakes.ts(12,17): error TS96001: 'points' cannot be used here: it was sent to 'spawn' on line 11.
mistakes.ts(13,5): error TS96010: Cannot change 'centers[0] as Point': it is a shared value, which is immutable.
mistakes.ts(14,27): error TS96008: 'mine' cannot be sent: it is captured from an outer scope.
```

Without the cast, `centers[0].x = 0.5` is already a tsc error, since a `Shared<T>` is readonly. The
fixes are to use `points` before sending it, to `share` a changed copy rather than the original, and
to create what a thread gets where it is sent, as `main` does with `randomPoints`.

## 3. What comes out

The types are erased, and the compiler adds two things for the runtime: an import of its helpers, and
a table of the module's functions so a thread can find the one it should run:

```js
import { __register } from "./threads.js";
import { log, partition, scope, share, take } from "./threads.js";
function countNearest(points, centers) {
    const counts = centers.map(() => 0);
    ...
}
...
__register(import.meta.url, { randomPoints, countNearest, main });
```

The loops are untouched: the compiled `countNearest` is the plain JavaScript you would have written.

## 4. Run it

```sh
node run.js build/ts/tutorial.js --threads=1,2,4
```

```
1 threads: 56336 56064 87600
2 threads: 56336 56064 87600
4 threads: 56336 56064 87600
```

The same counts on every thread count. `chrome.js` runs the same module in Chrome, on real Web
Workers:

```sh
node chrome.js build/ts/tutorial.js --threads=1,2,4
```

## How it works

```
thread A (its own V8 heap)          SharedArrayBuffer                   thread B (its own V8 heap)
owned points   -- spawn: copy --->  moved data         -- read ----->   owned points (plain objects)
share(centers) -- write once ---->  shared values      -- first use ->  frozen copy (plain objects)
                                    cells: Barrier, Slots, structs  <-> used in place by both
```

- **The heaps stay separate.** V8 objects cannot cross workers, so each thread works on ordinary
  objects in its own heap. That is why the inner loops run at full speed.
- **Moving copies.** `spawn` writes its arguments into the SharedArrayBuffer in a compact binary form,
  once. The thread reads them back as plain objects of its own. `join` does the same in the other
  direction. `own.js` also revokes the sender's moved objects (any use throws), as a safety net for
  code the checker did not see.
- **Sharing copies once per reader.** `share` writes a value once; each thread that reads it makes
  one frozen copy on first use and keeps it.
- **Cells are the only shared mutable state.** They live in the SharedArrayBuffer and synchronize
  with `Atomics`.
- **Threads come from a pool of workers** that start before the program does. A thread names its
  function by the key `__register` gave it, and every worker loads the same module, so the key finds
  the same function in each.

So the cost is copying at the crossings, proportional to what crosses, and nothing per property
access. In this example each point is copied once, into its thread. In [README.md](README.md)'s
N-body, positions are shared every step, so every thread copies all of them every step, and that
copying is what stops it scaling past a few threads.

## Limits

- **No collector for what crosses.** Moved and shared data in the SharedArrayBuffer is never freed.
- **A value captured by a closure can't be moved out of it,** even one received as `Sending`. Create
  it inside, as `main` does in the `scope` callback.
- **Arrays of owned values** are split with the trusted `partition` and `take`. The checker can't
  prove that two slices of one array are disjoint.
