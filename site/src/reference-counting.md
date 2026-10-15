---
title: Reference Counting for Shared Structs
navTitle: Reference Counting
description:
  How shared structs and SharedArrays are reference counted and freed.
---

::: note Status

This is a prototype. It lives in the runtime
([own.ts](https://github.com/arv/threads/blob/main/src/runtime/own.ts),
[runtime.ts](https://github.com/arv/threads/blob/main/src/runtime/runtime.ts))
and in the tsgo fork's emit.
[refcount.ts](https://github.com/arv/threads/blob/main/src/refcount.ts) tests
it, and
[refcount-hand.ts](https://github.com/arv/threads/blob/main/src/refcount-hand.ts)
is the same test written by hand. The playground's "Reference counting under a
race" runs it in a browser
([programs/refcount.ts](https://github.com/arv/threads/blob/main/playground/programs/refcount.ts)).
Shared structs, SharedArrays, SharedMaps, SharedSets and interned strings are
freed when nothing refers to them. Other cells (`Lock`, `Condition`, `Channel`)
and shared values are still never freed.

:::

Shared structs and SharedArrays live in the shared heap, and someone has to
decide when it's safe to free one. This page explains how we do that, what the
compiler emits to make it work, and where it falls short.

A shared struct or SharedArray is an address in the shared heap. It's passed
around as a plain number, so V8's garbage collector can't see who holds one.
Instead, each block counts its own references. There are two kinds:

- **References stored in the shared heap.** These are reference fields.
- **References that threads hold.** These are locals, handles and a spawned
  thread's arguments.

The compiler emits the increments and decrements for you. Numeric code emits
none, because borrowed addresses aren't counted.

## Layout

Each kind of block starts with a header of i32 words:

| Block                           | Words (i32)                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------- |
| struct                          | `[kind][count]`, then field k in slot k (8 bytes at byte 8 + 8k)                 |
| SharedArray                     | `[kind = 23][length][element size][count]`, then the elements from byte 16       |
| struct element of a SharedArray | `[kind][back]`, where back is the array's address minus the element's (negative) |

A struct element of a SharedArray has no count of its own. Its lifetime is its
array's, so retaining or releasing an element counts its array.

Each field of a struct fills one 8-byte slot:

- **A number field** is an f64: `__F64[(p >> 3) + 1 + k]`.
- **A reference field** holds a struct or a SharedArray, or either with
  `| null`. It's an i32 address in the low half of its slot,
  `__I32[(p >> 2) + 2 + 2 * k]`, and 0 for null.
- **A field that holds a Channel, a Lock or a Condition** is an address too, but
  it isn't counted. Those cells last as long as the program.

## The Race, and Deferred Decrements

Counting alone isn't safe across threads. Here's the race:

1. Thread A reads `p.child`.
2. Thread B overwrites `p.child`. That drops the old child's count to 0, and
   thread B frees it.
3. Thread A increments the count of a block that has already been freed.

So one decrement is deferred: the decrement of a field's old value when the
field is overwritten. It waits until every thread has passed a **quiescent
point** since then. A thread at a quiescent point holds no uncounted address
that it read from a field. Every other increment and decrement is immediate.

### Why a Count of 0 Is Safe

When a count reaches 0, two things are true:

- **No field refers to the block.** Pending decrements haven't been applied yet,
  so they still count.
- **Every thread that read the block from a field has passed a quiescent point
  since then.**

Together, these mean that no thread holds an uncounted address of the block, or
of anything it read through the block. So the block is freed at once, and its
reference fields are released at once too. That's why a list of any length is
freed in one pass. No block is ever revived.

### Quiescent Points

These are the quiescent points:

- `Condition.wait`, and a `Lock.hold` that has to wait
- `spawn` and `join`
- the end of a `scope`
- a thread's start and its end
- `__quiescent()`, which the compiler puts at the end of each iteration of a
  loop that reads or stores a reference field. It's an atomic load and store.
  Numeric loops get none.

A thread that's blocked in a wait counts as quiescent the whole time. Before it
blocks, it moves the decrements it couldn't apply yet to a shared list, just as
a thread does when it ends. That's because the wait may last forever, and no
other thread works off a thread's own queue.

A thread that runs for a long time without a quiescent point delays reclaiming,
so memory grows. It never affects correctness.

### Async Functions

Async functions share a thread. A worker that hosts async goroutines runs one at
a time, each until its next `await`.

The compiler holds no uncounted address across an `await`. An `await` counts as
a call, and an async function's counted parameters are owned. So when one of
these functions resumes from one of the runtime's waits, every other one is
suspended with nothing uncounted. The runtime's waits are `recvAsync`,
`sendAsync`, `selectAsync`, `joinAsync`, `Condition.waitAsync` and
`Lock.holdAsync`.

That resume is a quiescent point for the thread. So is each turn of the host's
loop. A host whose async functions are all waiting passes no quiescent point,
though. So a thread with many decrements queued rings the bell of each host
that's behind, and each of them passes one.

### Epochs

This technique is quiescent-state-based reclamation. There's a global epoch, and
each thread has a word with the epoch it last saw at a quiescent point. A
decrement queued in one epoch is safe once every running thread's word is past
it.

The epoch is an i32 that wraps. Two epochs are compared by their difference,
which works while they're less than half the range apart. A thread that falls a
quarter of the range behind stalls the epoch until it passes a quiescent point,
and memory grows meanwhile. Falling that far behind takes 2^29 reclaims by other
threads without a quiescent point of its own, which is hours of them.

## Runtime (own.ts)

The runtime exports these functions from `@arv/threads`. Compiled code imports
each one under the same name with two leading underscores
(`retain as __retain`), so that none of them clash with the program's own names.
The rules below quote them that way.

| Function                                  | What it does                                                                                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sharedStruct(name, fields, refs, kinds)` | Declares a struct type. `refs` lists the indexes of the reference fields. `kinds` has a letter per field: `f` f64, `i` i32, `u` u8, `b` bool, `s` str, `r` reference, `c` channel, lock or condition. |
| `newStruct(T)`, `newSharedArray(T, n)`    | Allocates a zeroed block with count 1, owned by the caller.                                                                                                                                           |
| `retain(p)`                               | Adds 1 to the count and returns p. Does nothing for 0.                                                                                                                                                |
| `release(p)`                              | Subtracts 1 from the count. At 0, frees the block and releases its reference fields. Does nothing for 0.                                                                                              |
| `store(i, v)`                             | Stores a reference at i32 index i. Takes over v's count, defers the old value's decrement, and returns v.                                                                                             |
| `storeStr(i, s)`, `strAt(p)`              | `storeStr` stores a string field or element at i32 index i. It counts s's interned string, defers the old one's decrement, and returns s. `strAt` returns the string at address p.                    |
| `countedRef(v)`                           | Passes a counted argument to `spawn`, `go` or a channel's `send`. Retains v either for the thread, which releases it when its function returns, or for the message, whose receiver owns it.           |
| `moved(v)`                                | Wraps a counted result that a callback returns to the runtime, such as a SharedMap's getOrInsertComputed's callback. The result carries its count already.                                            |
| `quiescent()`                             | Marks a quiescent point.                                                                                                                                                                              |
| `box(p)`                                  | Returns this thread's handle for p. The handle holds a count of its own, and a FinalizationRegistry releases it when the handle is collected.                                                         |
| `unbox(v)`, `cellAddress(v)`              | `unbox` returns the handle's address, borrowed. `cellAddress` returns a lasting cell's address (a channel's, a lock's or a condition's). Both return 0 for null.                                      |
| `capture(fn, ...ps)`                      | Retains each address for a closure that captures them. They're released when the closure is collected.                                                                                                |
| `F64`, `I32`, `U8`, `outOfBounds`         | The shared heap's views, which field and element accesses index into, and what an out-of-range index reads (it throws).                                                                               |
| `heapStats()`                             | Reports the heap bytes in use, the blocks allocated and freed, and the decrements pending.                                                                                                            |

Freed blocks go to free lists by size, with a per-thread cache over global
lists. Allocation takes from these lists before it bumps the shared cursor.
Large blocks are reused only at the same size.

## What the Compiler Emits

Every expression of a counted type (a struct or SharedArray, possibly `| null`)
is one of three things:

- **Owned (+1).** These are `new S()`, `new SharedArray(...)`, `__retain(E)`, a
  call to a function compiled here whose declared return type is counted, and a
  call to a declared function whose result is `Sending<T>` (a channel's
  `recv()`, `join()`).
- **A stable borrow.** These are a parameter, a counted local that's never
  reassigned, `A[i]` where A is a stable borrow, and `__unbox(v)`.
- **An unstable borrow.** These are a reference field read `e.f`, `A[i]` where A
  is an unstable borrow, and the result of any other call. A generic or declared
  function adds no count. An unstable borrow is valid only until the thread's
  next quiescent point, so it's never held across a call.

### Rules

1. **Locals.** A `const`, or a `let` that's never reassigned, initialized from a
   stable borrow is a borrowed local. It does no counting. Every other counted
   local is owned:

   - It's initialized with `E` if E is owned, and with `__retain(E)` otherwise.
   - It's released when its block ends, on every path, as
     `try { ... } finally { __release(x) }` around the block.
   - Reassigning it retains the new value before releasing the old one.

   A parameter that's reassigned is an owned local too, retained on entry. So is
   every counted parameter of an async function, because it outlives its
   caller's borrow. A generator can't take a counted parameter.

2. **Results.** A function returns +1. For a borrow, `return E` becomes
   `return __retain(E)`. For an owned local, the local's count moves out, and
   the local is zeroed so that the `finally` releases nothing. The count doesn't
   move out of a local that a closure captures.

3. **Temporaries.** An owned value that isn't bound to a local is released after
   its statement. Examples are an argument, `f().x`, and a statement `f();`.

4. **Arguments.** Parameters borrow. An unstable borrow passed to a function is
   retained around the call, because the callee may reach a quiescent point.
   Helpers and intrinsics don't need this.

5. **Field stores.** `e.f = E` becomes `__store((e >> 2) + 2 + 2k, E')`, where
   E' is E if E is owned, and `__retain(E)` otherwise. If `e` is an unstable
   borrow and E contains a call, `e` is retained first.

6. **Field reads.** `e.f` becomes `__I32[(e >> 2) + 2 + 2k]`.

7. **Threads, channels and maps.**

   - A counted argument to a `Sending<T>` parameter of a declared function is
     passed as `__countedRef(E)`. Those functions are `spawn`, `s.spawn`, `go`,
     a channel's `send` and a SharedMap's `set`.
   - A channel's `send` also moves the value. Using the variable afterwards, or
     a local alias of it, is an error.
   - A rest parameter shares the value instead. That covers a thread's
     arguments, so one SharedArray can go to every thread. It also covers a
     SharedMap's or SharedSet's entry (`set(...entry)`), so a struct stays the
     caller's.
   - A callback whose type in the runtime has a `Sending` result
     (getOrInsertComputed's) returns a counted value as `__moved(E)`, with its
     count.
   - A map or set holds a count on each counted key and value. It defers the
     decrement of one it drops, and releases the rest when it's freed.
   - A `for...of` over a channel owns each value and releases it at the end of
     the iteration.
   - `select` over channels of counted values is rejected, because nothing could
     count the values in the tuple it returns.

8. **Closures.** A closure that captures counted variables is wrapped as
   `__capture(fn, x, y)`. A counted variable that a closure captures can't be
   reassigned. Registering the closure has a cost (see [Limits](#limits)), so
   the runtime's API avoids callbacks where it can. For example, `Lock.hold()`
   returns a Disposable for `using` rather than taking a function.

9. **null.** In raw positions, null and undefined are 0, and `x === null`
   becomes `x === 0`.

10. **Quiescent points in loops.** A loop whose body reads or stores a reference
    field ends each iteration with `__quiescent()`. That way neither a writer
    nor a long-running reader holds up freeing.

11. **Ordinary containers.** A raw address stored in a JS array or object is
    invisible to counting. The checker rejects the forms it can see: literals,
    element and property stores, destructuring, and `for...of` over such a
    container. It can't see a store made by a generic call, such as
    `list.push(node)`, or `map.set(k, node)` on a JS Map. That's still a hole,
    which we mean to close by boxing at generic boundaries or by rejecting such
    calls. A SharedMap or SharedSet is the container that counts (see rule 7).

12. **Strings.** An interned string is counted the same way a struct is, by what
    holds its address:

    - a `str` field or a `SharedArray<string>` element. `e.f = s` becomes
      `__storeStr(i, s)`, which leaves the counts alone when the field holds s
      already.
    - a map's key or value.
    - a message. A message counts its strings and its objects' keys, and gives
      them back once it's read. A shared value keeps them.

    Compiled code reads a string field as a JS string (`__strAt(__I32[i])`). It
    holds no string's address beyond a runtime call, so a string's decrement
    doesn't need to wait for a quiescent point.

    When a string's count reaches 0, it leaves the table at once, so no lookup
    finds it again. Its block is freed a grace period later, because a lookup on
    another thread may have found it just before. Each string has a serial, so
    that a thread's caches (string to address, and address to string) never take
    a reused address for the string that left it. The runtime's own strings,
    such as struct layouts and the message for a full heap, are pinned and stay.

## Limits

Reference counting here has real limits. Here's what to keep in mind:

- **Cycles leak.** A cycle of reference fields keeps its counts above 0. A
  backup collector (trial deletion at quiescent points) or a rule against
  recursive struct types would close this.
- **Handles and closures are released late, or not at all in Node.** The same
  goes for a thread that's never joined, and its result. They go once the
  thread's `Thread` is collected.
  - A FinalizationRegistry runs only after V8 collects the handle, and only when
    the worker's event loop gets a turn. A pool worker that has handles to
    finalize gives it a turn after each thread. While idle, it gives one 50 ms
    later, then twice as long after each turn that finalized nothing, up to a
    second.
  - A WeakRef keeps its target alive until the end of the task that made it, so
    handles made in a long thread outlive it into V8's old generation. Chrome's
    workers collect those: 200,000 handle-held nodes were freed within a second
    of the thread ending. Node's idle workers run no major GC, so there they
    stay.
  - Compiled code counts without handles. Handles are only for `any`, `unknown`
    and uncompiled code.
- **Exceptions.** `finally` releases owned locals, but owned temporaries in a
  statement that throws leak.
- **Races are the program's to avoid.** A channel's `send` moves a value, but
  the move check doesn't follow aliases through reference fields or calls. And
  threads that share a SharedArray (as N-body's do) can write the same element.
  Counting stays sound either way, because it only decides when a block is
  freed.
