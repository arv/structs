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

On [examples/nbody](https://github.com/arv/structs/tree/main/examples/nbody)
(1,000,000 steps, Node 24, Apple Silicon), which keeps its bodies in a
`SharedArray<Body>`, this takes 0.14 s. The same program on plain JavaScript
objects takes 0.045 s, and through the Proxy alone 7.5 s. Most of what is left
is the check of each slot's tag: a field may hold any shareable value, so a read
checks that it holds a Number.

The code is in
[src/compiler/project.ts](https://github.com/arv/structs/blob/main/src/compiler/project.ts)
(the type check) and
[src/compiler/fast.ts](https://github.com/arv/structs/blob/main/src/compiler/fast.ts)
(the direct access).
