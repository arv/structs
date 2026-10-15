---
title: Set Up
description:
  The Vite plugin, the page and the checker, and the two headers a server sends
  in production.
---

Setting up takes three steps: the Vite plugin, the page, and the checker. In
production, your server also needs to send two headers.

## 1. The Vite Plugin

The Vite plugin compiles your TypeScript and registers the functions that
threads run. It also sets the cross-origin isolation headers that
`SharedArrayBuffer` needs on the dev and preview servers.

```js
// vite.config.ts
import threads from '@arv/threads/vite';

export default {
  plugins: [threads({tsgo: '/path/to/threads-checker/built/local/tsgo'})],
};
```

| Option       | Default           | What it does                                                                                                                                                                                |
| ------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsgo`       | (required)        | The tsgo fork's binary (see [Status](/status/)).                                                                                                                                            |
| `tsconfig`   | `'tsconfig.json'` | The project the fork compiles, relative to Vite's root.                                                                                                                                     |
| `args`       | `[]`              | More arguments for tsgo. They come after the plugin's own: `-p`, `--ownRuntime`, `--outDir`, `--rootDir`, `--sourceMap`, `--noEmit false`, `--noEmitOnError false` and `--tsBuildInfoFile`. |
| `runtime`    | `'@arv/threads'`  | The module that programs import the runtime from (tsgo's `--ownRuntime`).                                                                                                                   |
| `playground` | `false`           | When true, the dev server compiles programs that the page sends it (`POST /__threads/compile`), as the playground's does.                                                                   |
| `checker`    | `null`            | Used with `playground`. The path of threads-check's entry module, which then reports the ownership errors instead of `tsgo own check`.                                                      |

The plugin serves what the fork emits for each module of that project. It leaves
any other module to Vite, which erases its types and registers none of its
functions, so no thread can run them. The project needs to:

- Include the page's modules and the modules its threads run, all under the
  tsconfig's directory (the plugin's `--rootDir`).
- Resolve imports the way a bundler does (`"module": "esnext"`,
  `"moduleResolution": "bundler"`), so that `@arv/threads` is the API's
  declarations.
- Emit JavaScript, whatever its tsconfig says. The plugin passes
  `--noEmit false`, so a project with `"noEmit": true`, as Vite's templates
  have, needs nothing more. But a tsconfig.json made only of references (also
  from Vite's templates) compiles nothing, so name the project itself
  (`tsconfig: 'tsconfig.app.json'`).

Thread modules may be `.ts`, `.mts` or `.tsx`.

Type errors don't stop the build. tsc reports them, and the checker reports the
ownership errors.

## 2. The Page

The page imports the shared memory first, then runs functions on the pool of
workers. `main` runs on a worker too, so it may block: it can join a thread,
wait on a condition, or receive from a channel. The page only awaits its result.

Keep the functions that threads run out of the page's entry module. A worker
loads a function's module to find it, and `start()`, `run()` and `stop()` throw
when they're called there.

```ts
// main.ts, the page's entry module
import '@arv/threads/heap'; // First: it creates the shared memory.
import {run} from '@arv/threads/browser';
import {main} from './app.ts';

console.log(await run(main, 8));
```

[The Page](/api/the-page/) in the API reference has the rest of the page's API.

## 3. The Checker

The checker runs in CI, like a linter. Here's how you run it:

```sh
npx @arv/threads-check -p tsconfig.json --runtime @arv/threads
```

[The Checker](/checker/) says what it reports, and what an error looks like.

## In Production

In production, your server must send these two headers:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

A host that can't send them, such as GitHub Pages, can have a service worker add
them. That's what the playground does
([coi-sw.js](https://github.com/arv/threads/blob/main/playground/public/coi-sw.js)).
