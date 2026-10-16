// One direction of a connection between two threads: a ring of bytes in a
// SharedArrayBuffer. read blocks (Atomics.wait) until there is something to
// read, and write until there is room, so it is for a worker, never the page.
// The bytes go through `chunk`, an ordinary buffer of the pipe's own, since
// Go's WebAssembly copies to and from such a buffer (main.go): read(n) fills
// it, write(n) sends what it holds.

// the header's Int32s: the bytes written and read so far (each wraps at 2^32),
// whether the writer is done, and how many times the writer has written or
// closed, which a reader waits on: a close moves no count of bytes, and a
// reader that waited on WRITTEN could miss one that came as it went to wait
const WRITTEN = 0,
  READ = 1,
  CLOSED = 2,
  WOKEN = 3,
  HEADER = 16;

export class Pipe {
  readonly sab: SharedArrayBuffer;
  readonly chunk: Uint8Array;
  private readonly header: Int32Array;
  private readonly ring: Uint8Array;
  private readonly mask: number;

  // a pipe of `capacity` bytes (a power of two), or the other end of one
  constructor(of: number | SharedArrayBuffer, chunk = 1 << 16) {
    this.sab = typeof of === 'number' ? new SharedArrayBuffer(HEADER + of) : of;
    this.header = new Int32Array(this.sab, 0, 4);
    this.ring = new Uint8Array(this.sab, HEADER);
    if ((this.ring.length & (this.ring.length - 1)) !== 0)
      throw new Error('a pipe holds a power of two of bytes');
    this.mask = this.ring.length - 1;
    this.chunk = new Uint8Array(chunk);
  }

  // reads up to n bytes into chunk, waiting for at least one: 0 once the
  // writer has closed the pipe and everything is read
  read(n: number): number {
    return this.readInto(this.chunk, 0, Math.min(n, this.chunk.length));
  }

  // reads up to n bytes into `into` at `at`
  readInto(into: Uint8Array, at: number, n: number): number {
    const h = this.header;
    const read = Atomics.load(h, READ);
    let written: number;
    for (;;) {
      // read first: whatever the writer does after this wakes the wait below
      const woken = Atomics.load(h, WOKEN);
      written = Atomics.load(h, WRITTEN);
      if (written !== read) break;
      if (Atomics.load(h, CLOSED)) {
        // what was written before the close, after the look above
        written = Atomics.load(h, WRITTEN);
        if (written !== read) break;
        return 0;
      }
      Atomics.wait(h, WOKEN, woken);
    }
    const count = Math.min(n, (written - read) >>> 0);
    this.copyOut(read, into, at, count);
    Atomics.store(h, READ, (read + count) | 0);
    Atomics.notify(h, READ);
    return count;
  }

  // writes the first n bytes of chunk
  write(n: number): void {
    this.writeFrom(this.chunk, 0, n);
  }

  // writes n bytes of `from`, from `at`, waiting for room as it goes
  writeFrom(from: Uint8Array, at: number, n: number): void {
    const h = this.header;
    const size = this.ring.length;
    while (n > 0) {
      const written = Atomics.load(h, WRITTEN);
      let read: number;
      for (;;) {
        read = Atomics.load(h, READ);
        if ((written - read) >>> 0 < size) break;
        Atomics.wait(h, READ, read);
      }
      const count = Math.min(n, size - ((written - read) >>> 0));
      this.copyIn(written, from, at, count);
      Atomics.store(h, WRITTEN, (written + count) | 0);
      this.wake();
      at += count;
      n -= count;
    }
  }

  // the writer is done: a reader reads what is left, then 0
  close(): void {
    Atomics.store(this.header, CLOSED, 1);
    this.wake();
  }

  private wake() {
    Atomics.add(this.header, WOKEN, 1);
    Atomics.notify(this.header, WOKEN);
  }

  private copyOut(pos: number, into: Uint8Array, at: number, n: number) {
    const start = pos & this.mask;
    const first = Math.min(n, this.ring.length - start);
    into.set(this.ring.subarray(start, start + first), at);
    if (first < n) into.set(this.ring.subarray(0, n - first), at + first);
  }

  private copyIn(pos: number, from: Uint8Array, at: number, n: number) {
    const start = pos & this.mask;
    const first = Math.min(n, this.ring.length - start);
    this.ring.set(from.subarray(at, at + first), start);
    if (first < n) this.ring.set(from.subarray(at + first, at + n), 0);
  }
}
