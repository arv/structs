// The memory every agent shares: one SharedArrayBuffer, the heap.
// Shared structs, Shared Arrays, Mutexes and Conditions live in it, and so do
// the strings their fields hold, interned. Memory is bump allocated and never
// freed: there is no collector across agents (see README.md).
//
// An agent (the main thread, a worker) attaches to the heap once. The first
// one makes it; a worker gets it from whoever started it (agent.ts).
//
// The heap's size is fixed (HEAP_SIZE, unless attach is given another), so
// its views never change: compiled code may keep them in locals (fast.ts).
// Memory the heap never uses is not committed, so the size is a reservation.

// ---- the control area: the first CTRL bytes, as Int32 indices ----
const C_TOP = 0; // the bump cursor, in bytes
const C_STR_LOCK = 1; // guards the string table
const C_STR_TABLE = 2; // the table's address
const C_STR_COUNT = 3;
const C_STR_CAP = 4;
const C_AGENTS = 5; // the last agent id given out
const C_LOCKS = 64; // striped locks for atomic field access (see fieldLock)
const LOCKS = 64;
const CTRL = 1024;

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
  const fresh = !sab;
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
  if (fresh) A.store(I32, C_TOP, CTRL);
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
// `bytes` rounded up to 8, zeroed (nothing is freed, so the heap is zero
// where it was never allocated). Lock free: the cursor moves.
export function alloc(bytes: number) {
  requireHeap();
  const n = (bytes + 7) & ~7;
  const p = A.add(I32, C_TOP, n);
  if (p + n > SAB.byteLength) {
    // the cursor stays past the end: every allocation after this one fails too
    throw new RangeError(
      `structs: the heap is full (${SAB.byteLength >> 20} MB)`,
    );
  }
  return p;
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

// The heap's size and use, in bytes.
export function heapStats() {
  requireHeap();
  return {
    size: SAB.byteLength,
    used: A.load(I32, C_TOP),
    strings: A.load(I32, C_STR_COUNT),
  };
}
