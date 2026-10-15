---
title: Goroutines and Channels
description: Go's model on threads, with channels that move values in order.
---

Everything here comes from `"@arv/threads"`.

|                                                                                      |                                                                                                                                                           |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `go(f, ...args)`                                                                     | Starts `f` as a goroutine, and nothing waits for it. A plain function gets a thread of its own, and an async function is light, one of many on a worker.  |
| `new Channel<T>(capacity = 0)`                                                       | `send(value)` moves a value in, `recv()` takes the next one out (undefined once closed, as for a sent undefined), and `close()` closes it. It's iterable. |
| `ch.recvOk()`                                                                        | `recv()`, plus whether a value came: `[value, true]`, or `[undefined, false]` once the channel is closed and empty.                                       |
| `ch.sendAsync(v)`, `ch.recvAsync()`, `ch.recvOkAsync()`, `for await (const v of ch)` | The same, for an async function. They wait without blocking the worker.                                                                                   |
| `select(...channels)`, `selectAsync(...channels)`                                    | Waits for the first channel that has a value or is closed, and gives `[index, value, ok]`. ok is false for a closed channel.                              |

[Go-Style Concurrency](/go-style-concurrency/) shows them at work.
