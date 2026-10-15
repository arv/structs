---
title: Performance
description:
  How long a few programs take, what crossing threads costs, and what the
  compiler adds.
---

Here's how long a few programs take on an Apple M5 Pro:

| Program                                                           | ms on 1, 2, 4 and 8 threads |
| ----------------------------------------------------------------- | --------------------------- |
| N-body, 800 bodies in shared structs (plain V8 on one thread: 25) | 29, 15, 8, 6                |
| Mandelbrot on goroutines and channels                             | 712, 341, 180, 97           |
| A sieve of Eratosthenes on a `SharedArray<boolean>` of 10 million | 76, 56, 40, 37              |

## Crossing Threads

Values cross threads about as fast as JSON would carry them, and they're read
back faster. Moving 50,000 parsed JSON requests costs about 1.1 times
`JSON.stringify` to write, and a third of `JSON.parse` to read. A few things
keep it fast:

- Each distinct set of keys is written once per message.
- Strings that repeat within a value are written once.
- ASCII text is stored at one byte per character.

All told, 23 MB of JSON text crosses in about 7 ms.

## Compiled, or With the Types Only Erased

The compiler is what makes shared structs fast. But a program also runs with its
types only erased, by Node's type stripping for example. (The Vite plugin always
compiles.) All it needs is the one line the compiler would add:
`register(import.meta.url, {main, ...})`, imported from @arv/threads. That line
registers the module's top-level functions, so that a thread finds the one it
runs.

The checker reads the source, so it reports the same errors either way. The
runtime still throws on a use after move.

Code that moves and shares plain objects runs at the same speed either way.
Shared structs and SharedArrays don't. With types erased, each struct is a
handle whose fields are accessors, and a SharedArray is a Proxy. That makes
N-body 50 to 60 times slower:

| ms on 1, 2, 4 and 8 threads           | Compiled          | Types erased        |
| ------------------------------------- | ----------------- | ------------------- |
| N-body, 800 bodies in shared structs  | 29, 15, 8, 6      | 1820, 971, 498, 301 |
| Mandelbrot on goroutines and channels | 712, 341, 180, 97 | 713, 349, 180, 99   |

[The playground](/playground/) runs every program both ways (Compiled and Types
erased), so you can compare them yourself.

[The Prototypes](/prototypes/#results) has the measurements this work started
from, against Porffor and plain V8.
