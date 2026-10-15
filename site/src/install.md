---
title: Install
description:
  The runtime from npm, and Vite and the ownership checker as dev dependencies.
---

Install the runtime, and add Vite and the ownership checker as dev dependencies:

```sh
npm install @arv/threads
npm install --save-dev vite @arv/threads-check   # Vite, and the ownership checker
```

To try what's on main before it's released, pack the packages from this
repository and install the tarballs. `pnpm pack` builds each package first, and
you import the packages the same way:

```sh
git clone https://github.com/arv/threads.git && cd threads
pnpm install
pnpm pack --pack-destination ~/threads-packages
pnpm -C src/checker pack --pack-destination ~/threads-packages
cd /path/to/your/app
npm install ~/threads-packages/arv-threads-0.0.1.tgz
npm install --save-dev vite ~/threads-packages/arv-threads-check-0.0.1.tgz
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
