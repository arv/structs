---
title: Differences from the Spec
description:
  Where JavaScript can't do what the spec says, or where the spec text looks
  like an oversight, and what this implementation does instead.
---

Where JavaScript can't do what the spec says, or where the spec text looks like
an oversight, this implementation does something else:

- **Memory comes back between turns.** A shared object is freed once no agent
  can reach it, but only after each agent that had a Proxy on it has returned to
  its event loop and collected the Proxy. Interned strings (and so shapes,
  BigInts and symbols) are never freed. A browser does not say when a worker
  ends, so what a worker held there stays held.
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
  (see [Shared structs](/shared-structs/)): writing it anything but a Number
  throws a TypeError rather than coercing, which would hide the mistake (`"1"`,
  `undefined`), and before its initializer runs it holds 0, not `undefined`.

::: note Logging a shared struct in Node
Node's `console.log` shows a Proxy's target, so it prints a shared struct's
fields as `undefined`. Spread it instead: `console.log({...s})`.
:::
