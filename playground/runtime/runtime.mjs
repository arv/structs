// the runtime for publish-on-escape threads in plain JS (see README.md). objects stay ordinary
// V8 objects while one thread can reach them. one moves into the shared heap (a SharedArrayBuffer)
// when its owner stores it somewhere another thread can reach: the owner copies it there, and the
// local object turns into a view of the copy. shared objects follow the threads design of
// threads/README.md: one value word per slot, readers never lock, thread-local ownership with
// handover at clean points, and a lock per object once it is really shared.
//
// a shared object is reached through a handle: a JS object whose prototype (one per shape) has
// a getter and a setter per property, reading and writing its slot in the heap. so the
// translated program reads and writes properties as plain JS does, and the engine's own inline
// caches pick the local field or the shared slot. a property the handle's shape did not have
// falls through to a Proxy at the end of the prototype chain, which looks it up in the heap

// ---- the control area: the first CTRL_BYTES of the SAB, as i32 indices ----
const C_ALLOC = 0;       // the shared bump cursor (bytes)
const C_POLL = 1;        // handovers requested and not yet done (the clean points' poll)
const C_STW_LOCK = 2;    // guards the thread table and handover lists
const C_STW_SEQ = 3;     // its condition variable
const C_NEXT_TID = 4;
const C_STR_LOCK = 5;
const C_SHAPE_LOCK = 6;
const C_ROOT_SHAPE = 7;
const C_RING_HEAD = 8, C_RING_TAIL = 9, C_PENDING = 10, C_IDLE = 11, C_SHUTDOWN = 12;
const C_LIVE = 13;       // threads spawned and not finished
const C_STR_TABLE = 14; // the interned strings' table (see $intern)
const C_HEAP_END = 16;
const C_EPOCH = 17;      // reclamation's global epoch (see $defer)
const C_FREE_LOCK = 18;  // guards the free lists
const C_PEND = 19, C_PEND_LEN = 20, C_PEND_CAP = 21, C_PEND_LOCK = 22; // decrements left by threads that ended
export const C_ACTIVITY = 23, C_SELECTING = 24; // bumped on every channel change; threads waiting in select (chan.mjs)
const C_FREE = 1100;     // free list heads: C_FREE + n for blocks of n * 8 bytes (n <= 256), C_FREE for larger
const C_CNT = 32;        // counters, see COUNTERS
const C_RING = 64, RING = 1024;
const C_THREADS = 2048, T_ENTRY = 8, MAX_THREADS = 4096;
const T_ALIVE = 0, T_CLEAN = 1, T_LEN = 2, T_CAP = 3, T_LIST = 4, T_QS = 5;
const CTRL_BYTES = 1 << 20;

export const COUNTERS = [ 'publishes', 'takeovers', 'directTakeovers', 'handoverRequests', 'handedOver', 'lockedWrites', 'slowPolls', 'threads', 'slowGets', 'slowSets', 'blocksAllocated', 'blocksFreed', 'deferred' ];
const N_PUB = 0, N_TAKEOVER = 1, N_DIRECT = 2, N_REQUEST = 3, N_HANDED = 4, N_LOCKED = 5, N_SLOWPOLL = 6, N_THREADS = 7, N_SLOWGET = 8, N_SLOWSET = 9, N_BALLOC = 10, N_BFREE = 11, N_DEFER = 12;
// counted per thread, added to the shared totals when the thread ends: one shared counter
// bumped on every locked write would itself be the most contended word in the program
const LC = new Int32Array(COUNTERS.length);
const count = n => { LC[n]++; };
const flushCounts = () => {
  for (let n = 0; n < LC.length; n++) if (LC[n] !== 0) { Atomics.add(I32, C_CNT + n, LC[n]); LC[n] = 0; }
};

// ---- block kinds and layouts (byte offsets) ----
// object: [0 kind][4 lock][8 slots][12 -][16 proto word]       slots: [0 shape][4 cap][8 words]
// array:  [0 kind][4 lock][8 slots][12 length]
// fn:     [0 kind][4 -][8 fn index][12 -][16 env word]
// lock:   [0 kind][4 -][8 state 0/1/2]   cond: [0 kind][4 -][8 seq]
// thread: [0 kind][4 detached][8 done][12 threw][16 fn word][24 result word]
// view:   [0 kind][4 -][8 byte offset][12 length]   sab: [0 kind][4 -][8 data][12 bytes]
// string: [0 kind][4 length][8 hash][12 -][16 utf-16 units]
// shape:  [0 parent][4 key][8 count][12 first child][16 next sibling]
export const K_OBJ = 1, K_ARR = 2, K_FN = 3, K_LOCK = 4, K_COND = 5, K_THREAD = 6, K_VIEW = 7, K_SAB = 8, K_STR = 9;

// lock word: an owner's tag (thread id << 12 | LOCAL), PENDING while a takeover waits on it,
// 0 when shared and unlocked, or a holder's id << 12 | depth
const LOCAL = 0x800, PENDING = 0x400, DEPTH = 0x3ff;

// in a worker the views are module constants, which the JIT can embed: the worker sets
// globalThis.__escapeSab before importing this module. a coordinator (run.mjs, page.mjs) only
// sets the heap up, through initShared, and reads it through the functions that take the buffer
const SAB = globalThis.__escapeSab ?? null;
export const I32 = SAB && new Int32Array(SAB), F64 = SAB && new Float64Array(SAB);
const U16 = SAB && new Uint16Array(SAB), U8 = SAB && new Uint8Array(SAB);
let ROOT, post, write;
let FNS = [];
let MY_TID = 0, MY_ID = 0, MY_TAG = 0, ME = 0;
const PRIV = new Int32Array(new SharedArrayBuffer(4)); // to sleep on

// a handle's (and a forwarded local object's) own fields: its block's address and kind. $fwd
// is the handle itself, or for a local object that moved to the shared heap, its handle
export const ADDR = Symbol('addr'), KIND = Symbol('kind');

// ---- value words: one f64 access, NaN-boxed when not a number ----
// a box: hi = 0xFFF80000 | tag << 11, lo = payload. boxes are built and read through this
// scratch pair, never held as JS numbers in between (engines may canonicalize a NaN they see)
export const SF = new Float64Array(1), SI = new Int32Array(SF.buffer);
const BOX_HI = 0xFFF80000 | 0;
const T_UNDEF = 1, T_NULL = 2, T_FALSE = 3, T_TRUE = 4, T_STR = 5, T_REF = 6;
export const REF_HI = BOX_HI | (T_REF << 11);
let CHECK = false;

const storeBox = (a, tag, p) => {
  SI[0] = p; SI[1] = BOX_HI | (tag << 11);
  F64[a >> 3] = SF[0];
  if (CHECK && (I32[a >> 2] !== p || I32[(a >> 2) + 1] !== (BOX_HI | (tag << 11)))) throw new Error(`value word changed on store at ${a}`);
};
// a fresh block's words, before anyone else can see it
const initUndef = (a, n) => {
  const hi = BOX_HI | (T_UNDEF << 11);
  for (let i = a >> 2, e = i + n * 2; i < e; i += 2) { I32[i] = 0; I32[i + 1] = hi; }
};

export function $enc(a, v) {
  if (typeof v === 'number') {
    if (v === v) F64[a >> 3] = v;
      else { SI[0] = 0; SI[1] = 0x7FF80000; F64[a >> 3] = SF[0]; } // x64's 0/0 is 0xFFF8..., a box
    return;
  }
  if (v === undefined) return storeBox(a, T_UNDEF, 0);
  if (v === null) return storeBox(a, T_NULL, 0);
  if (v === true) return storeBox(a, T_TRUE, 0);
  if (v === false) return storeBox(a, T_FALSE, 0);
  if (typeof v === 'string') return storeBox(a, T_STR, $intern(v));
  storeBox(a, T_REF, refAddr(v));
}

// numbers stay inline at every read; anything else is decoded out of line
export function $dec(a) {
  const w = F64[a >> 3];
  return w === w ? w : decBox(w, a);
}
export function decBox(w, a) {
  SF[0] = w;
  const hi = SI[1];
  if ((hi & BOX_HI) !== BOX_HI) return NaN;
  const p = SI[0];
  switch ((hi >>> 11) & 0xff) {
    case T_REF: return $h(p);
    case T_UNDEF: return undefined;
    case T_STR: return $str(p);
    case T_NULL: return null;
    case T_TRUE: return true;
    case T_FALSE: return false;
  }
  throw new Error(`bad value word at ${a}`);
}

// ---- slot accessors: one getter and setter per slot index, shared by every shape ----
const GET = [], SET = [];
const slotGetter = slot => GET[slot] ??= (off => function () {
  const w = F64[(I32[(this[ADDR] + 8) >> 2] + off) >> 3];
  return w === w ? w : decBox(w);
})(8 + slot * 8);
const slotSetter = slot => SET[slot] ??= (off => function (v) { setSlot(this[ADDR], off, v); })(8 + slot * 8);
// the owner writes without locking; anyone else takes the object over, then locks it
function setSlot(a, off, v) {
  if (I32[(a + 4) >> 2] === MY_TAG) { $enc(I32[(a + 8) >> 2] + off, v); return; }
  count(N_LOCKED);
  rlock(a);
  try { $enc(I32[(a + 8) >> 2] + off, v); } finally { runlock(a); }
}

// the end of every shared object's prototype chain: a property its handle's shape did not have
// (added since, or a method on its shared prototype) is looked up in the heap
const CATCH = new Proxy(Object.create(null), {
  get: (t, key, receiver) => typeof key === 'symbol' ? undefined : sgetNamed(receiver[ADDR], $intern(key)),
  set: (t, key, v, receiver) => {
    if (typeof key === 'symbol') throw new TypeError('threads: symbol keys are not shared');
    ssetNamed(receiver[ADDR], $intern(key), v);
    return true;
  },
  has: (t, key) => false
});
// a prototype per shape: accessors for the properties it has, then CATCH
const shapeProtos = new Map();
function shapeProto(shape) {
  let p = shapeProtos.get(shape);
  if (p !== undefined) return p;
  p = Object.create(CATCH);
  for (let s = shape; s !== ROOT; s = I32[s >> 2]) {
    const slot = I32[(s + 8) >> 2] - 1;
    Object.defineProperty(p, $str(I32[(s + 4) >> 2]), { get: slotGetter(slot), set: slotSetter(slot), enumerable: true });
  }
  shapeProtos.set(shape, p);
  return p;
}

// ---- handles: one per shared block per worker, so === holds ----
class SharedArray {
  constructor(a) { this[ADDR] = a; this[KIND] = K_ARR; this.$fwd = this; }
  get length() { return I32[(this[ADDR] + 12) >> 2]; }
  push(v) { return spush(this[ADDR], v); }
  *[Symbol.iterator]() { for (let i = 0; i < I32[(this[ADDR] + 12) >> 2]; i++) yield $sgeti(this, i); }
}
class SharedLock {
  constructor(a) { this[ADDR] = a; this[KIND] = K_LOCK; this.$fwd = this; }
  hold(fn) { return lockHold(this[ADDR], fn); }
}
class SharedCondition {
  constructor(a) { this[ADDR] = a; this[KIND] = K_COND; this.$fwd = this; }
  wait(lock, timeout) { return condWait(this[ADDR], lock, timeout); }
  notifyAll() { condNotify(this[ADDR], Infinity); }
  notifyOne() { condNotify(this[ADDR], 1); }
}
class SharedThread {
  constructor(a) { this[ADDR] = a; this[KIND] = K_THREAD; this.$fwd = this; }
  join() { return threadJoin(this[ADDR]); }
}
class SharedBuffer {
  constructor(a) { this[ADDR] = a; this[KIND] = K_SAB; this.$fwd = this; }
}
const makeHandle = (a, kind) => {
  switch (kind) {
    case K_OBJ: {
      const h = { __proto__: shapeProto(I32[I32[(a + 8) >> 2] >> 2]), [ADDR]: a, [KIND]: K_OBJ, $fwd: null };
      h.$fwd = h;
      return h;
    }
    case K_ARR: return new SharedArray(a);
    case K_FN: {
      // a shared function, callable
      const idx = I32[(a + 8) >> 2], env = $dec(a + 16);
      const f = function (a0, a1, a2) { return FNS[idx](env, this, a0, a1, a2); };
      f[ADDR] = a; f[KIND] = K_FN; f.$fwd = f; f.$idx = idx; f.$env = env;
      return f;
    }
    case K_LOCK: return new SharedLock(a);
    case K_COND: return new SharedCondition(a);
    case K_THREAD: return new SharedThread(a);
    case K_SAB: return new SharedBuffer(a);
    case K_VIEW: {
      const v = new Int32Array(SAB, I32[(a + 8) >> 2], I32[(a + 12) >> 2]);
      v.$rec = a;
      return v;
    }
  }
  throw new Error(`threads: no handle for kind ${kind}`);
};
export const HK = new Int32Array(1 << 16), HV = new Array(1 << 16).fill(null);
const HMAP = new Map();
export function $h(addr) {
  const i = (addr >>> 3) & 0xffff;
  if (HK[i] === addr) return HV[i];
  return hslow(addr, i);
}
function hslow(addr, i) {
  let h = HMAP.get(addr);
  if (h === undefined) HMAP.set(addr, h = makeHandle(addr, I32[addr >> 2]));
  HK[i] = addr; HV[i] = h;
  return h;
}
const newHandle = (a, kind) => {
  const h = makeHandle(a, kind);
  HMAP.set(a, h);
  return h;
};

// ---- allocation: bump, per-thread chunks. only blocks own.mjs counts are freed ($freeBlock) ----
// the cursor never passes the end: an allocation that does not fit leaves what is left to smaller
// ones, and the last chunk may be short
const CHUNK = 64 << 10;
let acur = 0, aend = 0;
export const heapFullMessage = () => `threads: the shared heap is full (${I32[C_HEAP_END] >> 20} MB)`;
export function $alloc(bytes) {
  bytes = (bytes + 7) & ~7;
  if (acur + bytes <= aend) { const p = acur; acur += bytes; return p; }
  const end = I32[C_HEAP_END];
  let p = Atomics.load(I32, C_ALLOC), want;
  for (;;) {
    const left = end - p;
    want = bytes > CHUNK >> 2 ? bytes : Math.min(CHUNK, left);
    if (want < bytes || want > left) throw new RangeError(heapFullMessage());
    const q = Atomics.compareExchange(I32, C_ALLOC, p, p + want);
    if (q === p) break;
    p = q;
  }
  if (want > bytes) { acur = p + bytes; aend = p + want; }
  return p;
}

// ---- locks on control words: futex style, 0 free, 1 held, 2 held with waiters ----
const mlock = i => {
  if (Atomics.compareExchange(I32, i, 0, 1) === 0) return;
  while (Atomics.exchange(I32, i, 2) !== 0) Atomics.wait(I32, i, 2);
};
const munlock = i => {
  if (Atomics.sub(I32, i, 1) !== 1) { Atomics.store(I32, i, 0); Atomics.notify(I32, i, 1); }
};

// ---- free lists, for the blocks own.mjs frees ----
// a block of up to 2 KiB goes on the list for its size, and each thread keeps a cache per size that
// it trades with the global lists, under one lock, a batch at a time. a larger block goes on one list
// of large blocks, in address order, from which an allocation takes the smallest that fits and puts
// back what is left of it; a large block that is freed next to another merges with it. a free block
// is [K_FREE][next] ([K_FREE][bytes][next] when large); with --check its other words are POISON, so a
// read after free stands out
const SMALL = 256, BATCH = 32;
export const K_FREE = 99, POISON = -1.2345e300;
const caches = [];
const cacheFor = c => caches[c] ?? (caches[c] = []);
// zero: whether the block must be zeroed (a message's is overwritten whole)
export function $allocBlock(bytes, zero = true) {
  bytes = (bytes + 7) & ~7;
  count(N_BALLOC);
  const c = bytes >> 3;
  let p = 0;
  if (c <= SMALL) {
    const cache = cacheFor(c);
    if (cache.length === 0 && Atomics.load(I32, C_FREE + c) !== 0) {
      mlock(C_FREE_LOCK);
      for (let q = I32[C_FREE + c]; q !== 0 && cache.length < BATCH; q = I32[C_FREE + c]) {
        I32[C_FREE + c] = I32[(q >> 2) + 1];
        cache.push(q);
      }
      munlock(C_FREE_LOCK);
    }
    if (cache.length !== 0) p = cache.pop();
  } else if (Atomics.load(I32, C_FREE) !== 0) {
    // the smallest large block that fits; what is left of it goes back on the list for its size
    mlock(C_FREE_LOCK);
    let best = 0, bestLink = 0;
    for (let link = C_FREE, q = I32[link]; q !== 0; link = (q >> 2) + 2, q = I32[link]) {
      const size = I32[(q >> 2) + 1];
      if (size >= bytes && (best === 0 || size < I32[(best >> 2) + 1])) {
        best = q; bestLink = link;
        if (size === bytes) break;
      }
    }
    if (best !== 0) {
      p = best;
      I32[bestLink] = I32[(p >> 2) + 2];
      const rest = I32[(p >> 2) + 1] - bytes;
      if (rest !== 0) freeLocked(p + bytes, rest);
    }
    munlock(C_FREE_LOCK);
  }
  if (p === 0) return $alloc(bytes); // fresh memory is zero
  if (zero) I32.fill(0, p >> 2, (p + bytes) >> 2);
  return p;
}
// under C_FREE_LOCK: a free block onto the global list for its size. a large one goes in address
// order, merged with the free blocks right before and after it
function freeLocked(p, bytes) {
  I32[p >> 2] = K_FREE;
  const c = bytes >> 3;
  if (c <= SMALL) {
    I32[(p >> 2) + 1] = I32[C_FREE + c];
    I32[C_FREE + c] = p;
    return;
  }
  let link = C_FREE, prev = 0; // link: the i32 index that points at the first block after p
  for (let q = I32[link]; q !== 0 && q < p; q = I32[link]) { prev = q; link = (q >> 2) + 2; }
  let next = I32[link];
  if (next !== 0 && p + bytes === next) {
    bytes += I32[(next >> 2) + 1];
    next = I32[(next >> 2) + 2];
  }
  if (prev !== 0 && prev + I32[(prev >> 2) + 1] === p) {
    I32[(prev >> 2) + 1] += bytes;
    I32[(prev >> 2) + 2] = next;
    return;
  }
  I32[(p >> 2) + 1] = bytes;
  I32[(p >> 2) + 2] = next;
  I32[link] = p;
}
export function $freeBlock(p, bytes) {
  bytes = (bytes + 7) & ~7;
  count(N_BFREE);
  const c = bytes >> 3;
  if (CHECK) F64.fill(POISON, p >> 3, (p + bytes) >> 3);
  I32[p >> 2] = K_FREE;
  if (c <= SMALL) {
    const cache = cacheFor(c);
    cache.push(p);
    if (cache.length >= 2 * BATCH) {
      mlock(C_FREE_LOCK);
      while (cache.length > BATCH) {
        const q = cache.pop();
        I32[(q >> 2) + 1] = I32[C_FREE + c];
        I32[C_FREE + c] = q;
      }
      munlock(C_FREE_LOCK);
    }
    return;
  }
  mlock(C_FREE_LOCK);
  freeLocked(p, bytes);
  munlock(C_FREE_LOCK);
}

// ---- deferred decrements: quiescent-state-based reclamation (see REFCOUNT.md) ----
// a decrement that may race with a reader (own.mjs: a field's old value, when the field is
// overwritten) waits until every running thread has passed a quiescent point since: a point where
// it holds no address it read from a field without counting it. each thread's T_QS word is the
// epoch it saw at its last one, IDLE while it waits; a decrement queued in epoch g is safe once
// every running thread's word is past g. a thread that ends hands what it still has to the
// shared list (C_PEND), which any thread works off
const IDLE = 0x7fffffff;
let pend = []; // this thread's queued decrements: epoch, address, epoch, address, ...
let deferHandler = null, qsTick = 0;
export const setDeferHandler = f => { deferHandler = f; };
export function $defer(p) {
  pend.push(Atomics.load(I32, C_EPOCH), p);
  count(N_DEFER);
}
export function $quiescent() {
  Atomics.store(I32, ME + T_QS, Atomics.load(I32, C_EPOCH));
  if ((++qsTick & 63) === 0 || pend.length >= 4096) reclaim();
}
// around a blocking wait: quiescent throughout
export function $waitBegin() {
  reclaim();
  Atomics.store(I32, ME + T_QS, IDLE);
}
export const $waitEnd = () => { Atomics.store(I32, ME + T_QS, Atomics.load(I32, C_EPOCH)); };
// the oldest epoch a running thread may still hold an uncounted address from
function oldestEpoch() {
  let min = IDLE;
  const n = Atomics.load(I32, C_NEXT_TID);
  for (let t = 1; t < n; t++) {
    const e = C_THREADS + t * T_ENTRY;
    if (Atomics.load(I32, e + T_ALIVE) === 1) {
      const q = Atomics.load(I32, e + T_QS);
      if (q < min) min = q;
    }
  }
  return min;
}
// apply the queued decrements that are safe now (at a quiescent point)
function reclaim() {
  if (pend.length === 0 && Atomics.load(I32, C_PEND_LEN) === 0) return;
  Atomics.add(I32, C_EPOCH, 1); // so what is queued now is older than every later quiescent point
  Atomics.store(I32, ME + T_QS, Atomics.load(I32, C_EPOCH));
  const min = oldestEpoch();
  const list = pend;
  pend = [];
  if (Atomics.load(I32, C_PEND_LEN) !== 0) { // adopt the safe ones that ended threads left
    mlock(C_PEND_LOCK);
    const b = I32[C_PEND] >> 2, n = I32[C_PEND_LEN];
    let kept = 0;
    for (let k = 0; k < n; k++) {
      const g = I32[b + 2 * k], p = I32[b + 2 * k + 1];
      if (g < min) list.push(g, p);
      else { I32[b + 2 * kept] = g; I32[b + 2 * kept + 1] = p; kept++; }
    }
    Atomics.store(I32, C_PEND_LEN, kept);
    munlock(C_PEND_LOCK);
  }
  for (let k = 0; k < list.length; k += 2) {
    if (list[k] < min) deferHandler(list[k + 1]); // may queue more, in pend
    else pend.push(list[k], list[k + 1]);
  }
}
// at a thread's end: hand the queued decrements to the shared list
function handOffPending() {
  if (pend.length === 0) return;
  mlock(C_PEND_LOCK);
  const n = I32[C_PEND_LEN], want = n + pend.length / 2;
  if (want > I32[C_PEND_CAP]) {
    const cap = Math.max(1024, want * 2), nb = $alloc(cap * 8), ob = I32[C_PEND];
    for (let k = 0; k < 2 * n; k++) I32[(nb >> 2) + k] = I32[(ob >> 2) + k];
    I32[C_PEND] = nb; I32[C_PEND_CAP] = cap;
  }
  const b = I32[C_PEND] >> 2;
  for (let k = 0; k < pend.length; k++) I32[b + 2 * n + k] = pend[k];
  Atomics.store(I32, C_PEND_LEN, want);
  munlock(C_PEND_LOCK);
  pend = [];
}
// work off every queued decrement this thread can: when no other thread is running, all of them
export function $drain() {
  for (let round = 0; round < 1000 && (pend.length !== 0 || Atomics.load(I32, C_PEND_LEN) !== 0); round++) reclaim();
}
export function $heapStats() {
  return {
    heapBytes: Atomics.load(I32, C_ALLOC) - CTRL_BYTES,
    allocated: Atomics.load(I32, C_CNT + N_BALLOC) + LC[N_BALLOC],
    freed: Atomics.load(I32, C_CNT + N_BFREE) + LC[N_BFREE],
    pending: pend.length / 2 + Atomics.load(I32, C_PEND_LEN)
  };
}
const stwBroadcast = () => { Atomics.add(I32, C_STW_SEQ, 1); Atomics.notify(I32, C_STW_SEQ); };
// holding the stw lock: release it, sleep until a broadcast, take it again
const stwWait = () => {
  const s = Atomics.load(I32, C_STW_SEQ);
  munlock(C_STW_LOCK);
  Atomics.wait(I32, C_STW_SEQ, s);
  mlock(C_STW_LOCK);
};

// ---- text in shared memory: a string is stored a byte per char when it is ASCII, and as UTF-16
// units otherwise. TextDecoder makes a string of long ASCII text several times faster than
// String.fromCharCode does, and of short text more slowly; it takes no view of shared memory, so the
// bytes are copied out first ----
const asciiDecoder = new TextDecoder();
const decodeScratch = new Uint8Array(1 << 16);
export const $isAscii = s => /^[\0-\x7f]*$/.test(s);
export function $decodeAscii(at, n) { // n chars from byte `at`
  if (n < 64) return String.fromCharCode.apply(null, U8.subarray(at, at + n));
  if (n > decodeScratch.length) return asciiDecoder.decode(U8.slice(at, at + n));
  decodeScratch.set(U8.subarray(at, at + n));
  return asciiDecoder.decode(decodeScratch.subarray(0, n));
}
export function $decodeUtf16(u, n) { // n units from U16[u]
  let s = '';
  for (let i = 0; i < n; i += 4096) s += String.fromCharCode.apply(null, U16.subarray(u + i, u + Math.min(n, i + 4096)));
  return s;
}

// ---- strings: interned, so a string's address is its identity (keys compare by address). a string
// is [K_STR][length][hash][ascii] and then its text ----
const strAddr = new Map(), addrStr = new Map();
const strHash = s => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h;
};
const strIs = (a, s) => {
  if (I32[(a + 4) >> 2] !== s.length) return false;
  if (I32[(a + 12) >> 2] !== 0) {
    for (let i = 0; i < s.length; i++) if (U8[a + 16 + i] !== s.charCodeAt(i)) return false;
  } else {
    const u = (a + 16) >> 1;
    for (let i = 0; i < s.length; i++) if (U16[u + i] !== s.charCodeAt(i)) return false;
  }
  return true;
};
// the table is a block [capacity][count] and then its slots, each 0 or a string's address. a filled
// slot never changes, so a lookup takes no lock; an insert takes C_STR_LOCK, and when the table is
// half full it doubles: the bigger table replaces it with one store. a lookup still probing the old
// table misses, and looks again under the lock. old tables are not freed (all of them together are
// no bigger than the newest), and neither are interned strings
function strFind(t, s, h) { // the string's address in table t, or -1 - the empty slot where it goes
  const slots = (t >> 2) + 2, mask = I32[t >> 2] - 1;
  for (let i = h & mask; ; i = (i + 1) & mask) {
    const a = Atomics.load(I32, slots + i);
    if (a === 0) return -1 - i;
    if (I32[(a + 8) >> 2] === h && strIs(a, s)) return a;
  }
}
function strGrow(t) { // under C_STR_LOCK
  const cap = I32[t >> 2] * 2, n = $alloc(8 + cap * 4), slots = (n >> 2) + 2, mask = cap - 1;
  I32[n >> 2] = cap; I32[(n >> 2) + 1] = I32[(t >> 2) + 1];
  for (let k = (t >> 2) + 2, end = k + (cap >> 1); k < end; k++) {
    const a = I32[k];
    if (a === 0) continue;
    let i = I32[(a + 8) >> 2] & mask;
    while (I32[slots + i] !== 0) i = (i + 1) & mask;
    I32[slots + i] = a;
  }
  Atomics.store(I32, C_STR_TABLE, n);
}
export function $intern(s) {
  let a = strAddr.get(s);
  if (a !== undefined) return a;
  const h = strHash(s);
  a = strFind(Atomics.load(I32, C_STR_TABLE), s, h);
  if (a < 0) {
    mlock(C_STR_LOCK);
    const t = Atomics.load(I32, C_STR_TABLE);
    a = strFind(t, s, h);
    if (a < 0) {
      const slot = (t >> 2) + 2 - 1 - a, ascii = $isAscii(s);
      a = $alloc(16 + s.length * (ascii ? 1 : 2));
      I32[a >> 2] = K_STR; I32[(a + 4) >> 2] = s.length; I32[(a + 8) >> 2] = h; I32[(a + 12) >> 2] = ascii ? 1 : 0;
      if (ascii) for (let k = 0; k < s.length; k++) U8[a + 16 + k] = s.charCodeAt(k);
      else for (let k = 0, u = (a + 16) >> 1; k < s.length; k++) U16[u + k] = s.charCodeAt(k);
      Atomics.store(I32, slot, a);
      if (++I32[(t >> 2) + 1] * 2 > I32[t >> 2]) strGrow(t);
    }
    munlock(C_STR_LOCK);
  }
  strAddr.set(s, a); addrStr.set(a, s);
  return a;
}
// the address of s if this thread has interned or read it already, else 0: a lookup, no hashing
export const $internedHere = s => strAddr.get(s) ?? 0;
export function $str(a) {
  let s = addrStr.get(a);
  if (s !== undefined) return s;
  const n = I32[(a + 4) >> 2];
  s = I32[(a + 12) >> 2] !== 0 ? $decodeAscii(a + 16, n) : $decodeUtf16((a + 16) >> 1, n);
  addrStr.set(a, s); strAddr.set(s, a);
  return s;
}
export const $key = $intern;

// ---- shapes: immutable (parent, key) chains. transitions are shared, under a lock. a
// key's slot never changes once added (nothing is deleted), so an accessor made for one shape
// is right for every shape after it ----
const kidCache = new Map();
function transition(shape, key) {
  let m = kidCache.get(shape);
  if (m === undefined) kidCache.set(shape, m = new Map());
  let c = m.get(key);
  if (c !== undefined) return c;
  mlock(C_SHAPE_LOCK);
  for (c = I32[(shape + 12) >> 2]; c !== 0; c = I32[(c + 16) >> 2]) if (I32[(c + 4) >> 2] === key) break;
  if (c === 0) {
    c = $alloc(24);
    I32[c >> 2] = shape; I32[(c + 4) >> 2] = key; I32[(c + 8) >> 2] = I32[(shape + 8) >> 2] + 1;
    I32[(c + 16) >> 2] = I32[(shape + 12) >> 2];
    Atomics.store(I32, (shape + 12) >> 2, c);
  }
  munlock(C_SHAPE_LOCK);
  m.set(key, c);
  return c;
}
const slotOf = (shape, key) => {
  for (let s = shape; s !== ROOT; s = I32[s >> 2]) if (I32[(s + 4) >> 2] === key) return I32[(s + 8) >> 2] - 1;
  return -1;
};
const shapeKeys = shape => {
  const keys = [];
  for (let s = shape; s !== ROOT; s = I32[s >> 2]) keys.push($str(I32[(s + 4) >> 2]));
  return keys.reverse();
};
const newSlots = cap => {
  const b = $alloc(8 + cap * 8);
  I32[b >> 2] = ROOT; I32[(b + 4) >> 2] = cap;
  initUndef(b + 8, cap);
  return b;
};

// ---- thread-local ownership (threads/README.md; render.js porf_ttl_* and porf_rlock) ----
function releaseMine() { // holding the stw lock
  const len = I32[ME + T_LEN];
  if (len === 0) return;
  const pending = MY_TAG | PENDING, list = I32[ME + T_LIST] >> 2;
  for (let k = 0; k < len; k++) {
    const li = I32[list + k] >> 2;
    if (Atomics.load(I32, li) === pending) Atomics.store(I32, li, 0);
  }
  Atomics.sub(I32, C_POLL, len);
  LC[N_HANDED] += len;
  Atomics.store(I32, ME + T_LEN, 0);
  stwBroadcast();
}
// a clean point that found a handover requested (of anyone's: the poll word is global)
export function $clean() {
  count(N_SLOWPOLL);
  if (Atomics.load(I32, ME + T_LEN) === 0) return false;
  mlock(C_STW_LOCK);
  releaseMine();
  munlock(C_STW_LOCK);
  return false;
}
// around a blocking wait: meanwhile other threads take this thread's objects directly
const cleanEnter = () => {
  $waitBegin();
  mlock(C_STW_LOCK);
  releaseMine();
  Atomics.store(I32, ME + T_CLEAN, 1);
  munlock(C_STW_LOCK);
};
const cleanExit = () => {
  mlock(C_STW_LOCK);
  Atomics.store(I32, ME + T_CLEAN, 0);
  munlock(C_STW_LOCK);
  $waitEnd();
};
const listPush = (owner, addr) => { // holding the stw lock
  const len = I32[owner + T_LEN];
  let list = I32[owner + T_LIST];
  if (len === I32[owner + T_CAP]) {
    const cap = len ? len * 2 : 64, nl = $alloc(cap * 4);
    for (let k = 0; k < len; k++) I32[(nl >> 2) + k] = I32[(list >> 2) + k];
    I32[owner + T_LIST] = list = nl; I32[owner + T_CAP] = cap;
  }
  I32[(list >> 2) + len] = addr;
  Atomics.store(I32, owner + T_LEN, len + 1);
};
// another thread's object this thread wants to write: returns once it is shared
function takeover(li) {
  count(N_TAKEOVER);
  mlock(C_STW_LOCK);
  let waiting = false;
  for (;;) {
    const v = Atomics.load(I32, li);
    if (!(v & LOCAL)) break;
    const owner = C_THREADS + (v >>> 12) * T_ENTRY;
    if (Atomics.load(I32, owner + T_ALIVE) === 0 || Atomics.load(I32, owner + T_CLEAN) !== 0) {
      // the owner is gone, or blocked between operations: nothing of it is midway
      if (Atomics.compareExchange(I32, li, v, 0) === v) count(N_DIRECT);
      continue;
    }
    if (!(v & PENDING)) {
      if (Atomics.compareExchange(I32, li, v, v | PENDING) !== v) continue;
      listPush(owner, li << 2);
      Atomics.add(I32, C_POLL, 1);
      count(N_REQUEST);
    }
    if (!waiting) {
      releaseMine();
      Atomics.store(I32, ME + T_CLEAN, 1);
      waiting = true;
    }
    stwWait();
  }
  if (waiting) Atomics.store(I32, ME + T_CLEAN, 0);
  munlock(C_STW_LOCK);
}
// a lock word at byte address a + 4: nothing for the owner, else a reentrant lock
function rlock(a) {
  const li = (a + 4) >> 2;
  if (I32[li] === MY_TAG) return;
  let spins = 0;
  for (;;) {
    const v = Atomics.load(I32, li);
    if ((v & ~PENDING) === MY_TAG) return; // ours with a takeover pending: still lock-free
    if (v & LOCAL) { takeover(li); continue; }
    if (v !== 0 && (v & ~DEPTH) === MY_ID) { I32[li] = v + 1; return; }
    if (v === 0 && Atomics.compareExchange(I32, li, 0, MY_ID | 1) === 0) return;
    if (I32[C_POLL] !== 0) $clean();
    if (++spins > 64) Atomics.wait(PRIV, 0, 0, 0.02);
  }
}
function runlock(a) {
  const li = (a + 4) >> 2, v = I32[li];
  if (v & LOCAL) return;
  if ((v & DEPTH) === 1) Atomics.store(I32, li, 0);
    else I32[li] = v - 1;
}

// ---- publishing: copy what a local value reaches into the shared heap ----
// a class prototype keeps its handle here: it stays as it is, since its local instances use it
const classProtos = new WeakSet(), protoHandles = new WeakMap();
function refAddr(v) {
  const a = v[ADDR];
  if (a !== undefined) return a;
  if (protoHandles.has(v)) return protoHandles.get(v)[ADDR];
  if (v instanceof Int32Array) return viewRec(v);
  return publish(v)[ADDR];
}
export function $pub(v) {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return v;
  if (v.$fwd !== undefined) return v.$fwd;
  if (protoHandles.has(v)) return protoHandles.get(v);
  if (v instanceof Int32Array) return $h(viewRec(v));
  return publish(v);
}
function publish(v) {
  count(N_PUB);
  if (Array.isArray(v)) {
    // a local array keeps its elements but forwards: element reads and writes, and array
    // methods and length, check $fwd (see expand.mjs) and go to the shared copy
    const n = v.length, a = $alloc(16), blk = newSlots(n < 4 ? 4 : n);
    I32[a >> 2] = K_ARR; I32[(a + 4) >> 2] = MY_TAG;
    const h = newHandle(a, K_ARR);
    v[ADDR] = a; v.$fwd = h; // before what it reaches, for cycles
    for (let i = 0; i < n; i++) $enc(blk + 8 + (i << 3), v[i]);
    I32[(a + 8) >> 2] = blk; I32[(a + 12) >> 2] = n;
    return h;
  }
  if (typeof v === 'function') {
    if (v.$idx === undefined) throw new TypeError(`threads: cannot share a host function (${v.name})`);
    const a = $alloc(24);
    I32[a >> 2] = K_FN; I32[(a + 8) >> 2] = v.$idx;
    initUndef(a + 16, 1);
    v[ADDR] = a; v[KIND] = K_FN;
    $enc(a + 16, v.$env);
    // the local function stays callable as it is, and is its own handle
    v.$fwd = v;
    HMAP.set(a, v);
    return v;
  }
  const proto = Object.getPrototypeOf(v);
  const isProto = classProtos.has(v);
  if (proto !== Object.prototype && !classProtos.has(proto) && !isProto) throw new TypeError('threads: cannot share this kind of object');
  const keys = Object.keys(v), n = keys.length;
  const a = $alloc(24), blk = newSlots(n < 4 ? 4 : n);
  I32[a >> 2] = K_OBJ; I32[(a + 4) >> 2] = MY_TAG;
  I32[(a + 8) >> 2] = blk;
  // the handle exists before what the object reaches is published, for cycles: so the shape it
  // starts with is the empty one, and its properties go through CATCH until it is made again
  const pending = { [ADDR]: a };
  if (isProto) protoHandles.set(v, pending); else { v[ADDR] = a; v.$fwd = pending; }
  if (proto === Object.prototype || isProto) initUndef(a + 16, 1);
    else $enc(a + 16, proto);
  let shape = ROOT;
  for (let k = 0; k < n; k++) {
    shape = transition(shape, $intern(keys[k]));
    $enc(blk + 8 + (k << 3), v[keys[k]]);
  }
  I32[blk >> 2] = shape;
  const h = newHandle(a, K_OBJ);
  if (isProto) { protoHandles.set(v, h); return h; }
  // the local object becomes a view of its copy: each property an accessor of its slot, then
  // the shared object's chain (so new properties and methods go to the heap too)
  for (let k = 0; k < n; k++) Object.defineProperty(v, keys[k], { get: slotGetter(k), set: slotSetter(k), enumerable: true, configurable: true });
  v[KIND] = K_OBJ; v.$fwd = h;
  Object.setPrototypeOf(v, CATCH);
  return h;
}
function viewRec(v) {
  if (v.$rec !== undefined) return v.$rec;
  if (v.buffer !== SAB) throw new TypeError('threads: only views of shared buffers can be shared');
  const a = $alloc(16);
  I32[a >> 2] = K_VIEW; I32[(a + 8) >> 2] = v.byteOffset; I32[(a + 12) >> 2] = v.length;
  v.$rec = a;
  HMAP.set(a, v);
  return a;
}

// ---- shared objects by key, off the accessors' path: reads never lock ----
function sgetNamed(a, key) {
  count(N_SLOWGET);
  if (I32[a >> 2] !== K_OBJ) return undefined;
  const blk = I32[(a + 8) >> 2], slot = slotOf(I32[blk >> 2], key);
  if (slot >= 0) return $dec(blk + 8 + (slot << 3));
  const proto = $dec(a + 16);
  return proto != null && typeof proto === 'object' && proto[ADDR] !== undefined ? sgetNamed(proto[ADDR], key) : undefined;
}
function ssetNamed(a, key, v) {
  count(N_SLOWSET);
  if (I32[a >> 2] !== K_OBJ) throw new TypeError(`threads: cannot set ${$str(key)} here`);
  if (I32[(a + 4) >> 2] === MY_TAG) return ssetBody(a, key, v);
  count(N_LOCKED);
  rlock(a);
  try { return ssetBody(a, key, v); } finally { runlock(a); }
}
function ssetBody(a, key, v) {
  const blk = I32[(a + 8) >> 2], shape = I32[blk >> 2];
  let slot = slotOf(shape, key);
  if (slot >= 0) { $enc(blk + 8 + (slot << 3), v); return v; }
  // a new property: the value before the shape that has it, so a racing reader never finds
  // the key without its value. past capacity, into a copied block published whole
  const ns = transition(shape, key);
  slot = I32[(ns + 8) >> 2] - 1;
  const cap = I32[(blk + 4) >> 2];
  if (slot < cap) {
    $enc(blk + 8 + (slot << 3), v);
    Atomics.store(I32, blk >> 2, ns);
  } else {
    const nb = newSlots(cap * 2);
    for (let i = (blk + 8) >> 2, j = (nb + 8) >> 2, e = i + cap * 2; i < e; i++, j++) I32[j] = I32[i];
    $enc(nb + 8 + (slot << 3), v);
    I32[nb >> 2] = ns;
    Atomics.store(I32, (a + 8) >> 2, nb);
  }
  return v;
}
// what a forwarding array (or anything) reaches by a name an array also has: see expand.mjs
let K_length, K_push;
export function $sget(h, key) {
  if (h[KIND] === K_ARR && key === K_length) return I32[(h[ADDR] + 12) >> 2];
  if (h[KIND] === K_OBJ) return sgetNamed(h[ADDR], key);
  return h[$str(key)];
}
export function $sset(h, key, v) {
  if (h[KIND] === K_OBJ) return ssetNamed(h[ADDR], key, v);
  throw new TypeError(`threads: cannot set ${$str(key)} on a shared ${h.constructor?.name ?? 'value'}`);
}
export function $scall(h, key, a0, a1, a2) {
  if (h[KIND] === K_ARR && key === K_push) return spush(h[ADDR], a0);
  const f = h[KIND] === K_OBJ ? sgetNamed(h[ADDR], key) : h[$str(key)];
  if (typeof f !== 'function') throw new TypeError(`threads: ${$str(key)} is not a function here`);
  return f.call(h, a0, a1, a2);
}

// ---- shared arrays: capacity never shrinks; a grow publishes the block before the length ----
export function $sgeti(h, i) {
  if (h[KIND] !== K_ARR) throw new TypeError('threads: indexing a shared non-array');
  const a = h[ADDR];
  if (!(i >= 0 && i < I32[(a + 12) >> 2]) || (i | 0) !== i) return undefined;
  const blk = I32[(a + 8) >> 2];
  if (i >= I32[(blk + 4) >> 2]) return undefined;
  return $dec(blk + 8 + (i << 3));
}
function arrStore(a, i, v) { // owner, or holding the lock
  let blk = I32[(a + 8) >> 2];
  const cap = I32[(blk + 4) >> 2];
  if (i >= cap) {
    const ncap = Math.max(cap * 2, i + 1), nb = newSlots(ncap);
    for (let s = (blk + 8) >> 2, d = (nb + 8) >> 2, e = s + cap * 2; s < e; s++, d++) I32[d] = I32[s];
    Atomics.store(I32, (a + 8) >> 2, nb);
    blk = nb;
  }
  $enc(blk + 8 + (i << 3), v);
  if (i >= I32[(a + 12) >> 2]) Atomics.store(I32, (a + 12) >> 2, i + 1);
}
export function $sseti(h, i, v) {
  if (h[KIND] !== K_ARR || !(i >= 0 && (i | 0) === i)) throw new TypeError('threads: unsupported shared element write');
  const a = h[ADDR];
  if (I32[(a + 4) >> 2] === MY_TAG) { arrStore(a, i, v); return v; }
  count(N_LOCKED);
  rlock(a);
  try { arrStore(a, i, v); } finally { runlock(a); }
  return v;
}
function spush(a, v) {
  if (I32[(a + 4) >> 2] === MY_TAG) { arrStore(a, I32[(a + 12) >> 2], v); return I32[(a + 12) >> 2]; }
  count(N_LOCKED);
  rlock(a);
  try { arrStore(a, I32[(a + 12) >> 2], v); return I32[(a + 12) >> 2]; } finally { runlock(a); }
}

// ---- functions and classes ----
// a function value: an index into the module's table and the environment it captured
export function $closure(idx, env) {
  const f = function (a0, a1, a2) { return FNS[idx](env, this, a0, a1, a2); };
  f.$idx = idx; f.$env = env;
  return f;
}
export function $fns(table) {
  const names = Object.keys(table), index = {};
  FNS = names.map((n, i) => { index[n] = i; return table[n]; });
  return index;
}
// a class: its prototype holds methods by table index
export function $class(ctor, methods) {
  const proto = {};
  for (const [ name, idx ] of Object.entries(methods)) proto[name] = $closure(idx, undefined);
  classProtos.add(proto);
  return { ctor, proto };
}
export function $new(cls, a0, a1, a2) {
  const o = Object.create(cls.proto);
  FNS[cls.ctor](undefined, o, a0, a1, a2);
  return o;
}

// ---- Lock, Condition, Thread, SharedArrayBuffer ----
export function $newLock() {
  const a = $alloc(16);
  I32[a >> 2] = K_LOCK;
  return newHandle(a, K_LOCK);
}
const lockAcquire = a => {
  const i = (a + 8) >> 2;
  if (Atomics.compareExchange(I32, i, 0, 1) === 0) return;
  cleanEnter();
  while (Atomics.exchange(I32, i, 2) !== 0) Atomics.wait(I32, i, 2);
  cleanExit();
};
const lockRelease = a => {
  const i = (a + 8) >> 2;
  if (Atomics.sub(I32, i, 1) !== 1) { Atomics.store(I32, i, 0); Atomics.notify(I32, i, 1); }
};
function lockHold(a, fn) {
  lockAcquire(a);
  try { return fn(); } finally { lockRelease(a); }
}
export function $newCond() {
  const a = $alloc(16);
  I32[a >> 2] = K_COND;
  return newHandle(a, K_COND);
}
function condWait(a, lock, timeout) {
  const si = (a + 8) >> 2, seq = Atomics.load(I32, si);
  lockRelease(lock[ADDR]);
  cleanEnter();
  const r = Atomics.wait(I32, si, seq, timeout ?? Infinity);
  cleanExit();
  lockAcquire(lock[ADDR]);
  return r !== 'timed-out';
}
function condNotify(a, n) {
  const si = (a + 8) >> 2;
  Atomics.add(I32, si, 1);
  Atomics.notify(I32, si, n);
}

export function $newThread(fn) {
  if (typeof fn !== 'function') throw new TypeError('Thread: argument must be a function');
  const t = $alloc(32);
  I32[t >> 2] = K_THREAD;
  initUndef(t + 24, 1);
  $enc(t + 16, fn); // publishes the function and everything it captured
  spawnThread(t);
  return newHandle(t, K_THREAD);
}
// queue a thread block for the pool (own.mjs makes its own blocks)
export function spawnThread(t) {
  Atomics.add(I32, C_LIVE, 1);
  const tail = Atomics.add(I32, C_RING_TAIL, 1);
  if (tail - Atomics.load(I32, C_RING_HEAD) >= RING) throw new RangeError('threads: too many threads waiting to start');
  Atomics.store(I32, C_RING + (tail % RING), t);
  const pending = Atomics.add(I32, C_PENDING, 1) + 1;
  Atomics.notify(I32, C_PENDING, 1);
  if (Atomics.load(I32, C_IDLE) < pending) post({ type: 'grow' });
}
export function threadJoin(a) {
  const di = (a + 8) >> 2;
  if (Atomics.load(I32, di) === 0) {
    cleanEnter();
    while (Atomics.load(I32, di) === 0) Atomics.wait(I32, di, 0);
    cleanExit();
  }
  return threadResult(a);
}
// the same without blocking, for a thread that must not (a page's main thread)
export async function threadJoinAsync(a) {
  const di = (a + 8) >> 2;
  while (Atomics.load(I32, di) === 0) {
    const w = Atomics.waitAsync(I32, di, 0);
    if (!w.async) continue;
    const alive = setTimeout(() => {}, 1 << 30); // node lets a worker exit on a bare waitAsync
    try { await w.value; } finally { clearTimeout(alive); }
  }
  return threadResult(a);
}
function threadResult(a) {
  const r = $dec(a + 24);
  if (I32[(a + 12) >> 2]) throw r;
  return r;
}

export function $newSAB(bytes) {
  const a = $alloc(16), data = $alloc(bytes);
  I32[a >> 2] = K_SAB; I32[(a + 8) >> 2] = data; I32[(a + 12) >> 2] = bytes;
  return newHandle(a, K_SAB);
}
export function $newTA(Ctor, buf) {
  if (Ctor !== Int32Array || !(buf instanceof SharedBuffer)) throw new TypeError('threads: only new Int32Array(sharedBuffer)');
  return new Int32Array(SAB, I32[(buf[ADDR] + 8) >> 2], I32[(buf[ADDR] + 12) >> 2] >> 2);
}

// ---- iteration, equality, printing ----
// a local array, or the shared one a local array forwards to (iterable either way)
export const $iter = x => x.$fwd === undefined ? x : x.$fwd;
export function $eq(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const fa = a.$fwd;
  return fa !== undefined && fa === b.$fwd;
}
const show = v => {
  if (typeof v === 'string') return v;
  if (v != null && typeof v === 'object' && v.$fwd !== undefined) {
    const h = v.$fwd;
    if (h instanceof SharedArray) return `[ ${Array.from(h, x => typeof x === 'string' ? `'${x}'` : show(x)).join(', ')} ]`;
    if (h[KIND] === K_OBJ) {
      const blk = I32[(h[ADDR] + 8) >> 2];
      return `{ ${shapeKeys(I32[blk >> 2]).map(k => `${k}: ${show(sgetNamed(h[ADDR], $intern(k)))}`).join(', ')} }`;
    }
    return `[shared ${h.constructor?.name ?? 'object'}]`;
  }
  return String(v);
};
export function $log(...args) {
  write(args.map(show).join(' ') + '\n');
}

// ---- setup and the worker side ----
export function initShared(sab) { // once, before any worker starts
  const i32 = new Int32Array(sab), cap = 1 << 12;
  const root = CTRL_BYTES, table = root + 24; // the root shape (all zero) and the string table
  i32[C_ROOT_SHAPE] = root;
  i32[C_STR_TABLE] = table; i32[table >> 2] = cap; // [capacity][count], then the slots
  i32[C_ALLOC] = table + 8 + cap * 4;
  i32[C_HEAP_END] = sab.byteLength;
  i32[C_NEXT_TID] = 2; // the program's main thread is 1
  i32[C_EPOCH] = 1;
}
export function attach(sab, opts, postMessage, writeOut) {
  if (sab !== SAB) throw new Error('threads: attach to the heap the worker was started with');
  ROOT = I32[C_ROOT_SHAPE];
  post = postMessage;
  write = writeOut;
  CHECK = !!opts.check;
  K_length = $intern('length'); K_push = $intern('push');
  $intern(HEAP_FULL()); // so that a thread can report a full heap without allocating
}
const HEAP_FULL = () => `RangeError: ${heapFullMessage()}`;
export const $ctrl = () => I32;

export function threadBegin(tid) {
  if (tid >= MAX_THREADS) throw new RangeError('threads: out of thread ids');
  MY_TID = tid; MY_ID = tid << 12; MY_TAG = MY_ID | LOCAL; ME = C_THREADS + tid * T_ENTRY;
  I32[ME + T_LEN] = 0; I32[ME + T_CAP] = 0; I32[ME + T_LIST] = 0;
  Atomics.store(I32, ME + T_CLEAN, 0);
  Atomics.store(I32, ME + T_QS, Atomics.load(I32, C_EPOCH));
  Atomics.store(I32, ME + T_ALIVE, 1);
}
export function threadEnd() {
  reclaim();
  handOffPending();
  flushCounts();
  mlock(C_STW_LOCK);
  releaseMine();
  Atomics.store(I32, ME + T_ALIVE, 0);
  stwBroadcast();
  munlock(C_STW_LOCK);
}
// what a pool thread runs, given its block: by default the function stored in it (own.mjs
// replaces this)
let threadEntry = t => $dec(t + 16)();
export const setThreadEntry = f => { threadEntry = f; };
// whether a worker should give its event loop a turn after a thread (own.mjs: when V8 may have
// handles to finalize, which a FinalizationRegistry does only between tasks)
let afterTask = () => false;
export const setAfterTask = f => { afterTask = f; };
// what a worker does before it runs a thread, if anything (own.mjs: load the thread's module)
let beforeTask = null;
export const setBeforeTask = f => { beforeTask = f; };
const eventLoopTurn = () => new Promise(resolve => {
  const ch = new MessageChannel();
  ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
  ch.port2.postMessage(0);
});
function runThread(t) {
  threadBegin(Atomics.add(I32, C_NEXT_TID, 1));
  count(N_THREADS);
  let r, threw = 0;
  try {
    r = threadEntry(t);
  } catch (e) {
    r = e instanceof Error ? String(e) : e;
    threw = 1;
  }
  // the result, or what went wrong storing it. a full heap is reported with a message interned when
  // the worker attached, which needs no memory: whoever joins the thread must hear that it ended
  try {
    $enc(t + 24, r);
  } catch (e) {
    threw = 1;
    try { $enc(t + 24, String(e)); } catch { $enc(t + 24, HEAP_FULL()); }
  }
  I32[(t + 12) >> 2] = threw;
  const detached = I32[(t + 4) >> 2] === 1; // only own.mjs's threads are: nothing joins them
  try {
    if (threw && detached) $log(`a detached thread threw: ${r}`);
    threadEnd();
  } finally {
    Atomics.store(I32, (t + 8) >> 2, 1);
    Atomics.notify(I32, (t + 8) >> 2);
    if (detached) $freeBlock(t, 32);
    if (Atomics.sub(I32, C_LIVE, 1) === 1) Atomics.notify(I32, C_LIVE);
  }
}
// a pool worker: take threads off the queue until shutdown
// while it has handles to finalize it waits asynchronously, so its event loop runs the registry
export async function poolLoop() {
  for (;;) {
    if (afterTask()) { await eventLoopTurn(); flushCounts(); }
    Atomics.add(I32, C_IDLE, 1);
    let p;
    for (;;) {
      if (Atomics.load(I32, C_SHUTDOWN)) return;
      p = Atomics.load(I32, C_PENDING);
      if (p === 0) {
        if (afterTask()) {
          const w = Atomics.waitAsync(I32, C_PENDING, 0, 50);
          if (w.async) {
            const alive = setTimeout(() => {}, 60); // node lets a worker exit on a bare waitAsync
            await w.value;
            clearTimeout(alive);
          }
          flushCounts();
        } else Atomics.wait(I32, C_PENDING, 0);
        continue;
      }
      if (Atomics.compareExchange(I32, C_PENDING, p, p - 1) === p) break;
    }
    Atomics.sub(I32, C_IDLE, 1);
    const q = C_RING + (Atomics.add(I32, C_RING_HEAD, 1) % RING);
    let t;
    while ((t = Atomics.load(I32, q)) === 0) Atomics.wait(PRIV, 0, 0, 0.01);
    Atomics.store(I32, q, 0);
    if (beforeTask !== null) await beforeTask(t);
    runThread(t);
  }
}
// the program's main thread lives until every thread it started has finished
export function waitAllThreads() {
  let n;
  if (Atomics.load(I32, C_LIVE) === 0) return;
  cleanEnter();
  while ((n = Atomics.load(I32, C_LIVE)) !== 0) Atomics.wait(I32, C_LIVE, n);
  cleanExit();
}
export function shutdown(sab) {
  const i32 = new Int32Array(sab);
  Atomics.store(i32, C_SHUTDOWN, 1);
  Atomics.notify(i32, C_PENDING);
}
export function counters(sab) {
  const i32 = new Int32Array(sab), out = {};
  COUNTERS.forEach((n, i) => { out[n] = i32[C_CNT + i]; });
  out.heapBytes = i32[C_ALLOC] - CTRL_BYTES;
  return out;
}

// a page makes the heap itself (heap.mjs) and has no coordinator to set it up: the first runtime to
// load on a fresh heap does. a coordinator (run.mjs, page.mjs) calls initShared before any worker starts
if (SAB && Atomics.compareExchange(I32, C_ALLOC, 0, -1) === 0) initShared(SAB);
