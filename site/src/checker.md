---
title: The Checker
description:
  "@arv/threads-check reports what TypeScript's types can't see, in CI, like a
  linter."
---

The checker runs in CI, like a linter. It reports what TypeScript's types can't
see:

- A value used after it was sent.
- An alias of something sent.
- Sending what the caller still holds.
- A write to a shared value through a cast.
- A number that may not be an integer, stored into an `i32` or a `u8` (see
  [Shared Memory](/api/shared-memory/)).
- A blocking call in an async function (see
  [Go-Style Concurrency](/go-style-concurrency/)).

Here's how you run it, and what an error looks like:

```sh
npx @arv/threads-check -p tsconfig.json --runtime @arv/threads
```

```
app.ts(23,16): error TS96007: 'order' cannot be sent: it may be referenced by the caller. Declare the parameter 'Sending<T>' to take ownership.
```

The checker needs no fork. @arv/threads-check runs on stock TypeScript 7.1's
API.

The checker reads the source, so it reports the same errors whether a program is
compiled or runs with its types only erased (see
[Performance](/performance/#compiled-or-with-the-types-only-erased)).

[The tutorial](/tutorial/#check-and-compile) shows how the checker follows each
value through a function, and the mistakes it catches.
