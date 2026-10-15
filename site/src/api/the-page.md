---
title: The Page
description:
  Starting the pool of workers, running functions on it, and stopping it.
---

The page's API comes from `"@arv/threads/browser"`:

- `start({ workers, check, onLog })` starts the pool, with one worker per core
  by default.
- `run(f, ...args)` runs `f` on a thread and resolves with its result.
- `stop()` stops the pool.

The pool's options are the ones the first `start()` was given. If the pool
hasn't started, `run` starts it with the defaults. So a page that wants other
options calls `start` before its first `run`. A later `start` with other options
throws.

`stop()` terminates the workers, along with the threads they ran, and fails the
runs that are waiting. After that, a spawn throws until `start()` starts a new
pool on the same heap. That's also how you recover a stuck pool, such as one
with a thread that never ends: call `stop()`, then `start()` again.

[Set Up](/setup/#2-the-page) shows a page's entry module.
