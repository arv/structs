// @arv/structs/runtime: what the code the compiler emits imports. Importing it
// installs the proposal's globals (index.ts).

import './index.ts';
import {F64, I32} from './heap.ts';
// the heap's views, which compiled code indexes with an address from addr():
// a function keeps them in locals (views()), code elsewhere reads them here
export {F64, I32, views} from './heap.ts';
import {
  addressOf,
  HEAD,
  K_ARRAY,
  K_STRUCT,
  read,
  requireShareable,
  shapeFor,
  SLOT,
  T_REF,
  W_NUMBER,
  write,
} from './shared.ts';

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
  // the shape's address, once known (this agent may not have a heap yet when
  // the module loads)
  addr: number;
}

export const layout = (keys: PropertyKey[]): Layout => ({keys, addr: 0});

// The address of `o` if it is a Shared Struct of layout `l`, else -1. The
// compiler emits it once for a binding that keeps its value, and reads its
// fields in the views, or with the `...At` functions below.
export function addr(o: unknown, l: Layout) {
  const a = addressOf(o);
  if (a === undefined) return -1;
  if (l.addr === 0) l.addr = shapeFor(l.keys).addr;
  return I32[a >> 2] === K_STRUCT && I32[(a >> 2) + 1] === l.addr ? a : -1;
}

// The address of `o`, if it is a Shared Array, or -1.
export function addrArray(o: unknown) {
  const a = addressOf(o);
  return a !== undefined && I32[a >> 2] === K_ARRAY ? a : -1;
}

// The address of the Shared Struct of layout `l` that the slot whose word is
// I32[w] holds, or -1: what that word says without making its Proxy. (A slot
// that holds anything else is read as written, through its holder.)
function refIn(w: number, l: Layout) {
  const v = I32[w]!;
  if ((v & 7) !== T_REF) return -1;
  const r = v & ~7;
  if (l.addr === 0) l.addr = shapeFor(l.keys).addr;
  return I32[r >> 2] === K_STRUCT && I32[(r >> 2) + 1] === l.addr ? r : -1;
}

// The address of the struct of layout `l` in field `i` of the struct at `a`
// (-1 for none: an address that is -1, or another value).
export const ref = (a: number, i: number, l: Layout) =>
  a < 0 ? -1 : refIn((a + HEAD + i * SLOT) >> 2, l);

// The address of the struct of layout `l` at index `i` of the Shared Array at
// `a` (-1 for none: an index out of its bounds, too).
export const elem = (a: number, i: number, l: Layout) =>
  a < 0 || i >>> 0 !== i || i >= I32[(a >> 2) + 1]!
    ? -1
    : refIn((a + HEAD + i * SLOT) >> 2, l);

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
