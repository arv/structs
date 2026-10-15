# Tutorial: Threads With Owned and Shared Values

Let's write a small program with threads, check it, compile it and run it. It's
a good way to get a feel for how the pieces fit together.

The program is [tutorial.ts](src/tutorial.ts). It generates 200,000 random
points, splits them across threads, and counts which of three centers each point
is nearest to.

It's plain TypeScript written against [threads.d.ts](src/runtime/threads.d.ts).
Three tools work on it:

- **Stock tsc** checks its types.
- **The ownership checker** checks its ownership.
- **The tsgo fork**
  ([arv/threads-checker](https://github.com/arv/threads-checker)) compiles it to
  run on [threads.ts](src/runtime/threads.ts).

If you'd like the ideas behind all this first, see [README.md](README.md).

## Before You Start

You'll need a few things installed:

- **The tsgo fork, built.** In a clone of it, run
  `go build -o built/local/tsgo ./cmd/tsgo`.
- **TypeScript.**
- **Node 22.18 or later.** It runs TypeScript files as they are.
- **`playwright-core`**, but only if you also want to run the program in Chrome.

## Write the Program

### Three Kinds of Values

Every value a thread touches is one of three kinds, and its type says which:

- **Owned** is the default. An owned value is an ordinary object that only one
  thread can reach. `Sending<T>` moves ownership: the caller gives the value up,
  and the receiver owns it from then on.
- **Shared** values have the type `Shared<T>`. They're deeply immutable, so any
  number of threads can read them at once.
- **A cell** is shared _and_ mutable, but only in a synchronized way. You change
  it through what synchronizes it (a `Lock`, a `Condition` or a `Channel`).
  Shared structs and SharedArrays are changed in place instead, with one of
  those ordering the changes.

To TypeScript, `Sending<T>` is just `T`, and `Shared<T>` is a deeply readonly
`T`. That means the whole program is ordinary TypeScript.

### The Thread Function

Each thread runs `countNearest`. It takes its own points, which it owns, and
reads the centers, which every thread shares:

```ts
function countNearest(
  points: Sending<Point[]>,
  centers: Shared<Point[]>,
): Sending<number[]> {
  const counts = centers.map(() => 0);
  for (const p of points) {
    let best = 0,
      bestDistance = Infinity;
    for (let c = 0; c < centers.length; c++) {
      const dx = p.x - centers[c].x,
        dy = p.y - centers[c].y,
        d = dx * dx + dy * dy;
      if (d < bestDistance) {
        bestDistance = d;
        best = c;
      }
    }
    counts[best]++;
  }
  return counts;
}
```

These are plain loops over plain objects. The only things in this function that
have anything to do with threads are the types of its parameters and its result.

### Hand Out the Work

Next, `main` creates the data and hands it out to the threads. In tutorial.ts,
the `scope` part runs once for each thread count you ask for, with `threads` set
to that count, and then logs the totals:

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

Here's what each call does:

- **`share(...)`** turns a value you own into a shared one. The array literal is
  fresh, so nothing else can change it.
- **`partition`** splits an owned array into owned parts, and
  **`take(parts, t)`** moves one part out.
- **`s.spawn(f, ...args)`** starts `f` on a thread. Its arguments are `Sending`,
  so part `t` moves to its thread. `centers` is shared, so it's just passed
  along.
- **`th.join()`** moves the thread's result back to the caller.
- **`scope`** joins every thread it started before it returns. That way, no
  thread outlives the data it uses.

## Check and Compile

Now let's check the program and compile it. There are three commands:

```sh
tsc -p tsconfig.json --noEmit                                       # types
/path/to/threads-checker/built/local/tsgo own check -p tsconfig.programs.json --ownRuntime @arv/threads
/path/to/threads-checker/built/local/tsgo -p tsconfig.programs.json --ownRuntime @arv/threads
```

- **The first** is stock TypeScript, checking types.
- **The second** is the ownership checker. It runs in CI like a linter: it
  reports only ownership errors, and it exits with status 1 if there are any.
- **The third** compiles the program to `build/ts`. A web page uses the bundler
  plugin instead (see [README.md](README.md)).

The ownership checker follows each value's region through the function. A
value's region is the set of objects reachable from it. The checker rejects
three things:

- **Using a region after it was moved.**
- **Writing to a shared value.**
- **Moving anything the code doesn't own.**

### Common Mistakes

Here are three typical mistakes, one of each kind:

```ts
const points = randomPoints(1000);
s.spawn(countNearest, points, centers);
log(points.length); // 1. points moved to the thread
(centers[0] as Point).x = 0.5; // 2. centers is shared
s.spawn(countNearest, mine, centers); // 3. mine belongs to the caller
```

The checker reports each one:

```
mistakes.ts(12,17): error TS96001: 'points' cannot be used here: it was sent to 'spawn' on line 11.
mistakes.ts(13,5): error TS96010: Cannot change 'centers[0] as Point': it is a shared value, which is immutable.
mistakes.ts(14,27): error TS96008: 'mine' cannot be sent: it is captured from an outer scope.
```

Without the cast, `centers[0].x = 0.5` is already a tsc error, because a
`Shared<T>` is readonly.

Each mistake has a straightforward fix:

1. **Use `points` before you send it,** not after.
2. **`share` a changed copy** rather than changing the original.
3. **Create what a thread gets where you send it,** as `main` does with
   `randomPoints`.

## What the Compiler Emits

The compiler erases the types and adds two things for the runtime:

- **An import of its helpers.**
- **A table of the module's functions,** so that a thread can find the one it
  should run.

Here's what that looks like:

```js
import { register as __register } from "@arv/threads";
import { log, partition, scope, share, take } from "@arv/threads";
function countNearest(points, centers) {
    const counts = centers.map(() => 0);
    ...
}
...
__register(import.meta.url, { randomPoints, countNearest, main });
```

The loops are untouched. The compiled `countNearest` is the same plain
JavaScript you would have written by hand.

You can also run a program with its types only erased, for example with Node's
type stripping. In that case, the program has to make the `register` call
itself. The [Performance](README.md#compiled-or-with-the-types-only-erased)
section of the README explains what that costs.

## Run It

Finally, run the compiled module on 1, 2 and 4 threads:

```sh
node src/run.ts build/ts/tutorial.js --threads=1,2,4
```

```
1 threads: 56336 56064 87600
2 threads: 56336 56064 87600
4 threads: 56336 56064 87600
```

You get the same counts no matter how many threads do the work.

`chrome.ts` runs the same module in Chrome, on real Web Workers:

```sh
node src/chrome.ts build/ts/tutorial.js --threads=1,2,4
```

That's it! You've written, checked, compiled and run a program on threads.

## How It Works

Here's what happens underneath when values cross between threads:

```
thread A (its own V8 heap)          SharedArrayBuffer                   thread B (its own V8 heap)
owned points   -- spawn: copy --->  moved data         -- read ----->   owned points (plain objects)
share(centers) -- write once ---->  shared values      -- first use ->  frozen copy (plain objects)
                                    cells: Lock, Condition, structs <-> used in place by both
```

- **The heaps stay separate.** V8 objects can't cross workers, so each thread
  works on ordinary objects in its own heap. That's why the inner loops run at
  full speed.
- **Moving copies.** `spawn` writes its arguments into the SharedArrayBuffer
  once, in a compact binary form. The thread reads them back as plain objects of
  its own. `join` does the same in the other direction. As a safety net for code
  the checker didn't see, `own.ts` also revokes the sender's moved objects, so
  any use of them throws.
- **Sharing copies once per reader.** `share` writes a value once. Each thread
  that reads it makes one frozen copy on first use, and keeps it.
- **Cells are the only shared mutable state.** They live in the
  SharedArrayBuffer and synchronize with `Atomics`.
- **Threads come from a pool of workers** that start before the program does. A
  thread names its function by the key `register` gave it. Every worker loads
  the same module, so the key finds the same function in each one.

So the cost is the copying at the crossings. It's proportional to what crosses,
and there's nothing extra per property access.

In this example, each point is copied once, into its thread. Compare that with
the N-body program in [the prototype](docs/prototype.md). There, positions are
shared every step, so every thread copies all of them every step. That copying
is what stops it from scaling past a few threads.

## Limits

There are a few limits to keep in mind:

- **Shared values are never freed.** A moved value is freed once it's read.
  Structs, SharedArrays, maps and strings are reference counted (see
  [REFCOUNT.md](REFCOUNT.md)). But what `share` writes stays.
- **A value captured by a closure can't be moved out of it.** That's true even
  for a value received as `Sending`. Create it inside the closure instead, as
  `main` does in the `scope` callback.
- **Arrays of owned values are split with the trusted `partition` and `take`.**
  The checker can't prove that two slices of one array are disjoint.
