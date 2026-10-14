// own and shared values between threads, with a borrow checker at the
// boundaries (see README.md). a value is one of:
//   own      an ordinary object, reachable by one thread. it crosses to another
//            thread only by moving (spawn's arguments, a thread's result): it
//            is copied over and the sender's objects are revoked, so using them
//            again throws
//   shared   immutable: share(v) deep-freezes v and writes it into the shared
//            heap once. a thread it reaches makes its own frozen copy on first
//            use, then reads plain objects
//   a cell   shared and mutable, explicitly: a struct, a SharedArray, a
//            channel, a map, a Lock, a Condition. their state lives in the shared
//            heap
// ordinary code reads and writes ordinary objects: nothing per access,
// everything at the crossings
import {
  $alloc,
  $checking,
  $decodeAscii,
  $decodeUtf16,
  $intern,
  $internedHere,
  $str,
  $log,
  K_THREAD,
  spawnThread,
  threadJoin,
  threadJoinAsync,
  setThreadEntry,
  setAfterTask,
  setBeforeTask,
  $allocBlock,
  $freeBlock,
  $defer,
  $quiescent,
  $waitBegin,
  $waitEnd,
  setDeferHandler,
  $drain,
  $heapStats,
  spawnAsync,
  $mustNotBlock,
  $resumed,
  $internRef,
  $retainString,
  $stringDying,
  K_STR,
  $releaseString,
} from './runtime.ts';

const SAB = globalThis.__escapeSab ?? null;
const I32 = SAB! && new Int32Array(SAB),
  F64 = SAB! && new Float64Array(SAB),
  U8 = SAB! && new Uint8Array(SAB);

export {$log as log};

// ---- the wire format: a blob of 8-byte words in the shared heap. word 0 is
// the root value ----
// a value word is a number (f64), or a box: hi = 0xFFF80000 | tag << 11, lo =
// payload. payloads of strings, arrays and objects are the word offset of their
// body in the same blob
//   string body: [length][flags] then its text: a byte per char if it is ASCII,
//                else UTF-16 units
//   array body:  [length] then value words
//   object body: [shape] then a value word per key
//   shape:       [count] then a word per key
// (an interned key's address). a shape is written once per blob, so the objects
// with the same keys share it, and a reader finds the function that makes them
// (see maker) once per shape a string that occurs more than once in a value is
// written once: its other occurrences point at the same body, which is marked
// repeated, so that a reader decodes it once. a long ASCII string is written by
// TextEncoder.encodeInto (into this thread's buffer: it takes no view of shared
// memory). a string this thread has interned (a `str` field's) or read from the
// string table already is not copied at all: it is the address of its one copy
// there (T_ISTR), with a count the message holds until it is freed. nothing
// else is added to the string table: a message is freed whole once it is read
const BOX = 0xfff80000 | 0;
// a string body's flags: ASCII, and from the string's second occurrence on, 1 +
// its number among the blob's repeated strings << 2, by which a reader keeps it
// once decoded
const STR_ASCII = 2;
const T_UNDEF = 1,
  T_NULL = 2,
  T_FALSE = 3,
  T_TRUE = 4,
  T_STR = 5,
  T_ARR = 6,
  T_OBJ = 7,
  T_SHARED = 8,
  T_CELL = 9,
  T_COUNTED = 10,
  T_ISTR = 11,
  T_CELL_COUNTED = 12;

// writing: into a growing private buffer, then copied into the heap in one
// piece
let wf = new Float64Array(1024),
  wi = new Int32Array(wf.buffer),
  wb = new Uint8Array(wf.buffer),
  wu = new Uint16Array(wf.buffer),
  wn = 0;
const encoder = new TextEncoder();
// the strings in the blob being written -> their body
const written = new Map<string, number>();
let repeats = 0; // the blob's repeated strings so far
// the shapes in the blob being written, by first key (or '' for none): [ keys,
// shape, ... ]; and the last one used, since an array's objects usually have
// the same keys
const shapes = new Map<string, (string[] | number)[]>();
let lastKeys: string[] | null = null,
  lastShape = 0;
// the counts the blob being written has taken, on strings and on cells: given
// back if the write fails (see write)
const takenStrings: number[] = [],
  takenCells: number[] = [];
// the objects a share writes, frozen once the blob is written, and not if it
// is not
const frozen: object[] = [];
function shapeOf(keys: string[]) {
  const n = keys.length;
  if (lastKeys !== null && sameKeys(lastKeys, keys)) return lastShape;
  const first = n === 0 ? '' : keys[0];
  let list = shapes.get(first),
    shape = -1;
  if (list === undefined) shapes.set(first, (list = []));
  for (let i = 0; i < list.length; i += 2)
    if (sameKeys(list[i] as string[], keys)) {
      shape = list[i + 1] as number;
      break;
    }
  if (shape < 0) {
    reserve(1 + n);
    shape = wn;
    wn += 1 + n;
    wi[shape * 2] = n;
    for (let k = 0; k < n; k++) {
      const a = $internRef(keys[k]);
      takenStrings.push(a);
      wi[(shape + 1 + k) * 2] = a;
    }
    list.push(keys, shape);
  }
  lastKeys = keys;
  lastShape = shape;
  return shape;
}
function sameKeys(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}
const reserve: (words: number) => void = words => {
  if (wn + words <= wf.length) return;
  const nf = new Float64Array(Math.max(wf.length * 2, wn + words));
  nf.set(wf.subarray(0, wn));
  wf = nf;
  wi = new Int32Array(wf.buffer);
  wb = new Uint8Array(wf.buffer);
  wu = new Uint16Array(wf.buffer);
};
const boxWord = (at: number, tag: number, p: number) => {
  wi[at * 2] = p;
  wi[at * 2 + 1] = BOX | (tag << 11);
};

// a cell's object: $cell is its block's address
export type CellObject = {$cell: number};
type F64Cell = Float64Array & CellObject;
// null, or a cell: what a reference field holds
type MaybeCell = {$cell?: number} | null | undefined;
// a struct type's class also describes its layout (see sharedStruct)
type CellClass = {prototype: object} & Partial<StructType>;
// a cell is a JS object of one of these classes; it crosses as its block's
// address
const cellKinds = new Map<number, CellClass>(); // kind -> class
// every struct type declared on this thread (sharedStruct): two with one
// layout share a kind, and the later one is the kind's class, but both are
// types (newSharedArray checks)
const structTypes = new WeakSet<object>();
const sharedAddr = new WeakMap<object, number>(); // a shared value -> its blob
const REVOKED = new Proxy(Object.create(null), {
  get: (_, key) => {
    if (typeof key === 'symbol') return undefined;
    throw new TypeError(`own: used after move (.${String(key)})`);
  },
  set: (_, key) => {
    throw new TypeError(`own: used after move (.${String(key)} = ...)`);
  },
  has: () => {
    throw new TypeError('own: used after move');
  },
});

// a value put writes. of an object it reads a cell's address too ($cell)
type Sent =
  | {$cell?: number; [key: string]: Sent}
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | ((...args: never) => unknown);
// what a move copied, to revoke
type Moved = Record<string, unknown>[];

// write v into word `at` . moved: the objects a move copied, to revoke once the
// whole blob is written (those at most revokeDepth deep: the moved values, or
// with the runtime's check option, everything in them). freeze: a share, which
// freezes each object it writes
const MAX_DEPTH = 1000;
let revokeDepth = 0;
function put(
  at: number,
  v: Sent,
  moved: Moved | null,
  freeze: boolean,
  depth: number,
) {
  if (typeof v === 'number') {
    wf[at] = v === v ? v : NaN;
    if (v !== v) {
      wi[at * 2] = 0;
      wi[at * 2 + 1] = 0x7ff80000;
    }
    return;
  }
  if (v === undefined) return boxWord(at, T_UNDEF, 0);
  if (v === null) return boxWord(at, T_NULL, 0);
  if (v === true) return boxWord(at, T_TRUE, 0);
  if (v === false) return boxWord(at, T_FALSE, 0);
  if (typeof v === 'string') {
    // written already (or -its address, when this thread interned or read it:
    // it crosses as that)
    let body = written.get(v);
    if (body === undefined) {
      // counted for the blob, once for each time it is in it
      const interned = $internedHere(v);
      if (interned !== 0 && $retainString(interned)) {
        written.set(v, -interned);
        takenStrings.push(interned);
        return boxWord(at, T_ISTR, interned);
      }
    } else if (body < 0) {
      $retainString(-body);
      takenStrings.push(-body);
      return boxWord(at, T_ISTR, -body);
    } else {
      if (wi[body * 2 + 1] >>> 2 === 0) wi[body * 2 + 1] |= ++repeats << 2;
      return boxWord(at, T_STR, body);
    }
    // a byte per char if it is ASCII (encodeInto writes ASCII as is, and
    // anything else as more bytes than chars), else UTF-16 units
    const n = v.length;
    reserve(1 + ((n + 7) >> 3));
    body = wn;
    const o = (body + 1) * 8;
    let ascii = true;
    if (n >= 256) {
      const r = encoder.encodeInto(v, wb.subarray(o, o + n));
      ascii = r.read === n && r.written === n;
    } else {
      for (let i = 0; i < n; i++) {
        const c = v.charCodeAt(i);
        if (c >= 128) {
          ascii = false;
          break;
        }
        wb[o + i] = c;
      }
    }
    if (ascii) wn += 1 + ((n + 7) >> 3);
    else {
      reserve(1 + ((n + 3) >> 2));
      for (let i = 0, u = o >> 1; i < n; i++) wu[u + i] = v.charCodeAt(i);
      wn += 1 + ((n + 3) >> 2);
    }
    wi[body * 2] = n;
    wi[body * 2 + 1] = ascii ? STR_ASCII : 0;
    written.set(v, body);
    return boxWord(at, T_STR, body);
  }
  if (typeof v !== 'object')
    throw new TypeError(`own: cannot send a ${typeof v}`);
  const proto = Object.getPrototypeOf(v);
  if (
    proto === Object.prototype ||
    proto === Array.prototype ||
    proto === null
  ) {
    // a plain object or array: shared already if it is frozen and in sharedAddr
    if (Object.isFrozen(v)) {
      const shared = sharedAddr.get(v);
      if (shared !== undefined) return boxWord(at, T_SHARED, shared);
    }
  } else {
    if (v instanceof CountedArg) return boxWord(at, T_COUNTED, v.a);
    if (v.$cell !== undefined) {
      // a struct, SharedArray or map: the value holds a count of it, so it
      // outlives the sender's handle. a moved value's reader gives the count
      // back once it has a handle of its own; a shared value keeps it
      if (!counted(I32[v.$cell >> 2])) return boxWord(at, T_CELL, v.$cell);
      retain(v.$cell);
      takenCells.push(v.$cell);
      return boxWord(at, freeze ? T_CELL : T_CELL_COUNTED, v.$cell);
    }
    if (!Array.isArray(v))
      throw new TypeError('own: only plain objects and arrays can be sent');
  }
  if (depth >= MAX_DEPTH)
    throw new TypeError(
      `own: a value nested ${MAX_DEPTH} deep (or with a cycle) cannot be sent`,
    );
  if (moved !== null && depth <= revokeDepth) moved.push(v);
  let body: number;
  if (Array.isArray(v)) {
    const n = v.length;
    reserve(1 + n);
    body = wn;
    wn += 1 + n;
    wi[body * 2] = n;
    for (let i = 0; i < n; i++)
      put(body + 1 + i, v[i], moved, freeze, depth + 1);
  } else {
    const keys = Object.keys(v),
      values = Object.values(v),
      n = keys.length,
      shape = shapeOf(keys);
    reserve(1 + n);
    body = wn;
    wn += 1 + n;
    wi[body * 2] = shape;
    for (let k = 0; k < n; k++)
      put(body + 1 + k, values[k], moved, freeze, depth + 1);
  }
  if (freeze) frozen.push(v);
  return boxWord(at, Array.isArray(v) ? T_ARR : T_OBJ, body);
}
// a blob of v in the shared heap; its address
// a blob of v in the shared heap; its address. all or nothing: when the blob
// does not fit (a full heap), or v cannot be sent, the counts taken for it go
// back and nothing is frozen
function write(v: Sent, moved: Moved | null, freeze: boolean, alloc = $alloc) {
  wn = 1;
  try {
    put(0, v, moved, freeze, 0);
    const a = alloc(wn * 8);
    U8.set(new Uint8Array(wf.buffer, 0, wn * 8), a);
    for (const o of frozen) Object.freeze(o);
    return a;
  } catch (e) {
    for (const p of takenStrings) $releaseString(p);
    for (const p of takenCells) release(p);
    throw e;
  } finally {
    written.clear();
    shapes.clear();
    lastKeys = null;
    repeats = 0;
    takenStrings.length = 0;
    takenCells.length = 0;
    frozen.length = 0;
  }
}

// reading: a blob is immutable once written, so its words are read without care
// for tearing
function get(base: number, at: number, frozen: boolean): unknown {
  const v = F64[(base >> 3) + at];
  if (v === v) return v;
  const i = (base >> 2) + at * 2,
    hi = I32[i + 1],
    p = I32[i];
  if ((hi & BOX) !== BOX) return NaN;
  switch ((hi >>> 11) & 0xff) {
    case T_UNDEF:
      return undefined;
    case T_NULL:
      return null;
    case T_FALSE:
      return false;
    case T_TRUE:
      return true;
    case T_STR: {
      const flags = I32[(base >> 2) + p * 2 + 1],
        repeat = decoded === null ? 0 : flags >>> 2; // kept within a read()
      if (repeat !== 0) {
        const s = decoded?.[repeat];
        if (s !== undefined) return s;
      }
      const n = I32[(base >> 2) + p * 2],
        text = base + (p + 1) * 8;
      const s =
        flags & STR_ASCII ? $decodeAscii(text, n) : $decodeUtf16(text >> 1, n);
      if (repeat !== 0) (decoded ??= [])[repeat] = s;
      return s;
    }
    case T_ISTR:
      if (given !== null) given.push(p);
      return $str(p);
    case T_ARR: {
      const n = I32[(base >> 2) + p * 2],
        a = [];
      for (let k = 0; k < n; k++) a.push(get(base, p + 1 + k, frozen));
      return frozen ? Object.freeze(a) : a;
    }
    case T_OBJ: {
      const shape = I32[(base >> 2) + p * 2];
      let make: Maker | undefined;
      if (shape === lastShapeRead) make = lastMakerRead!;
      else {
        make = shapesRead?.get(shape);
        if (make === undefined) {
          make = maker(base, shape, frozen);
          if (shapesRead !== null) (shapesRead ??= new Map()).set(shape, make);
          if (given !== null)
            for (let k = 0, n = I32[(base >> 2) + shape * 2]; k < n; k++)
              given.push(I32[(base >> 2) + (shape + 1 + k) * 2]);
        }
        if (shapesRead !== null) {
          lastShapeRead = shape;
          lastMakerRead = make;
        }
      }
      return make(F64, get, base, p + 1, frozen);
    }
    case T_SHARED:
      return materialize(p);
    case T_CELL:
      return cell(p);
    case T_CELL_COUNTED: {
      const c = cell(p);
      release(p);
      return c;
    }
    case T_COUNTED:
      if (countedInto !== null) countedInto.push(p);
      return p; // else the reader owns it
  }
  throw new Error('own: bad value word');
}
// what a read() of a blob learns as it goes: its repeated strings, decoded once
// (by number), and the functions that make its shapes' objects, looked up once
// (by offset; and the last one used). null outside a read (a get() of one value
// of a blob caches nothing), undefined in one until used
let decoded: string[] | null | undefined = null,
  shapesRead: Map<number, Maker> | null | undefined = null,
  lastShapeRead = -1,
  lastMakerRead: Maker | null = null;
function read(a: number, frozen: boolean) {
  const outer = [decoded, shapesRead, lastShapeRead, lastMakerRead] as const,
    outerGiven = given;
  decoded = undefined;
  shapesRead = undefined;
  lastShapeRead = -1;
  lastMakerRead = null;
  if (frozen) given = null; // a shared value keeps its counts
  try {
    return get(a, 0, frozen);
  } finally {
    [decoded, shapesRead, lastShapeRead, lastMakerRead] = outer;
    given = outerGiven;
  }
}

// objects with the same keys (in the same order) are made by one generated
// function, an object literal: the engine gives them one hidden class, and
// making one is a single allocation
type Maker = (
  F64: Float64Array,
  get: (base: number, at: number, frozen: boolean) => unknown,
  base: number,
  at: number,
  frozen: boolean,
) => object;
// hash of the key addresses -> [ { keys, frozen, make } ]
// by its keys' addresses, and their serials: a key's string may go, and its
// address be another string's (runtime.ts $intern)
const makers = new Map<
  number,
  {keys: number[]; serials: number[]; frozen: boolean; make: Maker}[]
>();
const serialOf = (a: number) => (a === 0 ? 0 : I32[(a >> 2) + 5]);
function maker(base: number, shape: number, frozen: boolean) {
  const n = I32[(base >> 2) + shape * 2],
    k0 = (base >> 2) + (shape + 1) * 2;
  let h = n | (frozen ? 1 << 30 : 0);
  for (let k = 0; k < n; k++) h = (Math.imul(h, 31) + I32[k0 + k * 2]) | 0;
  let list = makers.get(h);
  if (list !== undefined) {
    outer: for (const m of list) {
      if (m.frozen !== frozen || m.keys.length !== n) continue;
      for (let k = 0; k < n; k++) {
        const a = I32[k0 + k * 2];
        if (m.keys[k] !== a || m.serials[k] !== serialOf(a)) continue outer;
      }
      return m.make;
    }
  } else {
    if (makers.size >= 4096) makers.clear();
    makers.set(h, (list = []));
  }
  const keys = Array.from({length: n}, (_, k) => I32[k0 + k * 2]),
    serials = keys.map(serialOf);
  // each key quoted in the literal, but "__proto__", which quoted would set the
  // object's prototype rather than a property: computed, it is a property
  const fields = keys.map((a, k) => {
    const name = strAt(a),
      key =
        name === '__proto__'
          ? `[${JSON.stringify(name)}]`
          : JSON.stringify(name);
    return `${key}: (v = F64[(base >> 3) + at + ${k}]) === v ? v : get(base, at + ${k}, frozen)`;
  });
  const make = new Function(
    'F64',
    'get',
    'base',
    'at',
    'frozen',
    `let v; return ${frozen ? 'Object.freeze(' : ''}{ ${fields.join(', ')} }${frozen ? ')' : ''};`,
  ) as Maker;
  list.push({keys, serials, frozen, make});
  return make;
}

// ---- moving ----
// revoke what was moved: the sender keeps the objects, but any use of them
// throws. by default only the values moved themselves: an alias of something
// inside one still reads the sender's old copy (the ownership checker reports
// it), which the runtime's check option revokes as well
function revoke(objs: Moved) {
  for (const o of objs) {
    if (Array.isArray(o)) o.length = 0;
    else {
      const keys = Object.keys(o);
      // last first: V8 undoes those quickly
      for (let k = keys.length - 1; k >= 0; k--) delete o[keys[k]];
    }
    Object.setPrototypeOf(o, REVOKED);
  }
}
// a message (chan.ts, and a thread's arguments and result): v moved into a
// block of its own, which the receiver frees once it has read it. [address,
// bytes]. the moved values are v, or v's elements (depth 1: a thread's
// arguments)
const messageBlock: (bytes: number) => number = bytes =>
  $allocBlock(bytes, false); // written whole
export function __message(v: unknown, depth = 0): [number, number] {
  const moved: Moved = [];
  revokeDepth = $checking() ? Infinity : depth;
  const a = write(v as Sent, moved, false, messageBlock),
    bytes = wn * 8;
  revoke(moved);
  return [a, bytes];
}
// the counts a message holds on its strings and its shapes' keys, which its
// reader gives back once it has read them (see put); null outside a message's
// read
let given: number[] | null = null;
export function __unmessage<T = unknown>(a: number, bytes: number) {
  const outer = given;
  given = [];
  try {
    return read(a, false) as T;
  } finally {
    const list = given;
    given = outer;
    for (const p of list) release(p);
    $freeBlock(a, bytes);
  }
}

// ---- sharing ----
// writes v once and freezes it as it goes (it is shared now, so nobody may
// change it)
export function share<T>(v: T) {
  if (v === null || typeof v !== 'object') return v;
  if (sharedAddr.has(v)) return v;
  const a = write(v as Sent, null, true);
  sharedAddr.set(v, a);
  copies.set(a, v); // this thread's copy is v itself
  return v;
}
// the blob of a shared value, if v is one (a map holds it by that)
export const __sharedAddress: (v: object) => number | undefined = v =>
  sharedAddr.get(v);
// a shared blob, as this thread's own frozen copy (made once)
const copies = new Map<number, unknown>();
export const __materialize = (a: number) => materialize(a);
function materialize(a: number) {
  let v = copies.get(a);
  if (v === undefined) {
    v = read(a, true);
    if (v !== null && typeof v === 'object') sharedAddr.set(v, a);
    copies.set(a, v);
  }
  return v;
}

// ---- cells: shared and mutable, explicitly ----
const K_LOCK = 20,
  K_CONDITION = 21,
  K_F64 = 22,
  K_SHARED_ARRAY = 23,
  // maps.ts's, counted here: whether a kind is counted cannot wait for its
  // module to load, as a thread that has not loaded it may apply a decrement
  // of one (a pool worker reclaiming what another thread deferred), and a
  // decrement skipped as uncounted would keep the block for good
  K_SHARED_MAP = 25,
  K_SHARED_SET = 26;
// counted cells defined outside this module (maps.ts): what freeing a block of
// their kind releases and frees, given drop, which gives back a count it held
type Destroy = (b: number, drop: (p: number) => void) => void;
const destroys = new Map<number, Destroy>([[K_STR, b => $stringDying(b)]]);
// structs, SharedArrays, strings, maps and sets (REFCOUNT.md)
const counted: (kind: number) => boolean = kind =>
  kind === K_SHARED_ARRAY ||
  kind >= 100 ||
  kind === K_STR ||
  kind === K_SHARED_MAP ||
  kind === K_SHARED_SET;
// a cell's object in this thread
type CellValue = CellObject | Int32Array;
// address -> this thread's cell object. a struct's or SharedArray's handle
// holds a count of its own and is held weakly: when V8 collects it, the
// registry gives the count back
const cells = new Map<number, CellValue | WeakRef<CellValue>>();
let finalizable = 0;
const handles = new FinalizationRegistry<number>(a => {
  const r = cells.get(a);
  if (r instanceof WeakRef && r.deref() === undefined) cells.delete(a);
  finalizable--;
  release(a);
});
const holdFor = (h: object, a: number) => {
  retain(a);
  handles.register(h, a);
  finalizable++;
};
function cell(a: number) {
  let c = cells.get(a);
  if (c instanceof WeakRef) c = c.deref();
  if (c === undefined) {
    const kind = I32[a >> 2],
      Cls = cellKinds.get(kind);
    if (kind === K_F64) {
      c = new Float64Array(SAB!, a + 16, I32[(a >> 2) + 1]) as F64Cell;
      c.$cell = a;
    } else if (kind === K_SHARED_ARRAY) c = sharedArrayHandle(a);
    else
      c = Object.assign(
        Object.create((Cls ?? structType(kind)).prototype) as object,
        {$cell: a},
      );
    if (counted(kind)) {
      holdFor(c, a);
      cells.set(a, new WeakRef(c));
    } else cells.set(a, c);
  }
  return c;
}
// for cells defined outside this module (chan.ts): their kind's class, and a
// new one's block
export const __cellKind = (kind: number, Cls: CellClass) => {
  cellKinds.set(kind, Cls);
};
export const __newCell = (kind: number, bytes: number, self: CellObject) =>
  newCell(kind, bytes, self);
// a counted kind's class, and how one of its blocks is freed. a block of it
// starts [kind][count], and its handles hold counts as a struct's do
export const __countedCellKind = (
  kind: number,
  Cls: CellClass,
  destroy: Destroy,
) => {
  if (kind !== K_SHARED_MAP && kind !== K_SHARED_SET)
    throw new TypeError(`own: kind ${kind} is not one own.ts counts`);
  cellKinds.set(kind, Cls);
  destroys.set(kind, destroy);
};
const newCell = (kind: number, bytes: number, self: CellObject) => {
  const a = $alloc(bytes);
  I32[a >> 2] = kind;
  self.$cell = a;
  cells.set(a, self);
  return a;
};

// spins before a thread sleeps: the other side is often only a moment away
const SPINS = 20000;

// `using` needs Symbol.dispose, which an engine may not have yet
(Symbol as {dispose?: symbol}).dispose ??= Symbol.for('Symbol.dispose');

// a lock: one thread at a time holds it. its block is [kind][state], state 0
// free, 1 held, 2 held with threads waiting (a futex, as in Drepper's "Futexes
// Are Tricky"). a thread that waits for it is quiescent meanwhile
// (REFCOUNT.md). hold() returns the hold, which releases the lock when it is
// disposed: `using _ = lock.hold();` holds it to the end of the block, with no
// callback, which compiled code would have to count what it captures in
export class Lock {
  declare $cell: number;
  constructor() {
    newCell(K_LOCK, 8, this);
  }
  hold(): Disposable {
    $mustNotBlock('Lock.hold()', 'using _ = await lock.holdAsync()');
    const i = (this.$cell >> 2) + 1;
    acquire(i);
    return new Held(i);
  }
  // the same in an async function: waits for the lock without blocking its
  // worker
  async holdAsync(): Promise<Disposable> {
    const i = (this.$cell >> 2) + 1;
    await acquireAsync(i);
    return new Held(i);
  }
}
// a lock's hold: disposing it releases the lock, once
class Held {
  declare i: number;
  constructor(i: number) {
    this.i = i;
  }
  [Symbol.dispose]() {
    if (this.i === 0) return;
    unlock(this.i);
    this.i = 0;
  }
}
cellKinds.set(K_LOCK, Lock);
function acquire(i: number) {
  if (Atomics.compareExchange(I32, i, 0, 1) === 0) return;
  $waitBegin();
  for (let k = 0; k < SPINS; k++)
    if (
      Atomics.load(I32, i) === 0 &&
      Atomics.compareExchange(I32, i, 0, 1) === 0
    ) {
      $waitEnd();
      return;
    }
  while (Atomics.exchange(I32, i, 2) !== 0) Atomics.wait(I32, i, 2);
  $waitEnd();
}
async function acquireAsync(i: number) {
  if (Atomics.compareExchange(I32, i, 0, 1) === 0) return;
  while (Atomics.exchange(I32, i, 2) !== 0) {
    const w = Atomics.waitAsync(I32, i, 2);
    if (w.async) await w.value;
  }
  $resumed();
}
const unlock = (i: number) => {
  if (Atomics.exchange(I32, i, 0) === 2) Atomics.notify(I32, i, 1);
};

// a condition: threads that hold a lock wait on it until another thread
// notifies them. its block is [kind][seq]: every notify changes seq, which
// waiters wait on. a waiter may wake without a notify, so it waits in a loop
// that checks what it waits for
export class Condition {
  declare $cell: number;
  constructor() {
    newCell(K_CONDITION, 8, this);
  }
  // releases lock, which this thread holds, waits for a notify, and holds lock
  // again
  wait(lock: Lock) {
    $mustNotBlock('Condition.wait()', 'await waitAsync()');
    const s = (this.$cell >> 2) + 1,
      seq = Atomics.load(I32, s),
      l = (lock.$cell >> 2) + 1;
    unlock(l);
    $waitBegin();
    let k = 0;
    while (k < SPINS && Atomics.load(I32, s) === seq) k++;
    while (Atomics.load(I32, s) === seq) Atomics.wait(I32, s, seq);
    $waitEnd();
    acquire(l);
  }
  // the same in an async function: waits without blocking its worker
  async waitAsync(lock: Lock) {
    const s = (this.$cell >> 2) + 1,
      seq = Atomics.load(I32, s),
      l = (lock.$cell >> 2) + 1;
    unlock(l);
    while (Atomics.load(I32, s) === seq) {
      const w = Atomics.waitAsync(I32, s, seq);
      if (w.async) await w.value;
    }
    $resumed();
    await acquireAsync(l);
  }
  notifyOne() {
    const s = (this.$cell >> 2) + 1;
    Atomics.add(I32, s, 1);
    Atomics.notify(I32, s, 1);
  }
  notifyAll() {
    const s = (this.$cell >> 2) + 1;
    Atomics.add(I32, s, 1);
    Atomics.notify(I32, s);
  }
}
cellKinds.set(K_CONDITION, Condition);

// numbers every thread reads and writes in place: a Float64Array over the
// shared heap. no copies; the program orders its reads and writes itself (with
// a Lock, say)
export function sharedFloat64Array(n: number) {
  if (!Number.isInteger(n) || n < 0)
    throw new RangeError(`own: a length is a whole number, not ${n}`);
  const a = $alloc(16 + n * 8);
  I32[a >> 2] = K_F64;
  I32[(a >> 2) + 1] = n;
  const v = new Float64Array(SAB!, a + 16, n) as F64Cell;
  v.$cell = a;
  cells.set(a, v);
  return v;
}

// a struct type: a class of handles on its blocks, and its layout
export interface StructType<T = unknown> {
  new (): T & CellObject;
  kind: number;
  size: number;
  fields: string[];
  refs: number[];
  kinds: string;
  strs: number[]; // the string fields
}
// `const Name = struct({a: f64, b: ref<Name>(), c: bool, d: str, e: i32, f: u8,
// g: ref<Channel>()})`
// (threads.ts), or `shared struct Name { a: number; b: Name | null; ... }` in
// the syntax, compiles to __sharedStruct('Name', ['a', 'b', 'c', 'd', 'e',
// 'f'], [1], 'frbsiu'): the reference fields' indexes, and the fields' kinds,
// or '' if each is f or r. a struct's block is [kind][count] and then its
// fields, 8 bytes each, in order, each as its kind says: f an f64; r a struct's
// or a SharedArray's address in the slot's low half, 0 for null; b a byte, 0 or
// 1, and u a byte, at the slot's start; s an interned string's address in the
// low half, 0 for "" (see storeStr); i an i32 in the low half; c a channel's
// address in the low half, 0 for null, with no count (a channel is never
// freed). compiled code has c where uncompiled code, which cannot tell a
// channel from a struct, has r. compiled with the tsgo fork's typed layout, a
// struct value is the block's address and `p.a` is `__F64[(p >> 3) + 1]` (see
// newStruct). where one flows into `any` or `unknown` the compiler boxes it
// (__box): the handle is an instance of the class this returns, an object whose
// accessors read and write the same block. uncompiled code can use the class
// directly. a struct's kind is the address of its name and layout in the shared
// string table, so every thread agrees on it whatever order it loads modules in
// (a page's workers load them on demand), and two structs with one layout may
// share it. it is at least CTRL_BYTES, so never a small cell kind
export function sharedStruct<T = unknown>(
  name: string,
  fields: string[],
  refs: number[] = [],
  kinds = '',
) {
  // the layout, as JSON: a field's name may hold anything (see structType)
  const layout = `struct ${JSON.stringify([name, fields, refs, kinds])}`;
  if (!kinds)
    kinds = fields.map((_, k) => (refs.includes(k) ? 'r' : 'f')).join('');
  const kind = $intern(layout),
    n = fields.length,
    size = 8 + n * 8;
  const Struct = {
    [name]: class {
      declare $cell: number;
      constructor() {
        const a = newStruct(Struct);
        this.$cell = a;
        holdFor(this, a);
        cells.set(a, new WeakRef(this));
        release(a);
      }
    },
  }[name] as StructType<T>;
  Struct.kind = kind;
  Struct.size = size;
  Struct.fields = fields;
  Struct.refs = refs;
  Struct.kinds = kinds;
  Struct.strs = kinds.split('').flatMap((kind, k) => (kind === 's' ? [k] : []));
  const accessors: Record<
    string,
    (k: number) => PropertyDescriptor & ThisType<CellObject>
  > = {
    r: k => ({
      get() {
        const q = I32[(this.$cell >> 2) + 2 + 2 * k];
        return q === 0 ? null : cell(q);
      },
      set(v: MaybeCell) {
        store((this.$cell >> 2) + 2 + 2 * k, retain(cellAddress(v)));
      },
    }),
    c: k => ({
      get() {
        const q = I32[(this.$cell >> 2) + 2 + 2 * k];
        return q === 0 ? null : cell(q);
      },
      set(v: MaybeCell) {
        I32[(this.$cell >> 2) + 2 + 2 * k] = cellAddress(v);
      },
    }),
    b: k => ({
      get() {
        return U8[this.$cell + 8 + 8 * k] !== 0;
      },
      set(v: boolean) {
        U8[this.$cell + 8 + 8 * k] = v ? 1 : 0;
      },
    }),
    u: k => ({
      get() {
        return U8[this.$cell + 8 + 8 * k];
      },
      set(v: number) {
        U8[this.$cell + 8 + 8 * k] = v;
      },
    }),
    i: k => ({
      get() {
        return I32[(this.$cell >> 2) + 2 + 2 * k];
      },
      set(v: number) {
        I32[(this.$cell >> 2) + 2 + 2 * k] = v;
      },
    }),
    s: k => ({
      get() {
        return strAt(I32[(this.$cell >> 2) + 2 + 2 * k]);
      },
      set(v: string) {
        storeStr((this.$cell >> 2) + 2 + 2 * k, v);
      },
    }),
    f: k => ({
      get() {
        return F64[(this.$cell >> 3) + 1 + k];
      },
      set(v: number) {
        F64[(this.$cell >> 3) + 1 + k] = +v;
      },
    }),
  };
  fields.forEach((field, k) =>
    Object.defineProperty(Struct.prototype, field, {
      ...accessors[kinds[k]](k),
      enumerable: true,
    }),
  );
  cellKinds.set(kind, Struct);
  structTypes.add(Struct);
  return Struct;
}
// the struct type of kind: declared here, or by another thread, whose module
// this one may never load (a page's workers load modules on demand, and a
// struct reaches a thread by address, in a message or a map). a kind is the
// address of the type's layout, a pinned string (see sharedStruct), so the
// type is declared from that: what frees a struct, or boxes one, needs no
// module for it
function structType(kind: number): StructType {
  const known = cellKinds.get(kind) as StructType | undefined;
  if (known !== undefined) return known;
  const text = I32[kind >> 2] === K_STR ? $str(kind) : '';
  let layout: unknown;
  try {
    layout = text.startsWith('struct ') ? JSON.parse(text.slice(7)) : null;
  } catch {
    layout = null;
  }
  if (
    !Array.isArray(layout) ||
    layout.length !== 4 ||
    typeof layout[0] !== 'string' ||
    !Array.isArray(layout[1]) ||
    !Array.isArray(layout[2]) ||
    typeof layout[3] !== 'string'
  )
    throw new TypeError(`own: no cell of kind ${kind}`);
  const [name, fields, refs, kinds] = layout as [
    string,
    string[],
    number[],
    string,
  ];
  return sharedStruct(name, fields, refs, kinds);
}

// ---- typed layouts: what the compiler emits for shared structs and
// SharedArrays ----
// a struct or SharedArray value is the byte address of its block in the shared
// heap, so threads pass it along as a number and all use the same memory:
// nothing is copied. the compiler reads and writes fields and elements through
// these views
export {I32, F64, U8};
// strings in shared memory are interned (runtime.ts $intern): one copy of each,
// which every thread decodes once and keeps, and counted: a string goes when
// nothing refers to it. a string field or element holds its address and a count
// of it, 0 for "": compiled, a read is __strAt(__I32[i]) and a write
// __storeStr(i, v)
export const strAt: (a: number) => string = a => (a === 0 ? '' : $str(a));
// a string field's or element's store at i32 index i: counts the new string,
// and gives back the old one's count (runtime.ts $releaseString); returns s.
// storing the string the field holds already changes nothing
export function storeStr(i: number, s: string) {
  s = String(s);
  const here = s === '' ? 0 : $internedHere(s);
  if (I32[i] === here && (here !== 0 || s === '')) return s;
  const a = $internRef(s),
    old = Atomics.exchange(I32, i, a);
  $releaseString(old === a ? a : old); // one count is enough
  return s;
}
// a zeroed struct: [kind][count 1], then its fields from byte 8. the caller
// owns the count
export function newStruct(type: StructType) {
  const a = $allocBlock(type.size);
  I32[a >> 2] = type.kind;
  I32[(a >> 2) + 1] = 1;
  return a;
}
// [kind][length][element][count] then the elements from byte 16. type, which
// the compiler emits, is a struct type or the element's size in bytes, negative
// for an integer: numbers (8), i32s (-4), strings (4, an interned string's
// address each), u8s (-1) and booleans (1, a byte each, 0 or 1). the element
// word is the size, and the element's kind in its high half (E_*, 0 for a
// number or a struct). a struct element is a whole struct block, with a header
// of its own so that its address can be boxed like any struct's: [kind][back],
// back the array's address minus its own (an element lives as long as its
// array, and counting it counts the array)
const E_BOOL = 1,
  E_STR = 2,
  E_I32 = 3,
  E_U8 = 4;
const elementCodes = new Map([
  [8, 0],
  [1, E_BOOL],
  [4, E_STR],
  [-4, E_I32],
  [-1, E_U8],
]);
const elementSize: (a: number) => number = a => I32[(a >> 2) + 2] & 0xffff,
  elementKind: (a: number) => number = a => I32[(a >> 2) + 2] >>> 16;
export function newSharedArray(type: StructType | number, length: number) {
  const struct = typeof type !== 'number',
    size = struct ? type?.size : Math.abs(type);
  // checked here, where every array is made: a size that is not would make a
  // block of no bytes, or of a negative number of them, over the next one
  if (!Number.isInteger(length) || length < 0)
    throw new RangeError(
      `own: a SharedArray's length is a whole number, not ${length}`,
    );
  // a struct type is one sharedStruct declared (structTypes): an object of a
  // size and no kind, or of another's, would write a kind into every element
  // that nothing reads back
  if (
    !(size > 0) ||
    (struct ? !structTypes.has(type) : !elementCodes.has(type))
  )
    throw new TypeError(
      'own: a SharedArray holds numbers, booleans, strings, i32s, u8s or a shared struct',
    );
  const a = $allocBlock(16 + length * size);
  I32[a >> 2] = K_SHARED_ARRAY;
  I32[(a >> 2) + 1] = length;
  I32[(a >> 2) + 3] = 1;
  I32[(a >> 2) + 2] = size | ((struct ? 0 : elementCodes.get(type)!) << 16);
  if (struct)
    for (let e = a + 16, end = e + length * size; e < end; e += size) {
      I32[e >> 2] = type.kind;
      I32[(e >> 2) + 1] = a - e;
    }
  return a;
}

// ---- reference counts (REFCOUNT.md) ----
// the block whose count an address's lifetime is, and where that count is
const owner: (p: number) => number = p => {
  const w = I32[(p >> 2) + 1];
  return w < 0 ? p + w : p;
};
const countAt: (o: number) => number = o =>
  I32[o >> 2] === K_SHARED_ARRAY ? (o >> 2) + 3 : (o >> 2) + 1;
// null is 0; a raw value can also be undefined at run time (a missing argument,
// `f?.()` ). a reference field may also hold a channel (uncompiled code cannot
// tell), which lives as long as the program and has no count
export function retain(p: number) {
  if (p && counted(I32[p >> 2])) Atomics.add(I32, countAt(owner(p)), 1);
  return p;
}
export function release(p: number) {
  if (!p || !counted(I32[p >> 2])) return;
  const o = owner(p);
  if (Atomics.sub(I32, countAt(o), 1) === 1) destroy(o);
}
// count 0: no thread holds an uncounted address of the block or of anything
// read through it, so its reference fields are released at once, and so on
// down, with a work list rather than recursion
function destroy(o: number) {
  const work = [o];
  const drop: (p: number) => void = p => {
    if (p === 0 || !counted(I32[p >> 2])) return;
    const q = owner(p);
    if (Atomics.sub(I32, countAt(q), 1) === 1) work.push(q);
  };
  while (work.length !== 0) {
    const b = work.pop()!,
      kind = I32[b >> 2],
      d = destroys.get(kind);
    if (d !== undefined) d(b, drop);
    else if (kind === K_SHARED_MAP || kind === K_SHARED_SET)
      // the entry points load maps.ts (threads-worker.ts, browser.ts); a
      // thread that has not would leave the block's contents counted
      throw new Error(
        'own: a SharedMap or SharedSet is freed on a thread that has not loaded maps.ts',
      );
    else if (kind === K_SHARED_ARRAY) {
      const n = I32[(b >> 2) + 1],
        size = elementSize(b);
      if (size > 8 && n !== 0) {
        // structs
        const T = structType(I32[(b + 16) >> 2]);
        if (T.refs.length + T.strs.length !== 0)
          for (let e = b + 16, end = e + n * size; e < end; e += size) {
            for (const k of T.refs) drop(I32[(e >> 2) + 2 + 2 * k]);
            for (const k of T.strs) drop(I32[(e >> 2) + 2 + 2 * k]);
          }
      } else if (elementKind(b) === E_STR)
        for (let e = (b + 16) >> 2, end = e + n; e < end; e++) drop(I32[e]);
      $freeBlock(b, 16 + n * size);
    } else {
      const T = structType(kind);
      for (const k of T.refs) drop(I32[(b >> 2) + 2 + 2 * k]);
      for (const k of T.strs) drop(I32[(b >> 2) + 2 + 2 * k]);
      $freeBlock(b, T.size);
    }
  }
}
// a reference field store at i32 index i: takes over v's count. a thread may
// have read the old value and not counted it yet, so its decrement waits for
// every thread's next quiescent point
export function store(i: number, v: number) {
  const old = Atomics.exchange(I32, i, v);
  if (old !== 0) $defer(old);
  return v;
}
setDeferHandler(release);
export const quiescent = $quiescent;
export const heapStats = $heapStats;
// works off the decrements that wait: all of them when no other thread runs
export const __collect = $drain;
// a closure that captures counted addresses holds a count on each until V8
// collects it
const closures = new FinalizationRegistry<number[]>(ps => {
  finalizable--;
  for (const p of ps) release(p);
});
export function capture<F extends object>(fn: F, ...ps: number[]) {
  for (const p of ps) retain(p);
  closures.register(fn, ps);
  finalizable++;
  return fn;
}
// a counted spawn argument: retained for the thread, which releases it when its
// function returns
class CountedArg {
  declare a: number;
  constructor(a: number) {
    this.a = a;
  }
}
export const countedRef: (a: number) => CountedArg = a =>
  new CountedArg(retain(a));
// a counted result the compiler returns to the runtime (a callback's of a
// runtime function whose result is `Sending`, as a SharedMap's
// getOrInsertComputed's): it carries its count already
export const moved: (a: number) => CountedArg = a => new CountedArg(a);
// where get() records the counted values it reads: a thread's arguments,
// released when its function returns, or null, when the reader owns them (a
// channel message's receiver)
let countedInto: number[] | null = null;
export const __isCounted: (v: unknown) => boolean = v =>
  v instanceof CountedArg;

// boxing: where a struct or SharedArray value (an address) flows into `any` ,
// `unknown` , a generic and the like, the compiler wraps it in this thread's
// one handle object for that address (so ===
// still holds), and unwraps it on the way back. a struct's handle is an
// instance of its class; a SharedArray's is an array-like Proxy over the same
// memory
export const box: (a: number) => CellValue | null = a => (a ? cell(a) : null);
// the address of a cell's block (a struct's, a SharedArray's, a channel's...),
// 0 for null: what a reference or channel field holds
export function cellAddress(v: MaybeCell) {
  if (v == null) return 0;
  const a = typeof v === 'object' ? v.$cell : undefined;
  if (a === undefined)
    throw new TypeError(
      'own: not a cell (a shared struct, a SharedArray, a Channel)',
    );
  return a;
}
// what a SharedArray holds: Number, Boolean, String, threads.ts's i32 or u8, or
// a struct type; and the type of its elements
type ElementType =
  | ((NumberConstructor | BooleanConstructor | StringConstructor) & {
      kind?: undefined;
    })
  | {readonly kind: 'i32' | 'u8'}
  | StructType;
type Element<E> =
  E extends StructType<infer T>
    ? T & CellObject
    : E extends BooleanConstructor
      ? boolean
      : E extends StringConstructor
        ? string
        : number;
// for code the compiler did not lay out: `new SharedArray(Struct, n)` gives the
// boxed array-like
export class SharedArray<E extends ElementType = ElementType> {
  declare $cell: number;
  declare readonly length: number;
  [index: number]: Element<E>;
  constructor(type: E, length: number) {
    const code =
      type === Number
        ? 8
        : type === Boolean
          ? 1
          : type === String
            ? 4
            : type?.kind === 'i32'
              ? -4
              : type?.kind === 'u8'
                ? -1
                : type;
    const a = newSharedArray(code as StructType | number, length),
      h = cell(a) as SharedArray<E>;
    release(a); // the handle holds its own count
    return h;
  }
}
export function unbox(v: MaybeCell) {
  if (v == null) return 0;
  const a = typeof v === 'object' ? v.$cell : undefined;
  if (
    a === undefined ||
    !(I32[a >> 2] === K_SHARED_ARRAY || I32[a >> 2] >= 100)
  )
    throw new TypeError('own: not a shared struct or SharedArray');
  return a;
}
class SharedArrayHandle {
  declare $cell: number;
  get length() {
    return I32[(this.$cell >> 2) + 1];
  }
  *[Symbol.iterator]() {
    for (let i = 0; i < this.length; i++) yield sharedArrayGet(this.$cell, i);
  }
}
const isIndex: (key: string | symbol) => boolean = key =>
  typeof key === 'string' &&
  key !== '' &&
  String((key as unknown as number) >>> 0) === key;
function sharedArrayAddress(a: number, i: number) {
  if (!(i < I32[(a >> 2) + 1])) oob(a, i);
  return a + 16 + i * elementSize(a);
}
// numbers, integers, booleans and strings are read in place; a struct element
// is boxed in turn
function sharedArrayGet(a: number, i: number) {
  const e = sharedArrayAddress(a, i);
  switch (elementKind(a)) {
    case E_BOOL:
      return U8[e] !== 0;
    case E_STR:
      return strAt(I32[e >> 2]);
    case E_I32:
      return I32[e >> 2];
    case E_U8:
      return U8[e];
  }
  return elementSize(a) === 8 ? F64[e >> 3] : cell(e);
}
function sharedArrayHandle(a: number): SharedArrayHandle {
  const target = Object.assign(Object.create(SharedArrayHandle.prototype), {
    $cell: a,
  });
  return new Proxy(target, {
    get: (t, key, receiver) =>
      isIndex(key)
        ? sharedArrayGet(a, Number(key))
        : Reflect.get(t, key, receiver),
    set: (t, key, v, receiver) => {
      if (!isIndex(key)) return Reflect.set(t, key, v, receiver);
      const e = sharedArrayAddress(a, Number(key));
      switch (elementKind(a)) {
        case E_BOOL:
          U8[e] = v ? 1 : 0;
          break;
        case E_STR:
          storeStr(e >> 2, v);
          break;
        case E_I32:
          I32[e >> 2] = v;
          break;
        case E_U8:
          U8[e] = v;
          break;
        default:
          if (elementSize(a) !== 8)
            throw new TypeError(
              'own: a SharedArray of structs holds its structs in place',
            );
          F64[e >> 3] = +v;
      }
      return true;
    },
    has: (t, key) =>
      isIndex(key) ? Number(key) < I32[(a >> 2) + 1] : Reflect.has(t, key),
  });
}
function oob(a: number, i: number): never {
  throw new RangeError(
    `index ${i} is out of range for a SharedArray of length ${I32[(a >> 2) + 1]}`,
  );
}
// ---- atomic operations (threads.d.ts `atomic`) ----
// on an i32 field of a struct, by name, or on an element of a SharedArray<i32>,
// by index. compiled, a call is the Atomics call itself, on the i32's index;
// code the compiler did not lay out finds the index here, through the handle
function atomicIndex(target: MaybeCell, key: any) {
  const a = unbox(target);
  if (I32[a >> 2] === K_SHARED_ARRAY) {
    if (elementKind(a) !== E_I32)
      throw new TypeError(
        'own: an atomic operation acts on a SharedArray<i32>',
      );
    if (!(key >>> 0 === key && key < I32[(a >> 2) + 1])) oob(a, key);
    return ((a + 16) >> 2) + key;
  }
  const T = structType(I32[a >> 2]),
    k = T.fields.indexOf(key);
  if (k < 0 || T.kinds[k] !== 'i')
    throw new TypeError(
      `own: an atomic operation acts on an i32 field, which ${String(key)} is not`,
    );
  return (a >> 2) + 2 + 2 * k;
}
// an operation on an i32 field by name, or a SharedArray<i32>'s element
type AtomicOperation<A extends unknown[], R> = (
  target: MaybeCell,
  key: number | string,
  ...args: A
) => R;
export const atomic: {
  load: AtomicOperation<[], number>;
  store: AtomicOperation<[value: number], number>;
  add: AtomicOperation<[value: number], number>;
  sub: AtomicOperation<[value: number], number>;
  and: AtomicOperation<[value: number], number>;
  or: AtomicOperation<[value: number], number>;
  xor: AtomicOperation<[value: number], number>;
  exchange: AtomicOperation<[value: number], number>;
  compareExchange: AtomicOperation<
    [expected: number, replacement: number],
    number
  >;
  wait: AtomicOperation<
    [value: number, timeout?: number],
    'ok' | 'not-equal' | 'timed-out'
  >;
  notify: AtomicOperation<[count?: number], number>;
} = Object.freeze({
  load: (t, k) => Atomics.load(I32, atomicIndex(t, k)),
  store: (t, k, v) => Atomics.store(I32, atomicIndex(t, k), v),
  add: (t, k, v) => Atomics.add(I32, atomicIndex(t, k), v),
  sub: (t, k, v) => Atomics.sub(I32, atomicIndex(t, k), v),
  and: (t, k, v) => Atomics.and(I32, atomicIndex(t, k), v),
  or: (t, k, v) => Atomics.or(I32, atomicIndex(t, k), v),
  xor: (t, k, v) => Atomics.xor(I32, atomicIndex(t, k), v),
  exchange: (t, k, v) => Atomics.exchange(I32, atomicIndex(t, k), v),
  compareExchange: (t, k, expected, replacement) =>
    Atomics.compareExchange(I32, atomicIndex(t, k), expected, replacement),
  // a wait as the runtime's waits are: refused where it would block a host or
  // the page, and quiescent throughout (the thread holds nothing it read
  // uncounted, so it holds up no other thread's frees, and its own queue goes
  // to the shared list first), the thread marked running again after
  wait: (t, k, v, timeout) => {
    $mustNotBlock(
      'atomic.wait()',
      'await condition.waitAsync(lock), on a Condition',
    );
    const i = atomicIndex(t, k);
    $waitBegin();
    try {
      return Atomics.wait(I32, i, v, timeout);
    } finally {
      $waitEnd();
    }
  },
  notify: (t, k, count) => Atomics.notify(I32, atomicIndex(t, k), count),
});

// what compiled code reads when an index is out of range, instead of calling a
// function: a read of this Proxy throws. an optimized loop with a call in it
// (even one never taken) loses some of V8's loop optimizations; a property read
// with no feedback costs nothing until it happens
export const outOfBounds = new Proxy(
  {},
  {
    get(_, i) {
      throw new RangeError(
        `index ${String(i)} is out of range for a SharedArray`,
      );
    },
  },
);

// ---- threads: spawn(fn, ...args) moves args to a new thread running fn; join
// moves its result back ----
// any function: a thread's arguments are whatever it takes
export type ThreadFn = (...args: never[]) => unknown;
// a thread names its function by key: every worker loads the same modules, so a
// key finds the same function everywhere. the compiler registers every
// top-level function of a module that uses the ownership syntax
// (`register(import.meta.url, { ... })`, which it imports as __register); a
// program whose types are only erased calls it itself, and fns() is the same
// without a module
const byKey = new Map<string, ThreadFn>(),
  keyOf = new Map<ThreadFn, string>();
export function register(url: string, table: Record<string, ThreadFn>) {
  for (const [name, f] of Object.entries(table)) {
    const key = `${url}#${name}`;
    byKey.set(key, f);
    keyOf.set(f, key);
  }
}
export const fns: (table: Record<string, ThreadFn>) => void = table =>
  register('', table);
setThreadEntry(t => {
  const mine = (countedInto = []);
  // frees the arguments
  const [key, ...args] = __unmessage<[string, ...unknown[]]>(
    I32[(t + 16) >> 2],
    I32[(t + 20) >> 2],
  );
  countedInto = null;
  let pending = false;
  try {
    const f = byKey.get(key);
    if (f === undefined)
      throw new Error(`own: no function ${key} in this worker`);
    const r = (f as (...args: unknown[]) => unknown)(...args);
    if (r instanceof Promise) {
      // an async function: its arguments are counted until it ends, and its
      // result is sent then
      pending = true;
      return r
        .then(v => resultOf(t, v))
        .finally(() => {
          for (const p of mine) release(p);
        });
    }
    return resultOf(t, r);
  } finally {
    if (!pending) for (const p of mine) release(p);
  }
});
function resultOf(t: number, r: unknown) {
  if (I32[(t + 4) >> 2] === 1) return 0; // detached: nothing reads a result
  const [a, bytes] = __message(r);
  I32[(t + 20) >> 2] = bytes;
  return a;
}
const AsyncFunction = (async () => {}).constructor;
// between threads, a worker yields to its event loop when handles or closures
// wait to be finalized
setAfterTask(() => finalizable > 0);
// in a page's worker pool (threads-worker.ts), a worker loads a thread's module
// the first time a thread needs it: a key is `${module}#${name}` , and the
// loader maps a module to its import
type ModuleLoader = (module: string) => Promise<unknown> | undefined;
let moduleLoader: ModuleLoader | null = null;
// the modules this worker loaded through the loader, whole: a module that
// registers its functions and then throws as it loads has its keys in byKey
// all the same, and is not to run. one that another module imported is loaded
// once more by its id, which the module system has cached
const loaded = new Set<string>();
export function setModuleLoader(load: ModuleLoader) {
  moduleLoader = load;
  setBeforeTask(async t => {
    // the blob's [key, ...args]
    const base = I32[(t + 16) >> 2],
      key = get(base, I32[base >> 2] + 1, false) as string,
      id = key.slice(0, key.lastIndexOf('#'));
    if (loaded.has(id)) return;
    try {
      await moduleLoader!(id);
    } catch (e) {
      // the thread's error (runtime.ts prepare): a module that throws as it
      // loads, is not found, or is blocked. the thread's arguments, which its
      // entry would have read and freed, are dropped here, with their counts
      try {
        dropArguments(t);
      } catch {}
      throw new Error(
        `own: the module of thread function '${key.slice(key.lastIndexOf('#') + 1)}' could not be loaded here (${id}): ${String((e as {message?: unknown})?.message ?? e)}`,
      );
    }
    loaded.add(id);
  });
}
// R: what fn returns, or what its promise resolves to
class Thread<R = unknown> {
  declare t: number;
  declare joined: boolean;
  constructor(t: number) {
    this.t = t;
    this.joined = false;
  }
  join(): R {
    // first: a host must not block, and the thread goes on, so nothing below
    // may have happened (the finally would free the block of a running thread)
    $mustNotBlock('join()', 'await joinAsync()');
    if (this.joined)
      throw new TypeError(
        'own: a thread is joined once (its result moves out)',
      );
    this.joined = true;
    $quiescent();
    try {
      return __unmessage<R>(threadJoin(this.t), I32[(this.t + 20) >> 2]);
    } finally {
      $freeBlock(this.t, 32);
    }
  }
  // for a page's main thread, and an async function, which must not block
  async joinAsync(): Promise<R> {
    if (this.joined)
      throw new TypeError(
        'own: a thread is joined once (its result moves out)',
      );
    this.joined = true;
    $quiescent();
    try {
      const a = await threadJoinAsync(this.t);
      $resumed();
      return __unmessage<R>(a, I32[(this.t + 20) >> 2]);
    } finally {
      $freeBlock(this.t, 32);
    }
  }
}
// a thread's arguments as spawn takes them: an address may come counted
// (__countedRef), and arrives as the number
export type SpawnArgs<A extends unknown[]> = {
  [K in keyof A]: A[K] extends number ? A[K] | CountedArg : A[K];
};
export const spawn = <A extends unknown[], R>(
  fn: (...args: A) => R,
  ...args: SpawnArgs<A>
) => new Thread<Awaited<R>>(__start(fn, args, false));
// a thread block for fn(...args), queued for the pool:
// [kind][detached][done][threw][arguments][their bytes][result]. the arguments,
// and then the result, are messages: the thread frees its arguments once it has
// read them, and whoever joins it frees the result and the block. a detached
// thread (chan.ts go) is never joined: it has no result, the runtime frees its
// block and prints its error if it throws. an async function's thread is an
// async thread: a host runs it with others, and it ends when its promise
// settles (runtime.ts spawnAsync)
export function __start(fn: ThreadFn, args: unknown[], detached: boolean) {
  const key = keyOf.get(fn);
  if (key === undefined)
    throw new TypeError(
      'own: spawn a top-level function of a module that registers it: the compiler adds `register(import.meta.url, {...})`, and a module run uncompiled calls it',
    );
  const t = $allocBlock(32);
  I32[t >> 2] = K_THREAD;
  I32[(t + 4) >> 2] = detached ? 1 : 0;
  const [a, bytes] = __message([key, ...args], 1);
  I32[(t + 16) >> 2] = a;
  I32[(t + 20) >> 2] = bytes;
  $quiescent();
  // an async function runs on a host, among other async threads: it waits
  // without blocking
  try {
    if (fn instanceof AsyncFunction) spawnAsync(t);
    else spawnThread(t);
  } catch (e) {
    // refused (too many threads waiting): no worker will run it. its
    // arguments, with the counts the message carries, and its block go
    discardThread(t);
    throw e;
  }
  return t;
}
// a thread block no worker will run: its arguments' message is read back and
// freed, with the counts it carried (as a thread's entry frees them), and the
// block is freed
function discardThread(t: number) {
  dropArguments(t);
  $freeBlock(t, 32);
}
// a thread's arguments read back and dropped, with the counts they carried (as
// the thread's entry frees them once it has read them)
function dropArguments(t: number) {
  const outer = countedInto,
    mine = (countedInto = []);
  try {
    __unmessage(I32[(t + 16) >> 2], I32[(t + 20) >> 2]);
  } finally {
    countedInto = outer;
    for (const p of mine) release(p);
  }
}

// structured threads: scope(s => ...) joins every thread s spawned before it
// returns
class Scope {
  declare threads: Thread[];
  constructor() {
    this.threads = [];
  }
  spawn<A extends unknown[], R>(fn: (...args: A) => R, ...args: SpawnArgs<A>) {
    const th = spawn(fn, ...args);
    this.threads.push(th);
    return th;
  }
}
export function scope<R>(body: (s: Scope) => R): R {
  // first, before a thread is spawned: joining would block a worker that runs
  // async functions, and a thread spawned here could then not be joined
  $mustNotBlock('scope()');
  const s = new Scope();
  // every thread is joined, whatever the body or a join threw: none outlives
  // the scope, and each one's block and result are freed. the body's error is
  // the one thrown; else the first join's, or all of them if several
  const errors: unknown[] = [];
  const joinAll = () => {
    for (const th of s.threads)
      if (!th.joined)
        try {
          th.join();
        } catch (e) {
          errors.push(e);
        }
    $quiescent();
  };
  let result: R;
  try {
    result = body(s);
  } catch (e) {
    joinAll();
    throw e;
  }
  joinAll();
  if (errors.length !== 0)
    throw errors.length === 1
      ? errors[0]
      : new AggregateError(errors, 'threads: more than one thread threw');
  return result;
}

// `parts` owned, disjoint chunks of nearly equal size (the checker trusts this)
export const partition = <T>(items: T[], parts: number) =>
  Array.from({length: parts}, (_, t) =>
    items.slice(
      Math.floor((items.length * t) / parts),
      Math.floor((items.length * (t + 1)) / parts),
    ),
  );
// a destructive read: the element leaves the array, so the caller owns it (the
// checker trusts this)
export function take<T>(items: (T | undefined)[], index: number) {
  const v = items[index];
  items[index] = undefined;
  return v;
}
