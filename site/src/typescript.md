---
title: TypeScript
description:
  Projects type checked with each struct seen as a class, and shared struct
  field access made direct where the types prove the layout.
---

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
[Shared structs](/shared-structs/)), so its word isn't read: `b.x` is
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

On [examples/nbody](https://github.com/arv/structs/tree/main/examples/nbody)
(1,000,000 steps, Node 24, Apple Silicon), which keeps its bodies in a
`SharedArray<Body>` and declares their fields `: number`, this takes 0.10 s
(0.13 s with the fields untyped, when each read checks its slot's tag). The same
program on plain JavaScript objects takes 0.045 s, and through the Proxy alone 7
s. Most of what is left is finding each body's address in the array and checking
that it is a Body. A `counter.count++` loop does 10,000,000 increments in 18 ms,
against 360 ms through the Proxy.

The code is in
[src/compiler/project.ts](https://github.com/arv/structs/blob/main/src/compiler/project.ts)
(the type check) and
[src/compiler/fast.ts](https://github.com/arv/structs/blob/main/src/compiler/fast.ts)
(the direct access).
