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
import { $alloc, $intern, $str, $h, $log, ADDR, K_THREAD, spawnThread, threadJoin, threadJoinAsync, setThreadEntry, setAfterTask, setBeforeTask,
  $allocBlock, $freeBlock, $defer, $quiescent, $waitBegin, $waitEnd, setDeferHandler, $drain, $heapStats } from './runtime.mjs';

const SAB = globalThis.__escapeSab ?? null;
const I32 = SAB && new Int32Array(SAB), F64 = SAB && new Float64Array(SAB), U8 = SAB && new Uint8Array(SAB), U16 = SAB && new Uint16Array(SAB);

export { $log as log };

// ---- the wire format: a blob of 8-byte words in the shared heap. word 0 is the root value ----
// a value word is a number (f64), or a box: hi = 0xFFF80000 | tag << 11, lo = payload. payloads
// of strings, arrays and objects are the word offset of their body in the same blob
//   string body: [length] then utf-16 units     array body: [length] then value words
//   object body: [count] then count key words (interned key address) then count value words
const BOX = 0xFFF80000 | 0;
const T_UNDEF = 1, T_NULL = 2, T_FALSE = 3, T_TRUE = 4, T_STR = 5, T_ARR = 6, T_OBJ = 7, T_SHARED = 8, T_CELL = 9, T_COUNTED = 10;

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
  if (v instanceof CountedArg) return box(at, T_COUNTED, v.a);
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
function write(v, moved, alloc = $alloc) {
  wn = 1;
  put(0, v, moved, new Set());
  const a = alloc(wn * 8);
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
    case T_COUNTED: if (countedInto !== null) countedInto.push(p); return p; // else the reader owns it
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
// a message (chan.mjs): v moved into a block of its own, which the receiver frees once it has read
// it. [address, bytes]
export function __message(v) {
  const moved = [];
  const a = write(v, moved, $allocBlock), bytes = wn * 8;
  revoke(moved);
  return [ a, bytes ];
}
export function __unmessage(a, bytes) {
  const v = read(a, false);
  $freeBlock(a, bytes);
  return v;
}

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
const counted = kind => kind === K_SHARED_ARRAY || kind >= 100; // structs and SharedArrays (REFCOUNT.md)
// address -> this thread's cell object. a struct's or SharedArray's handle holds a count of its own
// and is held weakly: when V8 collects it, the registry gives the count back
const cells = new Map();
let finalizable = 0;
const handles = new FinalizationRegistry(a => {
  const r = cells.get(a);
  if (r instanceof WeakRef && r.deref() === undefined) cells.delete(a);
  finalizable--;
  __release(a);
});
const holdFor = (h, a) => { __retain(a); handles.register(h, a); finalizable++; };
function cell(a) {
  let c = cells.get(a);
  if (c instanceof WeakRef) c = c.deref();
  if (c === undefined) {
    const kind = I32[a >> 2], Cls = cellKinds.get(kind);
    if (kind === K_F64) { c = new Float64Array(SAB, a + 16, I32[(a >> 2) + 1]); c.$cell = a; }
      else if (kind === K_SHARED_ARRAY) c = sharedArrayHandle(a);
      else c = Cls ? Object.assign(Object.create(Cls.prototype), { $cell: a }) : $h(a); // Lock, Condition
    if (counted(kind)) { holdFor(c, a); cells.set(a, new WeakRef(c)); } else cells.set(a, c);
  }
  return c;
}
// for cells defined outside this module (chan.mjs): their kind's class, and a new one's block
export const __cellKind = (kind, Cls) => { cellKinds.set(kind, Cls); };
export const __newCell = (kind, bytes, self) => newCell(kind, bytes, self);
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
    $waitBegin(); // a quiescent point (REFCOUNT.md), and quiescent while it waits
    if (Atomics.add(I32, i + 2, 1) === I32[i + 1] - 1) {
      Atomics.store(I32, i + 2, 0);
      Atomics.add(I32, i + 3, 1);
      Atomics.notify(I32, i + 3);
    } else {
      let k = 0;
      while (k < SPINS && Atomics.load(I32, i + 3) === gen) k++;
      while (Atomics.load(I32, i + 3) === gen) Atomics.wait(I32, i + 3, gen);
    }
    $waitEnd();
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

// `const Name = struct({ a: f64, b: ref<Name>(), c: bool })` (threads.mjs), or `shared struct Name {
// a: number; b: Name | null; c: boolean }` in the syntax, compiles to __sharedStruct('Name', ['a',
// 'b', 'c'], [1], [2]). a struct's block is [kind][count] and then its fields, 8 bytes each, in order:
// a number field is an f64, a reference field (refs: a struct or a SharedArray) the address in its
// low half, 0 for null, and a boolean field (bools) a byte, 0 or 1, at the start of its slot.
// compiled with the tsgo fork's typed layout, a struct value is the block's address and `p.a` is
// `__F64[(p >> 3) + 1]` (see __newStruct). where one flows into `any` or `unknown` the compiler
// boxes it (__box): the handle is an instance of the class this returns, an object whose accessors
// read and write the same block. uncompiled code can use the class directly.
// a struct's kind is the address of its name and layout in the shared string table, so every thread
// agrees on it whatever order it loads modules in (a page's workers load them on demand), and two
// structs with one layout may share it. it is at least CTRL_BYTES, so never a small cell kind
export function __sharedStruct(name, fields, refs = [], bools = []) {
  const layout = `struct ${name} { ${fields.join(', ')} } refs [${refs.join(', ')}]${bools.length ? ` bools [${bools.join(', ')}]` : ''}`;
  const kind = $intern(layout), n = fields.length, size = 8 + n * 8;
  const Struct = { [name]: class {
    constructor() {
      const a = __newStruct(Struct);
      this.$cell = a;
      holdFor(this, a);
      cells.set(a, new WeakRef(this));
      __release(a);
    }
  } }[name];
  Struct.kind = kind;
  Struct.size = size;
  Struct.fields = fields;
  Struct.refs = refs;
  Struct.bools = bools;
  fields.forEach((field, k) => Object.defineProperty(Struct.prototype, field, refs.includes(k) ? {
    get() { const q = I32[(this.$cell >> 2) + 2 + 2 * k]; return q === 0 ? null : cell(q); },
    set(v) { __store((this.$cell >> 2) + 2 + 2 * k, v == null ? 0 : __retain(__unbox(v))); },
    enumerable: true
  } : bools.includes(k) ? {
    get() { return U8[this.$cell + 8 + 8 * k] !== 0; },
    set(v) { U8[this.$cell + 8 + 8 * k] = v ? 1 : 0; },
    enumerable: true
  } : {
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
export { I32 as __I32, F64 as __F64, U8 as __U8 };
// a zeroed struct: [kind][count 1], then its fields from byte 8. the caller owns the count
export function __newStruct(type) {
  const a = $allocBlock(type.size);
  I32[a >> 2] = type.kind;
  I32[(a >> 2) + 1] = 1;
  return a;
}
// [kind][length][element size][count] then the elements from byte 16: numbers (type 8, their size),
// booleans (type 1, a byte each, 0 or 1) or whole struct blocks, each with its own header so an element's address can be boxed like any struct.
// an element's header is [kind][back], back the array's address minus its own: an element lives as
// long as its array, and counting it counts the array
export function __newSharedArray(type, length) {
  const size = typeof type === 'number' ? type : type.size;
  const a = $allocBlock(16 + length * size);
  I32[a >> 2] = K_SHARED_ARRAY; I32[(a >> 2) + 1] = length; I32[(a >> 2) + 2] = size; I32[(a >> 2) + 3] = 1;
  if (typeof type !== 'number') for (let e = a + 16, end = e + length * size; e < end; e += size) { I32[e >> 2] = type.kind; I32[(e >> 2) + 1] = a - e; }
  return a;
}

// ---- reference counts (REFCOUNT.md) ----
// the block whose count an address's lifetime is, and where that count is
const owner = p => { const w = I32[(p >> 2) + 1]; return w < 0 ? p + w : p; };
const countAt = o => I32[o >> 2] === K_SHARED_ARRAY ? (o >> 2) + 3 : (o >> 2) + 1;
// null is 0; a raw value can also be undefined at run time (a missing argument, `f?.()`)
export function __retain(p) {
  if (p) Atomics.add(I32, countAt(owner(p)), 1);
  return p;
}
export function __release(p) {
  if (!p) return;
  const o = owner(p);
  if (Atomics.sub(I32, countAt(o), 1) === 1) destroy(o);
}
// count 0: no thread holds an uncounted address of the block or of anything read through it, so
// its reference fields are released at once, and so on down, with a work list rather than recursion
function destroy(o) {
  const work = [ o ];
  const drop = p => {
    if (p === 0) return;
    const q = owner(p);
    if (Atomics.sub(I32, countAt(q), 1) === 1) work.push(q);
  };
  while (work.length !== 0) {
    const b = work.pop(), kind = I32[b >> 2];
    if (kind === K_SHARED_ARRAY) {
      const n = I32[(b >> 2) + 1], size = I32[(b >> 2) + 2];
      if (size !== 8 && size !== 1 && n !== 0) { // structs
        const refs = cellKinds.get(I32[(b + 16) >> 2]).refs;
        if (refs.length !== 0) for (let e = b + 16, end = e + n * size; e < end; e += size) for (const k of refs) drop(I32[(e >> 2) + 2 + 2 * k]);
      }
      $freeBlock(b, 16 + n * size);
    } else {
      const T = cellKinds.get(kind);
      for (const k of T.refs) drop(I32[(b >> 2) + 2 + 2 * k]);
      $freeBlock(b, T.size);
    }
  }
}
// a reference field store at i32 index i: takes over v's count. a thread may have read the old value
// and not counted it yet, so its decrement waits for every thread's next quiescent point
export function __store(i, v) {
  const old = Atomics.exchange(I32, i, v);
  if (old !== 0) $defer(old);
  return v;
}
setDeferHandler(__release);
export const __quiescent = $quiescent;
export const __heapStats = $heapStats;
// works off the decrements that wait: all of them when no other thread runs
export const __collect = $drain;
// a closure that captures counted addresses holds a count on each until V8 collects it
const closures = new FinalizationRegistry(ps => { finalizable--; for (const p of ps) __release(p); });
export function __hold(fn, ...ps) {
  for (const p of ps) __retain(p);
  closures.register(fn, ps);
  finalizable++;
  return fn;
}
// a counted spawn argument: retained for the thread, which releases it when its function returns
class CountedArg { constructor(a) { this.a = a; } }
export const __ref = a => new CountedArg(__retain(a));
// where get() records the counted values it reads: a thread's arguments, released when its function
// returns, or null, when the reader owns them (a channel message's receiver)
let countedInto = null;
export const __isCounted = v => v instanceof CountedArg;

// boxing: where a struct or SharedArray value (an address) flows into `any`, `unknown`, a generic
// and the like, the compiler wraps it in this thread's one handle object for that address (so ===
// still holds), and unwraps it on the way back. a struct's handle is an instance of its class; a
// SharedArray's is an array-like Proxy over the same memory
export const __box = a => a ? cell(a) : null;
// for code the compiler did not lay out: `new SharedArray(Struct, n)` gives the boxed array-like
export class SharedArray {
  constructor(type, length) {
    const a = __newSharedArray(type === Number ? 8 : type === Boolean ? 1 : type, length), h = cell(a);
    __release(a); // the handle holds its own count
    return h;
  }
}
export function __unbox(v) {
  if (v == null) return 0;
  const a = typeof v === 'object' ? v.$cell : undefined;
  if (a === undefined || !(I32[a >> 2] === K_SHARED_ARRAY || I32[a >> 2] >= 100)) throw new TypeError('own: not a shared struct or SharedArray');
  return a;
}
class SharedArrayHandle {
  get length() { return I32[(this.$cell >> 2) + 1]; }
  *[Symbol.iterator]() { for (let i = 0; i < this.length; i++) yield sharedArrayGet(this.$cell, i); }
}
const isIndex = key => typeof key === 'string' && key !== '' && String(key >>> 0) === key;
function sharedArrayAddress(a, i) {
  if (!(i < I32[(a >> 2) + 1])) oob(a, i);
  return a + 16 + i * I32[(a >> 2) + 2];
}
// numbers and booleans are read in place; a struct element is boxed in turn
function sharedArrayGet(a, i) {
  const size = I32[(a >> 2) + 2];
  return size === 8 ? F64[sharedArrayAddress(a, i) >> 3] : size === 1 ? U8[sharedArrayAddress(a, i)] !== 0 : cell(sharedArrayAddress(a, i));
}
function sharedArrayHandle(a) {
  const target = Object.assign(Object.create(SharedArrayHandle.prototype), { $cell: a });
  return new Proxy(target, {
    get: (t, key, receiver) => isIndex(key) ? sharedArrayGet(a, Number(key)) : Reflect.get(t, key, receiver),
    set: (t, key, v, receiver) => {
      if (!isIndex(key)) return Reflect.set(t, key, v, receiver);
      const size = I32[(a >> 2) + 2];
      if (size === 1) U8[sharedArrayAddress(a, Number(key))] = v ? 1 : 0;
      else if (size === 8) F64[sharedArrayAddress(a, Number(key)) >> 3] = +v;
      else throw new TypeError('own: a SharedArray of structs holds its structs in place');
      return true;
    },
    has: (t, key) => isIndex(key) ? Number(key) < I32[(a >> 2) + 1] : Reflect.has(t, key)
  });
}
function oob(a, i) {
  throw new RangeError(`index ${i} is out of range for a SharedArray of length ${I32[(a >> 2) + 1]}`);
}
// what compiled code reads when an index is out of range, instead of calling a function: a read of
// this Proxy throws. an optimized loop with a call in it (even one never taken) loses some of V8's loop
// optimizations; a property read with no feedback costs nothing until it happens
export const __OOB = new Proxy({}, {
  get(t, i) { throw new RangeError(`index ${String(i)} is out of range for a SharedArray`); }
});

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
  const mine = countedInto = [];
  const [ key, ...args ] = read(I32[(t + 16) >> 2], false);
  countedInto = null;
  try {
    const f = byKey.get(key);
    if (f === undefined) throw new Error(`own: no function ${key} in this worker`);
    return send(f(...args));
  } finally {
    for (const p of mine) __release(p);
  }
});
// between threads, a worker yields to its event loop when handles or closures wait to be finalized
setAfterTask(() => finalizable > 0);
// in a page's worker pool (threads-worker.mjs), a worker loads a thread's module the first time a
// thread needs it: a key is `${module}#${name}`, and the loader maps a module to its import
let moduleLoader = null;
export function setModuleLoader(load) {
  moduleLoader = load;
  setBeforeTask(async t => {
    const base = I32[(t + 16) >> 2], key = get(base, I32[base >> 2] + 1, false); // the blob's [key, ...args]
    if (!byKey.has(key)) await moduleLoader(key.slice(0, key.lastIndexOf('#')));
  });
}
class Thread {
  constructor(t) { this.t = t; this.joined = false; }
  join() {
    if (this.joined) throw new TypeError('own: a thread is joined once (its result moves out)');
    this.joined = true;
    $quiescent();
    return read(threadJoin(this.t), false);
  }
  // for a page's main thread, which must not block
  async joinAsync() {
    if (this.joined) throw new TypeError('own: a thread is joined once (its result moves out)');
    this.joined = true;
    $quiescent();
    return read(await threadJoinAsync(this.t), false);
  }
}
export const spawn = (fn, ...args) => new Thread(__start(fn, args, false));
// a thread block for fn(...args), queued for the pool. a detached thread (chan.mjs go) is never
// joined, so the runtime prints its error if it throws
export function __start(fn, args, detached) {
  const key = keyOf.get(fn);
  if (key === undefined) throw new TypeError('own: spawn a top-level function of a module the compiler registered (or fns())');
  const t = $alloc(32);
  I32[t >> 2] = K_THREAD;
  I32[(t + 4) >> 2] = detached ? 1 : 0;
  I32[(t + 16) >> 2] = send([ key, ...args ]);
  $quiescent();
  spawnThread(t);
  return t;
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
    $quiescent();
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
