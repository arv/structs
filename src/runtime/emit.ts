// @arv/structs/runtime: what the code the compiler emits imports. Importing it
// installs the proposal's globals (index.ts).

import './index.ts';
import {F64, I32} from './heap.ts';
import {
  addressOf,
  HEAD,
  K_STRUCT,
  read,
  requireShareable,
  shapeFor,
  SLOT,
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

// the slot of field `i` of `o`, if `o` is a Shared Struct of layout `l`
function slot(o: unknown, l: Layout, i: number) {
  const a = addressOf(o);
  if (a === undefined) return -1;
  if (l.addr === 0) l.addr = shapeFor(l.keys).addr;
  return I32[a >> 2] === K_STRUCT && I32[(a >> 2) + 1] === l.addr
    ? a + HEAD + i * SLOT
    : -1;
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
