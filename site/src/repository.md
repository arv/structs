---
title: This Repository
description: What's in arv/threads, how to work on it, and how it's released.
---

@arv/threads is developed in [arv/threads](https://github.com/arv/threads).
Here's what's in it:

|                                                                                 |                                                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [src/runtime/](https://github.com/arv/threads/tree/main/src/runtime)            | The runtime: the API, the shared heap, a page's side and the Vite plugin       |
| [src/checker/](https://github.com/arv/threads/tree/main/src/checker)            | The ownership checker (@arv/threads-check)                                     |
| [playground/](https://github.com/arv/threads/tree/main/playground)              | A page to write programs in, and see what they compile to and how they run     |
| [site/](https://github.com/arv/threads/tree/main/site)                          | The docs site, which GitHub Pages publishes with the playground                |
| [TUTORIAL.md](https://github.com/arv/threads/blob/main/TUTORIAL.md)             | Writing, checking and running a small program, and how each step works         |
| [REFCOUNT.md](https://github.com/arv/threads/blob/main/REFCOUNT.md)             | How shared structs and SharedArrays are reference counted and freed            |
| [docs/prototype.md](https://github.com/arv/threads/blob/main/docs/prototype.md) | The prototypes this grew out of in Porffor's threads work, and what they found |

TUTORIAL.md, REFCOUNT.md and docs/prototype.md are also pages of these docs:
[the tutorial](/tutorial/), [Reference Counting](/reference-counting/) and
[The Prototypes](/prototypes/).

## Development

The repository is a pnpm workspace on [Vite+](https://viteplus.dev) (`vp`). It
holds the code in [src/](https://github.com/arv/threads/tree/main/src) at the
root, the checker
([src/checker/](https://github.com/arv/threads/tree/main/src/checker)), the
[playground](/the-playground/) and these docs
([site/](https://github.com/arv/threads/tree/main/site)). Vite+ brings Vite,
Oxlint and a task runner, and it runs pnpm at the version that `packageManager`
names. You need Node 22.18 or later (24.11 or later on Node 24).

```sh
vp install                  # Once, at the root
vp dev                      # The playground; TSGO=<threads-checker>/built/local/tsgo for the compiled JavaScript
vp run build-wasm           # The compiler the playground's build runs in the browser (needs Go)
vp build                    # The playground's production build
vp run threads-site#dev     # The docs site, served as you edit it
vp run threads-site#build   # The docs site's static build, into site/dist/
vp fmt                      # Oxfmt, over the whole workspace
vp lint                     # Oxlint, type-aware, over the whole workspace
vp check                    # Formatting, lint and types, as CI would
vp test                     # The unit tests, as CI would
vp run -r build-dist        # Each package's dist/, as pnpm pack builds it
vp run test-pack            # The packages packed and installed in a project; with TSGO, a page on them in Chrome
vp run -r typecheck         # tsc in every package
```

`vp` is Vite+'s [global CLI](https://viteplus.dev/guide/). If you don't have it,
run `pnpm install` to install, and `pnpm vp <command>` for everything else. That
uses the CLI from the `vite-plus` dev dependency.

The code is TypeScript, and Node runs it as it is, with its types stripped.
Tests sit next to the code they test (`*.test.ts`), and run on Vitest.

## Releasing

A release is a version tag:

1. Set the same `version` in package.json and src/checker/package.json, and
   merge that.
2. Push `vX.Y.Z` on that commit.

The Release workflow
([.github/workflows/release.yml](https://github.com/arv/threads/blob/main/.github/workflows/release.yml))
checks, tests and packs both packages. Then it publishes them to npm with
provenance, by trusted publishing: each package's settings on npmjs.com name
this repository and release.yml as its trusted publisher, so no token is needed.
A new trusted publisher setting expires unless a publish succeeds within 48
hours, so add it just before the tag it's for.

## License

Copyright 2026 Erik Arvidsson. Licensed under the
[Apache License 2.0](https://github.com/arv/threads/blob/main/LICENSE).
