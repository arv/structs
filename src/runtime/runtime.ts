// the shared heap under own and shared values (own.ts), channels (chan.ts) and
// maps (maps.ts): one SharedArrayBuffer, its memory (bump allocation and free
// lists), interned strings, the deferred decrements of reference counting
// (REFCOUNT.md), and the pool of workers that run threads, blocking ones and
// async ones

// ---- the control area: the first CTRL_BYTES of the SAB, as i32 indices ----
const C_ALLOC = 0; // the shared bump cursor (bytes)
const C_NEXT_TID = 4;
const C_STR_LOCK = 5;
const C_RING_HEAD = 8,
  C_RING_TAIL = 9,
  C_PENDING = 10,
  C_IDLE = 11,
  C_SHUTDOWN = 12;
const C_LIVE = 13; // threads spawned and not finished
const C_STR_TABLE = 14; // the interned strings' table (see $intern)
const C_STR_SERIAL = 15; // the last string's serial (see $intern)
const C_HEAP_END = 16;
const C_EPOCH = 17; // reclamation's global epoch (see $defer)
const C_FREE_LOCK = 18; // guards the free lists
const C_PEND = 19,
  C_PEND_LEN = 20,
  C_PEND_CAP = 21,
  C_PEND_LOCK = 22; // decrements left by threads that ended
export const C_ACTIVITY = 23,
  // bumped on every channel change; threads waiting in select (chan.ts)
  C_SELECTING = 24;
const C_AQ_LOCK = 25,
  C_AQ_HEAD = 26,
  C_AQ_TAIL = 27,
  C_AQ_LEN = 28; // async threads waiting for a host (see spawnAsync)
const C_HOSTS = 29,
  C_DRAFTS = 30; // workers that host async threads, and idle workers asked to
// free list heads: C_FREE + n for blocks of n * 8 bytes (n <= 256), C_FREE for
// larger
const C_FREE = 1100;
const C_CNT = 32; // counters, see COUNTERS
const C_RING = 64,
  RING = 1024;
const C_THREADS = 2048,
  T_ENTRY = 8,
  MAX_THREADS = 4096;
const T_ALIVE = 0,
  T_QS = 5,
  T_HOST = 6,
  T_BELL = 7;
const CTRL_BYTES = 1 << 20;

const COUNTERS = ['threads', 'blocksAllocated', 'blocksFreed', 'deferred'];
const N_THREADS = 0,
  N_BALLOC = 1,
  N_BFREE = 2,
  N_DEFER = 3;
// counted per thread, added to the shared totals when the thread ends: one
// shared counter bumped on every allocation would itself be a contended word
const LC = new Int32Array(COUNTERS.length);
const count: (n: number) => void = n => {
  LC[n]++;
};
const flushCounts = () => {
  for (let n = 0; n < LC.length; n++)
    if (LC[n] !== 0) {
      Atomics.add(I32, C_CNT + n, LC[n]);
      LC[n] = 0;
    }
};

// ---- block kinds and layouts (byte offsets) ----
// thread: [0 kind][4 detached][8 done][12 threw][16 its arguments' message:
//         address][20 bytes][24 its result: a message's address, or what it
//         threw, an interned string] (see own.ts __start)
// string: see $intern
export const K_THREAD = 6,
  K_STR = 9,
  K_STR_TABLE = 10;

// in a worker the views are module constants, which the JIT can embed: the
// worker sets globalThis.__escapeSab before importing this module. a
// coordinator (src/run.ts, src/page.ts) only sets the heap up, through
// initShared, and reads it through the functions that take the buffer
declare global {
  var __escapeSab: SharedArrayBuffer | undefined;
}
const SAB = globalThis.__escapeSab ?? null;
export const I32 = SAB! && new Int32Array(SAB),
  F64 = SAB! && new Float64Array(SAB);
const U16 = SAB! && new Uint16Array(SAB),
  U8 = SAB! && new Uint8Array(SAB);
let post: (message: Message) => void, write: (text: string) => void;
let ME = 0; // this thread's entry in the thread table
const PRIV = new Int32Array(new SharedArrayBuffer(4)); // to sleep on
// whether this thread may block (a page's main thread may not: a lock spins
// there instead)
export const CAN_BLOCK = (() => {
  try {
    Atomics.wait(PRIV, 0, 1, 0);
    return true;
  } catch {
    return false;
  }
})();

// what a pool worker posts to the page (browser.ts)
export type Message =
  | {type: 'out'; text: string}
  | {type: 'grow'}
  | {type: 'ready'}
  | {type: 'crash'; message: string};

let CHECK = false;
// the runtime's check option: slower, stricter (poisons freed blocks)
export const $checking = () => CHECK;

// ---- allocation: bump, per-thread chunks. only blocks own.ts counts are freed
// ($freeBlock) ----
// the cursor never passes the end: an allocation that does not fit leaves what
// is left to smaller ones, and the last chunk may be short
const CHUNK = 64 << 10;
let acur = 0,
  aend = 0;
const heapFullMessage = () =>
  `threads: the shared heap is full (${I32[C_HEAP_END] >> 20} MB)`;
export function $alloc(bytes: number) {
  bytes = (bytes + 7) & ~7;
  if (acur + bytes <= aend) {
    const p = acur;
    acur += bytes;
    return p;
  }
  const end = I32[C_HEAP_END];
  let p = Atomics.load(I32, C_ALLOC),
    want;
  for (;;) {
    const left = end - p;
    want = bytes > CHUNK >> 2 ? bytes : Math.min(CHUNK, left);
    if (want < bytes || want > left) throw new RangeError(heapFullMessage());
    const q = Atomics.compareExchange(I32, C_ALLOC, p, p + want);
    if (q === p) break;
    p = q;
  }
  if (want > bytes) {
    acur = p + bytes;
    aend = p + want;
  }
  return p;
}

// ---- locks on control words: futex style, 0 free, 1 held, 2 held with waiters.
// held only for a few loads and stores, so a thread spins a little before it
// sleeps ----
const LOCK_SPINS = 1000;
const mlock: (i: number) => void = i => {
  if (Atomics.compareExchange(I32, i, 0, 1) === 0) return;
  for (let k = 0; k < LOCK_SPINS; k++)
    if (
      Atomics.load(I32, i) === 0 &&
      Atomics.compareExchange(I32, i, 0, 1) === 0
    )
      return;
  while (Atomics.exchange(I32, i, 2) !== 0)
    if (CAN_BLOCK) Atomics.wait(I32, i, 2);
};
const munlock: (i: number) => void = i => {
  if (Atomics.sub(I32, i, 1) !== 1) {
    Atomics.store(I32, i, 0);
    Atomics.notify(I32, i, 1);
  }
};
// the same for a cell's lock word (a channel's, a map's): held only for a few
// loads and stores, never across a wait or user code
export const $lock = mlock,
  $unlock = munlock;

// ---- free lists, for the blocks own.ts frees ----
// a block of up to 2 KiB goes on the list for its size, and each thread keeps a
// cache per size that it trades with the global lists, under one lock, a batch
// at a time. a larger block goes on one list of large blocks, in address order,
// from which an allocation takes the smallest that fits and puts back what is
// left of it; a large block that is freed next to another merges with it. a
// free block is [K_FREE][next] ([K_FREE][bytes][next] when large); with --check
// its other words are POISON, so a read after free stands out
const SMALL = 256,
  BATCH = 32;
export const K_FREE = 99,
  POISON = -1.2345e300;
const caches: number[][] = [];
const cacheFor: (c: number) => number[] = c => caches[c] ?? (caches[c] = []);
// zero: whether the block must be zeroed (a message's is overwritten whole)
export function $allocBlock(bytes: number, zero = true) {
  bytes = (bytes + 7) & ~7;
  count(N_BALLOC);
  const c = bytes >> 3;
  let p = 0;
  if (c <= SMALL) {
    const cache = cacheFor(c);
    if (cache.length === 0 && Atomics.load(I32, C_FREE + c) !== 0) {
      mlock(C_FREE_LOCK);
      for (
        let q = I32[C_FREE + c];
        q !== 0 && cache.length < BATCH;
        q = I32[C_FREE + c]
      ) {
        I32[C_FREE + c] = I32[(q >> 2) + 1];
        cache.push(q);
      }
      munlock(C_FREE_LOCK);
    }
    if (cache.length !== 0) p = cache.pop()!;
  } else if (Atomics.load(I32, C_FREE) !== 0) {
    // the smallest large block that fits; what is left of it goes back on the
    // list for its size
    mlock(C_FREE_LOCK);
    let best = 0,
      bestLink = 0;
    for (
      let link = C_FREE, q = I32[link];
      q !== 0;
      link = (q >> 2) + 2, q = I32[link]
    ) {
      const size = I32[(q >> 2) + 1];
      if (size >= bytes && (best === 0 || size < I32[(best >> 2) + 1])) {
        best = q;
        bestLink = link;
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
// under C_FREE_LOCK: a free block onto the global list for its size. a large
// one goes in address order, merged with the free blocks right before and after
// it
function freeLocked(p: number, bytes: number) {
  I32[p >> 2] = K_FREE;
  const c = bytes >> 3;
  if (c <= SMALL) {
    I32[(p >> 2) + 1] = I32[C_FREE + c];
    I32[C_FREE + c] = p;
    return;
  }
  let link = C_FREE,
    prev = 0; // link: the i32 index that points at the first block after p
  for (let q = I32[link]; q !== 0 && q < p; q = I32[link]) {
    prev = q;
    link = (q >> 2) + 2;
  }
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
export function $freeBlock(p: number, bytes: number) {
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
        const q = cache.pop()!;
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

// ---- deferred decrements: quiescent-state-based reclamation (see REFCOUNT.md)
// ----
// a decrement that may race with a reader (own.ts: a field's old value, when
// the field is overwritten) waits until every running thread has passed a
// quiescent point since: a point where it holds no address it read from a field
// without counting it. each thread's T_QS word is the epoch it saw at its last
// one, IDLE while it waits; a decrement queued in epoch g is safe once every
// running thread's word is past g. a thread that ends hands what it still has
// to the shared list (C_PEND), which any thread works off
const IDLE = 0x7fffffff;
// this thread's queued decrements: epoch, address, epoch, address, ... (an
// address -p is a block to free, see retire)
let pend: number[] = [];
let deferHandler: ((p: number) => void) | null = null,
  qsTick = 0;
export const setDeferHandler: (f: (p: number) => void) => void = f => {
  deferHandler = f;
};
export function $defer(p: number) {
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
export const $waitEnd = () => {
  Atomics.store(I32, ME + T_QS, Atomics.load(I32, C_EPOCH));
};
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
  // so what is queued now is older than every later quiescent point
  Atomics.add(I32, C_EPOCH, 1);
  Atomics.store(I32, ME + T_QS, Atomics.load(I32, C_EPOCH));
  const min = oldestEpoch();
  const list = pend;
  pend = [];
  if (Atomics.load(I32, C_PEND_LEN) !== 0) {
    // adopt the safe ones that ended threads left
    mlock(C_PEND_LOCK);
    const b = I32[C_PEND] >> 2,
      n = I32[C_PEND_LEN];
    let kept = 0;
    for (let k = 0; k < n; k++) {
      const g = I32[b + 2 * k],
        p = I32[b + 2 * k + 1];
      if (g < min) list.push(g, p);
      else {
        I32[b + 2 * kept] = g;
        I32[b + 2 * kept + 1] = p;
        kept++;
      }
    }
    Atomics.store(I32, C_PEND_LEN, kept);
    munlock(C_PEND_LOCK);
  }
  for (let k = 0; k < list.length; k += 2) {
    if (list[k] >= min) pend.push(list[k], list[k + 1]);
    else if (list[k + 1] < 0) retire(-list[k + 1]);
    else deferHandler!(list[k + 1]); // may queue more, in pend
  }
  if (pend.length >= 4096) nudgeHosts();
}
// a host whose async threads all wait passes no quiescent point until one
// resumes: ring the bells of those behind, so that each passes one (see
// hostTurn)
function nudgeHosts() {
  const n = Atomics.load(I32, C_NEXT_TID),
    epoch = Atomics.load(I32, C_EPOCH);
  for (let t = 1; t < n; t++) {
    const e = C_THREADS + t * T_ENTRY;
    if (
      e !== ME &&
      Atomics.load(I32, e + T_HOST) === 1 &&
      Atomics.load(I32, e + T_QS) < epoch
    )
      ring(e);
  }
}
// at a thread's end: hand the queued decrements to the shared list
function handOffPending() {
  if (pend.length === 0) return;
  mlock(C_PEND_LOCK);
  const n = I32[C_PEND_LEN],
    want = n + pend.length / 2;
  if (want > I32[C_PEND_CAP]) {
    const cap = Math.max(1024, want * 2),
      nb = $alloc(cap * 8),
      ob = I32[C_PEND];
    for (let k = 0; k < 2 * n; k++) I32[(nb >> 2) + k] = I32[(ob >> 2) + k];
    I32[C_PEND] = nb;
    I32[C_PEND_CAP] = cap;
  }
  const b = I32[C_PEND] >> 2;
  for (let k = 0; k < pend.length; k++) I32[b + 2 * n + k] = pend[k];
  Atomics.store(I32, C_PEND_LEN, want);
  munlock(C_PEND_LOCK);
  pend = [];
}
// work off every queued decrement this thread can: when no other thread is
// running, all of them
export function $drain() {
  for (
    let round = 0;
    round < 1000 && (pend.length !== 0 || Atomics.load(I32, C_PEND_LEN) !== 0);
    round++
  )
    reclaim();
}
export function $heapStats() {
  return {
    heapBytes: Atomics.load(I32, C_ALLOC) - CTRL_BYTES,
    allocated: Atomics.load(I32, C_CNT + N_BALLOC) + LC[N_BALLOC],
    freed: Atomics.load(I32, C_CNT + N_BFREE) + LC[N_BFREE],
    pending: pend.length / 2 + Atomics.load(I32, C_PEND_LEN),
  };
}
// ---- text in shared memory: a string is stored a byte per char when it is
// ASCII, and as UTF-16 units otherwise. TextDecoder makes a string of long
// ASCII text several times faster than String.fromCharCode does, and of short
// text more slowly; it takes no view of shared memory, so the bytes are copied
// out first ----
const asciiDecoder = new TextDecoder();
const decodeScratch = new Uint8Array(1 << 16);
const $isAscii: (s: string) => boolean = s => /^[\0-\x7f]*$/.test(s);
export function $decodeAscii(at: number, n: number) {
  // n chars from byte `at`
  if (n < 64)
    return String.fromCharCode.apply(null, U8.subarray(at, at + n) as never);
  if (n > decodeScratch.length)
    return asciiDecoder.decode(U8.slice(at, at + n));
  decodeScratch.set(U8.subarray(at, at + n));
  return asciiDecoder.decode(decodeScratch.subarray(0, n));
}
export function $decodeUtf16(u: number, n: number) {
  // n units from U16[u]
  let s = '';
  for (let i = 0; i < n; i += 4096)
    s += String.fromCharCode.apply(
      null,
      U16.subarray(u + i, u + Math.min(n, i + 4096)) as never,
    );
  return s;
}

// ---- strings: interned, so a string's address is its identity (keys compare
// by address), and counted, so a string goes when nothing refers to it any
// more: a struct's str field, a SharedArray<string>'s element, a map's key or
// value, a message (REFCOUNT.md). a string is [K_STR][count][length][hash]
// [ASCII][serial] and then its text, a byte per char if it is ASCII, else
// UTF-16 units. a pinned string has PIN in its count, and stays: the structs'
// layouts, and the message for a full heap. a string whose count reaches 0
// leaves the table at once, its count DEAD so that nothing counts it again, and
// its block goes a grace period later, once every thread has passed a
// quiescent point (see $defer): a lookup that found it before it left may be
// reading it still. no two strings have one serial, so this thread's caches
// (address -> string, string -> address) tell by it whether a block is still
// the string they knew ----
const STR_HEAD = 24,
  PIN = 1 << 30,
  DEAD = 1 << 31,
  TOMB = 1; // a slot whose string left
// this thread's caches, each with the string's serial
const strAddr = new Map<string, [number, number]>(),
  addrStr = new Map<number, [string, number]>();
const remember = (s: string, a: number) => {
  if (addrStr.size >= 1 << 14) {
    addrStr.clear();
    strAddr.clear();
  }
  const serial = I32[(a >> 2) + 5];
  addrStr.set(a, [s, serial]);
  strAddr.set(s, [a, serial]);
};
// the address of s, if this thread knows it and its block is still s
function known(s: string) {
  const k = strAddr.get(s);
  if (k === undefined) return 0;
  const a = k[0];
  return I32[a >> 2] === K_STR && I32[(a >> 2) + 5] === k[1] ? a : 0;
}
const strHash: (s: string) => number = s => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h;
};
const strBytes = (a: number) =>
  STR_HEAD + I32[(a >> 2) + 2] * (I32[(a >> 2) + 4] !== 0 ? 1 : 2);
const strIs = (a: number, s: string) => {
  if (I32[(a >> 2) + 2] !== s.length) return false;
  if (I32[(a >> 2) + 4] !== 0) {
    for (let i = 0; i < s.length; i++)
      if (U8[a + STR_HEAD + i] !== s.charCodeAt(i)) return false;
  } else {
    const u = (a + STR_HEAD) >> 1;
    for (let i = 0; i < s.length; i++)
      if (U16[u + i] !== s.charCodeAt(i)) return false;
  }
  return true;
};
// the table is a block [K_STR_TABLE][capacity][used][live] and then its slots,
// each 0, a string's address, or TOMB where one left. a lookup takes no lock;
// an insert or a removal takes C_STR_LOCK. a slot is used once, so when used
// slots (live and left) fill half the table, a new table with only the live
// ones, about four times as big as they need, replaces it with one store, and
// the old one goes a grace period later. a lookup still probing the old table
// may miss, and looks again under the lock
const MIN_TABLE = 1 << 12;
function strFind(t: number, s: string, h: number) {
  // the string's address in table t, or -1 - the empty slot where it goes
  const slots = (t >> 2) + 4,
    mask = I32[(t >> 2) + 1] - 1;
  for (let i = h & mask; ; i = (i + 1) & mask) {
    const a = Atomics.load(I32, slots + i);
    if (a === 0) return -1 - i;
    if (a !== TOMB && I32[(a >> 2) + 3] === h && strIs(a, s)) return a;
  }
}
function strResize(t: number) {
  // under C_STR_LOCK
  const live = I32[(t >> 2) + 3];
  let cap = MIN_TABLE;
  while (cap < live * 4) cap *= 2;
  const n = $allocBlock(16 + cap * 4),
    slots = (n >> 2) + 4,
    mask = cap - 1;
  I32[n >> 2] = K_STR_TABLE;
  I32[(n >> 2) + 1] = cap;
  I32[(n >> 2) + 2] = live;
  I32[(n >> 2) + 3] = live;
  for (let k = (t >> 2) + 4, end = k + I32[(t >> 2) + 1]; k < end; k++) {
    const a = I32[k];
    if (a === 0 || a === TOMB) continue;
    let i = I32[(a >> 2) + 3] & mask;
    while (I32[slots + i] !== 0) i = (i + 1) & mask;
    I32[slots + i] = a;
  }
  Atomics.store(I32, C_STR_TABLE, n);
  $defer(-t);
}
// a new string in table t's empty slot -1 - at, with count count
function strAdd(t: number, at: number, s: string, h: number, count: number) {
  // under C_STR_LOCK
  // a pinned string stays: bump-allocated, as nothing will free it
  const ascii = $isAscii(s),
    bytes = STR_HEAD + s.length * (ascii ? 1 : 2),
    a = count >= PIN ? $alloc(bytes) : $allocBlock(bytes, false);
  I32[a >> 2] = K_STR;
  I32[(a >> 2) + 1] = count;
  I32[(a >> 2) + 2] = s.length;
  I32[(a >> 2) + 3] = h;
  I32[(a >> 2) + 4] = ascii ? 1 : 0;
  I32[(a >> 2) + 5] = Atomics.add(I32, C_STR_SERIAL, 1) + 1;
  if (ascii)
    for (let k = 0; k < s.length; k++) U8[a + STR_HEAD + k] = s.charCodeAt(k);
  else
    for (let k = 0, u = (a + STR_HEAD) >> 1; k < s.length; k++)
      U16[u + k] = s.charCodeAt(k);
  Atomics.store(I32, (t >> 2) + 4 + (-1 - at), a);
  I32[(t >> 2) + 3]++;
  if (++I32[(t >> 2) + 2] * 2 > I32[(t >> 2) + 1]) strResize(t);
  return a;
}
// adds add to string a's count if it is alive, or at 0 and not yet DEAD (the
// count brings it back: $stringDying sees it); pinning (add PIN) does nothing
// to a pinned one, and waits for the lock if a's count is 0
function strCount(a: number, add: number) {
  const i = (a >> 2) + 1;
  if (add !== PIN) {
    if (Atomics.add(I32, i, add) >= 0) return true;
    Atomics.sub(I32, i, add); // DEAD: as it was
    return false;
  }
  for (let c = Atomics.load(I32, i); c > 0; c = Atomics.load(I32, i))
    if (c >= PIN || Atomics.compareExchange(I32, i, c, c + PIN) === c)
      return true;
  return false;
}
// s's string with add added to its count (PIN or 1), made if there is none
function intern(s: string, add: number) {
  let a = known(s);
  if (a !== 0 && strCount(a, add)) return a;
  const h = strHash(s);
  a = strFind(Atomics.load(I32, C_STR_TABLE), s, h);
  if (a <= 0 || !strCount(a, add)) {
    // not there, or about to leave: under the lock, a string in the table is
    // alive or at 0, which counting again brings back
    mlock(C_STR_LOCK);
    const t = Atomics.load(I32, C_STR_TABLE);
    a = strFind(t, s, h);
    if (a < 0) a = strAdd(t, a, s, h, add);
    else if (add !== PIN || Atomics.load(I32, (a >> 2) + 1) < PIN)
      Atomics.add(I32, (a >> 2) + 1, add);
    munlock(C_STR_LOCK);
  }
  remember(s, a);
  return a;
}
// s's address, pinned: it stays
export const $intern = (s: string) => intern(s, PIN);
// s's address, with a count the caller holds and gives back with
// $releaseString ("" is 0, and has none)
export const $internRef = (s: string) => (s === '' ? 0 : intern(s, 1));
// another count on string a, if it is alive
export const $retainString = (a: number) => strCount(a, 1);
// the address of s if any thread has interned it, else 0: a lookup that adds
// nothing, and counts nothing
export function $internFind(s: string) {
  const a = known(s);
  if (a !== 0) return a;
  const f = strFind(Atomics.load(I32, C_STR_TABLE), s, strHash(s));
  return f > 0 ? f : 0;
}
// the address of s if this thread has interned or read it already and it is
// alive, else 0: a lookup, no hashing
export const $internedHere: (s: string) => number = s => {
  const a = known(s);
  return a !== 0 && Atomics.load(I32, (a >> 2) + 1) > 0 ? a : 0;
};
export function $str(a: number) {
  const k = addrStr.get(a);
  if (k !== undefined && k[1] === I32[(a >> 2) + 5]) return k[0];
  const n = I32[(a >> 2) + 2],
    s =
      I32[(a >> 2) + 4] !== 0
        ? $decodeAscii(a + STR_HEAD, n)
        : $decodeUtf16((a + STR_HEAD) >> 1, n);
  remember(s, a);
  return s;
}
// gives back a count on string a (0 for "" has none). no thread holds a
// string's address across a quiescent point (compiled code reads a string field
// as a JS string), so the decrement need not wait: a string that a reader found
// a moment ago is still there until the grace period after it leaves
export function $releaseString(a: number) {
  if (a !== 0 && Atomics.sub(I32, (a >> 2) + 1, 1) === 1) $stringDying(a);
}
// string a's count reached 0 ($releaseString, own.ts's __release): unless
// something counted it again meanwhile, it leaves the table, and its block goes
// a grace period later
export function $stringDying(a: number) {
  mlock(C_STR_LOCK);
  if (Atomics.compareExchange(I32, (a >> 2) + 1, 0, DEAD) === 0) {
    const t = Atomics.load(I32, C_STR_TABLE),
      slots = (t >> 2) + 4,
      mask = I32[(t >> 2) + 1] - 1;
    for (
      let i = I32[(a >> 2) + 3] & mask;
      I32[slots + i] !== 0;
      i = (i + 1) & mask
    )
      if (I32[slots + i] === a) {
        Atomics.store(I32, slots + i, TOMB);
        I32[(t >> 2) + 3]--;
        break;
      }
    $defer(-a);
  }
  munlock(C_STR_LOCK);
}
// a block whose grace period is over: a string that left, or a string table
// that was replaced
function retire(p: number) {
  $freeBlock(
    p,
    I32[p >> 2] === K_STR ? strBytes(p) : 16 + I32[(p >> 2) + 1] * 4,
  );
}

// ---- the pool's threads ----
// queue a thread block for the pool (own.ts __start makes them)
export function spawnThread(t: number) {
  Atomics.add(I32, C_LIVE, 1);
  enqueue(t);
}
// queue a thread block, or a DRAFT, for an idle worker; with none idle, ask the
// page for one more
function enqueue(t: number) {
  const tail = Atomics.add(I32, C_RING_TAIL, 1);
  if (tail - Atomics.load(I32, C_RING_HEAD) >= RING)
    throw new RangeError('threads: too many threads waiting to start');
  Atomics.store(I32, C_RING + (tail % RING), t);
  const pending = Atomics.add(I32, C_PENDING, 1) + 1;
  Atomics.notify(I32, C_PENDING, 1);
  if (Atomics.load(I32, C_IDLE) < pending) post({type: 'grow'});
}
// wait for thread block a to finish: its result, or what it threw thrown
export function threadJoin(a: number) {
  $mustNotBlock('join()', 'await joinAsync()');
  const di = (a + 8) >> 2;
  if (Atomics.load(I32, di) === 0) {
    $waitBegin();
    while (Atomics.load(I32, di) === 0) Atomics.wait(I32, di, 0);
    $waitEnd();
  }
  return threadResult(a);
}
// the same without blocking, for a thread that must not (a page's main thread)
export async function threadJoinAsync(a: number) {
  const di = (a + 8) >> 2;
  while (Atomics.load(I32, di) === 0) {
    const w = Atomics.waitAsync(I32, di, 0);
    if (!w.async) continue;
    // node lets a worker exit on a bare waitAsync
    const alive = setTimeout(() => {}, 1 << 30);
    try {
      await w.value;
    } finally {
      clearTimeout(alive);
    }
  }
  return threadResult(a);
}
function threadResult(a: number) {
  const r = I32[(a + 24) >> 2];
  if (I32[(a + 12) >> 2] === 0) return r;
  const what = r === 0 ? '' : $str(r);
  $releaseString(r);
  throw what;
}

// what log writes: its arguments as text, a space between
export function $log(...args: unknown[]) {
  write(args.map(v => String(v)).join(' ') + '\n');
}

// ---- setup and the worker side ----
export function initShared(sab: SharedArrayBuffer) {
  // once, before any worker starts
  const i32 = new Int32Array(sab),
    cap = MIN_TABLE,
    table = CTRL_BYTES;
  i32[C_STR_TABLE] = table;
  i32[table >> 2] = K_STR_TABLE; // see strFind
  i32[(table >> 2) + 1] = cap;
  i32[C_ALLOC] = table + 16 + cap * 4;
  i32[C_HEAP_END] = sab.byteLength;
  i32[C_NEXT_TID] = 2; // the program's main thread is 1
  i32[C_EPOCH] = 1;
}
export function attach(
  sab: SharedArrayBuffer,
  opts: {check?: boolean},
  postMessage: (message: Message) => void,
  writeOut: (text: string) => void,
) {
  if (sab !== SAB)
    throw new Error('threads: attach to the heap the worker was started with');
  post = postMessage;
  write = writeOut;
  CHECK = !!opts.check;
  // so that a thread can report a full heap without allocating
  $intern(HEAP_FULL());
}
const HEAP_FULL = () => `RangeError: ${heapFullMessage()}`;

export function threadBegin(tid: number) {
  if (tid >= MAX_THREADS) throw new RangeError('threads: out of thread ids');
  ME = C_THREADS + tid * T_ENTRY;
  Atomics.store(I32, ME + T_QS, Atomics.load(I32, C_EPOCH));
  Atomics.store(I32, ME + T_ALIVE, 1);
}
export function threadEnd() {
  reclaim();
  handOffPending();
  flushCounts();
  Atomics.store(I32, ME + T_ALIVE, 0);
}
// what a thread's function returns: its result's message address (own.ts), or
// an async function's promise of one
type Result = number | PromiseLike<number>;
// what a pool thread runs, given its block (own.ts sets it)
let threadEntry: (t: number) => Result = () => {
  throw new Error('threads: no thread entry (own.ts sets it)');
};
export const setThreadEntry: (f: (t: number) => Result) => void = f => {
  threadEntry = f;
};
// whether a worker should give its event loop a turn after a thread (own.ts:
// when V8 may have handles to finalize, which a FinalizationRegistry does only
// between tasks)
let afterTask = () => false;
export const setAfterTask: (f: () => boolean) => void = f => {
  afterTask = f;
};
// what a worker does before it runs a thread, if anything (own.ts: load the
// thread's module)
let beforeTask: ((t: number) => Promise<void>) | null = null;
export const setBeforeTask: (f: (t: number) => Promise<void>) => void = f => {
  beforeTask = f;
};
const eventLoopTurn = () =>
  new Promise<void>(resolve => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });
// a worker's thread id, the same for every thread it runs: the thread table has
// MAX_THREADS entries
let myTid = 0;
const workerTid = () => myTid || (myTid = Atomics.add(I32, C_NEXT_TID, 1));
function runThread(t: number) {
  if (!hosting) threadBegin(workerTid());
  count(N_THREADS);
  let r: Result;
  try {
    r = threadEntry(t);
  } catch (e) {
    endThread(t, 0, false, true, e);
    return;
  }
  // an async function's thread ends when its promise settles; meanwhile its
  // worker hosts it
  if (typeof r !== 'number') {
    if (!hosting) host();
    live++;
    r.then(
      v => endThread(t, v, true),
      e => endThread(t, 0, true, true, e),
    );
    return;
  }
  endThread(t, r, false);
}
// thread block t's thread ended with result r, or threw e
function endThread(
  t: number,
  r: number,
  async: boolean,
  threw = false,
  e?: unknown,
) {
  // what it threw is an interned string. a full heap is reported with a message
  // interned when the worker attached, which needs no memory: whoever joins the
  // thread must hear that it ended
  if (threw) {
    try {
      r = $internRef(String(e));
    } catch {
      r = $intern(HEAP_FULL());
      $retainString(r);
    }
  }
  I32[(t + 24) >> 2] = r;
  I32[(t + 12) >> 2] = threw ? 1 : 0;
  // nothing joins a detached thread (chan.ts go)
  const detached = I32[(t + 4) >> 2] === 1;
  try {
    if (threw && detached) {
      $log(`a detached thread threw: ${r === 0 ? '' : $str(r)}`);
      $releaseString(r);
    }
    if (async) {
      if (--live === 0 && kick !== null) kick();
    } else if (!hosting) threadEnd();
  } finally {
    Atomics.store(I32, (t + 8) >> 2, 1);
    Atomics.notify(I32, (t + 8) >> 2);
    if (detached) $freeBlock(t, 32);
    if (Atomics.sub(I32, C_LIVE, 1) === 1) Atomics.notify(I32, C_LIVE);
  }
}

// ---- async threads: many on one worker ----
// a thread whose function is async runs on a host: a pool worker that keeps its
// event loop free, so that any number of async threads wait on it at once, each
// on a promise, and their channels wake them (chan.ts). async threads wait in
// one queue for a host to take them. an idle worker becomes a host when it
// takes a DRAFT from the pool's ring, which spawnAsync queues while there are
// fewer hosts than cores and a worker is idle, or there is no host at all; a
// worker whose thread returned a promise becomes one too. a host takes no
// blocking threads, which would stop every async thread on it (a blocking call
// there throws: $mustNotBlock), until it has had no async thread for LINGER ms
const DRAFT = -1;
// ms: how often an idle worker with handles to finalize lets V8 finalize them
const FINALIZE = 50;
const HOSTS = Math.max(1, globalThis.navigator?.hardwareConcurrency ?? 8);
const LINGER = 10,
  // ms: how long a host with no async threads waits for more; between a waiting
  // host's quiescent points
  WAKE = 50;
let hosting = false,
  live = 0,
  kick: (() => void) | null = null,
  cursor = 0,
  started = 0;
// a blocking call on a host would stop every async thread on it, the one that
// would wake it perhaps
export function $mustNotBlock(what: string, instead?: string) {
  if (hosting)
    throw new TypeError(
      `threads: ${what} would block a worker that runs async functions, and every one waiting on it: ${instead ? `use ${instead}` : 'an async function must not block'}`,
    );
}
// after an async function's wait: with every other async thread of this worker
// suspended at an await (where the compiler leaves no address uncounted), a
// quiescent point (REFCOUNT.md)
export const $resumed = () => {
  if (hosting) $quiescent();
};
// queue an async thread for a host
export function spawnAsync(t: number) {
  Atomics.add(I32, C_LIVE, 1);
  mlock(C_AQ_LOCK);
  I32[(t + 24) >> 2] = 0; // the queue links blocks through their result words
  const tail = I32[C_AQ_TAIL];
  if (tail === 0) I32[C_AQ_HEAD] = t;
  else I32[(tail + 24) >> 2] = t;
  I32[C_AQ_TAIL] = t;
  Atomics.add(I32, C_AQ_LEN, 1);
  munlock(C_AQ_LOCK);
  // after queueing: a host that leaves takes what it finds queued first (see
  // hostTurn)
  const hosts = Atomics.load(I32, C_HOSTS) + Atomics.load(I32, C_DRAFTS);
  if (
    hosts === 0 ||
    (hosts < HOSTS && Atomics.load(I32, C_IDLE) > Atomics.load(I32, C_PENDING))
  ) {
    Atomics.add(I32, C_DRAFTS, 1);
    enqueue(DRAFT);
  } else ringHost();
}
function takeAsync() {
  if (Atomics.load(I32, C_AQ_LEN) === 0) return 0;
  mlock(C_AQ_LOCK);
  const t = I32[C_AQ_HEAD];
  if (t !== 0) {
    const next = I32[(t + 24) >> 2];
    I32[C_AQ_HEAD] = next;
    if (next === 0) I32[C_AQ_TAIL] = 0;
    Atomics.sub(I32, C_AQ_LEN, 1);
  }
  munlock(C_AQ_LOCK);
  return t;
}
// a host's bell: rung when there is an async thread to take, or a quiescent
// point to pass
const ring: (e: number) => void = e => {
  Atomics.add(I32, e + T_BELL, 1);
  Atomics.notify(I32, e + T_BELL);
};
// ring the next host's bell, in turn
function ringHost() {
  const n = Atomics.load(I32, C_NEXT_TID);
  for (let k = 1; k < n; k++) {
    cursor = cursor + 1 < n ? cursor + 1 : 1;
    const e = C_THREADS + cursor * T_ENTRY;
    if (Atomics.load(I32, e + T_HOST) === 1) {
      ring(e);
      return;
    }
  }
}
// the worker becomes a host (its thread begun)
function host() {
  hosting = true;
  Atomics.add(I32, C_HOSTS, 1);
  Atomics.store(I32, ME + T_HOST, 1);
}
function unhost() {
  Atomics.store(I32, ME + T_HOST, 0);
  hosting = false;
  ring(ME); // ends this worker's own wait on its bell, if one is left
  threadEnd();
}
// node lets a worker exit on a bare waitAsync
const keepAlive: (ms: number) => ReturnType<typeof setTimeout> = ms =>
  setTimeout(() => {}, ms);
// one turn of a host: start the next queued async thread, or wait for one (or
// for one of its own to end)
async function hostTurn() {
  const bell = ME + T_BELL,
    b = Atomics.load(I32, bell);
  const t = takeAsync();
  if (t !== 0) {
    if (beforeTask !== null) await beforeTask(t);
    runThread(t);
    $quiescent();
    // resumed threads run between new ones
    if ((++started & 31) === 0) await eventLoopTurn();
    return;
  }
  if (Atomics.load(I32, C_SHUTDOWN)) {
    unhost();
    return;
  }
  const idle = live === 0,
    w = Atomics.waitAsync(I32, bell, b, idle ? LINGER : WAKE);
  if (w.async) {
    const alive = keepAlive((idle ? LINGER : WAKE) + 10);
    await (idle
      ? w.value
      : Promise.race([
          w.value,
          new Promise<void>(resolve => {
            kick = resolve;
          }),
        ]));
    kick = null;
    clearTimeout(alive);
  }
  $quiescent();
  if (idle && live === 0 && Atomics.load(I32, bell) === b) {
    // no async thread for LINGER ms: back to blocking threads, unless one was
    // queued meanwhile
    Atomics.sub(I32, C_HOSTS, 1);
    if (Atomics.load(I32, C_AQ_LEN) !== 0) Atomics.add(I32, C_HOSTS, 1);
    else unhost();
  }
}
// a pool worker: take threads off the queue until shutdown; a host takes async
// threads only while it has handles to finalize it waits asynchronously, so its
// event loop runs the registry
export async function poolLoop() {
  for (;;) {
    if (hosting) {
      await hostTurn();
      continue;
    }
    if (Atomics.load(I32, C_SHUTDOWN)) return;
    // idle first: a thread queued meanwhile waits for this worker rather than
    // asking for one more
    Atomics.add(I32, C_IDLE, 1);
    if (afterTask()) {
      await eventLoopTurn();
      flushCounts();
    }
    let p: number;
    for (;;) {
      if (Atomics.load(I32, C_SHUTDOWN)) return;
      p = Atomics.load(I32, C_PENDING);
      if (p === 0) {
        if (afterTask()) {
          // V8 finalizes handles only between tasks: block, so that new work
          // wakes the worker at once, but give the event loop a turn every
          // FINALIZE ms while idle
          if (Atomics.wait(I32, C_PENDING, 0, FINALIZE) === 'timed-out') {
            await eventLoopTurn();
            flushCounts();
          }
        } else Atomics.wait(I32, C_PENDING, 0);
        continue;
      }
      if (Atomics.compareExchange(I32, C_PENDING, p, p - 1) === p) break;
    }
    Atomics.sub(I32, C_IDLE, 1);
    const q = C_RING + (Atomics.add(I32, C_RING_HEAD, 1) % RING);
    let t: number;
    while ((t = Atomics.load(I32, q)) === 0) Atomics.wait(PRIV, 0, 0, 0.01);
    Atomics.store(I32, q, 0);
    if (t === DRAFT) {
      threadBegin(workerTid());
      host();
      Atomics.sub(I32, C_DRAFTS, 1);
      continue;
    }
    if (beforeTask !== null) await beforeTask(t);
    runThread(t);
  }
}
// a program's main, on the coordinator's main worker (src/worker.ts,
// src/web-worker.ts), its thread begun: an async main is awaited, and meanwhile
// the thread passes a quiescent point every WAKE ms, so that its waits hold up
// no other thread's frees. it may: when a timer runs, main is suspended at an
// await, where the compiler leaves no address uncounted (REFCOUNT.md)
export async function runMain(main: () => unknown) {
  const r = main();
  if (!(r instanceof Promise)) return;
  const tick = setInterval($quiescent, WAKE);
  try {
    await r;
  } finally {
    clearInterval(tick);
  }
}
// the program's main thread lives until every thread it started has finished
export function waitAllThreads() {
  let n: number;
  if (Atomics.load(I32, C_LIVE) === 0) return;
  $waitBegin();
  while ((n = Atomics.load(I32, C_LIVE)) !== 0) Atomics.wait(I32, C_LIVE, n);
  $waitEnd();
}
export function shutdown(sab: SharedArrayBuffer) {
  const i32 = new Int32Array(sab);
  Atomics.store(i32, C_SHUTDOWN, 1);
  Atomics.notify(i32, C_PENDING);
}
export function counters(sab: SharedArrayBuffer) {
  const i32 = new Int32Array(sab),
    out: Record<string, number> = {};
  COUNTERS.forEach((n, i) => {
    out[n] = i32[C_CNT + i];
  });
  out.heapBytes = i32[C_ALLOC] - CTRL_BYTES;
  return out;
}

// a page makes the heap itself (heap.ts) and has no coordinator to set it up:
// the first runtime to load on a fresh heap does. a coordinator (src/run.ts,
// src/page.ts) calls initShared before any worker starts
if (SAB && Atomics.compareExchange(I32, C_ALLOC, 0, -1) === 0) initShared(SAB);
