---
title: Odds and Ends
description: Logging from any thread, and what the shared memory holds.
---

Everything here comes from `"@arv/threads"`.

`log(...args)` prints a line from any thread. `heapStats()` reports the shared
memory in use, and the blocks allocated and freed.
