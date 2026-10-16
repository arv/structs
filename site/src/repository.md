---
title: This Repository
description:
  What's in the tc39-proposal branch of arv/threads, and how to work on it.
---

@arv/structs is the `tc39-proposal` branch of
[arv/threads](https://github.com/arv/threads/tree/tc39-proposal). Here's what's
in it:

| Path                                                                                                     | What it is                                               |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [src/runtime/heap.ts](https://github.com/arv/threads/blob/tc39-proposal/src/runtime/heap.ts)             | The heap: allocation, locks, interned strings            |
| [src/runtime/shared.ts](https://github.com/arv/threads/blob/tc39-proposal/src/runtime/shared.ts)         | Shared Structs and Shared Arrays: slots, shapes, Proxies |
| [src/runtime/structs.ts](https://github.com/arv/threads/blob/tc39-proposal/src/runtime/structs.ts)       | What struct declarations become                          |
| [src/runtime/sync.ts](https://github.com/arv/threads/blob/tc39-proposal/src/runtime/sync.ts)             | Mutex, UnlockToken, Condition                            |
| [src/runtime/atomics.ts](https://github.com/arv/threads/blob/tc39-proposal/src/runtime/atomics.ts)       | The Atomics overloads, `Reflect.canBeShared`             |
| [src/runtime/agent.ts](https://github.com/arv/threads/blob/tc39-proposal/src/runtime/agent.ts)           | Workers on the same heap, messages with shared objects   |
| [src/runtime/emit.ts](https://github.com/arv/threads/blob/tc39-proposal/src/runtime/emit.ts)             | What compiled code imports                               |
| [src/compiler/scan.ts](https://github.com/arv/threads/blob/tc39-proposal/src/compiler/scan.ts)           | Finds struct declarations and spells them as classes     |
| [src/compiler/transform.ts](https://github.com/arv/threads/blob/tc39-proposal/src/compiler/transform.ts) | Lowers them                                              |
| [src/compiler/project.ts](https://github.com/arv/threads/blob/tc39-proposal/src/compiler/project.ts)     | TypeScript projects: type checking                       |
| [src/compiler/fast.ts](https://github.com/arv/threads/blob/tc39-proposal/src/compiler/fast.ts)           | Direct field access where the types allow it             |
| [src/register.ts](https://github.com/arv/threads/blob/tc39-proposal/src/register.ts)                     | Node's load hook                                         |
| [playground/](https://github.com/arv/threads/tree/tc39-proposal/playground)                              | The playground: edit, compile and run in the browser     |
| [site/](https://github.com/arv/threads/tree/tc39-proposal/site)                                          | These docs as a site, built by Eleventy                  |

The compiler parses with TypeScript 7's API (the same parser in both modes),
edits with magic-string, and strips types with OXC.

## Development

The repository is a pnpm workspace on [Vite+](https://viteplus.dev) (`vp`), with
the playground and these docs as packages of their own.

```bash
pnpm install
```

```bash
vp check
```

```bash
vp test
```

`vp check` formats, lints and type checks. `vp test` runs the tests in
[test/](https://github.com/arv/threads/tree/tc39-proposal/test), including
workers that share the heap, and the site's own: every link of these docs leads
somewhere, and every code block and table of the repository's Markdown is in
them.

## License

Copyright 2026 Erik Arvidsson. Licensed under the
[Apache License 2.0](https://github.com/arv/threads/blob/tc39-proposal/LICENSE).
