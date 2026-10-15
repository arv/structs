---
title: The Model
description:
  Every value is owned by one thread, shared read-only, or a cell built for
  sharing.
---

A thread is a worker with its own JavaScript heap, and objects can't cross
between heaps. That's why every value is one of three kinds:

| Kind   | In the types                                                 | How it crosses threads                                        | Use it for                                                      |
| ------ | ------------------------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------- |
| Owned  | Ordinary types, and `Sending<T>` where it moves              | It moves. It's copied once, and the sender loses it.          | Work a thread does alone, and its result                        |
| Shared | `Shared<T>`, which is deeply readonly                        | It's frozen. Every thread reads its own copy, made once.      | Tables, settings and lookups                                    |
| Cell   | `struct(...)`, `SharedArray`, `SharedMap`, `Lock`, `Channel` | It doesn't. There's only one copy, and it's in shared memory. | Data many threads read and write in place, and what orders them |

Code inside a thread is plain JavaScript on plain objects, so it runs at full
speed. The cost is at the crossings, and the types tell you where they are.

```ts
import {log, share, spawn, type Sending, type Shared} from '@arv/threads';

type Order = {id: number; items: number[]};

// The order moves to the thread. The thread owns it now, and may change it.
function total(order: Sending<Order>): Sending<number> {
  order.items.push(5);
  return order.items.reduce((sum, x) => sum + x, 0);
}

// The rates are shared. They're frozen, and any thread can read them.
function convert(
  amount: number,
  rates: Shared<Record<string, number>>,
  to: string,
): Sending<number> {
  return amount * rates[to];
}

export function main() {
  const order = {id: 1, items: [10, 20, 30]};
  log(spawn(total, order).join()); // 65. Using `order` here is an error.
  const rates = share({USD: 1, EUR: 0.92, SEK: 10.5});
  log(spawn(convert, 100, rates, 'EUR').join());
}
```

Threads can also talk to each other the way Go does, with goroutines and
channels: see [Go-Style Concurrency](/go-style-concurrency/). The
[tutorial](/tutorial/#how-it-works) shows what happens underneath when values
cross between threads.
