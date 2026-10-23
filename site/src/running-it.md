---
title: Installing and Running It
navTitle: Installing and Running
description:
  Run struct syntax in Node with the register hook, compile files and TypeScript
  projects with the CLI, or call the compiler from code.
---

There are two packages: the runtime, and the compiler for the proposal's syntax,
which you need only to build or run code that has it.

```bash
npm install @arv/structs
```

```bash
npm install --save-dev @arv/structs-compiler
```

In Node, the compiler's load hook compiles struct syntax as modules load, in
workers too:

```bash
node --import @arv/structs-compiler/register main.js
```

The `structs` command compiles a single file, or a whole TypeScript project with
type checking:

```bash
npx structs transpile main.js
```

```bash
npx structs compile -p tsconfig.json
```

`compile` writes each file to the tsconfig's `outDir` (or `build/`), with its
source map. `--no-fast` leaves every shared struct field access to the Proxy
(see [TypeScript](/typescript/)), and `--typescript` keeps the types.

From code, use `transpile(source, {fileName})` and `compile(tsconfigPath)` from
`@arv/structs-compiler`.

::: note The compiler runs on TypeScript 7
It parses with TypeScript 7's API, the same parser for JavaScript and for
TypeScript, which starts tsgo, TypeScript's compiler, as a process. The
playground runs the same compiler on tsgo in WebAssembly.
:::
