---
title: Set Up
description:
  The Vite plugin, the page and the checker, and the two headers a server sends
  in production.
---

Setting up takes three steps: the Vite plugin, the page, and the checker. In
production, your server also needs to send two headers.

## 1. The Vite Plugin

The Vite plugin compiles your TypeScript with @arv/threads-check, and registers
the functions that threads run. It also sets the cross-origin isolation headers
that `SharedArrayBuffer` needs on the dev and preview servers.

```js
// vite.config.ts
import threads from '@arv/threads/vite';

export default {
  plugins: [threads()],
};
```

| Option       | Default           | What it does                                                                                                              |
| ------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `tsconfig`   | `'tsconfig.json'` | The project that threads-check compiles, relative to Vite's root.                                                         |
| `runtime`    | `'@arv/threads'`  | The module that programs import the runtime from.                                                                         |
| `playground` | `false`           | When true, the dev server compiles programs that the page sends it (`POST /__threads/compile`), as the playground's does. |
| `checker`    | `null`            | The path of threads-check's entry module, if it's not the @arv/threads-check installed beside the plugin.                 |

threads-check compiles each module of that project. The plugin hands Vite each
one's TypeScript with the compiler's edits, and a source map, and Vite strips
the types. It leaves any other module to Vite, which erases its types and
registers none of its functions, so no thread can run them. The project needs
to:

- Include the page's modules and the modules its threads run, all under the
  tsconfig's directory.
- Resolve imports the way a bundler does (`"module": "esnext"`,
  `"moduleResolution": "bundler"`), so that `@arv/threads` is the API's
  declarations.
- Be the app's project. `"noEmit": true`, as Vite's templates have, is fine:
  threads-check compiles whatever the tsconfig says. But a tsconfig.json made
  only of references (also from Vite's templates) compiles nothing, so name the
  project itself (`tsconfig: 'tsconfig.app.json'`).

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
