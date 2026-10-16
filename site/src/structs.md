---
title: Structs
description:
  'A struct is a class with a different construction: fixed-layout, sealed, made
  in one shot, with methods that check their receiver.'
---

A `struct` is a class with a different construction. The compiler keeps the
class, which gives the struct its scope, private names and static elements. It
moves the fields and the constructor into the runtime's hands
([src/runtime/structs.ts](https://github.com/arv/threads/blob/tc39-proposal/src/runtime/structs.ts)
shows the shape). An instance is made the spec's way (§1.1.6):

1. All of its fields, the base struct's first, are defined as `undefined`, and
   it is sealed.
2. The field initializers run, from the base struct down.
3. The `constructor` runs. It is an initializer, and `super(...)` calls the
   parent struct's initializer.

Instance methods check that `this` is an instance of their struct (struct method
exotic objects, §1.2). Constructing anything but the struct itself is a
TypeError, so a class cannot extend a struct.

::: note No constructor, no initializer
A struct with no `constructor` has no initializer, so its parent's initializer
doesn't run. That's the spec's behavior. Classes do the opposite.
:::
