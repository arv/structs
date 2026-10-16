// What a struct declaration (§1) or a shared struct declaration (§2.2)
// evaluates to, in the code the compiler emits for it (src/compiler). The
// declaration stays a class, which keeps its scope, its private names and its
// static elements. The compiler moves the rest into a call to defineStruct or
// defineSharedStruct, the first static element:
//
//   struct S extends P {           class S extends $.structHeritage(P) {
//     x = 1;                         static { $.defineStruct(this, {
//     #y = 2;                          fields: [{key: 'x', init: o => o.#$f0()},
//     constructor(a) {                          {set: o => { o.#y = o.#$f1(); }}],
//       super(a); ...                  init: (o, a) => o.#$init(...a),
//     }                                brand: o => #$brand in o }) }
//     m() {}                         #$brand; #y;
//   }                                #$f0() { return (1); } #$f1() { return (2); }
//                                    #$init(a) { $.superInit(S, this, [a]); ... }
//                                    m() {}
//                                    constructor(...a) {
//                                      super($.beginStruct(new.target, S));
//                                      return $.endStruct(this, S, new.target, a);
//                                    }
//                                    static { $.sealStruct(this) }
//                                  }
//
// An instance is made the spec's way: its fields are all defined (undefined)
// and it is sealed before any initializer runs, then the initializers run,
// from the base struct down, then the initializer (the `constructor`). The
// class's own construction, through super(), only stamps the private names:
// those of every struct in the chain, and #$brand, which brand-checks the
// methods (StructBrands, §1.2).
//
// A shared struct's instance is a Shared Struct (shared.ts), made by
// constructSharedStruct; its declaration's class only holds the statics.

import {
  addressOf,
  create,
  HEAD,
  K_STRUCT,
  requireShareable,
  shapeFor,
  SLOT,
  write,
} from './shared.ts';
import type {Shape} from './shared.ts';

// A field (ClassFieldDefinition Record): a public one has a key, a private one
// a function that sets it to its initializer's value
export interface Field {
  key?: PropertyKey;
  // the initializer, called with the instance (absent: undefined)
  init?: (o: any) => unknown;
  // a private field's initialization: PrivateSet of its initializer's value
  set?: (o: any) => void;
}

export interface StructSpec {
  fields: Field[];
  // the initializer: the declaration's `constructor`
  init?: (o: any, args: unknown[]) => void;
  // whether an object has this struct's brand
  brand: (o: object) => boolean;
  // the declaration's name, for one with none (`export default struct {}`)
  name?: string;
}

interface Struct {
  parent: Function | null;
  // the fields, of the parents first
  chain: Field[];
  init?: (o: any, args: unknown[]) => void;
}

const structs = new WeakMap<Function, Struct>();

// [[IsStructConstructor]]
export const isStructConstructor = (f: unknown) =>
  typeof f === 'function' && structs.has(f);

// The base of a struct with no `extends`: its super() call returns the
// instance being made. Its prototype is the instances' prototype's parent.
function StructRoot(o: object) {
  return o;
}
StructRoot.prototype = Object.prototype;
// `extends null`
function NullStructRoot(o: object) {
  return o;
}
NullStructRoot.prototype = null;

// The class a struct's class extends: P checked to be a struct (§1.1.6), or
// the root.
export function structHeritage(parent?: unknown) {
  if (parent === undefined) return StructRoot;
  if (parent === null) return NullStructRoot;
  if (!isStructConstructor(parent))
    throw new TypeError('structs: a struct can only extend a struct');
  const proto = (parent as Function).prototype;
  if (proto !== null && typeof proto !== 'object')
    throw new TypeError('structs: the parent struct has no prototype');
  return parent;
}

const nameOf = (f: Function, name?: string) => {
  if (name !== undefined)
    Object.defineProperty(f, 'name', {value: name, configurable: true});
};

// The struct declared by the class `f` (its first static element).
export function defineStruct(f: Function, spec: StructSpec) {
  const parent = Object.getPrototypeOf(f);
  const up = structs.get(parent);
  structs.set(f, {
    parent: up ? parent : null,
    chain: [...(up?.chain ?? []), ...spec.fields],
    init: spec.init,
  });
  nameOf(f, spec.name);
  // the instance methods, struct method exotic objects (§1.2): they check
  // that `this` has this struct's brand. (DefineMethod wraps methods only:
  // not accessors, generators or async methods. The spec would wrap static
  // methods too, which could then never be called: they are not.)
  const proto = f.prototype;
  for (const key of Reflect.ownKeys(proto)) {
    if (key === 'constructor') continue;
    const desc = Object.getOwnPropertyDescriptor(proto, key)!;
    const m = desc.value;
    if (
      typeof m !== 'function' ||
      Object.getPrototypeOf(m) !== Function.prototype
    )
      continue;
    desc.value = structMethod(m, spec.brand);
    Object.defineProperty(proto, key, desc);
  }
}

// StructMethodCreate (§1.2.2): no own properties, its target's prototype
function structMethod(target: Function, brand: (o: object) => boolean) {
  // a method, taken off its object: it has no prototype and cannot be
  // constructed, and its `this` is the caller's
  // oxlint-disable-next-line typescript/unbound-method
  const m = {
    m(this: unknown, ...args: unknown[]) {
      if (typeof this !== 'object' || this === null || !brand(this))
        throw new TypeError(
          `structs: ${target.name || 'the method'} called on an object that is not an instance of its struct`,
        );
      return Reflect.apply(target, this, args);
    },
  }.m;
  delete (m as any).name;
  delete (m as any).length;
  return m;
}

// The class's last static element: the prototype sealed (§1.1.6).
export function sealStruct(f: Function) {
  if (f.prototype !== null) Object.seal(f.prototype);
}

// the instance whose private names are being stamped, and its NewTarget
let pending: object | null = null,
  pendingTarget: Function | null = null;

// A struct class's constructor, before its super(): the instance to stamp.
// One-shot construction: only the struct itself (NewTarget) makes an
// instance; its parents' constructors, called by super(), stamp it.
export function beginStruct(newTarget: Function | undefined, f: Function) {
  if (pending !== null && newTarget === pendingTarget) return pending;
  if (newTarget !== f)
    throw new TypeError(
      newTarget === undefined
        ? `Struct constructor ${f.name} cannot be invoked without 'new'`
        : `structs: ${f.name} cannot be subclassed by a class (a struct's NewTarget must be the struct)`,
    );
  pending = Object.create(f.prototype);
  pendingTarget = f;
  return pending!;
}

// A struct class's constructor, after its super(): the instance, made.
export function endStruct(
  o: object,
  f: Function,
  newTarget: Function,
  args: unknown[],
) {
  if (newTarget !== f) return o;
  pending = pendingTarget = null;
  const s = structs.get(f)!;
  // InitializeStructInstanceFieldsAndBrand (§1.1.3): the private names were
  // stamped by the classes, the public fields are defined here
  for (const field of s.chain)
    if (field.key !== undefined)
      Object.defineProperty(o, field.key, {
        value: undefined,
        writable: true,
        enumerable: true,
        configurable: false,
      });
  Object.preventExtensions(o);
  // RunStructInstanceFieldInitializers (§1.1.5)
  for (const field of s.chain) {
    if (field.set) field.set(o);
    else if (field.init)
      Object.defineProperty(o, field.key!, {
        value: field.init(o),
        writable: true,
        enumerable: true,
        configurable: false,
      });
  }
  if (s.init) s.init(o, args);
  return o;
}

// super(...args) in an initializer (§1.3.1): the parent's initializer, called
// on the instance. (The spec passes no arguments, but evaluates them: they are
// passed here.) In a struct with no parent there is nothing to call.
export function superInit(f: Function, o: object, args: unknown[]) {
  const parent = Object.getPrototypeOf(f);
  const up = structs.get(parent) ?? sharedStructs.get(parent);
  if (!up)
    throw new TypeError(
      `structs: super() in ${f.name}, which extends no struct`,
    );
  up.init?.(o, args);
  return undefined;
}

// ---- shared structs ----

export interface SharedStructSpec {
  // the initializers are functions called with the instance as `this`
  fields: Field[];
  // the initializer, a function: the declaration's `constructor`
  init?: Function;
  name?: string;
}

interface SharedStruct {
  chain: Field[];
  init?: (o: any, args: unknown[]) => void;
  shape: Shape;
}

const sharedStructs = new WeakMap<Function, SharedStruct>();

// [[IsSharedStructConstructor]]
export const isSharedStructConstructor = (f: unknown) =>
  typeof f === 'function' && sharedStructs.has(f);

// The class a shared struct's class extends (null when it has no `extends`:
// its instances have no prototype, §2.2.6).
export function sharedStructHeritage(parent: unknown) {
  if (parent === null) return null;
  if (!isSharedStructConstructor(parent))
    throw new TypeError(
      'structs: a shared struct can only extend a shared struct',
    );
  return parent;
}

export function defineSharedStruct(f: Function, spec: SharedStructSpec) {
  const up = sharedStructs.get(Object.getPrototypeOf(f));
  const chain = [...(up?.chain ?? []), ...spec.fields];
  const keys = [...new Set(chain.map(field => field.key!))];
  const init = spec.init;
  sharedStructs.set(f, {
    chain,
    init: init && ((o, args) => void Reflect.apply(init, o, args)),
    shape: shapeFor(keys),
  });
  nameOf(f, spec.name);
}

// A shared struct class's constructor: the Shared Struct, made (§2.2.6).
export function constructSharedStruct(
  newTarget: Function | undefined,
  f: Function,
  args: unknown[],
) {
  if (newTarget !== f)
    throw new TypeError(
      newTarget === undefined
        ? `Shared struct constructor ${f.name} cannot be invoked without 'new'`
        : `structs: ${f.name} cannot be subclassed by a class`,
    );
  const s = sharedStructs.get(f)!;
  const o = create(K_STRUCT, s.shape.addr, s.shape.keys.length);
  const a = addressOf(o)!;
  for (const field of s.chain) {
    if (!field.init) continue;
    const v = field.init.call(o, o);
    requireShareable(v);
    write(a + HEAD + s.shape.index.get(field.key!)! * SLOT, v);
  }
  s.init?.(o, args);
  return o;
}

// The class's last static element: the constructor sealed (§2.2.6).
export function sealSharedStruct(f: Function) {
  Object.seal(f);
}
