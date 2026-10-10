// own and shared values between threads, with a borrow checker at the boundaries (see
// README.md). a value is one of:
//   own      an ordinary object, reachable by one thread. it crosses to another thread only by
//            moving (spawn's arguments, a thread's result): it is copied over and the sender's
//            objects are revoked, so using them again throws
//   shared   immutable: share(v) deep-freezes v and writes it into the shared heap once. a thread
//            it reaches makes its own frozen copy on first use, then reads plain objects
//   a cell   shared and mutable, explicitly: Lock, Condition (runtime.mjs), Barrier, Slots. their
//            state lives in the shared heap and they synchronize
// ordinary code reads and writes ordinary objects: nothing per access, everything at the crossings
import { $alloc, $intern, $str, $h, $log, ADDR, K_THREAD, spawnThread, threadJoin, setThreadEntry } from './runtime.mjs';

const SAB = globalThis.__escapeSab ?? null;
const I32 = SAB && new Int32Array(SAB), F64 = SAB && new Float64Array(SAB), U8 = SAB && new Uint8Array(SAB), U16 = SAB && new Uint16Array(SAB);

export { $log as log };

// ---- the wire format: a blob of 8-byte words in the shared heap. word 0 is the root value ----
// a value word is a number (f64), or a box: hi = 0xFFF80000 | tag << 11, lo = payload. payloads
// of strings, arrays and objects are the word offset of their body in the same blob
//   string body: [length] then utf-16 units     array body: [length] then value words
//   object body: [count] then count key words (interned key address) then count value words
const BOX = 0xFFF80000 | 0;
const T_UNDEF = 1, T_NULL = 2, T_FALSE = 3, T_TRUE = 4, T_STR = 5, T_ARR = 6, T_OBJ = 7, T_SHARED = 8, T_CELL = 9;

// writing: into a growing private buffer, then copied into the heap in one piece
let wf = new Float64Array(1024), wi = new Int32Array(wf.buffer), wn = 0;
const reserve = words => {
  if (wn + words <= wf.length) return;
  const nf = new Float64Array(Math.max(wf.length * 2, wn + words));
  nf.set(wf.subarray(0, wn));
  wf = nf; wi = new Int32Array(wf.buffer);
};
const box = (at, tag, p) => { wi[at * 2] = p; wi[at * 2 + 1] = BOX | (tag << 11); };

// a cell is a JS object of one of these classes; it crosses as its block's address
const cellKinds = new Map(); // kind -> class
const sharedAddr = new WeakMap(); // a shared value -> its blob
const REVOKED = new Proxy(Object.create(null), {
  get: (t, key) => { if (typeof key === 'symbol') return undefined; throw new TypeError(`own: used after move (.${String(key)})`); },
  set: (t, key) => { throw new TypeError(`own: used after move (.${String(key)} = ...)`); },
  has: () => { throw new TypeError('own: used after move'); }
});

// write v into word `at`. moved: the own objects copied, to revoke once the whole blob is written
function put(at, v, moved, seen) {
  if (typeof v === 'number') { wf[at] = v === v ? v : NaN; if (v !== v) { wi[at * 2] = 0; wi[at * 2 + 1] = 0x7FF80000; } return; }
  if (v === undefined) return box(at, T_UNDEF, 0);
  if (v === null) return box(at, T_NULL, 0);
  if (v === true) return box(at, T_TRUE, 0);
  if (v === false) return box(at, T_FALSE, 0);
  if (typeof v === 'string') {
    const body = wn, words = 1 + ((v.length + 3) >> 2);
    reserve(words); wn += words;
    wi[body * 2] = v.length;
    const u = new Uint16Array(wf.buffer, (body + 1) * 8, v.length);
    for (let i = 0; i < v.length; i++) u[i] = v.charCodeAt(i);
    return box(at, T_STR, body);
  }
  if (typeof v !== 'object') throw new TypeError(`own: cannot send a ${typeof v}`);
  const shared = sharedAddr.get(v);
  if (shared !== undefined) return box(at, T_SHARED, shared);
  if (v.$cell !== undefined) return box(at, T_CELL, v.$cell);
  if (v[ADDR] !== undefined) return box(at, T_CELL, v[ADDR]); // a runtime.mjs Lock or Condition
  if (seen.has(v)) throw new TypeError('own: cycles cannot be sent yet');
  seen.add(v);
  if (moved) moved.push(v);
  if (Array.isArray(v)) {
    const n = v.length, body = wn;
    reserve(1 + n); wn += 1 + n;
    wi[body * 2] = n;
    for (let i = 0; i < n; i++) put(body + 1 + i, v[i], moved, seen);
    seen.delete(v);
    return box(at, T_ARR, body);
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw new TypeError('own: only plain objects and arrays can be sent');
  const keys = Object.keys(v), n = keys.length, body = wn;
  reserve(1 + 2 * n); wn += 1 + 2 * n;
  wi[body * 2] = n;
  for (let k = 0; k < n; k++) wi[(body + 1 + k) * 2] = $intern(keys[k]);
  for (let k = 0; k < n; k++) put(body + 1 + n + k, v[keys[k]], moved, seen);
  seen.delete(v);
  return box(at, T_OBJ, body);
}
// a blob of v in the shared heap; its address
function write(v, moved) {
  wn = 1;
  put(0, v, moved, new Set());
  const a = $alloc(wn * 8);
  U8.set(new Uint8Array(wf.buffer, 0, wn * 8), a);
  return a;
}

// reading: a blob is immutable once written, so its words are read without care for tearing
function get(base, at, frozen) {
  const v = F64[(base >> 3) + at];
  if (v === v) return v;
  const i = (base >> 2) + at * 2, hi = I32[i + 1], p = I32[i];
  if ((hi & BOX) !== BOX) return NaN;
  switch ((hi >>> 11) & 0xff) {
    case T_UNDEF: return undefined;
    case T_NULL: return null;
    case T_FALSE: return false;
    case T_TRUE: return true;
    case T_STR: {
      const n = I32[(base >> 2) + p * 2], u = (base + (p + 1) * 8) >> 1;
      let s = '';
      for (let k = 0; k < n; k += 4096) s += String.fromCharCode.apply(null, U16.subarray(u + k, u + Math.min(n, k + 4096)));
      return s;
    }
    case T_ARR: {
      const n = I32[(base >> 2) + p * 2], a = [];
      for (let k = 0; k < n; k++) a.push(get(base, p + 1 + k, frozen));
      return frozen ? Object.freeze(a) : a;
    }
    case T_OBJ: {
      const n = I32[(base >> 2) + p * 2];
      return maker(base, p, n, frozen)(F64, get, base, p + 1 + n, frozen);
    }
    case T_SHARED: return materialize(p);
    case T_CELL: return cell(p);
  }
  throw new Error('own: bad value word');
}
const read = (a, frozen) => get(a, 0, frozen);

// objects with the same keys (in the same order) are made by one generated function, an object
// literal: the engine gives them one hidden class, and making one is a single allocation
const makers = new Map(); // hash of the key addresses -> [ { keys, frozen, make } ]
function maker(base, p, n, frozen) {
  const k0 = (base >> 2) + (p + 1) * 2;
  let h = n | (frozen ? 1 << 30 : 0);
  for (let k = 0; k < n; k++) h = Math.imul(h, 31) + I32[k0 + k * 2] | 0;
  let list = makers.get(h);
  if (list !== undefined) {
    outer: for (const m of list) {
      for (let k = 0; k < n; k++) if (m.keys[k] !== I32[k0 + k * 2]) continue outer;
      return m.make;
    }
  } else makers.set(h, list = []);
  const keys = Array.from({ length: n }, (_, k) => I32[k0 + k * 2]);
  const fields = keys.map((a, k) => `${JSON.stringify($str(a))}: (v = F64[(base >> 3) + at + ${k}]) === v ? v : get(base, at + ${k}, frozen)`);
  const make = new Function('F64', 'get', 'base', 'at', 'frozen', `let v; return ${frozen ? 'Object.freeze(' : ''}{ ${fields.join(', ')} }${frozen ? ')' : ''};`);
  list.push({ keys, make });
  return make;
}

// ---- moving ----
// revoke what was moved: the sender keeps the objects, but any use of them throws
function revoke(objs) {
  for (const o of objs) {
    if (Array.isArray(o)) o.length = 0;
      else for (const k of Object.keys(o)) delete o[k];
    Object.setPrototypeOf(o, REVOKED);
  }
}
const send = v => {
  const moved = [];
  const a = write(v, moved);
  revoke(moved);
  return a;
};

// ---- sharing ----
const deepFreeze = v => {
  if (v === null || typeof v !== 'object' || Object.isFrozen(v) || sharedAddr.has(v) || v.$cell !== undefined || v[ADDR] !== undefined) return v;
  for (const k of Object.keys(v)) deepFreeze(v[k]);
  return Object.freeze(v);
};
// freezes v (it is shared now, so nobody may change it) and writes it once
export function share(v) {
  if (v === null || typeof v !== 'object') return v;
  if (sharedAddr.has(v)) return v;
  deepFreeze(v);
  sharedAddr.set(v, write(v, null));
  return v;
}
// a shared blob, as this thread's own frozen copy (made once)
const copies = new Map();
function materialize(a) {
  let v = copies.get(a);
  if (v === undefined) {
    v = read(a, true);
    if (v !== null && typeof v === 'object') sharedAddr.set(v, a);
    copies.set(a, v);
  }
  return v;
}

// ---- cells: shared and mutable, explicitly ----
const K_BARRIER = 20, K_SLOTS = 21, K_F64 = 22, K_SHARED_ARRAY = 23;
const cells = new Map(); // address -> this thread's cell object
function cell(a) {
  let c = cells.get(a);
  if (c === undefined) {
    const kind = I32[a >> 2], Cls = cellKinds.get(kind);
    if (kind === K_F64) { c = new Float64Array(SAB, a + 16, I32[(a >> 2) + 1]); c.$cell = a; }
      else if (kind === K_SHARED_ARRAY) c = sharedArrayHandle(a);
      else c = Cls ? Object.assign(Object.create(Cls.prototype), { $cell: a }) : $h(a); // Lock, Condition
    cells.set(a, c);
  }
  return c;
}
const newCell = (kind, bytes, self) => {
  const a = $alloc(bytes);
  I32[a >> 2] = kind;
  self.$cell = a;
  cells.set(a, self);
  return a;
};

// a reusable barrier for n threads: the last to arrive wakes the others. a waiter spins a
// little first: steps between barriers are often shorter than a sleep and a wake-up
const SPINS = 20000;
export class Barrier {
  constructor(n) { const a = newCell(K_BARRIER, 16, this); I32[(a >> 2) + 1] = n; }
  wait() {
    const i = this.$cell >> 2, gen = Atomics.load(I32, i + 3);
    if (Atomics.add(I32, i + 2, 1) === I32[i + 1] - 1) {
      Atomics.store(I32, i + 2, 0);
      Atomics.add(I32, i + 3, 1);
      Atomics.notify(I32, i + 3);
      return;
    }
    for (let k = 0; k < SPINS; k++) if (Atomics.load(I32, i + 3) !== gen) return;
    while (Atomics.load(I32, i + 3) === gen) Atomics.wait(I32, i + 3, gen);
  }
}
cellKinds.set(K_BARRIER, Barrier);

// numbers every thread reads and writes in place: a Float64Array over the shared heap. no copies;
// the program orders its reads and writes itself (with a Barrier, say)
export function sharedFloat64Array(n) {
  const a = $alloc(16 + n * 8);
  I32[a >> 2] = K_F64; I32[(a >> 2) + 1] = n;
  const v = new Float64Array(SAB, a + 16, n);
  v.$cell = a;
  cells.set(a, v);
  return v;
}

// n slots, each holding a shared value (or nothing)
export class Slots {
  constructor(n) { const a = newCell(K_SLOTS, 8 + n * 4, this); I32[(a >> 2) + 1] = n; }
  get length() { return I32[(this.$cell >> 2) + 1]; }
  set(i, v) {
    const a = sharedAddr.get(v);
    if (a === undefined) throw new TypeError('own: a slot holds shared values only (share() it first)');
    Atomics.store(I32, (this.$cell >> 2) + 2 + i, a);
  }
  get(i) {
    const a = Atomics.load(I32, (this.$cell >> 2) + 2 + i);
    return a === 0 ? undefined : materialize(a);
  }
  // the arrays in every slot, concatenated in slot order (their elements are this thread's copies)
  flat() {
    const all = [];
    for (let k = 0; k < this.length; k++) {
      const v = this.get(k);
      if (v !== undefined) for (const o of v) all.push(o);
    }
    return all;
  }
}
cellKinds.set(K_SLOTS, Slots);

// `shared struct Name { a: number; b: number }` compiles to __sharedStruct('Name', ['a', 'b']). a
// struct's block is a header word (its kind) and then its fields, 8 bytes each, in order. compiled
// with the tsgo fork's typed layout, a struct value is the block's address and `p.a` is
// `__F64[(p >> 3) + 1]` (see __newStruct). where one flows into `any` or `unknown` the compiler
// boxes it (__box): the handle is an instance of the class this returns, an object whose accessors
// read and write the same block. uncompiled code can use the class directly. every worker evaluates
// the same modules in the same order, so a struct gets the same kind in each
let structKinds = 100;
export function __sharedStruct(name, fields) {
  const kind = structKinds++, n = fields.length;
  const Struct = { [name]: class { constructor() { newCell(kind, 8 + n * 8, this); } } }[name];
  Struct.kind = kind;
  Struct.size = 8 + n * 8;
  Struct.fields = fields;
  fields.forEach((field, k) => Object.defineProperty(Struct.prototype, field, {
    get() { return F64[(this.$cell >> 3) + 1 + k]; },
    set(v) { F64[(this.$cell >> 3) + 1 + k] = +v; },
    enumerable: true
  }));
  cellKinds.set(kind, Struct);
  return Struct;
}

// ---- typed layouts: what the compiler emits for shared structs and SharedArrays ----
// a struct or SharedArray value is the byte address of its block in the shared heap, so threads pass
// it along as a number and all use the same memory: nothing is copied. the compiler reads and writes
// fields and elements through these views
export { I32 as __I32, F64 as __F64 };
// a zeroed struct: its kind, then its fields from byte 8
export function __newStruct(type) {
  const a = $alloc(type.size);
  I32[a >> 2] = type.kind;
  return a;
}
// [kind][length][element size][-] then the elements from byte 16: numbers (type 8, their size) or
// whole struct blocks, each with its own header so an element's address can be boxed like any struct
export function __newSharedArray(type, length) {
  const size = typeof type === 'number' ? type : type.size;
  const a = $alloc(16 + length * size);
  I32[a >> 2] = K_SHARED_ARRAY; I32[(a >> 2) + 1] = length; I32[(a >> 2) + 2] = size;
  if (typeof type !== 'number') for (let e = a + 16, end = e + length * size; e < end; e += size) I32[e >> 2] = type.kind;
  return a;
}

// boxing: where a struct or SharedArray value (an address) flows into `any`, `unknown`, a generic
// and the like, the compiler wraps it in this thread's one handle object for that address (so ===
// still holds), and unwraps it on the way back. a struct's handle is an instance of its class; a
// SharedArray's is an array-like Proxy over the same memory
export const __box = a => cell(a);
// for code the compiler did not lay out: `new SharedArray(Struct, n)` gives the boxed array-like
export class SharedArray {
  constructor(type, length) { return cell(__newSharedArray(type === Number ? 8 : type, length)); }
}
export function __unbox(v) {
  const a = v !== null && typeof v === 'object' ? v.$cell : undefined;
  if (a === undefined || !(I32[a >> 2] === K_SHARED_ARRAY || I32[a >> 2] >= 100)) throw new TypeError('own: not a shared struct or SharedArray');
  return a;
}
class SharedArrayHandle {
  get length() { return I32[(this.$cell >> 2) + 1]; }
  *[Symbol.iterator]() { for (let i = 0; i < this.length; i++) yield sharedArrayGet(this.$cell, i); }
}
const isIndex = key => typeof key === 'string' && key !== '' && String(key >>> 0) === key;
function sharedArrayAddress(a, i) {
  if (!(i < I32[(a >> 2) + 1])) __oob(a, i);
  return a + 16 + i * I32[(a >> 2) + 2];
}
// numbers are read in place; a struct element is boxed in turn
const sharedArrayGet = (a, i) => I32[(a >> 2) + 2] === 8 ? F64[sharedArrayAddress(a, i) >> 3] : cell(sharedArrayAddress(a, i));
function sharedArrayHandle(a) {
  const target = Object.assign(Object.create(SharedArrayHandle.prototype), { $cell: a });
  return new Proxy(target, {
    get: (t, key, receiver) => isIndex(key) ? sharedArrayGet(a, Number(key)) : Reflect.get(t, key, receiver),
    set: (t, key, v, receiver) => {
      if (!isIndex(key)) return Reflect.set(t, key, v, receiver);
      if (I32[(a >> 2) + 2] !== 8) throw new TypeError('own: a SharedArray of structs holds its structs in place');
      F64[sharedArrayAddress(a, Number(key)) >> 3] = +v;
      return true;
    },
    has: (t, key) => isIndex(key) ? Number(key) < I32[(a >> 2) + 1] : Reflect.has(t, key)
  });
}
export function __oob(a, i) {
  throw new RangeError(`index ${i} is out of range for a SharedArray of length ${I32[(a >> 2) + 1]}`);
}

// ---- threads: spawn(fn, ...args) moves args to a new thread running fn; join moves its result back ----
// a thread names its function by key: every worker loads the same modules, so a key finds the same
// function everywhere. the compiler registers every top-level function of a module that uses the
// ownership syntax (`__register(import.meta.url, { ... })`); fns() is the same, by hand
const byKey = new Map(), keyOf = new Map();
export function __register(url, table) {
  for (const [ name, f ] of Object.entries(table)) {
    const key = `${url}#${name}`;
    byKey.set(key, f);
    keyOf.set(f, key);
  }
}
export const fns = table => __register('', table);
setThreadEntry(t => {
  const [ key, ...args ] = read(I32[(t + 16) >> 2], false);
  const f = byKey.get(key);
  if (f === undefined) throw new Error(`own: no function ${key} in this worker`);
  return send(f(...args));
});
class Thread {
  constructor(t) { this.t = t; this.joined = false; }
  join() {
    if (this.joined) throw new TypeError('own: a thread is joined once (its result moves out)');
    this.joined = true;
    return read(threadJoin(this.t), false);
  }
}
export function spawn(fn, ...args) {
  const key = keyOf.get(fn);
  if (key === undefined) throw new TypeError('own: spawn a top-level function of a module the compiler registered (or fns())');
  const t = $alloc(32);
  I32[t >> 2] = K_THREAD;
  I32[(t + 16) >> 2] = send([ key, ...args ]);
  spawnThread(t);
  return new Thread(t);
}

// structured threads: scope(s => ...) joins every thread s spawned before it returns
class Scope {
  constructor() { this.threads = []; }
  spawn(fn, ...args) {
    const th = spawn(fn, ...args);
    this.threads.push(th);
    return th;
  }
}
export function scope(body) {
  const s = new Scope();
  try {
    return body(s);
  } finally {
    for (const th of s.threads) if (!th.joined) th.join();
  }
}

// `parts` owned, disjoint chunks of nearly equal size (the checker trusts this)
export const partition = (items, parts) =>
  Array.from({ length: parts }, (_, t) => items.slice(Math.floor(items.length * t / parts), Math.floor(items.length * (t + 1) / parts)));
// a destructive read: the element leaves the array, so the caller owns it (the checker trusts this)
export function take(items, index) {
  const v = items[index];
  items[index] = undefined;
  return v;
}
