// What TypeScript 7.1's sync API client talks to tsgo through, in place of
// its own (typescript/dist/api/syncChannel.js, which spawns tsgo and talks
// over its stdio): the same class, the same protocol, but over two pipes in
// shared memory (pipe.ts) to tsgo in WebAssembly, in a worker of its own
// (main.go, tsgo-worker.ts). The bundle puts this module where the client
// imports its own (vite.config.ts); `connect`, which whoever starts the API
// sets first, starts tsgo with the client's arguments and gives the pipes.
//
// The protocol: each message is a MessagePack array of three, its type (u8),
// the method's name (bin) and the payload (bin).
import {Pipe} from './pipe.ts';

// from the client to tsgo
const REQUEST = 1,
  CALL_RESPONSE = 2,
  CALL_ERROR = 3;
// from tsgo to the client
const RESPONSE = 4,
  ERROR = 5,
  CALL = 6;

const FIXARRAY3 = 0x93,
  UINT8 = 0xcc,
  BIN8 = 0xc4,
  BIN16 = 0xc5,
  BIN32 = 0xc6;

export type Connection = {
  // to tsgo, and from it
  out: Pipe;
  in: Pipe;
  close(): void;
};
let connector: ((args: string[]) => Connection) | null = null;
// how the next channel reaches tsgo
export function connect(f: (args: string[]) => Connection) {
  connector = f;
}

const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const EMPTY = new Uint8Array(0);

export class SyncRpcChannel {
  // what the client reads for its timing (only with collectTiming)
  lastBytesSent = 0;
  lastBytesReceived = 0;
  private readonly connection: Connection | null;
  private readonly callbacks = new Map<
    string,
    (name: string, payload: string) => string
  >();
  private readonly collectTiming: boolean;
  private open = true;
  private type = 0;
  private name: Uint8Array = EMPTY;
  private payload: Uint8Array = EMPTY;
  // read ahead of what is asked
  private readonly buffer = new Uint8Array(1 << 16);
  private pos = 0;
  private len = 0;
  private readonly header = new Uint8Array(16);

  constructor(_exe: string, args: string[], collectTiming = false) {
    if (!connector)
      throw new Error('tsgo in WebAssembly: nothing to connect to (connect)');
    this.connection = connector(args);
    this.collectTiming = collectTiming;
  }

  requestSync(method: string, payload: string | Uint8Array): string {
    return decoder.decode(this.request(method, payload));
  }

  requestBinarySync(method: string, payload: string | Uint8Array): Uint8Array {
    return this.request(method, payload);
  }

  registerCallback(
    name: string,
    callback: (name: string, payload: string) => string,
  ) {
    this.callbacks.set(name, callback);
  }

  unregisterCallback(name: string) {
    this.callbacks.delete(name);
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.connection!.out.close();
    this.connection!.close();
  }

  private request(method: string, payload: string | Uint8Array): Uint8Array {
    if (!this.open) throw new Error('SyncRpcChannel is closed');
    const name = encoder.encode(method);
    const bytes =
      typeof payload === 'string' ? encoder.encode(payload) : payload;
    if (this.collectTiming) {
      this.lastBytesSent = bytes.length;
      this.lastBytesReceived = 0;
    }
    this.write(REQUEST, name, bytes);
    for (;;) {
      this.readMessage();
      switch (this.type) {
        case RESPONSE:
          this.expect(method);
          if (this.collectTiming) this.lastBytesReceived = this.payload.length;
          return this.payload;
        case ERROR:
          this.expect(method);
          throw new Error(decoder.decode(this.payload));
        case CALL:
          this.call(decoder.decode(this.name), this.payload);
          break;
        default:
          throw new Error(`Invalid message type from tsgo: ${this.type}`);
      }
    }
  }

  private expect(method: string) {
    const got = decoder.decode(this.name);
    if (got !== method)
      throw new Error(
        `name mismatch for response: expected \`${method}\`, got \`${got}\``,
      );
  }

  // tsgo calls back: a failed call ends the request, as the native channel's
  // does
  private call(name: string, payload: Uint8Array) {
    const nameBytes = encoder.encode(name);
    const callback = this.callbacks.get(name);
    if (!callback) {
      this.write(
        CALL_ERROR,
        nameBytes,
        encoder.encode(`unknown callback: \`${name}\``),
      );
      throw new Error(`no callback named \`${name}\` found`);
    }
    try {
      const result = callback(name, decoder.decode(payload));
      this.write(CALL_RESPONSE, nameBytes, encoder.encode(result));
    } catch (e) {
      const message = String(e instanceof Error ? e.message : e).trim();
      this.write(CALL_ERROR, nameBytes, encoder.encode(message));
      throw new Error(`Error calling callback \`${name}\`: ${message}`);
    }
  }

  private write(type: number, name: Uint8Array, payload: Uint8Array) {
    const out = this.connection!.out;
    const h = this.header;
    h[0] = FIXARRAY3;
    h[1] = type;
    let n = binHeader(h, 2, name.length);
    out.writeFrom(h, 0, n);
    out.writeFrom(name, 0, name.length);
    n = binHeader(h, 0, payload.length);
    out.writeFrom(h, 0, n);
    out.writeFrom(payload, 0, payload.length);
  }

  private readMessage() {
    const marker = this.byte();
    if (marker !== FIXARRAY3)
      throw new Error(
        `Expected fixed 3-element array (0x93), received: 0x${marker.toString(16)}`,
      );
    const t = this.byte();
    this.type = t <= 0x7f ? t : t === UINT8 ? this.byte() : -1;
    if (this.type < 0)
      throw new Error(`Expected a message type, received: 0x${t.toString(16)}`);
    this.name = this.bin();
    this.payload = this.bin();
  }

  private bin(): Uint8Array {
    const marker = this.byte();
    let size: number;
    if (marker === BIN8) size = this.byte();
    else if (marker === BIN16) size = (this.byte() << 8) | this.byte();
    else if (marker === BIN32)
      size =
        ((this.byte() << 24) |
          (this.byte() << 16) |
          (this.byte() << 8) |
          this.byte()) >>>
        0;
    else
      throw new Error(
        `Expected binary data (0xc4-0xc6), received: 0x${marker.toString(16)}`,
      );
    if (size === 0) return EMPTY;
    // its own ArrayBuffer, at offset 0: the client reads source files
    // through views of .buffer at absolute offsets
    const bytes = new Uint8Array(size);
    let at = 0;
    const buffered = Math.min(size, this.len - this.pos);
    if (buffered > 0) {
      bytes.set(this.buffer.subarray(this.pos, this.pos + buffered));
      this.pos += buffered;
      at = buffered;
    }
    while (at < size) {
      const n = this.connection!.in.readInto(bytes, at, size - at);
      if (n === 0) throw new Error('tsgo closed its end of the connection');
      at += n;
    }
    return bytes;
  }

  private byte(): number {
    if (this.pos >= this.len) {
      this.pos = 0;
      this.len = this.connection!.in.readInto(
        this.buffer,
        0,
        this.buffer.length,
      );
      if (this.len === 0)
        throw new Error('tsgo closed its end of the connection');
    }
    return this.buffer[this.pos++]!;
  }
}

function binHeader(into: Uint8Array, at: number, size: number): number {
  if (size < 0x100) {
    into[at] = BIN8;
    into[at + 1] = size;
    return at + 2;
  }
  if (size < 0x10000) {
    into[at] = BIN16;
    into[at + 1] = size >>> 8;
    into[at + 2] = size & 0xff;
    return at + 3;
  }
  into[at] = BIN32;
  into[at + 1] = size >>> 24;
  into[at + 2] = (size >>> 16) & 0xff;
  into[at + 3] = (size >>> 8) & 0xff;
  into[at + 4] = size & 0xff;
  return at + 5;
}
