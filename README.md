# @arv/structs

An implementation of the TC39
[structs proposal](https://tc39.es/proposal-structs/) (Stage 2, the December
2024 draft) for JavaScript today: structs, shared structs, Shared Arrays,
`Atomics.Mutex` and `Atomics.Condition`. It has a runtime that follows the
spec's algorithms, and a compiler for the proposal's syntax. In TypeScript, the
compiler also uses the types to make shared struct field access direct.

```js
shared struct Counter {
  count = 0;
  lock = new Atomics.Mutex();
}

const counter = new Counter();
worker.postMessage(counter); // the same object in the worker, not a copy

// in any agent:
{
  using _ = Atomics.Mutex.lock(counter.lock);
  counter.count++;
}
```

You can write programs and run them in your browser, with the compiled
JavaScript side by side, in [the playground](playground).

> **Status: experimental.** This grew out of
> [arv/threads](https://github.com/arv/threads), as something much smaller that
> stays as close to the spec as JavaScript allows. See
> [Where it differs](#where-it-differs-from-the-spec).

## What's in it

| Spec                              | Here                                                             |
| --------------------------------- | ---------------------------------------------------------------- |
| §1 `struct` declarations          | The compiler lowers them to classes that call the runtime        |
| §2 `shared struct` declarations   | Proxies over one `SharedArrayBuffer`, the heap                   |
| §2.3 `Atomics` on struct fields   | `load`, `store`, `exchange` and `compareExchange` take a struct  |
| §2.4 `Reflect.canBeShared`        | Installed on `Reflect`                                           |
| §3 `SharedArray`                  | A global: a Shared Struct with indexed fields and a fixed length |
| §4 `Atomics.Mutex`, `UnlockToken` | Futex-style locks on heap words; tokens work with `using`        |
| §4 `Atomics.Condition`            | `wait`, `waitFor` (with a timeout and a predicate), `notify`     |

Importing `@arv/structs` installs the globals. The compiler's output imports
`@arv/structs/runtime`, which does it too.

## Installing it

There are two packages: the runtime, and the compiler for the proposal's syntax,
which you need only to build or run code that has it.

```bash
npm install @arv/structs
```

```bash
npm install --save-dev @arv/structs-compiler
```

## Running it

In Node, the compiler's load hook compiles struct syntax as modules load, in
workers too:

```bash
node --import @arv/structs-compiler/register main.js
```

The `structs` command compiles a single file, or a whole TypeScript project with
type checking:

```bash
npx structs transpile main.js
```

```bash
npx structs compile -p tsconfig.json
```

From code, use `transpile(source, {fileName})` and `compile(tsconfigPath)` from
`@arv/structs-compiler`.

### Agents

The proposal leaves sharing across agents to the host. `@arv/structs/agent`
starts workers that attach to the same heap: `worker_threads` in Node, module
Web Workers in a browser. Messages sent through it carry shared objects as
themselves, and everything else as `postMessage` copies it.

```js
// main.js
import {startWorker} from '@arv/structs/agent';
const w = startWorker(new URL('./worker.js', import.meta.url));
w.postMessage({tally, n: 1000});

// worker.js
import {parent} from '@arv/structs/agent';
parent.onmessage = ({tally, n}) => {
  /* tally is the main thread's struct */
};
```

`run(url, name, ...args)` calls the function a module exports as `name` on a
worker and settles with what it returns. A module can run its own functions with
`run(import.meta.url, ...)`. The workers are a pool: one that returns waits for
the next call, with the code V8 has optimized in it, so a program that runs its
work again finds its workers warm. Each worker imports the module, so its
top-level code runs there too: keep what only the main thread does in a
function, or behind `if (!parent)`.

[examples/counter](examples/counter) has four workers counting to a million
under a Mutex, with a Condition saying when they are done.

## How it works

### Structs

A `struct` is a class with a different construction. The compiler keeps the
class, which gives the struct its scope, private names and static elements. It
moves the fields and the constructor into the runtime's hands
([src/runtime/structs.ts](src/runtime/structs.ts) shows the shape). An instance
is made the spec's way (§1.1.6):

1. All of its fields, the base struct's first, are defined as `undefined`, and
   it is sealed.
2. The field initializers run, from the base struct down.
3. The `constructor` runs. It is an initializer, and `super(...)` calls the
   parent struct's initializer.

Instance methods check that `this` is an instance of their struct (struct method
exotic objects, §1.2), and so do getters and setters here. Constructing anything
but the struct itself is a TypeError, so a class cannot extend a struct.

### Shared structs

Every agent attaches to one `SharedArrayBuffer` of a fixed size (256 MB, which
is reserved rather than used up front). A Shared Struct is a block in it with a
slot per field. Each agent sees the block through a Proxy whose traps are the
spec's internal methods (§2.1.5 to §2.1.10). There is one Proxy per block per
agent, so `===` holds.

```
a shared object  [kind][shape: its keys, interned][..][..] then 16 bytes per field
a slot           [a tagged word: the value][a Float64, for a Number]
```

A field holds `undefined`, `null`, a boolean, a Number, a string (interned in
the heap), a BigInt, a registered or well-known symbol, or another shared
object. Anything else is a TypeError (`CanBeSharedAcrossAgents`, §2.2.4). A read
never tears: a Number's Float64 is written before its word, and the word is
stored atomically.

A field declared `: number` in TypeScript (not `x?: number`, which may hold
`undefined`) is typed. Its word says Number from the moment the struct is made
and never changes, so the Float64 alone is its value, and writing it anything
but a Number is a TypeError, from compiled code, plain JavaScript,
`Object.defineProperty` and `Atomics` alike. The compiler passes the types to
the runtime (`{key: 'x', value: 0, number: true}`), and they are part of the
struct's shape: two structs with the same keys typed differently have different
shapes. A key is typed only if every declaration of it in the struct and its
parents says `number`.

Mutex and Condition are Shared Structs with no fields. Their internal slots are
heap words that `Atomics.wait` and `Atomics.notify` work on. Blocking where an
agent cannot (a browser's main thread) is a TypeError, as the spec says
(`AgentCanSuspend`).

### Mutex and Condition

`Atomics.Mutex` and `Atomics.Condition` are shared structs with no fields, so
they can be stored in another shared struct's fields and sent to workers. A lock
gives an `UnlockToken`, which `using` unlocks at the end of its block. A
Condition waits with that token: it unlocks the Mutex while it waits and locks
it again before it returns.

```js
shared struct Queue {
  items = new SharedArray(16);
  size = 0;
  lock = new Atomics.Mutex();
  changed = new Atomics.Condition();
}

// on a worker: wait until there is something to take
{
  using token = Atomics.Mutex.lock(queue.lock);
  Atomics.Condition.waitFor(queue.changed, token, Infinity, () => queue.size > 0);
  // take an item, then tell the others
  Atomics.Condition.notify(queue.changed);
}
```

### TypeScript

`compile` type checks a project as TypeScript sees it with each struct spelled
as a class. It drops the errors that hold for a class but not for a struct, such
as a derived constructor without `super()`. Then, where the checker proves an
expression is an instance of a shared struct whose fields are all known, `o.x`
and `o.x = v` skip the Proxy:

```js
const dx = a.x - b.x;
// compiles to
const dx = $struct.getNumber(a, $L0, 0) - $struct.getNumber(b, $L0, 0);
```

The types are not trusted. The runtime checks that the object is a Shared Struct
with that layout, and reads it through the Proxy if not, so a structurally typed
plain object still works.

Compiled code holds heap addresses rather than Proxies where it can. A binding
that keeps its value (a `const`, or a `let` or a parameter that is never
assigned) is checked once, beside the binding. A struct taken from a
`SharedArray<S>` element or from a struct-typed field is the address that slot
already holds, read without making its Proxy at all; the binding itself is made
only on the slow path. Each function keeps the heap's views in locals, since the
heap's size is fixed:

```js
const b = bodies[j];
const bx = b.x;
// compiles to: b's address from bodies' slot, then the Float64 if it holds a Number
const $a1 = $struct.elem($a0, j, $L0),
  b = $a1 < 0 ? bodies[j] : undefined;
const bx =
  $a1 < 0 || $I[($a1 >> 2) + 4] !== 1
    ? $struct.getNumberAt(b, $a1, $L0, 0)
    : $F[($a1 >> 3) + 3];
```

A field declared `: number` always holds a Number (see
[Shared structs](#shared-structs)), so its word isn't read: `b.x` is
`$a1 < 0 ? $struct.getAt(b, $a1, $L0, 0) : $F[($a1 >> 3) + 3]`, and `b.x = v`
writes the Float64 if `v` is a Number and calls the runtime, which throws, if
not.

Compound assignments and updates (`o.x += v`, `o.x ??= v`, `o.x++`,
`--arr[i].y`) read and write the slot the same way. The receiver, and an
element's index, are evaluated once, into locals. The new value is computed with
the operator as written, so a string concatenation or a bigint field works as
through the Proxy, a postfix update's value is the old one after ToNumeric, and
`&&=`, `||=` and `??=` write nothing when they short-circuit:

```js
counter.count += n;
// compiles to: the slot read, the operator applied, the slot written
$t0 =
  ($a0 < 0 || $I[($a0 >> 2) + 4] !== 1
    ? $struct.getNumberAt(counter, $a0, $L0, 0)
    : $F[($a0 >> 3) + 3]) + n;
$a0 < 0 || typeof $t0 !== 'number' || $I[($a0 >> 2) + 4] !== 1
  ? $struct.setAt(counter, $a0, $L0, 0, $t0)
  : ($F[($a0 >> 3) + 3] = $t0);
```

On [examples/nbody](examples/nbody) (1,000,000 steps, Node 24, Apple Silicon),
which keeps its bodies in a `SharedArray<Body>` and declares their fields
`: number`, this takes 0.10 s (0.13 s with the fields untyped, when each read
checks its slot's tag). The same program on plain JavaScript objects takes 0.045
s, and through the Proxy alone 7 s. Most of what is left is finding each body's
address in the array and checking that it is a Body. A `counter.count++` loop
does 10,000,000 increments in 18 ms, against 360 ms through the Proxy.

## Where it differs from the spec

Where JavaScript can't do what the spec says, or where the spec text looks like
an oversight, this implementation does something else:

- **Memory is never reclaimed.** Shared objects and interned strings live until
  the process ends. There is no collector across agents.
- **Symbols.** Only registered (`Symbol.for`) and well-known symbols can be
  shared, as values or as field keys, because other agents don't have the
  others. `Reflect.canBeShared` returns false for the rest.
- **`[[GetOwnProperty]]` reports shared fields as writable.** The spec says not
  writable, but its own `[[DefineOwnProperty]]` asserts writable, and a Proxy
  can't report a writable target property as non-writable.
- **Constructors are classes.** A shared struct's constructor has a `prototype`
  object (with a null prototype; its instances still have none). A struct with
  no `extends` has a hidden root function as its constructor's `[[Prototype]]`,
  not `Function.prototype`.
- **Arguments.** The spec evaluates the arguments of `new S(...)` and of
  `super(...)` but never passes them to the initializer. Here they are passed.
- **Methods are methods.** The spec wraps each instance method in a struct
  method exotic object, which checks `this` and has no own properties. Here the
  check is the method's first statement, so it keeps its `name` and `length`. A
  method whose parameters run code (a default, a destructuring) is called
  through another that checks first.
- **Getters and setters check `this` too.** The spec checks only methods: its
  `DefineMethod` makes no struct method of an accessor. Here an instance getter
  or setter throws a TypeError on what is not an instance of its struct, as a
  method does.
- **Static methods are not brand-checked.** The spec's `DefineMethod` would wrap
  them too, which would make them impossible to call.
- **`super.x` in a shared struct's initializers** looks at the parent
  constructor. In the spec their home object is null, and `super.x` throws.
- **Mutexes aren't fair.** A woken waiter competes with newcomers, where the
  spec has a waiter queue.
- **Fields declared `: number` only hold Numbers.** The spec's fields are
  untyped. Here a shared struct field declared `: number` in TypeScript is typed
  (see [Shared structs](#shared-structs)): writing it anything but a Number
  throws a TypeError rather than coercing, which would hide the mistake (`"1"`,
  `undefined`), and before its initializer runs it holds 0, not `undefined`.

A behavior that is the spec's but may surprise: a struct with no `constructor`
has no initializer, so its parent's initializer doesn't run. Classes do the
opposite.

Node's `console.log` shows a Proxy's target, so it prints a shared struct's
fields as `undefined`. Spread it instead: `console.log({...s})`.

## Layout

| Path                                                   | What it is                                               |
| ------------------------------------------------------ | -------------------------------------------------------- |
| [src/runtime/heap.ts](src/runtime/heap.ts)             | The heap: allocation, locks, interned strings            |
| [src/runtime/shared.ts](src/runtime/shared.ts)         | Shared Structs and Shared Arrays: slots, shapes, Proxies |
| [src/runtime/structs.ts](src/runtime/structs.ts)       | What struct declarations become                          |
| [src/runtime/sync.ts](src/runtime/sync.ts)             | Mutex, UnlockToken, Condition                            |
| [src/runtime/atomics.ts](src/runtime/atomics.ts)       | The Atomics overloads, `Reflect.canBeShared`             |
| [src/runtime/agent.ts](src/runtime/agent.ts)           | Workers on the same heap, messages with shared objects   |
| [src/runtime/emit.ts](src/runtime/emit.ts)             | What compiled code imports                               |
| [src/compiler/scan.ts](src/compiler/scan.ts)           | Finds struct declarations and spells them as classes     |
| [src/compiler/transform.ts](src/compiler/transform.ts) | Lowers them                                              |
| [src/compiler/project.ts](src/compiler/project.ts)     | TypeScript projects: type checking                       |
| [src/compiler/fast.ts](src/compiler/fast.ts)           | Direct field access where the types allow it             |
| [src/compiler/register.ts](src/compiler/register.ts)   | Node's load hook                                         |
| [playground/](playground)                              | The playground: edit, compile and run in the browser     |
| [site/](site)                                          | These docs as a site, built by Eleventy                  |

The compiler parses with TypeScript 7's API (the same parser in both modes),
edits with magic-string, and strips types with OXC.

## Development

The repository is a pnpm workspace on [Vite+](https://viteplus.dev) (`vp`): the
runtime at the root, the compiler in [src/compiler/](src/compiler), the
playground and these docs in folders of their own.

```bash
git clone https://github.com/arv/structs.git
```

```bash
cd structs && pnpm install
```

```bash
vp check
```

```bash
vp test
```

`vp check` formats, lints and type checks. `vp test` runs the tests in
[test/](test), including workers that share the heap. `vp run test-pack` packs
both packages, installs them with npm in a project of its own, and uses them
there. The examples run from the repository with the load hook's source:

```bash
node --import ./src/compiler/register.ts examples/counter/main.js
```

Pushing a version tag (`v0.1.0`) publishes both packages to npm
([release.yml](.github/workflows/release.yml)).

> **Disclaimer:** This project was mostly built by iterating with the help of
> Claude Code (Claude Opus 5.5).

## License

Apache-2.0
