# Threads playground

A page to write threads programs in, and see what they compile to and how they
run: the playground of [@arv/threads](../README.md), threads for JavaScript in
plain TypeScript on Web Workers and a SharedArrayBuffer. The model, the API and
the limits are in [the README](../README.md).

> Written iterating with Claude Code (Claude Opus 5.5).

## Try it

You need Node 22.18 or later (24.11 or later on Node 24), a recent Chrome (or
another browser with SharedArrayBuffer), and, for the compiled JavaScript, a
fork of TypeScript 7.0.2,
[arv/threads-checker](https://github.com/arv/threads-checker), built with
`go build -o built/local/tsgo ./cmd/tsgo` in a clone of it. The ownership
checker needs no fork: it is [src/checker/](../src/checker), on stock TypeScript
7.1. The repository is a pnpm workspace on [Vite+](https://viteplus.dev) (see
[its README](../README.md#development)).

```sh
pnpm install                                               # at the repository's root
TSGO=/path/to/threads-checker/built/local/tsgo vp dev      # here, or at the root
```

Open the address Vite prints. Pick a program and edit it in Monaco, with
TypeScript's hover types, completions and errors from the threads API, and see:

- the JavaScript the fork compiles it to, with what the compiler added marked;
- the same program with its types only erased, which still runs;
- the ownership checker's errors (threads-check's), as squiggles in the editor
  and in a list;
- its output, run on a pool of Web Workers (Run). `main` runs on a worker too,
  started like any other thread, so it may block (`join`, `recv`, a barrier);
  the page itself never blocks, it only awaits `main`'s result.

`vp run typecheck` checks the programs' types, and `vp run own-check` runs the
ownership checker on them, as CI would.

The dev server compiles, so a production build (`vp build`) shows the page but
cannot compile. It needs cross-origin isolation for SharedArrayBuffer: the dev
server sends the COOP and COEP headers, and a production server must too.

## Programs

[programs/](programs) starts with the basics, one idea each: hello, threads;
moving a value to a thread; sharing a value; a shared struct; a SharedArray of
booleans (a sieve); strings in shared memory; atomics (claiming work, and
counting together); a channel pipeline; a pool of workers on channels; ten
thousand async goroutines waiting for a database replica. Then the bigger
examples: N-body four ways (shared structs with a barrier, shared structs with
channels, moving and sharing objects, channels copying objects), Mandelbrot on
channels, JSON parsed on threads, the nearest-centers example, what channels
cost, reference counting under a race, a SharedMap and a SharedSet counting
words, a growable `SharedVector` written in user space on the API, and the
mistakes the checker catches. Each exports `main`, which the page calls with the
thread counts to run with.

Compiled, and with the types only erased, on an Apple M5 Pro, ms on 1/2/4/8
threads:

|                                                 | Compiled             | Types erased           |
| ----------------------------------------------- | -------------------- | ---------------------- |
| N-body, shared structs (plain V8, 1 thread: 25) | 29 / 15 / 8 / 6      | 1820 / 971 / 498 / 301 |
| Mandelbrot, channels                            | 712 / 341 / 180 / 97 | 713 / 349 / 180 / 99   |

## Layout

| Path                    | What                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `index.html`, `main.ts` | the page, on [Monaco](https://github.com/microsoft/monaco-editor)                            |
| `programs/`             | its programs                                                                                 |
| `vite.config.ts`        | the dev server: the runtime's Vite plugin, which compiles with the fork and runs the checker |
| `assets.d.ts`           | the types of what Vite imports besides modules                                               |

The runtime and the checker are in [src/](../src).

## License

Copyright 2026 Erik Arvidsson. Licensed under the
[Apache License 2.0](../LICENSE).
