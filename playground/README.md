# Threads Playground

The threads playground is a page where you write threads programs, see what they
compile to, and watch them run. It's the playground of
[@arv/threads](../README.md), which brings threads to JavaScript in plain
TypeScript, on Web Workers and a SharedArrayBuffer. You'll find the model, the
API and the limits in [the README](../README.md).

> Written iterating with Claude Code (Claude Opus 5.5).

You can try it at
[arv.github.io/threads/playground](https://arv.github.io/threads/playground/).
It compiles everything right in your browser.

## Using the Playground

Pick a program from the **Program** menu and edit it in Monaco. You get
TypeScript's hover types, completions and errors from the threads API. As you
type, the page compiles your program and shows you:

- **The compiled JavaScript.** This is what the fork of TypeScript compiles your
  program to. Everything the compiler added is marked.
- **The JavaScript with its types erased.** This is the same program with its
  types only erased, and it still runs.
- **The ownership checker's errors.** They show up as squiggles in the editor
  and in a list. On the dev server they come from threads-check. In the browser
  they come from the fork's own check.
- **The output.** **Run** runs the program on a pool of Web Workers.

The **Compiled** and **Types erased** switch picks which of the two JavaScript
versions you see, and which one runs.

The page remembers your edits to each program in this browser. If you want the
original back, click **Reset**.

### Running a Program

**Run** calls the program's `main` with the thread counts in the **Threads**
field, which starts out as 1, 2, 4 and 8.

`main` runs on a worker too. It's started like any other thread, so it may
block, for example on `join`, `recv` or a barrier. The page itself never blocks.
It only awaits `main`'s result.

**Stop** ends a run that doesn't end on its own. The pool stops, along with
every thread on it, and a fresh pool starts.

### When Compiling Fails

If compiling goes wrong, the status in the page's header tells you. On the dev
server, the page says when it can't reach Vite's dev server. When the page
compiles in the browser, it says if the compiler failed, or if the compiler
didn't load at all.

## Run It Locally

### What You Need

- **Node** 22.18 or later (24.11 or later if you're on Node 24).
- **A recent Chrome**, or another browser with SharedArrayBuffer.
- **The TypeScript fork**, for the compiled JavaScript. This is a fork of
  TypeScript 7.0.2,
  [arv/threads-checker](https://github.com/arv/threads-checker). Build it in a
  clone of it with `go build -o built/local/tsgo ./cmd/tsgo`.

The ownership checker doesn't need the fork. It's
[src/checker/](../src/checker), and it runs on stock TypeScript 7.1.

The repository is a pnpm workspace on [Vite+](https://viteplus.dev). Its
[README](../README.md#development) has the details.

### Starting the Dev Server

Install the dependencies, then start the dev server with `TSGO` pointing at the
fork:

```sh
vp install                                                 # at the repository's root
TSGO=/path/to/threads-checker/built/local/tsgo vp dev      # here, or at the root
```

Open the address Vite prints, and you're ready to go.

### Checking the Programs

`vp run typecheck` checks the programs' types, and `vp run own-check` runs the
ownership checker on them. Run both before you send a change to a program.

## Static Builds

Without a dev server, the page compiles programs itself. It uses the fork
compiled to WebAssembly
([arv/threads-checker](https://github.com/arv/threads-checker)'s `cmd/wasm`),
running in a worker. You get the same JavaScript, `tsgo own check`'s ownership
errors, and tsgo erasing the types.

The catch is size. The compiler is 34 MB (about 8 MB compressed), because Go's
WebAssembly is huge. The page shows its download as it goes.

```sh
vp run build-wasm                                          # the compiler, into public/compiler/ (needs Go)
TSGO=/path/to/threads-checker/built/local/tsgo vp build    # into dist/, to be served from /playground/
vp preview                                                 # serves dist/, at /playground/
```

`vp run build-wasm` builds from the clone that `TSGO_FORK` names. By default,
that's ~/src/arv/threads-checker.

The build is served from `/playground/`. To serve it from another path, build it
with `BASE=/elsewhere/ vp build`.

You can also compile in the browser on the dev server. Just add `?wasm` to the
address.

### Deploying to GitHub Pages

On every push to main, [the Pages workflow](../.github/workflows/pages.yml)
builds it all and deploys it to GitHub Pages, at
[arv.github.io/threads/playground/](https://arv.github.io/threads/playground/).

### Cross-Origin Isolation

SharedArrayBuffer only works on a cross-origin isolated page. That takes the
COOP and COEP headers, which the dev and preview servers send.

Some hosts, such as GitHub Pages, can't send these headers. There, a service
worker ([public/coi-sw.js](public/coi-sw.js)) provides them. The first time you
visit, the page loads once more, under the service worker.

## Programs

The programs you can pick from live in [programs/](programs). Each one exports
`main`, which the page calls with the thread counts to run with.

The basics come first, with one idea each:

- Hello, threads
- Moving a value to a thread
- Sharing a value
- A shared struct
- A SharedArray of booleans (a sieve)
- Strings in shared memory
- Atomics (claiming work, and counting together)
- A channel pipeline
- A pool of workers on channels
- Ten thousand async goroutines waiting for a database replica
- A SharedMap and a SharedSet counting words

Then come the bigger examples:

- N-body four ways: shared structs with a barrier, shared structs with channels,
  moving and sharing objects, and channels copying objects
- Mandelbrot on channels
- JSON parsed on threads
- The nearest-centers example from [the tutorial](../TUTORIAL.md)
- What channels cost
- Reference counting under a race
- A growable `SharedVector`, written in user space on the API
- The mistakes the checker catches

### How Fast They Run

Here's how two of them do, compiled and with the types only erased, on an Apple
M5 Pro. Times are in milliseconds, on 1, 2, 4 and 8 threads:

|                                                 | Compiled             | Types erased           |
| ----------------------------------------------- | -------------------- | ---------------------- |
| N-body, shared structs (plain V8, 1 thread: 25) | 29 / 15 / 8 / 6      | 1820 / 971 / 498 / 301 |
| Mandelbrot, channels                            | 712 / 341 / 180 / 97 | 713 / 349 / 180 / 99   |

## Layout

| Path                     | What It Is                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `index.html`, `main.ts`  | The page, built on [Monaco](https://github.com/microsoft/monaco-editor)                           |
| `programs/`              | The page's programs                                                                               |
| `vite.config.ts`         | The dev server, with the runtime's Vite plugin, which compiles with the fork and runs the checker |
| `wasm.ts`, `compiler.ts` | Compiling in the browser: the page's side, and the worker that runs the compiler                  |
| `build-wasm.ts`          | Builds the compiler, in WebAssembly, into `public/compiler/`                                      |
| `public/coi-sw.js`       | The service worker that isolates the page where the host can't                                    |
| `assets.d.ts`            | The types of what Vite imports besides modules                                                    |

The runtime and the checker are in [src/](../src).

## License

Copyright 2026 Erik Arvidsson. Licensed under the
[Apache License 2.0](../LICENSE).
