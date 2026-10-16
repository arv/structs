---
title: Running It
description:
  Run struct syntax in Node with the register hook, compile files and TypeScript
  projects with the CLI, or call the compiler from code.
---

There is no package to install: clone the repository, its `tc39-proposal`
branch, and install what it needs:

```bash
git clone --branch tc39-proposal https://github.com/arv/threads.git
```

```bash
cd threads && pnpm install
```

In Node, the register hook compiles struct syntax as modules load, in workers
too:

```bash
node --import ./src/register.ts examples/counter/main.js
```

The CLI compiles a single file, or a whole TypeScript project with type
checking:

```bash
node src/compiler/cli.ts transpile examples/counter/main.js
```

```bash
node src/compiler/cli.ts compile -p examples/nbody/tsconfig.json
```

`compile` writes each file to the tsconfig's `outDir` (or `build/`), with its
source map. `--no-fast` leaves every shared struct field access to the Proxy
(see [TypeScript](/typescript/)), and `--typescript` keeps the types.

From code, use `transpile(source, {fileName})` and `compile(tsconfigPath)` from
[src/compiler/index.ts](https://github.com/arv/threads/blob/tc39-proposal/src/compiler/index.ts).

::: note The compiler runs on TypeScript 7
It parses with TypeScript 7's API, the same parser for JavaScript and for
TypeScript, which starts tsgo, TypeScript's compiler, as a process. The
playground runs the same compiler on tsgo in WebAssembly.
:::
