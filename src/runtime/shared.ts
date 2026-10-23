// Shared Structs (§2) and Shared Arrays (§3) of the proposal, in the heap
// (heap.ts). A Shared Struct is a block of field slots; each agent sees it
// through a Proxy of its own whose traps are the spec's internal methods
// (§2.1.5 to §2.1.10). One Proxy per block per agent, so `===` holds within an
// agent.
//
//   a shared object  [0 kind][4 shape: the keys, or the length]
//                    [8 a struct's number of slots][12]
//                    then a slot per field, 16 bytes each
//   a slot           [0 a word: the value, tagged][8 a Float64, for a Number]
//
// A slot's word holds the whole value but for a Number, whose bits are in the
// Float64 beside it: the Float64 is written first, then the word, with
// Atomics.store, so a field read never tears and never shows a value nobody
// wrote (§2.1.3, "no tear").

import {allocObject, onGC, root, rootSlot, unroot, writeSlot} from './gc.ts';
import {A, F64, I32, intern, requireHeap, stringAt} from './heap.ts';

export const K_STRUCT = 1,
  K_ARRAY = 2,
  K_MUTEX = 3,
  K_CONDITION = 4;
export const HEAD = 16,
  SLOT = 16;

// a word: tagged in its low 3 bits. Tag 0 holds the constants (zeroed memory
// is undefined); the others an address, of an interned string or a shared
// object
const W_UNDEFINED = 0,
  W_NULL = 8,
  W_FALSE = 16,
  W_TRUE = 24;
export const W_NUMBER = 1;
const T_STRING = 2,
  T_BIGINT = 3,
  T_SYMBOL = 4;
export const T_REF = 5;

// ---- this agent's handles ----
// An address is one of this agent's roots (gc.ts) while `handles` has it: the
// collector frees no object this agent has a Proxy for.
const addresses = new WeakMap<object, number>();
const handles = new Map<number, WeakRef<object>>();
const gone = (a: number) => {
  const h = handles.get(a);
  // (none: gone already, its root too)
  if (h === undefined || h.deref() !== undefined) return;
  handles.delete(a);
  unroot(a);
};
const collected = new FinalizationRegistry<number>(gone);
// those this agent's GC has collected, before the registry says so
onGC(() => {
  for (const [a, h] of handles) if (h.deref() === undefined) gone(a);
});

// The address of a shared object (a Shared Struct, a Shared Array, a Mutex, a
// Condition), or undefined.
export const addressOf = (o: unknown): number | undefined =>
  typeof o === 'object' && o !== null ? addresses.get(o) : undefined;

export const kindOf = (o: unknown): number => {
  const a = addressOf(o);
  return a === undefined ? 0 : I32[a >> 2]!;
};

// This agent's handle on the shared object at `a`, which it holds otherwise
// for now (a pin, say).
export function handleAt(a: number): object {
  const known = handles.get(a)?.deref();
  if (known) return known;
  root(a);
  return newHandle(a);
}

// a Proxy on the object at `a`, one of this agent's roots
function newHandle(a: number): object {
  let h: object;
  switch (I32[a >> 2]) {
    case K_STRUCT:
      h = new Proxy(shapeAt(I32[(a >> 2) + 1]!).target, new StructHandler(a));
      break;
    case K_ARRAY: {
      const length = I32[(a >> 2) + 1]!;
      h = new Proxy(arrayTarget(length), new ArrayHandler(a, length));
      break;
    }
    default:
      // a Mutex or a Condition: a Shared Struct with no fields
      h = Object.preventExtensions(Object.create(null));
  }
  addresses.set(h, a);
  handles.set(a, new WeakRef(h));
  collected.register(h, a);
  return h;
}

// A new shared object of `kind`, `slots` slots long, its handle.
export function create(kind: number, shape: number, slots: number) {
  requireHeap();
  const a = allocObject(HEAD + slots * SLOT);
  I32[a >> 2] = kind;
  I32[(a >> 2) + 1] = shape;
  if (kind === K_STRUCT) I32[(a >> 2) + 2] = slots;
  return newHandle(a);
}

// ---- symbols. An agent's symbols are its own: those that are the same in
// every agent are the registered ones (Symbol.for) and the well-known ones ----
const wellKnown = new Map<symbol, string>();
for (const name of Object.getOwnPropertyNames(Symbol)) {
  const s = (Symbol as any)[name];
  if (typeof s === 'symbol') wellKnown.set(s, name);
}

function symbolCode(s: symbol) {
  const key = Symbol.keyFor(s);
  if (key !== undefined) return 'r' + key;
  const name = wellKnown.get(s);
  return name === undefined ? undefined : 'w' + name;
}

const symbolOf = (code: string): symbol =>
  code[0] === 'r' ? Symbol.for(code.slice(1)) : (Symbol as any)[code.slice(1)];

// CanBeSharedAcrossAgents (§2.2.4). A symbol that is neither registered nor
// well-known cannot be: no other agent has it.
export function canBeShared(v: unknown): boolean {
  switch (typeof v) {
    case 'object':
      return v === null || addresses.has(v);
    case 'function':
      return false;
    case 'symbol':
      return symbolCode(v) !== undefined;
    default:
      return true;
  }
}

export function requireShareable(v: unknown) {
  if (!canBeShared(v))
    throw new TypeError(
      `structs: ${describe(v)} cannot be shared across agents (only primitives and shared objects can)`,
    );
}

const describe = (v: unknown) =>
  typeof v === 'symbol'
    ? 'a symbol that is not registered (Symbol.for)'
    : typeof v === 'function'
      ? 'a function'
      : 'an object that is not shared';

// ---- slots ----
// The value in the slot at `s`. (ReadSharedStructField, §2.1.3.)
export function read(s: number): unknown {
  const w = A.load(I32, s >> 2);
  if ((w & 7) !== T_REF) return valueOf(w, s);
  const known = handles.get(w & ~7)?.deref();
  if (known) return known;
  // the slot read again, its object one of this agent's roots before its
  // Proxy is made
  const v = rootSlot(s >> 2);
  return (v & 7) === T_REF
    ? (handles.get(v & ~7)?.deref() ?? newHandle(v & ~7))
    : valueOf(v, s);
}

// the value the word `w` of the slot at `s` says, but for an object
function valueOf(w: number, s: number): unknown {
  switch (w & 7) {
    case 0:
      return w === W_UNDEFINED ? undefined : w === W_NULL ? null : w === W_TRUE;
    case W_NUMBER:
      return F64[(s >> 3) + 1];
    case T_STRING:
      return stringAt(w & ~7);
    case T_BIGINT:
      return BigInt(stringAt(w & ~7));
    default:
      return symbolOf(stringAt(w & ~7));
  }
}

// Writes `v`, which can be shared, to the slot at `s`.
// (WriteSharedStructField, §2.1.4.)
export function write(s: number, v: unknown) {
  if (typeof v === 'number') {
    F64[(s >> 3) + 1] = v;
    // a reader that sees the word says Number reads this Number or an older
    // one: the word is stored (seq-cst, after the Float64) only as it changes
    if (I32[s >> 2] !== W_NUMBER) writeSlot(s >> 2, W_NUMBER);
  } else writeSlot(s >> 2, encode(v));
}

function encode(v: unknown): number {
  switch (typeof v) {
    case 'undefined':
      return W_UNDEFINED;
    case 'boolean':
      return v ? W_TRUE : W_FALSE;
    case 'string':
      return intern(v) | T_STRING;
    case 'bigint':
      return intern(v.toString()) | T_BIGINT;
    case 'symbol':
      return intern(symbolCode(v)!) | T_SYMBOL;
    default:
      return v === null ? W_NULL : addresses.get(v as object)! | T_REF;
  }
}

// ---- shapes: a Shared Struct's field keys, interned as one string ----
export interface Shape {
  addr: number;
  keys: PropertyKey[];
  index: Map<PropertyKey, number>;
  // the Proxy target every struct of this shape shares: sealed, its fields
  // data properties that are writable and not configurable (the spec's
  // [[GetOwnProperty]] says not writable, but its [[DefineOwnProperty]]
  // asserts writable, and a Proxy cannot report a writable target property
  // as not writable)
  target: object;
}
const shapes = new Map<number, Shape>();

function keyCode(k: PropertyKey) {
  if (typeof k !== 'symbol') return 's' + String(k);
  const code = symbolCode(k);
  if (code === undefined)
    throw new TypeError(
      'structs: a Shared Struct field key must be a string, or a registered or well-known symbol',
    );
  return code;
}

// The shape of a struct with these keys (in order, without repeats).
export function shapeFor(keys: PropertyKey[]): Shape {
  const code = keys
    .map(k => {
      const c = keyCode(k);
      return `${c.length}:${c}`;
    })
    .join('');
  return shapeAt(intern(code));
}

function shapeAt(addr: number): Shape {
  let shape = shapes.get(addr);
  if (shape) return shape;
  const code = stringAt(addr),
    keys: PropertyKey[] = [];
  for (let i = 0; i < code.length;) {
    const colon = code.indexOf(':', i),
      n = Number(code.slice(i, colon)),
      c = code.slice(colon + 1, colon + 1 + n);
    keys.push(c[0] === 's' ? c.slice(1) : symbolOf(c));
    i = colon + 1 + n;
  }
  const target = Object.create(null);
  for (const k of keys)
    Object.defineProperty(target, k, {
      value: undefined,
      writable: true,
      enumerable: true,
      configurable: false,
    });
  Object.preventExtensions(target);
  shape = {addr, keys, index: new Map(keys.map((k, i) => [k, i])), target};
  shapes.set(addr, shape);
  return shape;
}

const field = (desc: PropertyDescriptor) =>
  !('get' in desc) &&
  !('set' in desc) &&
  desc.enumerable !== false &&
  desc.configurable !== true &&
  desc.writable !== false;

// The internal methods of a Shared Struct (§2.1.5 to §2.1.10).
class StructHandler implements ProxyHandler<object> {
  readonly a: number;
  readonly index: Map<PropertyKey, number>;
  constructor(a: number) {
    this.a = a;
    this.index = shapeAt(I32[(a >> 2) + 1]!).index;
  }
  get(_: object, p: PropertyKey) {
    const i = this.index.get(p);
    return i === undefined ? undefined : read(this.a + HEAD + i * SLOT);
  }
  set(_: object, p: PropertyKey, v: unknown) {
    const i = this.index.get(p);
    if (i === undefined) return false;
    requireShareable(v);
    write(this.a + HEAD + i * SLOT, v);
    return true;
  }
  has(_: object, p: PropertyKey) {
    return this.index.has(p);
  }
  deleteProperty() {
    return false;
  }
  getOwnPropertyDescriptor(_: object, p: PropertyKey) {
    const i = this.index.get(p);
    if (i === undefined) return undefined;
    return {
      value: read(this.a + HEAD + i * SLOT),
      writable: true,
      enumerable: true,
      configurable: false,
    };
  }
  defineProperty(_: object, p: PropertyKey, desc: PropertyDescriptor) {
    const i = this.index.get(p);
    if (i === undefined || !field(desc)) return false;
    if ('value' in desc) {
      requireShareable(desc.value);
      write(this.a + HEAD + i * SLOT, desc.value);
    }
    return true;
  }
}

// The slot of the field `key` of the Shared Struct or Shared Array at `a`, or
// -1 when it has none.
export function fieldSlot(a: number, key: PropertyKey) {
  const i =
    I32[a >> 2] === K_ARRAY
      ? indexOf(key, I32[(a >> 2) + 1]!)
      : (shapeAt(I32[(a >> 2) + 1]!).index.get(key) ?? -1);
  return i < 0 ? -1 : a + HEAD + i * SLOT;
}

// ---- Shared Arrays (§3): a Shared Struct with a field per index, and a
// length that cannot change ----
const arrayTargets = new Map<number, object>();

function arrayTarget(length: number) {
  let target = arrayTargets.get(length);
  if (target) return target;
  target = Object.create(null) as object;
  for (let i = 0; i < length; i++)
    Object.defineProperty(target, i, {
      value: undefined,
      writable: true,
      enumerable: true,
      configurable: false,
    });
  Object.defineProperty(target, 'length', {
    value: length,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  Object.preventExtensions(target);
  arrayTargets.set(length, target);
  return target;
}

// The index `p` names in an array `length` long, or -1.
const indexOf = (p: PropertyKey, length: number) => {
  if (typeof p !== 'string') return -1;
  const n = Number(p);
  return n >>> 0 === n && n < length && String(n) === p ? n : -1;
};

class ArrayHandler implements ProxyHandler<object> {
  readonly a: number;
  readonly length: number;
  constructor(a: number, length: number) {
    this.a = a;
    this.length = length;
  }
  get(_: object, p: PropertyKey) {
    if (p === 'length') return this.length;
    const i = indexOf(p, this.length);
    return i < 0 ? undefined : read(this.a + HEAD + i * SLOT);
  }
  set(_: object, p: PropertyKey, v: unknown) {
    const i = indexOf(p, this.length);
    if (i < 0) return false;
    requireShareable(v);
    write(this.a + HEAD + i * SLOT, v);
    return true;
  }
  has(_: object, p: PropertyKey) {
    return p === 'length' || indexOf(p, this.length) >= 0;
  }
  deleteProperty() {
    return false;
  }
  getOwnPropertyDescriptor(_: object, p: PropertyKey) {
    if (p === 'length')
      return {
        value: this.length,
        writable: false,
        enumerable: false,
        configurable: false,
      };
    const i = indexOf(p, this.length);
    if (i < 0) return undefined;
    return {
      value: read(this.a + HEAD + i * SLOT),
      writable: true,
      enumerable: true,
      configurable: false,
    };
  }
  defineProperty(_: object, p: PropertyKey, desc: PropertyDescriptor) {
    if (p === 'length')
      return (
        !('get' in desc) &&
        !('set' in desc) &&
        desc.writable !== true &&
        desc.enumerable !== true &&
        desc.configurable !== true &&
        (!('value' in desc) || Object.is(desc.value, this.length))
      );
    const i = indexOf(p, this.length);
    if (i < 0 || !field(desc)) return false;
    if ('value' in desc) {
      requireShareable(desc.value);
      write(this.a + HEAD + i * SLOT, desc.value);
    }
    return true;
  }
}

// SharedArray ( ...values ) (§3.1.2)
export const SharedArray = function SharedArray(...values: unknown[]) {
  if (new.target === undefined)
    throw new TypeError("Constructor SharedArray requires 'new'");
  if (values.length === 0) return create(K_ARRAY, 0, 0);
  if (values.length === 1) {
    const len = values[0];
    if (typeof len !== 'number' || !Number.isInteger(len))
      throw new TypeError('SharedArray: the length must be an integral Number');
    if (len < 0 || len > 2 ** 32 - 1)
      throw new RangeError('SharedArray: invalid length');
    // the heap is smaller than a 2 ** 32 - 1 long array: alloc says so
    return create(K_ARRAY, len, len);
  }
  for (const v of values) requireShareable(v);
  const array = create(K_ARRAY, values.length, values.length);
  const a = addresses.get(array)!;
  values.forEach((v, k) => write(a + HEAD + k * SLOT, v));
  return array;
} as unknown as SharedArrayConstructor;

export interface SharedArrayConstructor {
  new <T = unknown>(length?: number): SharedArray<T>;
  new <T = unknown>(...values: T[]): SharedArray<T>;
}
export interface SharedArray<T = unknown> {
  [index: number]: T;
  readonly length: number;
}
