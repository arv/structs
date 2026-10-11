// A growable vector of numbers in shared memory, written in user space: nothing here is built into
// the runtime or the compiler. A SharedArray has a fixed length, so the vector is a shared struct
// holding the length and a SharedArray with room to spare. Pushing past the room copies into an array
// twice as big and stores it in the struct. A thread that read the old array a moment before keeps a
// valid one: the old array's count drops only once every thread has passed a quiescent point, and
// then it is freed.
//
// Reads and writes are plain and unordered between threads, as with any struct. One thread pushes at
// a time: several writers share a lock, here a channel holding one token, Go's way.
import { Channel, f64, heapStats, log, ref, scope, SharedArray, struct, type Struct, type Thread } from "threads";

interface SharedVector { length: number; grows: number; data: SharedArray<number> | null }
const SharedVector = struct<SharedVector>({ length: f64, grows: f64, data: ref<SharedArray<number>>() });

/** An empty vector with room for `capacity` numbers. */
function vector(capacity = 8): SharedVector {
  const v = new SharedVector();
  v.data = new SharedArray(Number, capacity);
  return v;
}

/** Appends x, growing the vector when it is full. One thread at a time. */
function push(v: SharedVector, x: number) {
  let data = v.data!;
  if (v.length === data.length) {
    const bigger = new SharedArray(Number, data.length * 2);
    for (let i = 0; i < v.length; i++) bigger[i] = data[i];
    v.data = bigger; // the old array is freed once no thread can still be reading it
    v.grows++;
    data = bigger;
  }
  data[v.length] = x;
  v.length++;
}

/** Element i. */
function at(v: SharedVector, i: number): number {
  const data = v.data!;
  if (!(i >= 0 && i < v.length && i < data.length)) throw new RangeError(`index ${i} is out of range for a vector of ${v.length}`);
  return data[i];
}

/** The elements, copied into an ordinary array. */
function toArray(v: SharedVector): number[] {
  const data = v.data!, out: number[] = [];
  for (let i = 0; i < v.length; i++) out.push(data[i]);
  return out;
}

// ---- a demo: writers pushing into one vector while a reader reads it ----

const Flag = struct({ stop: f64 });
type Flag = Struct<typeof Flag>;
const PER_WRITER = 20000;

// pushes first, first + 1, ... count values, taking the lock for each
function writer(v: SharedVector, lock: Channel<number>, first: number, count: number) {
  for (let k = 0; k < count; k++) {
    lock.recv(); // take the token: no one else pushes now
    push(v, first + k);
    lock.send(0); // give it back
  }
}

// reads the newest element until told to stop, while the vector grows under it: how many reads, and
// how many values that no writer pushed
function reader(v: SharedVector, flag: Flag, max: number): number {
  let reads = 0, bad = 0;
  while (flag.stop === 0) {
    const data = v.data!, n = Math.min(v.length, data.length);
    if (n === 0) continue;
    const x = data[n - 1];
    if (!(Number.isInteger(x) && x >= 0 && x < max)) bad++;
    reads++;
  }
  return reads * 1e6 + bad; // two numbers in one: a thread's result is one value
}

export function main(threadCounts: readonly number[]) {
  // one thread: a million pushes into a vector that starts with room for eight
  const t0 = performance.now(), one = vector();
  for (let i = 0; i < 1_000_000; i++) push(one, i);
  log(`one thread: 1000000 pushes in ${(performance.now() - t0).toFixed(0)} ms, ${one.grows} grows, ` +
    `capacity ${one.data!.length}, element 999999 is ${at(one, 999_999)}`);

  for (const threads of threadCounts) {
    const v = vector(), lock = new Channel<number>(1), flag = new Flag(), total = threads * PER_WRITER;
    lock.send(0); // the token
    const before = heapStats(), t1 = performance.now();
    let result = 0;
    scope(s => {
      const r = s.spawn(reader, v, flag, total);
      const ws: Thread<void>[] = [];
      for (let t = 0; t < threads; t++) ws.push(s.spawn(writer, v, lock, t * PER_WRITER, PER_WRITER));
      for (const w of ws) w.join();
      flag.stop = 1;
      result = r.join();
    });
    const ms = performance.now() - t1;
    // every value pushed exactly once
    const seen = new Uint8Array(total);
    let missing = 0, twice = 0;
    for (const x of toArray(v)) { if (seen[x]++) twice++; }
    for (let x = 0; x < total; x++) if (!seen[x]) missing++;
    const after = heapStats();
    log(`${threads} writer${threads === 1 ? "" : "s"} and a reader: ${v.length} pushes in ${ms.toFixed(0)} ms, ` +
      `${v.grows} grows, ${missing} missing, ${twice} twice; reader: ${Math.floor(result / 1e6)} reads, ` +
      `${result % 1e6} bad; heap grew ${(after.heapBytes - before.heapBytes) >> 10} KiB`);
  }
}
