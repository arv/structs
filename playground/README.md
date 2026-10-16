# Structs Playground

The structs playground is a page where you write programs in the
[structs proposal](https://tc39.es/proposal-structs/)'s syntax, see what they
compile to, and run them on Web Workers that share memory. It's the playground
of [@arv/structs](../README.md), whose README explains the runtime, the compiler
and where they differ from the spec.

> Written iterating with Claude Code (Claude Opus 5.5).

## Using the Playground

Pick a program from the **Program** menu and edit it in Monaco. As you type, the
page compiles the program and shows you:

- **The JavaScript.** **Direct field access** shows what the compiler emits
  where TypeScript proves an object is an instance of a shared struct: the field
  is read and written in shared memory, without the Proxy. **Proxy only** shows
  the same program with every field access going through the Proxy. The
  runtime's calls are marked, and the direct accesses are in bold.
- **The errors.** These are TypeScript's, from seeing each struct as a class,
  and the structs' own: a shared struct can't have methods, for example. They
  appear as squiggles in the editor and in a list.
- **The output.** **Run** calls the program's `main(workers)` on a worker, with
  the number in the **Workers** field. `main` may block, on `Atomics.Mutex.lock`
  for example. A program starts its own workers with
  `run(import.meta.url, 'name', ...args)` from `@arv/structs/agent`, which calls
  the function it exports as `name` on a new worker. Their console output comes
  back to the page. **Stop** ends the run, along with the workers it started.

Monaco's TypeScript can't parse `struct`, so the editor only colors and
completes. The errors you see come from the playground's compiler.

The page remembers your edits to each program in this browser. **Reset** puts
the original back.

## Run It Locally

You need Node 22.13 or later and a recent Chrome. A static build also needs Go
1.27 or later, and git.

```sh
vp install
```

```sh
vp dev playground
```

On the dev server, programs compile in Node, on TypeScript's native API
([vite.config.ts](vite.config.ts)). Add `?wasm` to the address to compile in the
browser instead.

## Static Builds

Without a dev server, the page compiles programs itself. It runs the same
compiler, in a worker, on tsgo (stock TypeScript 7.1) compiled to WebAssembly,
in a worker of its own. The two talk over pipes in shared memory
([tsgo/](tsgo)). You get the same JavaScript and the same errors as on the dev
server. The catch is size: tsgo is 46 MB, about 10 MB gzipped, and the page
shows the download as it goes.

```sh
vp run build-wasm
```

```sh
vp build
```

```sh
vp run test-build
```

`build-wasm` builds tsgo from TypeScript's sources at the commit of the
compiler's `typescript` package, into `public/compiler/`. `vp build` builds the
page into `dist/`, to be served from `/playground/` (set `BASE` for another
path). `test-build` serves the build with no COOP or COEP headers, so the
service worker has to isolate it. It then compiles and runs every program in
Chrome, in both modes, and checks that the JavaScript, the errors and the output
match the dev server's.

### Cross-Origin Isolation

SharedArrayBuffer needs a cross-origin isolated page, which takes the COOP and
COEP headers. The dev and preview servers send them. Where a host can't, as on
GitHub Pages, a service worker ([public/coi-sw.js](public/coi-sw.js)) adds them,
and the page loads once more under it.

## Programs

The programs live in [programs/](programs). Each one exports `main(workers)`:

- Structs: sealed, initialized in one shot, with brand-checked methods
- Shared structs across workers: a linked list that workers add to
- `Atomics.Mutex`: workers counting together
- `Atomics.Condition`: a bounded queue between producers and a consumer
- `Atomics` on fields: claiming work with `compareExchange`
- N-body: direct field access against the Proxy
- The mistakes the compiler catches

## Layout

| Path                             | What It Is                                                              |
| -------------------------------- | ----------------------------------------------------------------------- |
| `index.html`, `main.ts`          | The page, built on [Monaco](https://github.com/microsoft/monaco-editor) |
| `boot.ts`                        | The page's entry: it isolates the page, then loads `main.ts`            |
| `programs/`                      | The page's programs                                                     |
| `compile-program.ts`             | A program compiled, on the dev server and in the browser alike          |
| `vite.config.ts`                 | The dev server, which compiles programs, and the headers                |
| `wasm.ts`, `compiler.ts`         | Compiling in the browser: the page's side, and the compiler's worker    |
| `link.ts`                        | A compiled program as a `blob:` module its workers can import too       |
| `tsgo/`                          | tsgo in WebAssembly, and the API client's channel to it                 |
| `build-wasm.ts`, `test-build.ts` | Building tsgo, and the static build tested in Chrome                    |
| `public/coi-sw.js`               | The service worker that isolates the page where the host can't          |

## License

Copyright 2026 Erik Arvidsson. Licensed under the
[Apache License 2.0](../LICENSE).
