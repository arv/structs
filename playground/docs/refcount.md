# Reference counting for shared structs

> Status: a prototype, in the runtime (own.mjs, runtime.mjs) and the tsgo fork's emit;
> [refcount.mts](refcount.mts) tests it, and [refcount-hand.mjs](refcount-hand.mjs) is the same test
> written by hand. Shared structs and SharedArrays are freed when nothing refers to them; other cells
> (`Barrier`, `Slots`) and moved or shared values are still never freed.

A shared struct or SharedArray is an address in the shared heap, passed around as a plain number, so
V8's collector cannot see who holds one. Each block counts its references instead: references
stored in the shared heap (reference fields), and references threads hold (locals, handles, a
spawned thread's arguments). The compiler emits the increments and decrements; numeric code
emits none, because borrowed addresses are not counted.

## Layout

| Block | Words (i32) |
|---|---|
| struct | `[kind][count]`, then field k in slot k (8 bytes at byte 8 + 8k) |
| SharedArray | `[kind = 23][length][element size][count]`, then the elements from byte 16 |
| struct element of a SharedArray | `[kind][back]`: back = the array's address minus the element's (negative); the element's lifetime is its array's |

A number field is an f64 (`__F64[(p >> 3) + 1 + k]`). A reference field (a struct or SharedArray,
or either with `| null`) is an i32 address in the low half of its slot (`__I32[(p >> 2) + 2 + 2 * k]`),
0 for null. Retaining or releasing an element counts its array.

## The race, and deferred decrements

Counting alone is not safe across threads: thread A reads `p.child`, thread B overwrites `p.child`
and drops the old child's count to 0 and frees it, then A increments a freed block. So the
decrement of a field's old value, when the field is overwritten, is deferred until every thread has
passed a **quiescent point** since. A thread at a quiescent point holds no uncounted address it read
from a field. Every other increment and decrement is immediate. When a count reaches 0, no field
refers to the block (pending decrements still count), and every thread that read it from a field
has passed a quiescent point since, so no thread holds an uncounted address of the block or of
anything it read through it. The block is freed at once, and its reference fields are released at
once, so a list of any length is freed in one pass. No block is ever revived.

Quiescent points are `Barrier.wait`, `spawn`, `join`, the end of a `scope`, a thread's start and
end, and `__quiescent()`, which the compiler puts at the end of each iteration of a loop that
reads or stores a reference field (an atomic load and store; numeric loops get none). A thread blocked in a wait counts as quiescent throughout. A thread that
runs long without one delays reclaiming (memory grows), never correctness.

This is quiescent-state-based reclamation: a global epoch, and a word per thread with the epoch
it last saw at a quiescent point.

## Runtime (own.mjs)

| Function | Does |
|---|---|
| `__sharedStruct(name, fields, refs)` | `refs`: the indexes of the reference fields |
| `__newStruct(T)`, `__newSharedArray(T, n)` | a zeroed block with count 1, owned by the caller |
| `__retain(p)` | +1, returns p; nothing for 0 |
| `__release(p)` | −1, frees at 0 and releases its reference fields; nothing for 0 |
| `__store(i, v)` | a reference store at i32 index i: takes over v's count, defers the old value's decrement, returns v |
| `__ref(v)` | a counted argument to `spawn`, `go` or a channel's `send`: retains v for the thread, which releases it when its function returns, or for the message, whose receiver owns it |
| `__quiescent()` | a quiescent point |
| `__box(p)` | this thread's handle for p, which holds a count of its own; a FinalizationRegistry releases it when the handle is collected |
| `__unbox(v)` | the handle's address, borrowed |
| `__hold(fn, ...ps)` | retains each address for a closure that captures them; released when the closure is collected |
| `__heapStats()` | heap bytes in use, blocks allocated and freed, decrements pending |

Freed blocks go to free lists by size (a per-thread cache over global lists), and allocation takes
from them before bumping. Large blocks are reused only at the same size.

## What the compiler emits

Every expression of a counted type (a struct or SharedArray, possibly `| null`) is one of:

- **owned (+1)**: `new S()`, `new SharedArray(...)`, `__retain(E)`, a call to a function compiled
  here whose declared return type is counted, and a call to a declared function whose result is
  `Sending<T>` (a channel's `recv()`, `join()`);
- **a stable borrow**: a parameter, a counted local that is never reassigned, `A[i]` where A is a
  stable borrow, `__unbox(v)`;
- **an unstable borrow**: a reference field read `e.f`, `A[i]` where A is one, and the result of any
  other call (a generic or declared function adds no count). It is valid only until the thread's
  next quiescent point, so it is never held across a call.

Rules:

1. **Locals.** A `const` (or a `let` never reassigned) initialized from a stable borrow is a
   borrowed local: no counting. Every other counted local is owned: initialized with `E` if
   owned, else `__retain(E)`, and released when its block ends on every path, as
   `try { ... } finally { __release(x) }` around the block. Reassignment retains the new value
   before releasing the old. A parameter that is reassigned is an owned local too, retained on
   entry, and so is every counted parameter of an async function, which outlives its caller's
   borrow. A generator cannot take a counted parameter.
2. **Results.** A function returns +1: `return E` is `return __retain(E)` for a borrow, and an owned
   local's count moves out (the local is zeroed so the `finally` releases nothing), unless a
   closure captures it.
3. **Temporaries.** An owned value not bound to a local (an argument, `f().x`, a statement `f();`)
   is released after its statement.
4. **Arguments.** Parameters borrow. An unstable borrow passed to a function is retained around the
   call (the callee may reach a quiescent point); helpers and intrinsics need none.
5. **Field stores.** `e.f = E` is `__store((e >> 2) + 2 + 2k, E')`, where E' is E if owned, else
   `__retain(E)`. If `e` is an unstable borrow and E contains a call, `e` is retained first.
6. **Field reads.** `e.f` is `__I32[(e >> 2) + 2 + 2k]`.
7. **Threads and channels.** A counted argument to a `Sending<T>` parameter of a declared function
   (`spawn`, `s.spawn`, `go`, a channel's `send`) is passed as `__ref(E)`. A channel's `send` also
   moves it: using the variable, or a local alias of it, afterwards is an error. A thread's
   arguments share it instead, so one SharedArray can go to every thread. A `for...of` over a
   channel owns each value and releases it at the end of the iteration. `select` over channels of
   counted values is rejected: nothing could count the values in the tuple it returns.
8. **Closures.** A closure that captures counted variables is wrapped: `__hold(fn, x, y)`. A counted
   variable captured by a closure cannot be reassigned.
9. **null.** In raw positions null and undefined are 0, and `x === null` is `x === 0`.
10. **Quiescent points in loops.** A loop whose body reads or stores a reference field ends each
    iteration with `__quiescent()`, so neither a writer nor a long-running reader holds up freeing.
11. **Ordinary containers.** A raw address stored in a JS array or object is invisible to counting;
    the checker rejects literals, element and property stores, destructuring and for-of over them.
    It cannot see a store made by a generic call (`list.push(node)`, `map.set(k, node)`): that is
    still a hole, to be closed by boxing at generic boundaries or rejecting such calls.

## Limits

- **Cycles leak.** A cycle of reference fields keeps its counts above 0. A backup collector (trial
  deletion at quiescent points) or a rule against recursive struct types would close it.
- **Handles and closures are released late, or not at all in node.** A FinalizationRegistry runs
  only after V8 collects the handle, and only when the worker's event loop gets a turn: a pool
  worker that has handles to finalize waits for work asynchronously. A WeakRef keeps its target
  alive until the end of the task that made it, so handles made in a long thread outlive it into
  V8's old generation. Chrome's workers collect those: 200,000 handle-held nodes were freed within
  a second of the thread ending. Node's idle workers run no major GC, so there they stay.
  Compiled code counts with no handles; handles are only for `any`, `unknown` and uncompiled code.
- **Exceptions.** `finally` releases owned locals; owned temporaries in a statement that throws leak.
- **Races are the program's to avoid.** A channel's `send` moves a value, but the move check does not
  follow aliases through reference fields or calls, and threads that share a SharedArray (as
  N-body's do) can write the same element. Counting stays sound either way: it only decides when a
  block is freed.
