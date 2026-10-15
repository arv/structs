---
title: Owned and Shared Values
description:
  The types that say how a value crosses threads, and the calls that change it.
---

Everything here comes from `"@arv/threads"`.

|                  |                                                                                 |
| ---------------- | ------------------------------------------------------------------------------- |
| `Sending<T>`     | A value that moves. The receiver owns it, and the sender must not use it again. |
| `Shared<T>`      | A deeply readonly value that any number of threads may read.                    |
| `share(value)`   | Freezes a value the caller owns, deeply, into a `Shared<T>`.                    |
| `consume(value)` | Ends a value's lifetime, for the checker.                                       |

[The Model](/model/) explains the three kinds of values, and when to use each.
