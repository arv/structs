---
title: Sharing Across Agents
description:
  Workers that share the heap, and messages between them that carry shared
  objects as themselves.
---

The proposal leaves sharing across agents to the host. The agent module
([src/runtime/agent.ts](https://github.com/arv/threads/blob/tc39-proposal/src/runtime/agent.ts))
starts workers that attach to the same heap: `worker_threads` in Node, module
Web Workers in a browser. Messages sent through it carry shared objects as
themselves, and everything else as `postMessage` copies it.

```js
// examples/counter/main.js
import {startWorker} from '../../src/runtime/agent.ts';
const w = startWorker(new URL('./worker.js', import.meta.url));
w.postMessage({tally, n: 1000});

// examples/counter/worker.js
import {parent} from '../../src/runtime/agent.ts';
parent.onmessage = ({tally, n}) => {
  /* tally is the main thread's struct */
};
```

`run(url, name, ...args)` calls the function a module exports as `name` on a
worker and settles with what it returns. A module can run its own functions with
`run(import.meta.url, ...)`. The workers are a pool: one that returns waits for
the next call, with the code V8 has optimized in it, so a program that runs its
work again finds its workers warm.

[examples/counter](https://github.com/arv/threads/tree/tc39-proposal/examples/counter)
has four workers counting to a million under a Mutex, with a Condition saying
when they are done.
