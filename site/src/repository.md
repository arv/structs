---
title: This Repository
description: What's in arv/structs, how to work on it, and how it's released.
---

@arv/structs is developed in
[arv/structs](https://github.com/arv/structs/tree/main). Here's what's in it:

| Path                                                                                            | What it is                                               |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [src/runtime/heap.ts](https://github.com/arv/structs/blob/main/src/runtime/heap.ts)             | The heap: allocation, locks, interned strings            |
| [src/runtime/shared.ts](https://github.com/arv/structs/blob/main/src/runtime/shared.ts)         | Shared Structs and Shared Arrays: slots, shapes, Proxies |
| [src/runtime/structs.ts](https://github.com/arv/structs/blob/main/src/runtime/structs.ts)       | What struct declarations become                          |
| [src/runtime/sync.ts](https://github.com/arv/structs/blob/main/src/runtime/sync.ts)             | Mutex, UnlockToken, Condition                            |
| [src/runtime/atomics.ts](https://github.com/arv/structs/blob/main/src/runtime/atomics.ts)       | The Atomics overloads, `Reflect.canBeShared`             |
| [src/runtime/agent.ts](https://github.com/arv/structs/blob/main/src/runtime/agent.ts)           | Workers on the same heap, messages with shared objects   |
| [src/runtime/emit.ts](https://github.com/arv/structs/blob/main/src/runtime/emit.ts)             | What compiled code imports                               |
| [src/compiler/scan.ts](https://github.com/arv/structs/blob/main/src/compiler/scan.ts)           | Finds struct declarations and spells them as classes     |
| [src/compiler/transform.ts](https://github.com/arv/structs/blob/main/src/compiler/transform.ts) | Lowers them                                              |
| [src/compiler/project.ts](https://github.com/arv/structs/blob/main/src/compiler/project.ts)     | TypeScript projects: type checking                       |
| [src/compiler/fast.ts](https://github.com/arv/structs/blob/main/src/compiler/fast.ts)           | Direct field access where the types allow it             |
| [src/compiler/register.ts](https://github.com/arv/structs/blob/main/src/compiler/register.ts)   | Node's load hook                                         |
| [playground/](https://github.com/arv/structs/tree/main/playground)                              | The playground: edit, compile and run in the browser     |
| [site/](https://github.com/arv/structs/tree/main/site)                                          | These docs as a site, built by Eleventy                  |

The compiler parses with TypeScript 7's API (the same parser in both modes),
edits with magic-string, and strips types with OXC.

## Development

The repository is a pnpm workspace on [Vite+](https://viteplus.dev) (`vp`): the
runtime at the root, the compiler in
[src/compiler/](https://github.com/arv/structs/tree/main/src/compiler), the
playground and these docs in folders of their own.

```bash
git clone https://github.com/arv/structs.git
```

```bash
cd structs && pnpm install
```

```bash
vp check
```

```bash
vp test
```

`vp check` formats, lints and type checks. `vp test` runs the tests in
[test/](https://github.com/arv/structs/tree/main/test), including workers that
share the heap, and the site's own: every link of these docs leads somewhere,
and every code block and table of the repository's Markdown is in them.
`vp run test-pack` packs both packages, installs them with npm in a project of
its own, and uses them there. The examples run from the repository with the load
hook's source:

```bash
node --import ./src/compiler/register.ts examples/counter/main.js
```

Pushing a version tag (`v0.1.0`) publishes both packages to npm
([release.yml](https://github.com/arv/structs/blob/main/.github/workflows/release.yml)).

## License

Copyright 2026 Erik Arvidsson. Licensed under the
[Apache License 2.0](https://github.com/arv/structs/blob/main/LICENSE).
