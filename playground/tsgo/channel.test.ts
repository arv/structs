// The API client's channel to tsgo (channel.ts) against a stand-in for tsgo on
// another thread, which speaks the protocol: [type, method, payload], in
// MessagePack. It answers a request, calls back into the client in the middle
// of one, fails one, and sends a payload too big for a pipe's ring.
import {Worker} from 'node:worker_threads';
import {afterAll, expect, it} from 'vite-plus/test';
import {connect, SyncRpcChannel} from './channel.ts';
import {Pipe} from './pipe.ts';

// the stand-in: echo answers with the payload, big with a megabyte and a bit,
// call calls the client's callback "twice" and answers with what it gave (or,
// if the callback failed, answers nothing), anything else fails
const tsgo = `
const {workerData: {toTsgo, fromTsgo, url}} = require('node:worker_threads');
import(url).then(({Pipe}) => {
  const input = new Pipe(toTsgo), output = new Pipe(fromTsgo);
  const one = new Uint8Array(1);
  const byte = () => { if (!input.readInto(one, 0, 1)) throw new Error('eof'); return one[0]; };
  const bin = () => {
    const m = byte();
    let n = m === 0xc4 ? byte() : m === 0xc5 ? (byte() << 8) | byte() : ((byte() << 24) | (byte() << 16) | (byte() << 8) | byte()) >>> 0;
    const b = new Uint8Array(n);
    for (let at = 0; at < n; ) at += input.readInto(b, at, n - at);
    return b;
  };
  const read = () => { if (byte() !== 0x93) throw new Error('not a tuple'); return [byte(), bin(), bin()]; };
  const header = n => n < 256 ? [0xc4, n] : n < 65536 ? [0xc5, n >> 8, n & 255] : [0xc6, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  const send = (type, name, payload) => {
    for (const part of [new Uint8Array([0x93, type, ...header(name.length)]), name, new Uint8Array(header(payload.length)), payload])
      output.writeFrom(part, 0, part.length);
  };
  const text = s => new TextEncoder().encode(s), str = b => new TextDecoder().decode(b);
  for (;;) {
    let message;
    try { message = read(); } catch { output.close(); return; }
    const [, name, payload] = message;
    const method = str(name);
    if (method === 'echo') send(4, name, payload);
    else if (method === 'big') send(4, name, new Uint8Array((1 << 20) + 3).fill(7));
    else if (method === 'call') {
      send(6, text('twice'), payload);
      const [type, , answer] = read();
      // the callback failed (3): the client gives up the request, and waits
      // for nothing more of it
      if (type === 3) continue;
      if (type !== 2) throw new Error('expected a call response');
      send(4, name, answer);
    } else send(5, name, text('no method ' + method));
  }
});`;

const workers: Worker[] = [];
connect(args => {
  const out = new Pipe(1 << 16),
    in_ = new Pipe(1 << 16);
  const worker = new Worker(tsgo, {
    eval: true,
    workerData: {
      toTsgo: out.sab,
      fromTsgo: in_.sab,
      url: new URL('./pipe.ts', import.meta.url).href,
      args,
    },
  });
  workers.push(worker);
  // a stand-in that fails fails the test that started it
  worker.on('error', e => {
    throw e;
  });
  return {out, in: in_, close: () => void worker.terminate()};
});
afterAll(() => Promise.all(workers.map(w => w.terminate())));

it('answers requests, and calls back in the middle of one', () => {
  const channel = new SyncRpcChannel('tsgo', ['--api'], true);
  expect(channel.requestSync('echo', 'hello')).toBe('hello');
  expect(channel.lastBytesSent).toBe(5);
  const long = 'x'.repeat(200_000);
  expect(channel.requestSync('echo', long)).toBe(long);
  const big = channel.requestBinarySync('big', '');
  expect(big.length).toBe((1 << 20) + 3);
  // its own buffer, at offset 0: the client reads it through .buffer
  expect(big.byteOffset).toBe(0);
  expect(big.buffer.byteLength).toBe(big.length);
  channel.registerCallback('twice', (_, payload) => payload + payload);
  expect(channel.requestSync('call', 'ab')).toBe('abab');
  expect(() => channel.requestSync('nope', '')).toThrow('no method nope');
  // still in step after a failure
  expect(channel.requestSync('echo', 'again')).toBe('again');
  channel.close();
  expect(() => channel.requestSync('echo', '')).toThrow('closed');
});

it('fails a request whose callback fails, says why, and stays in step', () => {
  const channel = new SyncRpcChannel('tsgo', [], false);
  channel.registerCallback('twice', () => {
    throw new Error('no');
  });
  expect(() => channel.requestSync('call', 'ab')).toThrow(
    'Error calling callback `twice`: no',
  );
  // the stand-in read the failure, and answers what comes next
  expect(channel.requestSync('echo', 'after')).toBe('after');
  channel.close();
});
