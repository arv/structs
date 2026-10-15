---
title: '@arv/threads'
navTitle: Introduction
description:
  Threads for JavaScript, in plain TypeScript, on Web Workers and a
  SharedArrayBuffer.
---

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

::: warning Status: experimental

The API, the checker, the compiler and the runtime work, and they're tested. The
compiler, which lays shared structs out in shared memory, is part of
@arv/threads-check, on stock TypeScript 7.1. See [Status](/status/).

:::

You can try it in the browser, with the compiled JavaScript side by side, in
[the playground](/playground/). Its source is in
[playground/](https://github.com/arv/threads/tree/main/playground).

::: note Disclaimer

This project was mostly built by iterating with the help of Claude Code (Claude
Opus 5.5).

:::

## Where to Go Next

- [Install](/install/) the packages, and [set up](/setup/) the Vite plugin, the
  page and the checker.
- Write, check and run a small program in [the tutorial](/tutorial/).
- Read about [the model](/model/), the three kinds of values it rests on.
