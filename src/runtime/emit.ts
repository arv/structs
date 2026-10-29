// @arv/structs/runtime: what the code the compiler emits imports. Importing it
// installs the proposal's globals (index.ts).

import './index.ts';
import {turn} from './gc.ts';
import {F64, I32, views as heapViews} from './heap.ts';
// the heap's views, which compiled code indexes with an address from addr():
// a function keeps them in locals (views()), code elsewhere reads them here
export {F64, I32} from './heap.ts';

// The views, for a function to keep in locals as it begins. It begins this
// agent's turn too, as the function may read addresses out of slots (elem,
// ref): the collector keeps what they held until the turn ends (gc.ts).
export function views() {
  const v = heapViews();
  // (none, in an agent that has no heap yet)
  if (v.I32.length !== 0) turn();
  return v;
}
import {
  addressOf,
  HEAD as HEAD_,
  K_ARRAY,
  K_STRUCT as K_STRUCT_,
  read,
  requireShareable,
  shapeFor,
  SLOT as SLOT_,
  T_REF as T_REF_,
  W_NUMBER,
  write,
} from './shared.ts';

// The constants elem and ref read, which compiled code inlines: V8 folds a
// const of this module, where it loads an imported one every time.
const HEAD = HEAD_,
  K_STRUCT = K_STRUCT_,
  SLOT = SLOT_,
  T_REF = T_REF_;

export {
  beginStruct,
  constructSharedStruct,
  defineSharedStruct,
  defineStruct,
  endStruct,
  notInstance,
  sealSharedStruct,
  sealStruct,
  sharedStructHeritage,
  structHeritage,
  superInit,
} from './structs.ts';

// ---- direct field access, which the compiler emits where TypeScript says the
// object is an instance of a shared struct of a layout, and the field is its
// `i`th (src/compiler/fast.ts). The object is checked to be a Shared Struct
// of that layout; any other is read through its properties, as the code was
// written (`o[key]`).

export interface Layout {
  keys: PropertyKey[];
  // the indexes of its typed fields (declared `: number`), whose slots only
  // hold a Number: compiled code reads and writes their Float64s alone
  numbers: number[];
  // the shape's address, once known (this agent may not have a heap yet when
  // the module loads)
  addr: number;
}

export const layout = (
  keys: PropertyKey[],
  numbers: number[] = [],
): Layout => ({
  keys,
  numbers,
  addr: 0,
});

const shapeOf = (l: Layout) =>
  l.addr === 0
    ? (l.addr = shapeFor(l.keys, new Set(l.numbers.map(i => l.keys[i]!))).addr)
    : l.addr;

// The address of `o` if it is a Shared Struct of layout `l`, else -1. The
// compiler emits it once for a binding that keeps its value, and reads its
// fields in the views, or with the `...At` functions below.
export function addr(o: unknown, l: Layout) {
  const a = addressOf(o);
  if (a === undefined) return -1;
  return I32[a >> 2] === K_STRUCT && I32[(a >> 2) + 1] === shapeOf(l) ? a : -1;
}

// The address of `o`, if it is a Shared Array, or -1.
export function addrArray(o: unknown) {
  const a = addressOf(o);
  return a !== undefined && I32[a >> 2] === K_ARRAY ? a : -1;
}

// The address of the Shared Struct of layout `l` that the slot whose word is
// I[w] holds, or -1: what that word says without making its Proxy. (A slot
// that holds anything else is read as written, through its holder.) `I` is
// the heap's I32: compiled code passes its function's own (views()), which
// V8 reads as a local, where this module's is a binding it loads every time.
function refIn(I: Int32Array, w: number, l: Layout) {
  const v = I[w]!;
  if ((v & 7) !== T_REF) return -1;
  const r = v & ~7;
  // (shapeOf's test written out: nbody runs a twentieth faster than with its
  // call, which V8 inlines)
  return I[r >> 2] === K_STRUCT &&
    I[(r >> 2) + 1] === (l.addr === 0 ? shapeOf(l) : l.addr)
    ? r
    : -1;
}

// The address of the struct of layout `l` in field `i` of the struct at `a`
// (-1 for none: an address that is -1, or another value).
export const ref = (a: number, i: number, l: Layout, I = I32) =>
  a < 0 ? -1 : refIn(I, (a + HEAD + i * SLOT) >> 2, l);

// The address of the struct of layout `l` at index `i` of the Shared Array at
// `a` (-1 for none: an index out of its bounds, too, or that is no Number,
// which the slow path converts, once).
export const elem = (a: number, i: unknown, l: Layout, I = I32) =>
  a < 0 || typeof i !== 'number' || i >>> 0 !== i || i >= I[(a >> 2) + 1]!
    ? -1
    : refIn(I, (a + HEAD + i * SLOT) >> 2, l);

// the slot of field `i` of `o`, if `o` is a Shared Struct of layout `l`
function slot(o: unknown, l: Layout, i: number) {
  const a = addr(o, l);
  return a < 0 ? -1 : a + HEAD + i * SLOT;
}

// o.key
export function get(o: any, l: Layout, i: number) {
  const s = slot(o, l, i);
  return s < 0 ? o[l.keys[i]!] : read(s);
}

// o.key, a field TypeScript says is a number
export function getNumber(o: any, l: Layout, i: number) {
  const s = slot(o, l, i);
  if (s < 0) return o[l.keys[i]!];
  return I32[s >> 2] === W_NUMBER ? F64[(s >> 3) + 1] : read(s);
}

// o.key = v
export function set(o: any, l: Layout, i: number, v: unknown) {
  const s = slot(o, l, i);
  if (s < 0) o[l.keys[i]!] = v;
  else {
    if (typeof v !== 'number') requireShareable(v);
    write(s, v);
  }
  return v;
}

// get, getNumber and set, given addr(o, l)
export function getAt(o: any, a: number, l: Layout, i: number) {
  return a < 0 ? o[l.keys[i]!] : read(a + HEAD + i * SLOT);
}

export function getNumberAt(o: any, a: number, l: Layout, i: number) {
  if (a < 0) return o[l.keys[i]!];
  const s = a + HEAD + i * SLOT;
  return I32[s >> 2] === W_NUMBER ? F64[(s >> 3) + 1] : read(s);
}

export function setAt(o: any, a: number, l: Layout, i: number, v: unknown) {
  if (a < 0) o[l.keys[i]!] = v;
  else {
    if (typeof v !== 'number') requireShareable(v);
    write(a + HEAD + i * SLOT, v);
  }
  return v;
}

// The computed keys of a struct's fields: each evaluated where its field is
// (ToPropertyKey), in element order, and recorded; the struct's first static
// block, which runs once all are, takes its own (the last `n`). A struct
// declared inside a key takes its keys before the outer one records the next.
const keys: PropertyKey[] = [];
export function fieldKey(v: unknown): PropertyKey {
  const key = typeof v === 'symbol' ? v : String(v);
  keys.push(key);
  return key;
}
export const fieldKeys = (n: number) => keys.splice(keys.length - n, n);
