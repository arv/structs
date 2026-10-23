// The memory every agent shares: one SharedArrayBuffer, the heap.
// Shared structs, Shared Arrays, Mutexes and Conditions live in it, and so do
// the strings their fields hold, interned. Memory is allocated in blocks, from
// free lists and then from the end; the collector (gc.ts) frees the shared
// objects no agent can reach. Interned strings are never freed.
//
// An agent (the main thread, a worker) attaches to the heap once. The first
// one makes it; a worker gets it from whoever started it (agent.ts).
//
// The heap's size is fixed (HEAP_SIZE, unless attach is given another), so
// its views never change: compiled code may keep them in locals (fast.ts).
// Memory the heap never uses is not committed, so the size is a reservation.

// ---- the control area: the first CTRL bytes, as Int32 indices ----
const C_TOP = 0; // the end of the blocks, in bytes: memory after it is unused
const C_STR_LOCK = 1; // guards the string table
const C_STR_TABLE = 2; // the table's address
const C_STR_COUNT = 3;
const C_STR_CAP = 4;
const C_AGENTS = 5; // the last agent id given out
// guards the blocks and the free lists, and the collector holds it while it
// runs (gc.ts)
export const C_ALLOC_LOCK = 6;
const C_USED = 7; // the bytes of the blocks in use
const C_SINCE = 8; // the bytes allocated since the last collection
const C_LIVE = 9; // the bytes in use after the last collection
const C_COLLECTIONS = 10;
const C_HIGH = 11; // the heap is zero after this address: never allocated
export const C_GC = 16; // the collector's words (gc.ts): 16 to 31
const C_LOCKS = 64; // striped locks for atomic field access (see fieldLock)
const LOCKS = 64;
const C_SMALL = 128; // free lists of blocks up to SMALL bytes, by size / 8
const C_BINS = 256; // free lists of larger blocks, by log2 of size
export const CTRL = 2048;

// Atomics as the engine has it: the runtime's own words are typed array
// elements, and the overloads (atomics.ts) only add a check to those
export const A = {
  add: Atomics.add,
  compareExchange: Atomics.compareExchange,
  exchange: Atomics.exchange,
  load: Atomics.load,
  notify: Atomics.notify,
  store: Atomics.store,
  sub: Atomics.sub,
  wait: Atomics.wait,
};

export const HEAP_SIZE = 256 << 20;
// addresses are tagged in the low 3 bits of an Int32 (see encode), so the heap
// stays under 2 GB
export const MAX_HEAP = 1 << 30;

declare global {
  // the heap, as an agent attaches to it
  var __structsHeap: SharedArrayBuffer | undefined;
}

export let SAB: SharedArrayBuffer;
export let I32: Int32Array;
export let F64: Float64Array;
let U16: Uint16Array;
// this agent's id, for a Mutex's owner: 1 and up
export let AGENT = 0;

// whether this agent may block in Atomics.wait (AgentCanSuspend): a browser's
// main thread may not
export const CAN_BLOCK = (() => {
  try {
    A.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 1, 0);
    return true;
  } catch {
    return false;
  }
})();

export const attached = () => AGENT !== 0;

// Attaches this agent to `sab`, or to a new heap of HEAP_SIZE bytes.
export function attach(sab?: SharedArrayBuffer) {
  if (AGENT !== 0) {
    if (sab && sab !== SAB) throw new Error('structs: already attached');
    return SAB;
  }
  SAB = sab ?? new SharedArrayBuffer(HEAP_SIZE);
  if (
    (SAB as any).growable ||
    SAB.byteLength > MAX_HEAP ||
    SAB.byteLength < CTRL
  )
    throw new Error(
      `structs: the heap must be a SharedArrayBuffer of a fixed size, ${CTRL} bytes to ${MAX_HEAP >> 20} MB`,
    );
  I32 = new Int32Array(SAB);
  F64 = new Float64Array(SAB);
  U16 = new Uint16Array(SAB);
  // a heap no agent has used yet: its blocks begin after the control area
  if (A.compareExchange(I32, C_TOP, 0, CTRL) === 0) A.store(I32, C_HIGH, CTRL);
  globalThis.__structsHeap = SAB;
  AGENT = A.add(I32, C_AGENTS, 1) + 1;
  return SAB;
}

// Attaches this agent on its first use of the heap: to the heap it was given
// (a Node worker's workerData, from agent.ts), or to a new one. A browser
// worker waits for its heap, which the first message brings (agent.ts).
export function requireHeap() {
  if (AGENT !== 0) return;
  const given = globalThis.__structsHeap ?? nodeWorkerHeap();
  if (given) {
    attach(given);
    return;
  }
  if (typeof (globalThis as any).WorkerGlobalScope !== 'undefined')
    throw new Error(
      'structs: this worker has no heap yet (it comes with the first message from the agent that started it, see agent.ts)',
    );
  attach();
}

function nodeWorkerHeap(): SharedArrayBuffer | undefined {
  const wt = (globalThis as any).process?.getBuiltinModule?.(
    'node:worker_threads',
  );
  return wt && !wt.isMainThread ? wt.workerData?.__structsHeap : undefined;
}

// ---- allocation ----
// A block is a header of two words, then what alloc returns, its payload:
//
//   [size in bytes, the header's too | its kind][the collector's mark]
//
// A free block's payload begins with the next in its free list. Blocks are
// laid end to end from CTRL to C_TOP, so the collector can walk them.
export const B_FREE = 0,
  B_OBJECT = 1, // a shared object: the collector frees it when unreachable
  B_RAW = 2; // anything else (a string, a table): freed by whoever made it
const SMALL = 1016;
// a collection runs once this many bytes have been allocated since the last
// one, or as many as were in use after it, whichever is more
const MIN_SINCE = 16 << 20;

// what alloc calls when the heap runs short, holding the allocation lock:
// the collector, once gc.ts has loaded. Called again (`tries` 1, 2) while
// the heap is still short, it tries harder.
let collector: ((tries: number) => void) | null = null;
export const setCollector = (f: (tries: number) => void) =>
  void (collector = f);

// the block at `b`'s size and kind
export const sizeAt = (b: number) => I32[b >> 2]! & ~7;
export const kindAt = (b: number) => I32[b >> 2]! & 7;
export const top = () => I32[C_TOP]!;

const listOf = (size: number) =>
  size <= SMALL ? C_SMALL + (size >> 3) : C_BINS + 31 - Math.clz32(size);

// puts the free block at `b` on its list
function release(b: number, size: number) {
  I32[b >> 2] = size | B_FREE;
  const l = listOf(size);
  I32[(b >> 2) + 2] = I32[l]!;
  I32[l] = b;
}

// a free block of `need` bytes or more, off its list (0 for none): an exact
// small one, else the first that fits in the bins, split, else from the end
function take(need: number) {
  if (need <= SMALL) {
    const l = C_SMALL + (need >> 3),
      b = I32[l]!;
    if (b !== 0) {
      I32[l] = I32[(b >> 2) + 2]!;
      return b;
    }
  }
  for (let l = listOf(Math.max(need, SMALL + 8)); l < C_BINS + 32; l++) {
    // `at` is the word that points at b: the list's, or the block before's
    for (let at = l, b = I32[l]!; b !== 0; at = (b >> 2) + 2, b = I32[at]!) {
      const size = sizeAt(b);
      if (size < need) continue;
      I32[at] = I32[(b >> 2) + 2]!;
      if (size - need >= 16) {
        release(b + need, size - need);
        I32[b >> 2] = need;
      }
      return b;
    }
  }
  const b = I32[C_TOP]!;
  if (b + need > SAB.byteLength) return 0;
  I32[C_TOP] = b + need;
  I32[b >> 2] = need;
  return b;
}

const full = () =>
  new RangeError(
    `structs: the heap is full (${SAB.byteLength >> 20} MB, ${I32[C_USED]! >> 20} MB of it in use)`,
  );

// A block whose payload is `bytes` long, rounded up to 8, of `kind`, zeroed;
// its payload's address. The caller holds the allocation lock.
export function allocLocked(bytes: number, kind: number) {
  if (bytes > SAB.byteLength) throw full();
  const need = Math.max(16, (bytes + 15) & ~7);
  if (collector && I32[C_SINCE]! >= Math.max(MIN_SINCE, I32[C_LIVE]!))
    collector(0);
  let b = take(need);
  for (let tries = 0; b === 0 && collector && tries < 3; tries++) {
    collector(tries);
    b = take(need);
  }
  if (b === 0) throw full();
  const size = sizeAt(b),
    p = b + 8,
    end = b + size,
    high = I32[C_HIGH]!;
  I32[b >> 2] = size | kind;
  I32[(b >> 2) + 1] = 0;
  if (p < high) I32.fill(0, p >> 2, Math.min(end, high) >> 2);
  if (end > high) I32[C_HIGH] = end;
  I32[C_USED] += size;
  I32[C_SINCE] += size;
  return p;
}

// A block whose payload is `bytes` long, rounded up to 8, zeroed: its
// payload's address. Raw: the caller frees it.
export function alloc(bytes: number, kind = B_RAW) {
  requireHeap();
  lock(C_ALLOC_LOCK);
  try {
    return allocLocked(bytes, kind);
  } finally {
    unlock(C_ALLOC_LOCK);
  }
}

// Frees the block whose payload is at `p`. The caller holds the allocation
// lock.
export function freeLocked(p: number) {
  const size = sizeAt(p - 8);
  I32[C_USED] -= size;
  release(p - 8, size);
}

export function free(p: number) {
  lock(C_ALLOC_LOCK);
  try {
    freeLocked(p);
  } finally {
    unlock(C_ALLOC_LOCK);
  }
}

// The collector's sweep: frees every block `dead` says is, joining those
// side by side, and makes the free lists anew. Under the allocation lock.
export function sweep(dead: (b: number, kind: number) => boolean) {
  I32.fill(0, C_SMALL, C_BINS + 32);
  let used = 0,
    run = 0;
  const end = I32[C_TOP]!;
  for (let b = CTRL; b < end;) {
    const h = I32[b >> 2]!,
      size = h & ~7;
    if ((h & 7) === B_FREE || dead(b, h & 7)) {
      if (run === 0) run = b;
    } else {
      used += size;
      if (run !== 0) release(run, b - run);
      run = 0;
    }
    b += size;
  }
  // the free blocks at the end are the end again
  if (run !== 0) I32[C_TOP] = run;
  I32[C_USED] = used;
  I32[C_LIVE] = used;
  I32[C_SINCE] = 0;
  I32[C_COLLECTIONS]++;
  return used;
}

// The heap's views, for compiled code to keep in locals (fast.ts); this
// agent attached first. An agent that cannot attach yet (a browser worker
// waiting for its heap) gets empty views: it has no shared object to read.
const NO_I32 = new Int32Array(0),
  NO_F64 = new Float64Array(0);
export function views(): {I32: Int32Array; F64: Float64Array} {
  if (AGENT === 0) {
    try {
      requireHeap();
    } catch {
      return {I32: NO_I32, F64: NO_F64};
    }
  }
  return {I32, F64};
}

// ---- locks: a word, 0 free, 1 held, 2 held with waiters (Drepper's mutex)
export function lock(i: number) {
  let c = A.compareExchange(I32, i, 0, 1);
  if (c === 0) return;
  for (let spin = 0; spin < 100; spin++) {
    if (A.load(I32, i) === 0 && (c = A.compareExchange(I32, i, 0, 1)) === 0)
      return;
  }
  if (c !== 2) c = A.exchange(I32, i, 2);
  while (c !== 0) {
    // an agent that cannot block spins: these locks are held briefly
    if (CAN_BLOCK) A.wait(I32, i, 2);
    c = A.exchange(I32, i, 2);
  }
}

export function unlock(i: number) {
  if (A.sub(I32, i, 1) !== 1) {
    A.store(I32, i, 0);
    A.notify(I32, i, 1);
  }
}

// the lock that orders the atomic accesses (Atomics.load and the rest) of the
// field slot at `slot`
export const fieldLock = (slot: number) =>
  C_LOCKS + ((slot >> 4) & (LOCKS - 1));

// ---- interned strings: [length][hash][UTF-16 code units] ----
// The table is open addressing over the strings' addresses. Each agent keeps
// its own maps both ways, so a string it has seen costs no lock.
const STR_HEAD = 8;
const toAddr = new Map<string, number>();
const fromAddr = new Map<number, string>();

const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h | 0;
};

function equalsAt(a: number, s: string) {
  if (I32[a >> 2] !== s.length) return false;
  const u = (a + STR_HEAD) >> 1;
  for (let i = 0; i < s.length; i++)
    if (U16[u + i] !== s.charCodeAt(i)) return false;
  return true;
}

// the slot of `s` in the table at `t` (capacity `cap`): its index, where its
// address is or where it goes
function probe(t: number, cap: number, s: string, h: number) {
  for (let i = h & (cap - 1); ; i = (i + 1) & (cap - 1)) {
    const a = I32[(t >> 2) + i];
    if (a === 0 || (I32[(a >> 2) + 1] === h && equalsAt(a, s))) return i;
  }
}

function grow() {
  const cap = I32[C_STR_CAP],
    t = I32[C_STR_TABLE];
  const ncap = cap === 0 ? 1024 : cap * 2;
  const nt = alloc(ncap * 4);
  for (let i = 0; i < cap; i++) {
    const a = I32[(t >> 2) + i];
    if (a === 0) continue;
    let j = I32[(a >> 2) + 1] & (ncap - 1);
    while (I32[(nt >> 2) + j] !== 0) j = (j + 1) & (ncap - 1);
    I32[(nt >> 2) + j] = a;
  }
  I32[C_STR_TABLE] = nt;
  I32[C_STR_CAP] = ncap;
  if (t !== 0) free(t);
}

// The address of `s`, interned.
export function intern(s: string) {
  let a = toAddr.get(s);
  if (a !== undefined) return a;
  requireHeap();
  const h = hash(s);
  lock(C_STR_LOCK);
  try {
    if ((I32[C_STR_COUNT] + 1) * 2 > I32[C_STR_CAP]) grow();
    const t = I32[C_STR_TABLE],
      i = probe(t, I32[C_STR_CAP], s, h);
    a = I32[(t >> 2) + i];
    if (a === 0) {
      a = alloc(STR_HEAD + s.length * 2);
      I32[a >> 2] = s.length;
      I32[(a >> 2) + 1] = h;
      const u = (a + STR_HEAD) >> 1;
      for (let k = 0; k < s.length; k++) U16[u + k] = s.charCodeAt(k);
      I32[(t >> 2) + i] = a;
      I32[C_STR_COUNT]++;
    }
  } finally {
    unlock(C_STR_LOCK);
  }
  toAddr.set(s, a);
  fromAddr.set(a, s);
  return a;
}

// The string interned at `a`.
export function stringAt(a: number) {
  let s = fromAddr.get(a);
  if (s !== undefined) return s;
  const n = I32[a >> 2]!;
  const u = (a + STR_HEAD) >> 1;
  // copied out: the decoders do not read shared memory
  const units = U16.slice(u, u + n);
  s = '';
  for (let i = 0; i < n; i += 8192)
    s += String.fromCharCode.apply(null, units.subarray(i, i + 8192) as any);
  fromAddr.set(a, s);
  toAddr.set(s, a);
  return s;
}

// The heap's size and use, in bytes, and how many collections have run.
export function heapStats() {
  requireHeap();
  lock(C_ALLOC_LOCK);
  try {
    return {
      size: SAB.byteLength,
      used: I32[C_USED]!,
      strings: I32[C_STR_COUNT]!,
      collections: I32[C_COLLECTIONS]!,
    };
  } finally {
    unlock(C_ALLOC_LOCK);
  }
}
