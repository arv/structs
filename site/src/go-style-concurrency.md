---
title: Go-Style Concurrency
description: Goroutines, and channels that move values between threads in order.
---

Threads can also talk to each other the way Go does. `go(f, ...args)` starts a
goroutine, and a `Channel<T>` moves values between threads in order. You can
`send` and `recv`, loop with `for (const v of channel)`, and wait on several
channels with `select`.

When you send a struct or a SharedArray on a channel, it stays where it is, in
shared memory. The receiver reads the same one.

## Closed Channels

`recv()` returns undefined both for a sent undefined and once the channel is
closed. To tell the two apart, use `const [v, ok] = channel.recvOk()`, just like
Go's `v, ok := <-ch`. `select` gives you the same ok, as its third element. So a
`Channel<void>` either signals by `close()`, which wakes every receiver, or is
read with `recvOk()`.

## Async Goroutines

A goroutine of an async function is light, just like Go's are. One worker can
run thousands of them, and each one waits with `await` without blocking the
others. Here's what each kind costs in Node on an M5 Pro:

| Goroutine              | Time to start | Memory          |
| ---------------------- | ------------- | --------------- |
| On a worker of its own | 3.2 ms        | 8.6 MB          |
| Of an async function   | 0.2 µs        | About 350 bytes |

A blocking call in an async function would stop every goroutine on its worker.
So the checker reports it, and the runtime throws.

```ts
interface Replica {
  position: i32;
  changed: Channel<void> | null;
} // Closed, and replaced, on every change.
const Replica = struct<Replica>({position: i32, changed: ref<Channel<void>>()});

async function request(
  replica: Replica,
  position: i32,
  answers: Channel<string>,
) {
  for (;;) {
    const changed = replica.changed!;
    if (atomic.load(replica, 'position') >= position) break;
    await changed.recvAsync(); // One of thousands waiting on this worker.
  }
  await answers.sendAsync('ready');
}

for (let k = 0; k < 10_000; k++) go(request, replica, (k % 1000) + 1, answers); // 0.2 µs each
```

[Goroutines and Channels](/api/goroutines-and-channels/) in the API reference
lists every call.
