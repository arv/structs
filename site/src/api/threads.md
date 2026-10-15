---
title: Threads
description:
  Starting threads, joining them, and the locks and conditions that order them.
---

Everything here comes from `"@arv/threads"`.

|                                             |                                                                                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spawn(f, ...args)`                         | Starts `f` on a thread. Owned arguments move, and shared values and cells are shared. The Thread it returns stays here: it isn't sent or shared.                      |
| `thread.join()`, `thread.joinAsync()`       | Waits for the thread, and its result moves back. If the thread threw, it throws an Error that says what the thread threw, whose `cause` has the thread's stack.       |
| `scope(s => ...)`                           | Structured threads. It joins every thread that `s.spawn` started before it returns. The body isn't async.                                                             |
| `partition(items, parts)`, `take(items, i)` | `partition` splits an owned array into owned parts, and `take` takes one element out.                                                                                 |
| `register(import.meta.url, {f, ...})`       | Registers a module's top-level functions, so a thread finds the one it runs. The compiler adds this call for you, and a program that runs uncompiled calls it itself. |
| `new Lock()`                                | `using _ = lock.hold()` holds the lock until the end of the block, and `await lock.holdAsync()` waits for it without blocking.                                        |
| `new Condition()`                           | `wait(lock)` releases the lock until another thread calls `notifyOne()` or `notifyAll()`, then holds it again. `waitAsync(lock)` waits without blocking.              |
