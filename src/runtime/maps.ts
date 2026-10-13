// SharedMap and SharedSet: Map and Set in shared memory, with their semantics.
// keys are compared as SameValueZero (a string by its text, a cell or a shared
// value by identity), iteration is in insertion order, and a loop sees what is
// added while it runs and skips what is deleted. keys and values are what can
// be shared: numbers, strings, booleans, null, undefined, cells (structs,
// SharedArrays, channels, maps...) and shared values (share()). each call is
// atomic: a map has a lock, held for the call only, never while user code runs
// (forEach's callback, a loop's body), so a loop sees other threads' changes
// between its steps, as it would see its own
//
// a deterministic hash table (Tyler Close's, as V8's Map is): entries are
// appended to an array in insertion order, so iterating is walking it, and the
// buckets' chains find a key. a delete leaves a hole, which the next rehash
// (growing, shrinking, clear) leaves out. an entry keeps its ordinal, the map's
// count of insertions when it was added: increasing along the array, it is
// where an iterator is, and survives a rehash
//
// a key or value is one 8-byte word: a number as itself (NaN as one NaN), or a
// box, hi = 0xFFF80000 | tag << 11 and lo its payload: an interned string's
// address (0 for ""), a cell's handle's, a shared value's. strings are
// interned, as a `str` field's are, so two equal strings are one address, and
// the map holds a count on each (runtime.ts $intern): a string no map, field or
// message refers to goes. compiled code passes a shared struct or SharedArray
// as its address, a number, and reads one back as that: the map keeps it as
// that number, and the compiler's __ref(p) (set's parameters are a `Sending`
// rest parameter, as spawn's are) says it is an address. the map holds a count
// on each cell and string in it, a flag in the entry saying which of its words
// do (REFCOUNT.md); a map is counted too, as a SharedArray is, and freeing it
// gives back what it held. an object or array stored moves in (the ownership
// checker sees to it): the map shares it, frozen
import {
  __box,
  __countedCellKind,
  __isCounted,
  __materialize,
  __release,
  __retain,
  __sharedAddress,
  share,
} from './own.ts';
import {
  $allocBlock,
  $defer,
  $freeBlock,
  $internFind,
  $internRef,
  $releaseString,
  $lock,
  $str,
  $unlock,
  F64,
  I32,
} from './runtime.ts';

// a map's block: [0 kind][1 count][2 lock][3 table][4 size][5 generation, one
// more with each rehash][6, 7 insertions so far, an f64]
const K_SHARED_MAP = 25,
  K_SHARED_SET = 26;
const HEADER = 32,
  LOCK = 2,
  TABLE = 3,
  SIZE = 4,
  GEN = 5,
  INSERTS = 24; // bytes
// a table: [0 capacity][1 buckets][2 entries used][3 -], the buckets (each the
// index + 1 of its chain's first entry, 0 for none), then the entries: a map's
// [key][value][ordinal][next, flags], a set's [key][ordinal][next, flags],
// 8-byte words but for next (the index + 1 of the next entry in the chain) and
// flags (which words hold a count: KEY_HELD, VALUE_HELD)
const MIN = 8;
const tableBytes = (capacity: number, w: number) =>
  16 + (((capacity >> 1) * 4 + 7) & ~7) + capacity * w;
const entriesAt = (t: number) => t + 16 + ((I32[(t >> 2) + 1] * 4 + 7) & ~7);
function newTable(capacity: number, w: number) {
  const t = $allocBlock(tableBytes(capacity, w));
  I32[t >> 2] = capacity;
  I32[(t >> 2) + 1] = capacity >> 1;
  return t;
}

// ---- words ----
const BOX = 0xfff80000 | 0,
  TAGS = 0xff << 11,
  NAN_HI = 0x7ff80000;
const T_UNDEF = 1,
  T_NULL = 2,
  T_FALSE = 3,
  T_TRUE = 4,
  T_STR = 5,
  T_SHARED = 8,
  T_CELL = 9,
  T_HOLE = 15;
const STR_HI = BOX | (T_STR << 11),
  CELL_HI = BOX | (T_CELL << 11),
  HOLE_HI = BOX | (T_HOLE << 11);
// the word encode made, and what the map does to hold it: nothing, retain (a
// handle's cell), or adopt the count that comes with it (compiled code's
// __ref(p), a raw address; a string's, which encode counts)
let lo = 0,
  hi = 0,
  held = 0,
  // a key string to add: the map takes a count of it only if it adds the key
  // (see counted), and none at all if no string table has it (absent)
  pending: string | null = null,
  absent = false;
const RETAIN = 1,
  ADOPT = 2;
const scratch = new Float64Array(1),
  bits = new Int32Array(scratch.buffer);
// v as a word, into lo, hi and held. adding: interns a value's string, with a
// count for the map (a key's waits, see pending), shares an object or array
// (which moves in), and throws if v cannot be shared; otherwise a key that
// cannot be in any map is not found (false)
function encode(v: unknown, key: boolean, adding: boolean): boolean {
  held = 0;
  pending = null;
  absent = false;
  switch (typeof v) {
    case 'number':
      if (v !== v) {
        lo = 0;
        hi = NAN_HI;
      } else {
        scratch[0] = key && v === 0 ? 0 : v; // a key's -0 is 0, as Map's
        lo = bits[0];
        hi = bits[1];
      }
      return true;
    case 'string': {
      const a = !adding || key ? $internFind(v) : $internRef(v);
      hi = STR_HI;
      lo = a;
      if (a === 0 && v !== '') {
        if (!adding) return false;
        absent = true;
      }
      if (adding && v !== '') {
        if (key) pending = v;
        else held = ADOPT;
      }
      return true;
    }
    case 'boolean':
      lo = 0;
      hi = BOX | ((v ? T_TRUE : T_FALSE) << 11);
      return true;
    case 'undefined':
      lo = 0;
      hi = BOX | (T_UNDEF << 11);
      return true;
    case 'object': {
      if (v === null) {
        lo = 0;
        hi = BOX | (T_NULL << 11);
        return true;
      }
      if (__isCounted(v)) {
        // compiled code's address, with a count for the map
        scratch[0] = (v as {a: number}).a;
        lo = bits[0];
        hi = bits[1];
        held = ADOPT;
        return true;
      }
      const c = (v as {$cell?: number}).$cell;
      if (c !== undefined) {
        lo = c;
        hi = CELL_HI;
        held = RETAIN;
        return true;
      }
      let s = __sharedAddress(v);
      if (s === undefined && adding) {
        share(v);
        s = __sharedAddress(v);
      }
      if (s !== undefined) {
        lo = s;
        hi = BOX | (T_SHARED << 11);
        return true;
      }
    }
  }
  if (!adding) return false;
  throw new TypeError(
    `threads: a SharedMap's or SharedSet's ${key ? 'key' : 'value'} is shared: a number, a string, a boolean, null, undefined, a cell (a shared struct, a SharedArray, a Channel, a map...), or a plain object or array, which the map shares`,
  );
}
// the key word l, h as the map adds it: a pending string, counted now (its
// address is the one encode found, if it found one: the string cannot have gone
// since, with no quiescent point between)
function counted(l: number, how: number, s: string | null): [number, number] {
  return s === null ? [l, how] : [$internRef(s), ADOPT];
}
// gives back the count a word encode made came with, which the map does not
// keep (its key was there already)
function unheld(l: number, h: number, how: number) {
  if (how !== ADOPT) return;
  if (h === STR_HI) {
    __release(l);
    return;
  }
  bits[0] = l;
  bits[1] = h;
  __release(scratch[0]);
}
// what a key or value is to the code that passed it: compiled code's __ref(p)
// is p
const plain = (v: unknown) => (__isCounted(v) ? (v as {a: number}).a : v);
// a value word, as its f64 and its two i32s, as a value of this thread: a map's
// methods read the words they return under its lock, and decode them once it
// is released. decoding a shared value builds this thread's copy of it, which
// takes a while, and what a word refers to stays until this thread's next
// quiescent point (REFCOUNT.md)
function decodeWord(f: number, h: number, p: number): unknown {
  if ((h & BOX) !== BOX || (h & TAGS) === 0) return f;
  switch ((h & TAGS) >> 11) {
    case T_UNDEF:
      return undefined;
    case T_NULL:
      return null;
    case T_FALSE:
      return false;
    case T_TRUE:
      return true;
    case T_STR:
      return p === 0 ? '' : $str(p);
    case T_SHARED:
      return __materialize(p);
    default:
      return __box(p); // a cell: this thread's handle, which holds a count
  }
}
// what a held word at at refers to: a string, a handle's cell (boxed), or an
// address kept as a number
const heldAddress = (at: number) =>
  I32[(at >> 2) + 1] === CELL_HI || I32[(at >> 2) + 1] === STR_HI
    ? I32[at >> 2]
    : F64[at >> 3];
const KEY_HELD = 1,
  VALUE_HELD = 2;
// store a word encode made, l and h, into entry e's word at offset o (0 the
// key, 8 a map's value), holding a count of its cell as h says (bit: its flag)
function store(
  e: number,
  w: number,
  o: number,
  l: number,
  h: number,
  how: number,
  bit: number,
) {
  I32[(e + o) >> 2] = l;
  I32[(e + o + 4) >> 2] = h;
  const f = (e + w + FLAGS) >> 2;
  if (how === 0) I32[f] &= ~bit;
  else {
    if (how === RETAIN) __retain(l);
    I32[f] |= bit;
  }
}
// give back the count entry e's word at offset o holds, if it holds one. a
// thread may have read a cell a moment ago and not counted it yet, so its
// decrement waits for every thread's next quiescent point; a string's need not
// (runtime.ts $releaseString)
function drop(e: number, w: number, o: number, bit: number) {
  const f = (e + w + FLAGS) >> 2;
  if ((I32[f] & bit) === 0) return;
  if (I32[(e + o + 4) >> 2] === STR_HI) $releaseString(I32[(e + o) >> 2]);
  else $defer(heldAddress(e + o));
  I32[f] &= ~bit;
}
const hash = (l: number, h: number) => {
  const x = Math.imul(l ^ Math.imul(h, 0x27d4eb2f), 0x9e3779b1);
  return x ^ (x >>> 15);
};

// ---- the table, under the map's lock ----
// w: an entry's bytes, 32 a map's and 24 a set's; its ordinal is at w - 16,
// its next at w - 8 and its flags at w - 4
const ORD = -16,
  NEXT = -8,
  FLAGS = -4;
// the index of the entry whose key is the word lo, hi, or -1
function find(t: number, w: number, l: number, h: number) {
  const e0 = entriesAt(t);
  for (
    let i = I32[(t >> 2) + 4 + (hash(l, h) & (I32[(t >> 2) + 1] - 1))];
    i !== 0;
  ) {
    const e = e0 + (i - 1) * w;
    if (I32[e >> 2] === l && I32[(e >> 2) + 1] === h) return i - 1;
    i = I32[(e + w + NEXT) >> 2];
  }
  return -1;
}
// a new table of capacity entries for map m, with its entries in order and
// without holes
function rehash(m: number, w: number, capacity: number) {
  const t = I32[(m >> 2) + TABLE],
    n = newTable(capacity, w),
    from = entriesAt(t),
    to = entriesAt(n),
    mask = I32[(n >> 2) + 1] - 1,
    used = I32[(t >> 2) + 2];
  let j = 0;
  for (let e = from, end = from + used * w; e < end; e += w) {
    if (I32[(e >> 2) + 1] === HOLE_HI) continue;
    const d = to + j * w;
    for (let k = 0; k < w; k += 4) I32[(d + k) >> 2] = I32[(e + k) >> 2];
    const b = (n >> 2) + 4 + (hash(I32[e >> 2], I32[(e >> 2) + 1]) & mask);
    I32[(d + w + NEXT) >> 2] = I32[b];
    I32[b] = ++j;
  }
  I32[(n >> 2) + 2] = j;
  I32[(m >> 2) + TABLE] = n;
  I32[(m >> 2) + GEN]++;
  $freeBlock(t, tableBytes(I32[t >> 2], w));
}
// a new entry for the key l, h (held as how says); returns its address, whose
// value word (a map's) the caller stores
function append(m: number, w: number, h: number, l: number, how: number) {
  let t = I32[(m >> 2) + TABLE];
  const capacity = I32[t >> 2],
    size = I32[(m >> 2) + SIZE];
  if (I32[(t >> 2) + 2] === capacity) {
    // full: twice as big, unless deletes left room enough
    rehash(m, w, size + 1 > capacity >> 1 ? capacity * 2 : capacity);
    t = I32[(m >> 2) + TABLE];
  }
  const i = I32[(t >> 2) + 2]++,
    e = entriesAt(t) + i * w,
    b = (t >> 2) + 4 + (hash(l, h) & (I32[(t >> 2) + 1] - 1));
  I32[(e + w + FLAGS) >> 2] = 0;
  store(e, w, 0, l, h, how, KEY_HELD);
  F64[(e + w + ORD) >> 3] = ++F64[(m + INSERTS) >> 3];
  I32[(e + w + NEXT) >> 2] = I32[b];
  I32[b] = i + 1;
  I32[(m >> 2) + SIZE] = size + 1;
  return e;
}
// deletes the entry whose key is the word lo, hi, if there is one
function remove(m: number, w: number, l: number, h: number) {
  const t = I32[(m >> 2) + TABLE],
    e0 = entriesAt(t);
  let link = (t >> 2) + 4 + (hash(l, h) & (I32[(t >> 2) + 1] - 1));
  for (let i = I32[link]; i !== 0; i = I32[link]) {
    const e = e0 + (i - 1) * w;
    if (I32[e >> 2] === l && I32[(e >> 2) + 1] === h) {
      I32[link] = I32[(e + w + NEXT) >> 2];
      drop(e, w, 0, KEY_HELD);
      if (w === MAP_ENTRY) {
        drop(e, w, 8, VALUE_HELD);
        F64[(e + 8) >> 3] = 0;
      }
      I32[e >> 2] = 0;
      I32[(e >> 2) + 1] = HOLE_HI; // its ordinal stays, for iterators
      const size = --I32[(m >> 2) + SIZE],
        capacity = I32[t >> 2];
      if (capacity > MIN && size < capacity >> 2) rehash(m, w, capacity >> 1);
      return true;
    }
    link = (e + w + NEXT) >> 2;
  }
  return false;
}
function clear(m: number, w: number) {
  const t = I32[(m >> 2) + TABLE],
    e0 = entriesAt(t);
  for (let e = e0, end = e0 + I32[(t >> 2) + 2] * w; e < end; e += w) {
    if (I32[(e >> 2) + 1] === HOLE_HI) continue;
    drop(e, w, 0, KEY_HELD);
    if (w === MAP_ENTRY) drop(e, w, 8, VALUE_HELD);
  }
  I32[(m >> 2) + TABLE] = newTable(MIN, w);
  I32[(m >> 2) + SIZE] = 0;
  I32[(m >> 2) + GEN]++;
  $freeBlock(t, tableBytes(I32[t >> 2], w));
}
// where an iterator is: the ordinal of the entry it saw last, and, while the
// table is the one it saw (by generation), the index after it
interface Cursor {
  gen: number;
  index: number;
  ord: number;
}
// the next entry for cursor c (its address, and c moves past it), or 0 at the
// end
function next(m: number, w: number, c: Cursor) {
  const t = I32[(m >> 2) + TABLE],
    e0 = entriesAt(t),
    used = I32[(t >> 2) + 2];
  let i = c.index;
  if (I32[(m >> 2) + GEN] !== c.gen) {
    // rehashed since: the first entry added after the last one seen
    let a = 0,
      b = used;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (F64[(e0 + mid * w + w + ORD) >> 3] > c.ord) b = mid;
      else a = mid + 1;
    }
    i = a;
    c.gen = I32[(m >> 2) + GEN];
  }
  for (; i < used; i++) {
    const e = e0 + i * w;
    if (I32[(e >> 2) + 1] === HOLE_HI) continue;
    c.index = i + 1;
    c.ord = F64[(e + w + ORD) >> 3];
    return e;
  }
  c.index = used;
  return 0;
}

// ---- the classes ----
const MAP_ENTRY = 32,
  SET_ENTRY = 24;
// a new map's block, and this thread's handle on it (which holds its count)
function make(kind: number, w: number) {
  const m = $allocBlock(HEADER);
  I32[m >> 2] = kind;
  I32[(m >> 2) + 1] = 1;
  I32[(m >> 2) + TABLE] = newTable(MIN, w);
  const h = __box(m);
  __release(m);
  return h;
}
// what freeing a map's block gives back: the cells its keys and values hold
const destroy = (w: number) => (m: number, give: (p: number) => void) => {
  const t = I32[(m >> 2) + TABLE],
    e0 = entriesAt(t);
  for (let e = e0, end = e0 + I32[(t >> 2) + 2] * w; e < end; e += w) {
    if (I32[(e >> 2) + 1] === HOLE_HI) continue;
    const f = I32[(e + w + FLAGS) >> 2];
    if (f & KEY_HELD) give(heldAddress(e));
    if (f & VALUE_HELD) give(heldAddress(e + 8));
  }
  $freeBlock(t, tableBytes(I32[t >> 2], w));
  $freeBlock(m, HEADER);
};
// a loop over map or set h: keys (0), values (1) or entries (2). it holds the
// handle, which keeps the map alive while it runs
function* loop<T>(
  h: {$cell: number},
  w: number,
  what: 0 | 1 | 2,
): Generator<T, undefined> {
  const c: Cursor = {gen: -1, index: 0, ord: -Infinity};
  for (;;) {
    const m = h.$cell;
    $lock((m >> 2) + LOCK);
    const e = next(m, w, c);
    // the key's word and the value's (a set's key twice)
    const v = e + (w === SET_ENTRY ? 0 : 8),
      kf = F64[e >> 3],
      kh = I32[(e >> 2) + 1],
      kp = I32[e >> 2],
      vf = F64[v >> 3],
      vh = I32[(v >> 2) + 1],
      vp = I32[v >> 2];
    $unlock((m >> 2) + LOCK);
    if (e === 0) return undefined;
    yield (
      what === 0
        ? decodeWord(kf, kh, kp)
        : what === 1
          ? decodeWord(vf, vh, vp)
          : [decodeWord(kf, kh, kp), decodeWord(vf, vh, vp)]
    ) as T;
  }
}

/**
 * A Map in shared memory: the same methods, and the same semantics (see the top
 * of this module). getOrInsert and getOrInsertComputed are Map's, and are
 * atomic here: a thread that adds an entry while another looks the key up gets
 * the one entry either way.
 */
export class SharedMap<K = unknown, V = unknown> {
  declare $cell: number;
  constructor(entries?: Iterable<readonly [K, V]> | null) {
    const h = make(K_SHARED_MAP, MAP_ENTRY) as SharedMap<K, V>;
    if (entries != null) for (const [k, v] of entries) h.set(k, v);
    return h;
  }
  get size(): number {
    return Atomics.load(I32, (this.$cell >> 2) + SIZE);
  }
  get(key: K): V | undefined {
    if (!encode(key, true, false)) return undefined;
    const m = this.$cell,
      l = lo,
      h = hi;
    $lock((m >> 2) + LOCK);
    const t = I32[(m >> 2) + TABLE],
      i = find(t, MAP_ENTRY, l, h),
      at = i < 0 ? 0 : entriesAt(t) + i * MAP_ENTRY + 8,
      wf = F64[at >> 3],
      wh = I32[(at >> 2) + 1],
      wp = I32[at >> 2];
    $unlock((m >> 2) + LOCK);
    return (i < 0 ? undefined : decodeWord(wf, wh, wp)) as V | undefined;
  }
  has(key: K): boolean {
    if (!encode(key, true, false)) return false;
    const m = this.$cell,
      l = lo,
      h = hi;
    $lock((m >> 2) + LOCK);
    const found = find(I32[(m >> 2) + TABLE], MAP_ENTRY, l, h) >= 0;
    $unlock((m >> 2) + LOCK);
    return found;
  }
  set(key: K, value: V): this {
    encode(value, false, true);
    const vl = lo,
      vh = hi,
      vhow = held;
    encode(key, true, true);
    const m = this.$cell,
      l = lo,
      h = hi,
      how = held,
      s = pending,
      no = absent;
    $lock((m >> 2) + LOCK);
    const t = I32[(m >> 2) + TABLE],
      i = no ? -1 : find(t, MAP_ENTRY, l, h);
    let e: number;
    if (i >= 0) {
      // a new value, in the key's place
      e = entriesAt(t) + i * MAP_ENTRY;
      drop(e, MAP_ENTRY, 8, VALUE_HELD);
      unheld(l, h, how);
    } else e = append(m, MAP_ENTRY, h, ...counted(l, how, s));
    store(e, MAP_ENTRY, 8, vl, vh, vhow, VALUE_HELD);
    $unlock((m >> 2) + LOCK);
    return this;
  }
  /** The key's value, after adding `value` for it if it has none. */
  getOrInsert(key: K, value: V): V {
    encode(value, false, true);
    const vl = lo,
      vh = hi,
      vhow = held;
    encode(key, true, true);
    const m = this.$cell,
      l = lo,
      h = hi,
      how = held,
      s = pending,
      no = absent;
    $lock((m >> 2) + LOCK);
    const t = I32[(m >> 2) + TABLE],
      i = no ? -1 : find(t, MAP_ENTRY, l, h);
    let e: number;
    if (i >= 0) {
      e = entriesAt(t) + i * MAP_ENTRY;
      unheld(l, h, how);
      unheld(vl, vh, vhow);
    } else {
      e = append(m, MAP_ENTRY, h, ...counted(l, how, s));
      store(e, MAP_ENTRY, 8, vl, vh, vhow, VALUE_HELD);
    }
    const wf = F64[(e + 8) >> 3],
      wh = I32[((e + 8) >> 2) + 1],
      wp = I32[(e + 8) >> 2];
    $unlock((m >> 2) + LOCK);
    return decodeWord(wf, wh, wp) as V;
  }
  /**
   * The key's value, after adding `callback(key)` for it if it has none. The
   * callback runs without the lock, so another thread may add the key first:
   * then that value is kept and returned (Map's would replace it), so that
   * threads adding the same key get the one value.
   */
  getOrInsertComputed(key: K, callback: (key: K) => V): V {
    if (encode(key, true, false)) {
      const m = this.$cell,
        l = lo,
        h = hi,
        how = held;
      $lock((m >> 2) + LOCK);
      const t = I32[(m >> 2) + TABLE],
        i = find(t, MAP_ENTRY, l, h),
        at = i < 0 ? 0 : entriesAt(t) + i * MAP_ENTRY + 8,
        wf = F64[at >> 3],
        wh = I32[(at >> 2) + 1],
        wp = I32[at >> 2];
      $unlock((m >> 2) + LOCK);
      if (i >= 0) {
        unheld(l, h, how);
        return decodeWord(wf, wh, wp) as V;
      }
    }
    return this.getOrInsert(key, callback(plain(key) as K));
  }
  delete(key: K): boolean {
    if (!encode(key, true, false)) return false;
    const m = this.$cell,
      l = lo,
      h = hi;
    $lock((m >> 2) + LOCK);
    const found = remove(m, MAP_ENTRY, l, h);
    $unlock((m >> 2) + LOCK);
    return found;
  }
  clear(): void {
    const m = this.$cell;
    $lock((m >> 2) + LOCK);
    clear(m, MAP_ENTRY);
    $unlock((m >> 2) + LOCK);
  }
  forEach(
    callback: (value: V, key: K, map: SharedMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [k, v] of loop<[K, V]>(this, MAP_ENTRY, 2))
      callback.call(thisArg, v, k, this);
  }
  keys(): Generator<K, undefined> {
    return loop<K>(this, MAP_ENTRY, 0);
  }
  values(): Generator<V, undefined> {
    return loop<V>(this, MAP_ENTRY, 1);
  }
  entries(): Generator<[K, V], undefined> {
    return loop<[K, V]>(this, MAP_ENTRY, 2);
  }
  [Symbol.iterator](): Generator<[K, V], undefined> {
    return loop<[K, V]>(this, MAP_ENTRY, 2);
  }
  get [Symbol.toStringTag]() {
    return 'SharedMap';
  }
}
__countedCellKind(K_SHARED_MAP, SharedMap, destroy(MAP_ENTRY));

/** A Set in shared memory: the same methods, and the same semantics. */
export class SharedSet<T = unknown> {
  declare $cell: number;
  constructor(values?: Iterable<T> | null) {
    const h = make(K_SHARED_SET, SET_ENTRY) as SharedSet<T>;
    if (values != null) for (const v of values) h.add(v);
    return h;
  }
  get size(): number {
    return Atomics.load(I32, (this.$cell >> 2) + SIZE);
  }
  has(value: T): boolean {
    if (!encode(value, true, false)) return false;
    const m = this.$cell,
      l = lo,
      h = hi;
    $lock((m >> 2) + LOCK);
    const found = find(I32[(m >> 2) + TABLE], SET_ENTRY, l, h) >= 0;
    $unlock((m >> 2) + LOCK);
    return found;
  }
  add(value: T): this {
    encode(value, true, true);
    const m = this.$cell,
      l = lo,
      h = hi,
      how = held,
      s = pending;
    $lock((m >> 2) + LOCK);
    if (absent || find(I32[(m >> 2) + TABLE], SET_ENTRY, l, h) < 0)
      append(m, SET_ENTRY, h, ...counted(l, how, s));
    else unheld(l, h, how);
    $unlock((m >> 2) + LOCK);
    return this;
  }
  delete(value: T): boolean {
    if (!encode(value, true, false)) return false;
    const m = this.$cell,
      l = lo,
      h = hi;
    $lock((m >> 2) + LOCK);
    const found = remove(m, SET_ENTRY, l, h);
    $unlock((m >> 2) + LOCK);
    return found;
  }
  clear(): void {
    const m = this.$cell;
    $lock((m >> 2) + LOCK);
    clear(m, SET_ENTRY);
    $unlock((m >> 2) + LOCK);
  }
  forEach(
    callback: (value: T, value2: T, set: SharedSet<T>) => void,
    thisArg?: unknown,
  ): void {
    for (const v of loop<T>(this, SET_ENTRY, 0))
      callback.call(thisArg, v, v, this);
  }
  values(): Generator<T, undefined> {
    return loop<T>(this, SET_ENTRY, 0);
  }
  keys(): Generator<T, undefined> {
    return loop<T>(this, SET_ENTRY, 0);
  }
  entries(): Generator<[T, T], undefined> {
    return loop<[T, T]>(this, SET_ENTRY, 2);
  }
  [Symbol.iterator](): Generator<T, undefined> {
    return loop<T>(this, SET_ENTRY, 0);
  }
  get [Symbol.toStringTag]() {
    return 'SharedSet';
  }
}
__countedCellKind(K_SHARED_SET, SharedSet, destroy(SET_ENTRY));
