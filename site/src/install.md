---
title: Install
description:
  The runtime from npm, and Vite and threads-check (the ownership checker and
  the compiler) as dev dependencies.
---

Install the runtime, and add Vite and threads-check (the ownership checker and
the compiler) as dev dependencies:

```sh
npm install @arv/threads
npm install --save-dev vite @arv/threads-check   # Vite, and the checker and compiler
```

## What It Needs

@arv/threads needs:

- [Vite](https://vite.dev) 8, or [Vite+](https://viteplus.dev), which is built
  on it. With Vite+, alias `vite` to Vite+'s core, as this repository's
  [pnpm-workspace.yaml](https://github.com/arv/threads/blob/main/pnpm-workspace.yaml)
  does.
- Node 22.13 or later. Vite+ needs 22.18.
- A browser with `SharedArrayBuffer`.

The runtime that the page and its workers run (`@arv/threads`,
`@arv/threads/heap` and `@arv/threads/browser`) is TypeScript, and Vite compiles
it as it bundles the page. What Node runs (the Vite plugin, and
@arv/threads-check) is JavaScript.

Next, [set up](/setup/) the Vite plugin, the page and the checker.
