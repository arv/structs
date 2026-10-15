---
title: Odds and Ends
description: Logging from any thread, and what the shared memory holds.
---

Everything here comes from `"@arv/threads"`.

`log(...args)` prints a line from any thread. `heapStats()` reports the shared
memory in use, and the blocks allocated and freed. `collectCycles()` frees
cycles of shared structs, SharedArrays and maps, which counting alone never
frees, and returns how many blocks it freed. Every other thread stops at its
next quiescent point while it runs (see
[Reference Counting](/reference-counting/#cycles)).
