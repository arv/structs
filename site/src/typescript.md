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
plain object still works. On
[examples/nbody](https://github.com/arv/threads/tree/tc39-proposal/examples/nbody)
(1,000,000 steps, Node 24, Apple Silicon) this takes 2.5 s against the Proxy's
5.0 s. Plain JavaScript objects take about 0.07 s. Closing that gap means
letting compiled code hold heap addresses instead of Proxies, as the compiler on
`main` does.

The code is in
[src/compiler/project.ts](https://github.com/arv/threads/blob/tc39-proposal/src/compiler/project.ts)
(the type check) and
[src/compiler/fast.ts](https://github.com/arv/threads/blob/tc39-proposal/src/compiler/fast.ts)
(the direct access).
