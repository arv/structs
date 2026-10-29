# Shared structs as shared Wasm GC structs?

An experiment, not a change to the runtime. Thomas Lively asked whether lowering
shared structs to shared Wasm GC structs (the
[shared-everything threads proposal](https://github.com/WebAssembly/shared-everything-threads),
in V8 behind a flag) would beat our SharedArrayBuffer heap. He added that V8
inlines simple struct accessors into JS, though he wasn't sure that works for
shared structs yet. This directory answers both with numbers.

**Short answer:** a shared Wasm struct is fast when Wasm code touches it: n-body
written entirely in Wasm on shared structs runs 1M steps in 38 ms, against 104
ms for our compiled fast path and 42 ms for plain JS. But our compiler emits
JavaScript, and from JavaScript every field access is a call into Wasm. V8 does
not inline that call for shared types yet, so the same n-body with JS calling
the accessors takes 1.2 to 3.5 s, 11 to 33 times slower than what we have.
**Recommendation: wait for V8.** Keep the SharedArrayBuffer heap. Look again
once V8 inlines JS-to-Wasm calls on shared types, fixes the cross-thread
`ref.cast` bug below, and ships the feature without a flag.

## Setup

- Apple M5 Pro (18 cores, 6 of them performance cores), macOS 26.7.1.
- **Node 26.12.1 (V8 14.6.202.34)**, the official
  `node-v26.12.1-darwin-arm64.tar.gz` from nodejs.org (SHA-256 checked), with
  `--experimental-wasm-shared`. V8 has no `--wasm-shared` flag under that name,
  in any engine tried. All the numbers below are from this engine unless marked
  otherwise.
- Also tried:
  - **Node 24.18.0 (V8 13.6.233.17)**: it accepts the flag, but its validator
    rejects `array.len` on a shared array and `any.convert_extern` on a shared
    externref ("expected type externref, found ... shared externref"). It also
    can't `postMessage` a shared Wasm struct ("could not be cloned"). It does
    convey V8's own JS shared structs (`SharedStructType`, under
    `--harmony-struct`).
  - **Deno 2.9.0 (V8 14.9.207.2)**: the module compiles and runs, but Deno's
    `postMessage` (Web Workers and `node:worker_threads` both) throws "shared
    value could not be cloned" for every shared value. That includes JS shared
    structs: Deno has no shared-value conveyor.
  - Chrome 156 is installed but wasn't needed once Node 26 worked.
- No toolchain was installed here (no wasm-tools, wabt or Binaryen), so
  [body-module.js](body-module.js) writes the binary itself. Binaryen fully
  supports shared types (per Thomas Lively), so a re-run could use it instead.
  It holds the `Body` struct (seven `mut f64` fields) and a `Bodies` array of
  `(ref null Body)`. Both are shared (the `0x65` prefix on the composite type)
  or not, so each variant differs from its control by sharedness alone. The
  exports are allocation, accessors, and n-body's `advance`, `energy` and
  `accelerate` in Wasm.

To reproduce, from the repository root:

```sh
NODE=/path/to/node-v26.12.1-darwin-arm64/bin/node sh experiments/wasm-shared/run.sh
```

[run.sh](run.sh) compiles the TypeScript in [ts/](ts/) with `structs compile`,
with and without the fast path, and runs everything. The raw output of three
Node 26 runs and one Node 24 run is in [results/](results/). The tables give the
median of the three Node 26 runs.

## Do they really cross agents?

Yes, on Node 26 ([share.js](share.js)). Main allocates a `Body` and a `Bodies`
array and posts both to a `worker_threads` worker.

- The worker reads main's write, and `bodies_get(bodies, 0) === body` holds in
  the worker.
- Main sees the worker's write. The body the worker posts back is `===` the one
  main sent.
- A worker spinning on `get_z(body) === 0` sees main's `set_z` with no message
  in between.
- A JS string stored by main in a shared struct's `(ref null (shared extern))`
  field reads back as that string in the worker, and the other way round.

**V8 bug:** in the worker, any `ref.cast` to `Body` fails with "illegal cast"
when main allocated the struct. That covers `any.convert_extern` + `ref.cast`,
or `ref.cast` from `(shared any)`. The same cast succeeds on main, and between
two instances on one thread. The JS-to-Wasm boundary check on a typed
`(ref null $Body)` parameter accepts the same object in the worker. So the check
inside Wasm seems to compare per-isolate type data, while the boundary check
compares canonical types. This bug is what rules out the inlinable accessors in
workers (next section). Thomas Lively reports it is fixed in upstream V8, after
14.6.

## Inlining: the open question

[inline.js](inline.js) times 10M calls from a hot JS loop to each accessor (ns
per call):

| accessor signature                                             | unshared types |            shared types |
| -------------------------------------------------------------- | -------------: | ----------------------: |
| `add1(f64) -> f64` (a control with no references)              |            1.2 |                     1.3 |
| `get_x((ref null $Body)) -> f64`                               |            9.0 |                     9.0 |
| `any_get_x(anyref) -> f64` + `ref.cast`                        |            8.4 |                     8.9 |
| `xget_x(externref) -> f64` + `any.convert_extern` + `ref.cast` |        **1.0** | 3.8 (`(shared extern)`) |

`--trace-turbo-inlining --trace-wasm-inlining` shows why. V8 inlines a
JS-to-Wasm call only when the signature has nothing but numbers and externrefs.
A typed struct reference, or `anyref`, gets a call through the wrapper (about 9
ns, shared or not). With `externref`, TurboFan inlines the wrapper, and for
unshared types Turboshaft inlines the body too ("Considering wasm function [N]
... - inlining"): the accessor ends up as fast as plain JS. With
`(shared extern)`, V8 never considers the body for inlining. It is faster than a
typed reference (3.8 ns) but still a call. **So Thomas's suspicion holds: in V8
14.6, simple struct accessors inline into JS for unshared structs but not for
shared ones.** (`--turboshaft-wasm-in-js-inlining` together with
`--turbolev-inline-js-wasm-wrappers` crashes this Node on a `v8_flags.turbolev`
check.)

## Microbenchmark

`bump`: `p.x = p.x + 1`, 10M times on one struct. `sum`: `s += a[i].x` over
1,000 structs, 10,000 times. Both in ns per operation ([micro.js](micro.js) and
[ts/micro.ts](ts/micro.ts)):

| what                                                            | bump |  sum |
| --------------------------------------------------------------- | ---: | ---: |
| plain JS object / Array                                         | 0.66 | 0.38 |
| V8's JS shared structs (`SharedStructType`, `--harmony-struct`) |  2.1 |  2.5 |
| **ours, compiled, fast path**                                   |  3.7 |  130 |
| ours, compiled, Proxy only (`--no-fast`)                        |   35 |  146 |
| Wasm GC, unshared, typed-ref accessors                          |   19 |   19 |
| Wasm GC, unshared, externref accessors (inlined)                |  3.0 | 0.76 |
| **Wasm GC, shared, typed-ref accessors**                        |   19 |   19 |
| **Wasm GC, shared, `(shared extern)` accessors**                |  7.3 |  7.1 |

On Node 24, our fast path's `bump` is 1.0 ns. It is 3.7 ns on Node 26, a
regression in the newer V8 that is worth a look apart from this experiment. Our
`sum` is slow on both: the compiler reads `a[i]` through the SharedArray's Proxy
and only then reads the field directly (`$struct.getNumber(a[i], ...)`). The
array element read isn't on the fast path.

## n-body, single-threaded

[examples/nbody](../../examples/nbody) (five bodies, 1M steps).
[nbody.js](nbody.js) runs the same arithmetic on each representation, and every
variant ends at the same energy, -0.169086185.

| what                                               |        ms |
| -------------------------------------------------- | --------: |
| plain JS objects                                   |        42 |
| **ours** (`structs compile`, fast path)            |   **104** |
| JS through typed-ref accessors, unshared           |     3,470 |
| **JS through typed-ref accessors, shared**         | **3,470** |
| JS through externref accessors, unshared (inlined) |        42 |
| **JS through `(shared extern)` accessors, shared** | **1,180** |
| `advance()` in Wasm, unshared                      |        39 |
| **`advance()` in Wasm, shared**                    |    **38** |

Two results stand out:

- **Wasm on shared structs costs nothing over unshared structs** (38 against 39
  ms), and is faster than plain JS.
- **Unshared externref accessors, inlined, match plain JS** (42 ms). If V8
  inlined `(shared extern)` accessors the same way, JS on shared Wasm structs
  would be about 2.5 times faster than our fast path. Today it is 11 times
  slower, or 33 times with typed references.

## n-body, parallel

[playground/programs/nbody-parallel.ts](../../playground/programs/nbody-parallel.ts)
(1,000 bodies, 50 steps, a barrier after each phase). The workers stay warm
between runs: `main(8)` runs once first, as in the playground. Ours is the
program compiled ([par-ours.js](par-ours.js)). The Wasm version
([par-wasm.js](par-wasm.js)) posts one shared `Bodies` array to each worker,
with a barrier of plain `Atomics` on a SharedArrayBuffer. Both end at the same
energy, -0.112525883. Times in ms, with the speedup over one worker:

| workers | ours (fast path) | shared Wasm, `accelerate` in Wasm | shared Wasm, JS via typed accessors |
| ------: | ---------------: | --------------------------------: | ----------------------------------: |
|       1 |              288 |                                65 |                               3,140 |
|       2 |      147 (1.96×) |                        34 (1.91×) |                       1,635 (1.92×) |
|       4 |       81 (3.56×) |                        18 (3.61×) |                         826 (3.80×) |
|       8 |       62 (4.65×) |                        17 (3.82×) |                         456 (6.89×) |

Shared Wasm structs scale across workers as our heap does. Past 4 workers, both
mostly measure the barrier and the 6 performance cores. The JS-through-
`(shared extern)` variant can't run in workers at all, because of the `ref.cast`
bug. Mandelbrot wasn't ported: it touches a struct once per row, so it would
measure the barrier rather than field access.

## What Wasm would replace, and what it wouldn't

| our runtime                                                      | with shared Wasm GC                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the 256 MB SharedArrayBuffer heap (`heap.ts`)                    | **gone**: V8's shared heap, no fixed size                                                                                                                                                                                                                                                                                                                                                                      |
| the cross-agent collector (`gc.ts`), pins for messages in flight | **gone**: V8 collects shared objects, and `WeakRef` / `Map` keys work on them                                                                                                                                                                                                                                                                                                                                  |
| one Proxy per address per agent, and its handle table            | **gone**: `postMessage` keeps identity (`===` both ways)                                                                                                                                                                                                                                                                                                                                                       |
| interned strings, never freed                                    | **probably gone**: JS strings fit in `(shared extern)` and cross threads (tested), and V8 collects them                                                                                                                                                                                                                                                                                                        |
| 16-byte tagged slots; untyped fields hold any shareable value    | `(shared extern)` fields take strings, numbers, null and shared objects, including `Atomics.Mutex` / `Condition` and `SharedStructType` instances. They reject plain objects (TypeError), as ours do. Numbers in an externref field are boxed, so untyped fields would still pay for that                                                                                                                      |
| `Atomics.Mutex` / `Atomics.Condition` (`sync.ts`)                | **not yet**: the proposal's `waitqueue` (`struct.wait`, `waitqueue.notify`, `WebAssembly.WaitQueue`) is absent from V8 14.6 (implemented in upstream V8 since). V8's own `Atomics.Mutex` (`--harmony-struct`) fits in a `(shared extern)` field: a second experimental flag. Untested: `struct.atomic.*` (`0xfe 0x5c`...)                                                                                      |
| shapes made at run time, by any agent                            | **awkward**: Wasm struct types are fixed per module, so each `shared struct` declaration would compile a small module at run time. Iso-recursive canonicalization makes two declarations with the same field types the _same_ type, so struct identity (`instanceof`, the spec's per-declaration types) needs a brand field                                                                                    |
| property access (`o.x`), methods, prototypes                     | **missing**: Wasm structs are opaque to JS: `b.x` is `undefined`, the prototype is `null`, and adding a property throws "WebAssembly objects are opaque". Every access needs an accessor call, so uncompiled code can't use them. The proposal's realm-local prototypes (and custom descriptors) would fix that, but V8 14.6 has neither. Custom descriptors are coming, then need to work with shared structs |
| works in today's Node 24, browsers, Deno                         | **no**: needs a flag, Node ≥ 26 for `postMessage`, nothing in Deno, and is untested in Chrome                                                                                                                                                                                                                                                                                                                  |

## Recommendation: wait for V8

Do not change the runtime now. The heap, collector, Proxy table and string
interning are the parts we'd most like to delete, and shared Wasm GC would
delete them. But in JavaScript, which is what we compile to, today's cost is 11
to 33 times our fast path on n-body. On top of that come a correctness bug in
cross-thread casts, opaque objects, and a flag. Lowering whole hot functions to
Wasm (the 38 ms row) would be a different project: a TypeScript-to-Wasm
compiler, not a lowering of field access.

What would change the answer, in order:

1. V8 inlines JS-to-Wasm calls on `(shared extern)` the way it does on
   `externref`. The unshared row says that would put JS on shared structs at
   plain-JS speed, about 2.5 times our fast path.
2. `ref.cast` works on a shared struct allocated by another thread. Fixed in
   upstream V8.
3. Realm-local prototypes on shared Wasm structs, so `o.x` works without a
   compiler. Custom descriptors will let a module install accessors on structs,
   once they work with shared structs.
4. `waitqueue` (or `Atomics.Mutex` without `--harmony-struct`), and the feature
   unflagged. Waitqueues are implemented in upstream V8.

The fixes for 2 and 4 come from Thomas Lively's
[reply to these results](https://bsky.app/profile/arv.tools/post/3myxmak7csc2z),
not from a run here. Worth re-running when Node ships a V8 that has them:
`run.sh` does it all.
