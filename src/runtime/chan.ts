import {
  __message,
  __unmessage,
  __newCell,
  __cellKind,
  __start,
  __isCounted,
  __release,
} from './own.ts';
import type {ThreadFn} from './own.ts';
// Go-style concurrency on own.ts: goroutines, channels, close, range over a
// channel, select.
//   const ch = new Channel(16);  go(f, ch, ...);  ch.send(v);  ch.recv();
//   for (const v of ch) ...
// a channel is a cell, and a value sent on it moves: it is copied into the
// shared heap and the sender's objects are revoked (the checker proves the
// sender does not use them again); the receiver reads its own copy and owns it.
// so threads share nothing but channels: no data races, and nothing in the
// shared heap outlives the message that carried it (the receiver frees each
// one)
//
// a goroutine is a pool thread (own.ts spawn, never joined): a real worker, so
// it is heavy, and a goroutine blocked on a channel holds its worker (the pool
// grows to run the others). an async function's goroutine is light: it runs on
// a host among others (runtime.ts spawnAsync), and waits with sendAsync,
// recvAsync, selectAsync and for await, without blocking the host. its blocking
// calls throw instead: they would stop every goroutine on the host. a shared
// struct or SharedArray is sent as its address, with no copy: the compiler
// passes it as __ref(p), so the message carries a count, and the receiver owns
// what recv() returns
import {
  I32,
  $waitBegin,
  $waitEnd,
  C_ACTIVITY,
  C_SELECTING,
  $lock,
  $unlock,
  $mustNotBlock,
  $resumed,
} from './runtime.ts';

// [0 kind][1 slots][2 lock][3 seq][4 head][5 tail][6 count][7 closed][8 sent][9
// received][10 unbuffered][11 -] then the ring from word 12: a slot is [message
// address][bytes]. seq changes with every change, and waiters wait on it. an
// unbuffered channel has one slot, and its sender also waits for the receiver
const K_CHAN = 24,
  RING = 12;
const LOCK = 2,
  SEQ = 3,
  HEAD = 4,
  TAIL = 5,
  COUNT = 6,
  CLOSED = 7,
  SENT = 8,
  RECEIVED = 9,
  UNBUFFERED = 10;

// the channel's lock (runtime.ts $lock): held only for a few loads and stores,
// never across a wait
const lock = $lock,
  unlock = $unlock;
// holding the lock: record a change and wake everyone waiting on this channel,
// and any select; an async function on this thread waiting for it wakes at once
const changed: (c: number) => void = c => {
  I32[c + SEQ]++;
  unlock(c + LOCK);
  Atomics.notify(I32, c + SEQ);
  Atomics.add(I32, C_ACTIVITY, 1);
  if (Atomics.load(I32, C_SELECTING) !== 0) Atomics.notify(I32, C_ACTIVITY);
  watches.get(c)?.fire();
};

// ---- waiting without blocking ----
// async functions on one thread wait for a channel to change through one
// Atomics.waitAsync on its seq (a watch), which another thread's change
// resolves (a task, some microseconds), and which a change on this thread fires
// at once (a microtask). a select waits on several watches, and leaves each
// when one fires: a watch on a channel that never changes waits for good, but
// only one per channel
const watches = new Map<number, Watch>(); // a channel's word index → its watch
class Watch {
  declare c: number;
  declare seq: number;
  declare waiters: Set<() => void>;
  constructor(c: number, seq: number) {
    this.c = c;
    this.seq = seq;
    this.waiters = new Set();
    const w = Atomics.waitAsync(I32, c + SEQ, seq);
    if (w.async) w.value.then(() => this.fire());
    else queueMicrotask(() => this.fire());
  }
  fire() {
    if (watches.get(this.c) === this) watches.delete(this.c);
    const waiters = this.waiters;
    this.waiters = new Set();
    for (const wake of waiters) wake();
  }
}
// calls wake once channel c's seq is no longer seq; returns what stops that
function onChange(c: number, seq: number, wake: () => void) {
  if (Atomics.load(I32, c + SEQ) !== seq) {
    queueMicrotask(wake);
    return () => {};
  }
  let w = watches.get(c);
  if (w === undefined || w.seq !== seq) watches.set(c, (w = new Watch(c, seq)));
  w.waiters.add(wake);
  return () => w.waiters.delete(wake);
}
// holding the lock: let it go and wait, without blocking, until the channel
// changes. the caller then passes a quiescent point ($resumed) and takes the
// lock again
const sleepAsync: (c: number) => Promise<void> = c => {
  const s = I32[c + SEQ];
  unlock(c + LOCK);
  return new Promise<void>(wake => {
    onChange(c, s, wake);
  });
};
// holding the lock: let it go and sleep until the channel changes, then take it
// again. it spins a little first, as Barrier does: the other side is often only
// microseconds away. a blocked thread is at a quiescent point (REFCOUNT.md)
const SPINS = 20000;
const sleep: (c: number) => void = c => {
  const s = I32[c + SEQ];
  unlock(c + LOCK);
  $waitBegin();
  let k = 0;
  while (k < SPINS && Atomics.load(I32, c + SEQ) === s) k++;
  if (k === SPINS) Atomics.wait(I32, c + SEQ, s);
  $waitEnd();
  lock(c + LOCK);
};

const EMPTY = Symbol('empty'),
  DONE = Symbol('done');
// holding the lock: the next message's value (unlocking), or EMPTY, or DONE
// when closed and empty. functions, not private methods: another thread's
// handle for a channel is made by own.ts, from the class's prototype
function take(c: number): unknown {
  if (I32[c + COUNT] === 0) return I32[c + CLOSED] !== 0 ? DONE : EMPTY;
  const h = I32[c + HEAD],
    m = I32[c + RING + 2 * h],
    bytes = I32[c + RING + 2 * h + 1];
  I32[c + HEAD] = (h + 1) % I32[c + 1];
  I32[c + COUNT]--;
  I32[c + RECEIVED]++;
  changed(c);
  return __unmessage(m, bytes);
}
// the same without blocking
async function receiveAsync(c: number) {
  lock(c + LOCK);
  for (;;) {
    const v = take(c);
    if (v === EMPTY) {
      await sleepAsync(c);
      $resumed();
      lock(c + LOCK);
      continue;
    }
    if (v === DONE) unlock(c + LOCK);
    return v;
  }
}
// the next value, waiting while the channel is empty, or DONE
function receive(c: number) {
  $mustNotBlock("a channel's recv()", 'await recvAsync() (or for await)');
  lock(c + LOCK);
  for (;;) {
    const v = take(c);
    if (v === EMPTY) {
      sleep(c);
      continue;
    }
    if (v === DONE) unlock(c + LOCK);
    return v;
  }
}

export class Channel {
  declare $cell: number;
  constructor(capacity = 0) {
    const slots = Math.max(1, capacity),
      a = __newCell(K_CHAN, (RING + 2 * slots) * 4, this) >> 2;
    I32[a + 1] = slots;
    I32[a + UNBUFFERED] = capacity === 0 ? 1 : 0;
  }
  // moves v into the channel: waits while it is full, and on an unbuffered
  // channel until a receiver has taken it
  send(v: unknown) {
    $mustNotBlock("a channel's send()", 'await sendAsync()');
    const c = this.$cell >> 2,
      [m, bytes] = __message(v);
    lock(c + LOCK);
    while (I32[c + COUNT] === I32[c + 1] && I32[c + CLOSED] === 0) sleep(c);
    if (I32[c + CLOSED] !== 0) {
      unlock(c + LOCK);
      const back = __unmessage<number>(m, bytes);
      if (__isCounted(v)) __release(back); // the count the message carried
      throw new TypeError('own: send on a closed channel');
    }
    const t = I32[c + TAIL];
    I32[c + RING + 2 * t] = m;
    I32[c + RING + 2 * t + 1] = bytes;
    I32[c + TAIL] = (t + 1) % I32[c + 1];
    I32[c + COUNT]++;
    const ticket = I32[c + SENT]++;
    if (I32[c + UNBUFFERED] !== 0) {
      changed(c);
      lock(c + LOCK);
      while (I32[c + RECEIVED] <= ticket) sleep(c);
      unlock(c + LOCK);
    } else changed(c);
  }
  // the same in an async function: waits without blocking its worker. the value
  // moves when sendAsync is called, as send's does
  async sendAsync(v: unknown) {
    const c = this.$cell >> 2,
      [m, bytes] = __message(v);
    lock(c + LOCK);
    while (I32[c + COUNT] === I32[c + 1] && I32[c + CLOSED] === 0) {
      await sleepAsync(c);
      $resumed();
      lock(c + LOCK);
    }
    if (I32[c + CLOSED] !== 0) {
      unlock(c + LOCK);
      const back = __unmessage<number>(m, bytes);
      if (__isCounted(v)) __release(back); // the count the message carried
      throw new TypeError('own: send on a closed channel');
    }
    const t = I32[c + TAIL];
    I32[c + RING + 2 * t] = m;
    I32[c + RING + 2 * t + 1] = bytes;
    I32[c + TAIL] = (t + 1) % I32[c + 1];
    I32[c + COUNT]++;
    const ticket = I32[c + SENT]++;
    changed(c);
    if (I32[c + UNBUFFERED] !== 0) {
      lock(c + LOCK);
      while (I32[c + RECEIVED] <= ticket) {
        await sleepAsync(c);
        $resumed();
        lock(c + LOCK);
      }
      unlock(c + LOCK);
    }
  }
  // the next value, which the caller now owns; waits while the channel is
  // empty. undefined once it is closed and empty
  recv() {
    const v = receive(this.$cell >> 2);
    return v === DONE ? undefined : v;
  }
  // the same in an async function: waits without blocking its worker
  async recvAsync() {
    const v = await receiveAsync(this.$cell >> 2);
    return v === DONE ? undefined : v;
  }
  // without waiting: the next value, EMPTY, or DONE
  poll() {
    const c = this.$cell >> 2;
    lock(c + LOCK);
    const v = take(c);
    if (v === EMPTY || v === DONE) unlock(c + LOCK);
    return v;
  }
  // no more sends; receivers drain what is left, then get undefined (and loops
  // over it end)
  close() {
    const c = this.$cell >> 2;
    lock(c + LOCK);
    I32[c + CLOSED] = 1;
    changed(c);
  }
  *[Symbol.iterator]() {
    const c = this.$cell >> 2;
    for (let v = receive(c); v !== DONE; v = receive(c)) yield v;
  }
  // for await (const v of channel): in an async function
  async *[Symbol.asyncIterator]() {
    const c = this.$cell >> 2;
    for (let v = await receiveAsync(c); v !== DONE; v = await receiveAsync(c))
      yield v;
  }
}
__cellKind(K_CHAN, Channel);

// starts f(...args) on a thread of its own; nothing waits for it (a goroutine).
// if it throws, the error is printed, as a Go panic would be
export function go(f: ThreadFn, ...args: unknown[]) {
  __start(f, args, true);
}

// waits until one of the channels has a value or is closed: [its index, the
// value], the value undefined for a closed channel. the first ready channel
// wins, from a rotating start for fairness
let turn = 0;
export function select(...chans: Channel[]): [number, unknown] {
  $mustNotBlock('select()', 'await selectAsync()');
  const n = chans.length;
  for (;;) {
    const seen = Atomics.load(I32, C_ACTIVITY);
    for (let k = 0; k < n; k++) {
      const i = (turn + k) % n,
        v = chans[i].poll();
      if (v === EMPTY) continue;
      turn = (i + 1) % n;
      return [i, v === DONE ? undefined : v];
    }
    Atomics.add(I32, C_SELECTING, 1);
    $waitBegin();
    Atomics.wait(I32, C_ACTIVITY, seen);
    $waitEnd();
    Atomics.sub(I32, C_SELECTING, 1);
  }
}
// the same in an async function: waits without blocking its worker, on the
// given channels only
export async function selectAsync(
  ...chans: Channel[]
): Promise<[number, unknown]> {
  const n = chans.length,
    cs = chans.map(ch => ch.$cell >> 2);
  for (;;) {
    // before polling: a change after it wakes the wait
    const seqs = cs.map(c => Atomics.load(I32, c + SEQ));
    for (let k = 0; k < n; k++) {
      const i = (turn + k) % n,
        v = chans[i].poll();
      if (v === EMPTY) continue;
      turn = (i + 1) % n;
      return [i, v === DONE ? undefined : v];
    }
    let stops!: (() => void)[];
    await new Promise<void>(wake => {
      stops = cs.map((c, i) => onChange(c, seqs[i], wake));
    });
    for (const stop of stops) stop();
    $resumed();
  }
}
