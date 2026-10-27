// The collector: it frees the shared objects that no agent can reach.
//
// It is a mark and sweep over the whole heap, run by the agent whose
// allocation finds the heap short, holding the allocation lock throughout
// (no agent allocates while it runs). The other agents go on as they were:
// none has to stop or answer, since what each of them holds is in the heap,
// in its record:
//
//   its roots   the addresses it has a Proxy for (shared.ts): one goes in as
//               the Proxy is made, and comes out as the agent's
//               FinalizationRegistry says it was collected
//   its turn    if it runs compiled code that holds addresses without a
//               Proxy, read from slots (emit.ts's elem and ref): the epoch by
//               which its current turn began. The compiler keeps such an
//               address in its own function, which is neither async nor a
//               generator, and out of its closures, so none is held between
//               turns, where a timer of the agent's own says so
//   its unlinks the objects it has taken out of a slot (written over) while
//               some agent runs such code, with the epoch: each is kept while
//               a turn that began by then goes on, as that code may hold it
//   busy        1 while it takes an object out of a slot, or puts one in or
//               out of its roots, or its unlinks
//
// and an object in flight in a message is pinned (agent.ts): in the roots of
// a record of the pins, once for each message that carries it.
//
// Every way an agent gets an object from the heap makes it a root first (but
// compiled code's, which the unlinks keep): it reads the slot again inside a
// busy window and puts what it holds in its roots. So an object no agent holds, in no slot a root reaches, is garbage:
// nothing can get it back. While a collection marks, an object that goes into
// or out of an agent's roots or unlinks is shaded gray, and the collector
// marks the gray ones too. It begins only once each agent has been seen out
// of a busy window after the marking flag was set (a handshake), so a window
// either ended before or sees the flag.
//
// An object's mark is the cycle that marked it: 2 * cycle, or 2 * cycle + 1
// while it is gray, in the second word of its block's header (heap.ts).
//
// Interned strings, and so shapes, symbols and BigInts too large for a slot
// (shared.ts), are never freed.

import {
  A,
  allocLocked,
  B64,
  B_OBJECT,
  B_RAW,
  C_ALLOC_LOCK,
  CAN_BLOCK,
  C_GC,
  CTRL,
  freeLocked,
  I32,
  kindAt,
  lock,
  requireHeap,
  setCollector,
  sizeAt,
  sweep,
  top,
  unlock,
} from './heap.ts';

const C_MARKING = C_GC; // the cycle being marked, or 0
const C_CYCLE = C_GC + 1; // the last cycle
const C_RECORDS = C_GC + 2; // the first agent record
const C_EPOCH = C_GC + 3; // bumped by each collection
const C_TURNS = C_GC + 4; // how many agents run such code (see R_TURN)
// bumped to ask each agent to collect its own garbage (its Proxies), as the
// heap runs short
const C_ASK = C_GC + 5;
const C_PINS = C_GC + 6; // the record of the pins (see pin)

// a shared object's header (shared.ts): its kind, then its length (an array)
// or the number of its slots (a struct)
const K_STRUCT = 1,
  K_ARRAY = 2,
  HEAD = 16,
  SLOT = 16,
  T_REF = 5;

// ---- the agents' records: a raw block each, in a list ----
const R_NEXT = 0,
  R_STATE = 1, // ALIVE, or DEAD once the agent has ended
  R_BUSY = 2,
  R_TABLE = 3, // the roots: an open addressed set of addresses
  R_CAP = 4,
  R_COUNT = 5, // the addresses in it
  R_FILLED = 6, // and its slots not empty (the deleted ones too)
  R_TURN = 7, // 1 + the epoch its turn began by, or 0 for no turns
  R_UNLINKS = 8, // pairs: an address, 1 + the epoch it was unlinked
  R_UNLINKS_CAP = 9, // in pairs
  R_UNLINKS_LEN = 10,
  R_WORDS = 11;
const ALIVE = 1,
  DEAD = 2,
  DELETED = -1;

// A record for a new agent: one that this agent starts gives it the record
// (agent.ts), and retires it as it ends.
export function makeRecord() {
  requireHeap();
  lock(C_ALLOC_LOCK);
  try {
    return makeRecordLocked();
  } finally {
    unlock(C_ALLOC_LOCK);
  }
}

function makeRecordLocked() {
  const r = allocLocked(R_WORDS * 4, B_RAW);
  I32[(r >> 2) + R_STATE] = ALIVE;
  I32[(r >> 2) + R_NEXT] = I32[C_RECORDS]!;
  I32[C_RECORDS] = r;
  return r;
}

// The agent whose record `r` is has ended: what it held is no longer held.
// (Its turn is read, and counted out, before it is dead, after which a
// collection may free the record. It takes no lock: a collection, which holds
// the allocation lock, may be waiting for that agent to leave a busy window it
// never will.)
export function retire(r: number) {
  if (A.load(I32, (r >> 2) + R_TURN) !== 0) A.sub(I32, C_TURNS, 1);
  A.store(I32, (r >> 2) + R_STATE, DEAD);
}

declare global {
  // this agent's record, as the agent that started it gives it (agent.ts)
  var __structsAgent: number | undefined;
}

// this agent's record, as words
let rec = 0;
function me() {
  if (rec === 0) {
    requireHeap();
    const given =
      globalThis.__structsAgent ??
      (globalThis as any).process?.getBuiltinModule?.('node:worker_threads')
        ?.workerData?.__structsAgent;
    rec = (typeof given === 'number' ? given : makeRecord()) >> 2;
    const timer = setInterval(tick, TICK);
    (timer as any).unref?.();
  }
  return rec;
}

// ---- this agent's timer, which runs between its turns ----
const TICK = 10;
let asked = 0;

function tick() {
  if (turns) A.store(I32, rec + R_TURN, A.load(I32, C_EPOCH) + 1);
  const ask = A.load(I32, C_ASK);
  if (ask !== asked) {
    asked = ask;
    ownGarbage();
  }
}

// this agent's own GC, where it can be run: Node's
let gc: (() => void) | null | undefined;
function runGC() {
  if (gc === undefined) {
    gc = (globalThis as any).gc ?? null;
    const p = (globalThis as any).process;
    if (!gc && p?.getBuiltinModule)
      try {
        p.getBuiltinModule('node:v8').setFlagsFromString('--expose-gc');
        gc = p.getBuiltinModule('node:vm').runInNewContext('gc');
      } catch {
        gc = null;
      }
  }
  gc?.();
}

// Collects this agent's Proxies that nothing holds, and drops them from its
// roots: its GC would in time, but it does not see the heap fill up. (Only
// right after its GC: a WeakRef that is read keeps what it refers to until
// the job ends, so shared.ts reads them only once those it can are gone.)
function ownGarbage() {
  runGC();
  for (const f of afterGC) f();
}

const enter = (r: number) => A.store(I32, r + R_BUSY, 1);
const leave = (r: number) => A.store(I32, r + R_BUSY, 0);

// shades `a` gray, if a collection is marking and has not marked it
function shade(a: number) {
  const m = A.load(I32, C_MARKING);
  if (m === 0) return;
  const w = (a >> 2) - 1,
    old = A.load(I32, w);
  if (old >> 1 !== m) A.compareExchange(I32, w, old, m * 2 + 1);
}

// ---- the roots ----
const hashOf = (a: number, cap: number) =>
  (Math.imul(a >> 3, 0x9e3779b1) >>> 0) & (cap - 1);

// room in the roots for one more, made before a busy window (which must not
// allocate: the collector, holding the allocation lock, waits for it)
function roomForRoot(r: number) {
  if ((I32[r + R_FILLED]! + 1) * 2 <= I32[r + R_CAP]!) return;
  lock(C_ALLOC_LOCK);
  try {
    roomForRootLocked(r);
  } finally {
    unlock(C_ALLOC_LOCK);
  }
}

function roomForRootLocked(r: number) {
  const cap = I32[r + R_CAP]!;
  if ((I32[r + R_FILLED]! + 1) * 2 <= cap) return;
  const old = I32[r + R_TABLE]!,
    count = I32[r + R_COUNT]!;
  let ncap = 256;
  while (ncap < (count + 1) * 4) ncap *= 2;
  const t = allocLocked(ncap * 4, B_RAW);
  for (let i = 0; i < cap; i++) {
    const a = I32[(old >> 2) + i]!;
    if (a <= 0) continue;
    let j = hashOf(a, ncap);
    while (I32[(t >> 2) + j] !== 0) j = (j + 1) & (ncap - 1);
    I32[(t >> 2) + j] = a;
  }
  I32[r + R_TABLE] = t;
  I32[r + R_CAP] = ncap;
  I32[r + R_FILLED] = count;
  if (old !== 0) freeLocked(old);
}

// puts `a` in the roots of the record `r`, if it is not there (or `again`)
function insert(r: number, a: number, again = false) {
  const t = I32[r + R_TABLE]! >> 2,
    cap = I32[r + R_CAP]!;
  let free = -1;
  for (let i = hashOf(a, cap); ; i = (i + 1) & (cap - 1)) {
    const e = I32[t + i]!;
    if (e === a && !again) return;
    if (e === DELETED) {
      if (free < 0) free = i;
    } else if (e === 0) {
      if (free < 0) {
        free = i;
        I32[r + R_FILLED]++;
      }
      I32[t + free] = a;
      I32[r + R_COUNT]++;
      return;
    }
  }
}

// takes `a` out of the roots of the record `r`: whether it was there
function remove(r: number, a: number) {
  const t = I32[r + R_TABLE]! >> 2,
    cap = I32[r + R_CAP]!;
  if (cap === 0) return false;
  for (let i = hashOf(a, cap); ; i = (i + 1) & (cap - 1)) {
    const e = I32[t + i]!;
    if (e === 0) return false;
    if (e === a) {
      I32[t + i] = DELETED;
      I32[r + R_COUNT]--;
      return true;
    }
  }
}

// Makes the object at `a`, which this agent holds otherwise for now (a pin,
// say), one of its roots.
export function root(a: number) {
  const r = me();
  roomForRoot(r);
  enter(r);
  insert(r, a);
  shade(a);
  leave(r);
}

// (An address that is not a root may have been freed: it is not shaded.)
export function unroot(a: number) {
  const r = me();
  enter(r);
  if (remove(r, a)) shade(a);
  leave(r);
}

// The word in the slot whose word is I32[w], read again: an object it holds
// is made one of this agent's roots first.
export function rootSlot(w: number) {
  const r = me();
  roomForRoot(r);
  enter(r);
  const v = A.load(I32, w);
  if ((v & 7) === T_REF) {
    insert(r, v & ~7);
    shade(v & ~7);
  }
  leave(r);
  return v;
}

// A new shared object, `bytes` long: made one of this agent's roots before
// any collection can see it.
// `init` writes its header, before any collection can see it (and must not
// allocate).
export function allocObject(bytes: number, init: (a: number) => void) {
  const r = me();
  roomForRoot(r);
  lock(C_ALLOC_LOCK);
  try {
    const a = allocLocked(bytes, B_OBJECT);
    init(a);
    insert(r, a);
    return a;
  } finally {
    unlock(C_ALLOC_LOCK);
  }
}

// ---- turns, and the objects unlinked while there are any ----
// Compiled code that reads addresses out of slots holds them until its turn
// ends, which code cannot see cheaply where it runs. So an agent that may run
// such code has its timer, which runs between turns, say that the turn it is
// in began no earlier than now.
let turns = false;

// Says that this agent may now hold addresses it read out of slots: compiled
// code calls it before it reads any (emit.ts's views).
export function turn() {
  if (!turns) beginTurns();
}

// (Counted before its turn is said: retire, which counts it out by its turn,
// then never counts out an agent it did not count in. One that ends in
// between stays counted, which only keeps writers logging their unlinks.)
function beginTurns() {
  turns = true;
  const r = me();
  A.add(I32, C_TURNS, 1);
  A.store(I32, r + R_TURN, A.load(I32, C_EPOCH) + 1);
}

// the earliest epoch, plus 1, at which a turn still going on began (2 ** 31 - 1
// for none). Under the allocation lock, or after a handshake.
function earliestTurn() {
  let min = 0x7fffffff;
  for (const r of records()) {
    const t = A.load(I32, r + R_TURN);
    if (t !== 0 && t < min) min = t;
  }
  return min;
}

// room for one more unlink, made before a busy window; those no turn can
// need any more go first
function roomForUnlink(r: number) {
  const cap = I32[r + R_UNLINKS_CAP]!,
    len = I32[r + R_UNLINKS_LEN]!;
  if (len < cap) return;
  lock(C_ALLOC_LOCK);
  try {
    const old = I32[r + R_UNLINKS]! >> 2,
      min = earliestTurn();
    let n = 0;
    for (let i = 0; i < len; i++)
      if (I32[old + 2 * i + 1]! >= min) {
        I32[old + 2 * n] = I32[old + 2 * i]!;
        I32[old + 2 * n + 1] = I32[old + 2 * i + 1]!;
        n++;
      }
    A.store(I32, r + R_UNLINKS_LEN, n);
    if (cap > 0 && n * 2 <= cap) return;
    const ncap = Math.max(512, cap * 2),
      t = allocLocked(ncap * 8, B_RAW);
    I32.copyWithin(t >> 2, old, old + 2 * n);
    I32[r + R_UNLINKS] = t;
    I32[r + R_UNLINKS_CAP] = ncap;
    if (old !== 0) freeLocked(old << 2);
  } finally {
    unlock(C_ALLOC_LOCK);
  }
}

// Writes the word `v` to I32[w], a slot's: an object it held is kept while a
// turn that began by now goes on. A BigInt `v` is the slot's first 8 bytes,
// its word and the 4 beside it, written as one (shared.ts).
export function writeSlot(w: number, v: number | bigint) {
  const r = me();
  roomForUnlink(r);
  enter(r);
  const old =
    typeof v === 'number'
      ? A.exchange(I32, w, v)
      : Number(BigInt.asIntN(32, A.exchange(B64, w >> 1, v)));
  // an agent that read `old` out of a slot without a Proxy said so (turn)
  // before it did, so is counted
  if ((old & 7) === T_REF && A.load(I32, C_TURNS) !== 0) {
    const a = old & ~7,
      at = (I32[r + R_UNLINKS]! >> 2) + 2 * I32[r + R_UNLINKS_LEN]!;
    I32[at] = a;
    I32[at + 1] = A.load(I32, C_EPOCH) + 1;
    A.store(I32, r + R_UNLINKS_LEN, I32[r + R_UNLINKS_LEN]! + 1);
    shade(a);
  }
  leave(r);
}

// ---- pins: an object in flight in a message (agent.ts) ----
// The roots of a record of their own, which no agent has: an address once per
// message that carries it. Under the allocation lock, so no collection runs
// meanwhile.
function pinsLocked() {
  if (I32[C_PINS] === 0) I32[C_PINS] = makeRecordLocked();
  return I32[C_PINS]! >> 2;
}

export function pin(a: number) {
  requireHeap();
  lock(C_ALLOC_LOCK);
  try {
    const p = pinsLocked();
    roomForRootLocked(p);
    insert(p, a, true);
  } finally {
    unlock(C_ALLOC_LOCK);
  }
}

export function unpin(a: number) {
  lock(C_ALLOC_LOCK);
  remove(pinsLocked(), a);
  unlock(C_ALLOC_LOCK);
}

// Whether `a` is the address of a shared object that a message pins: what
// only encode makes.
export function inFlight(a: unknown) {
  if (typeof a !== 'number' || a <= 0 || (a & 7) !== 0) return false;
  requireHeap();
  lock(C_ALLOC_LOCK);
  try {
    const p = pinsLocked(),
      t = I32[p + R_TABLE]! >> 2,
      cap = I32[p + R_CAP]!;
    if (cap === 0) return false;
    for (let i = hashOf(a, cap); ; i = (i + 1) & (cap - 1)) {
      const e = I32[t + i]!;
      if (e === 0) return false;
      if (e === a) return true;
    }
  } finally {
    unlock(C_ALLOC_LOCK);
  }
}

// ---- collecting ----
// what runs once this agent's GC has: shared.ts drops the roots of the
// Proxies it has collected, which its FinalizationRegistry would in time
const afterGC: (() => void)[] = [];
export const onGC = (f: () => void) => void afterGC.push(f);

// each live agent's record, as words
function* records() {
  for (let r = I32[C_RECORDS]!; r !== 0; r = I32[(r >> 2) + R_NEXT]!)
    if (I32[(r >> 2) + R_STATE] === ALIVE) yield r >> 2;
}

// waits until each live agent has been seen out of a busy window (or has
// ended, in one)
function handshake() {
  for (const r of records())
    while (A.load(I32, r + R_BUSY) !== 0 && A.load(I32, r + R_STATE) === ALIVE);
}

// Collects, holding the allocation lock.
function collectLocked(tries = 0) {
  if (tries > 0) {
    // the heap is still short: this agent's own garbage, and the others',
    // given a moment
    ownGarbage();
    A.add(I32, C_ASK, 1);
    if (CAN_BLOCK) A.wait(I32, C_ASK, A.load(I32, C_ASK), tries * 50);
  }
  const cycle = I32[C_CYCLE]! + 1,
    black = cycle * 2,
    gray = black + 1;
  I32[C_CYCLE] = cycle;
  A.store(I32, C_EPOCH, A.load(I32, C_EPOCH) + 1);
  A.store(I32, C_MARKING, cycle);
  handshake();
  const min = earliestTurn();

  const stack: number[] = [];
  const mark = (a: number) => {
    const w = (a >> 2) - 1;
    if (A.load(I32, w) === black) return;
    A.store(I32, w, black);
    stack.push(a);
  };
  const drain = () => {
    while (stack.length > 0) {
      const a = stack.pop()!,
        kind = I32[a >> 2],
        n =
          kind === K_STRUCT || kind === K_ARRAY
            ? I32[(a >> 2) + (kind === K_ARRAY ? 1 : 2)]!
            : 0;
      for (let s = (a + HEAD) >> 2, end = s + (n * SLOT) / 4; s < end; s += 4) {
        const v = I32[s]!;
        if ((v & 7) === T_REF) mark(v & ~7);
      }
    }
  };

  // the agents' roots, and the objects they unlinked while a turn still going
  // on was. An agent that has ended holds nothing, but what it unlinked may
  // be held by another's turn: its record goes once that is over
  for (let at = C_RECORDS, r = I32[at]!; r !== 0; r = I32[at]!) {
    const w = r >> 2,
      dead = I32[w + R_STATE] === DEAD;
    if (dead && I32[w + R_TABLE] !== 0) {
      freeLocked(I32[w + R_TABLE]!);
      I32[w + R_TABLE] = I32[w + R_CAP] = 0;
    }
    const t = I32[w + R_TABLE]! >> 2;
    for (let i = 0, cap = I32[w + R_CAP]!; i < cap; i++) {
      const a = I32[t + i]!;
      if (a > 0) mark(a);
    }
    const u = I32[w + R_UNLINKS]! >> 2;
    let held = false;
    for (let i = 0, n = A.load(I32, w + R_UNLINKS_LEN); i < n; i++)
      if (I32[u + 2 * i + 1]! >= min) {
        held = true;
        mark(I32[u + 2 * i]!);
      }
    if (dead && !held) {
      I32[at] = I32[w + R_NEXT]!;
      if (u !== 0) freeLocked(u << 2);
      freeLocked(r);
      continue;
    }
    at = w + R_NEXT;
  }
  // what the roots reach; then the gray, and what they reach, until there
  // are none: once the agents have been seen out of their busy windows, none
  // is shading one
  drain();
  const end = top();
  for (;;) {
    handshake();
    for (let b = CTRL; b < end; b += sizeAt(b))
      if (kindAt(b) === B_OBJECT && A.load(I32, (b >> 2) + 1) === gray)
        mark(b + 8);
    if (stack.length === 0) break;
    drain();
  }
  A.store(I32, C_MARKING, 0);
  const used = sweep(
    (b, kind) => kind === B_OBJECT && I32[(b >> 2) + 1] !== black,
  );
  // much of the heap is in use: each agent runs its GC between its turns,
  // which may let go of more by the next collection
  if (used > (I32.length << 2) / 2) A.add(I32, C_ASK, 1);
}

setCollector(collectLocked);

// Collects now; `thorough`, once this agent's GC has run (where it can).
export function collect(thorough = false) {
  requireHeap();
  if (thorough) ownGarbage();
  lock(C_ALLOC_LOCK);
  try {
    collectLocked();
  } finally {
    unlock(C_ALLOC_LOCK);
  }
}
