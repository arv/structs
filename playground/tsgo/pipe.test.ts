// A pipe (pipe.ts) between two threads: what one end writes, the other reads,
// in order and whole, through a ring smaller than what goes through it, and
// then 0 once the writer has closed it, however the close falls against a
// read
import {Worker} from 'node:worker_threads';
import {expect, it} from 'vite-plus/test';
import {Pipe} from './pipe.ts';

it('carries more than it holds, in order, and then says it is closed', async () => {
  const pipe = new Pipe(1 << 10);
  const n = 100_000;
  // the writer, on a thread of its own: bytes i & 0xff, in writes of 1 to
  // 3000 bytes
  const writer = new Worker(
    `const {workerData: {sab, n, url}} = require('node:worker_threads');
    import(url).then(({Pipe}) => {
      const pipe = new Pipe(sab), bytes = new Uint8Array(3000);
      for (let at = 0, size = 1; at < n; at += size, size = size % 3000 + 1) {
        size = Math.min(size, n - at);
        for (let i = 0; i < size; i++) bytes[i] = (at + i) & 0xff;
        pipe.writeFrom(bytes, 0, size);
      }
      pipe.close();
    });`,
    {
      eval: true,
      workerData: {
        sab: pipe.sab,
        n,
        url: new URL('./pipe.ts', import.meta.url).href,
      },
    },
  );
  const got = new Uint8Array(n + 1);
  let at = 0;
  for (;;) {
    const read = pipe.readInto(got, at, Math.min(777, got.length - at));
    if (read === 0) break;
    at += read;
  }
  await new Promise(r => writer.once('exit', r));
  expect(at).toBe(n);
  expect(got.subarray(0, n).every((b, i) => b === (i & 0xff))).toBe(true);
});

// a reader and a writer on threads of their own, started together on each of
// many pipes: the writer writes a byte or none, and closes at once, while the
// reader looks. Every byte must arrive, and every read must end
it('reads every byte, and ends, however a close falls against a read', async () => {
  const n = 20_000;
  const pipes = Array.from({length: n}, () => new Pipe(16).sab);
  // the pipe each thread is at, and what the reader read
  const at = new Int32Array(new SharedArrayBuffer(8));
  const got = new Int32Array(new SharedArrayBuffer(4 * n));
  const url = new URL('./pipe.ts', import.meta.url).href;
  const thread = (code: string) =>
    new Worker(
      `const {workerData: {pipes, at, got, url, n}} = require('node:worker_threads');
      import(url).then(({Pipe}) => { ${code} });`,
      {eval: true, workerData: {pipes, at, got, url, n}},
    );
  const ended = (w: Worker) =>
    new Promise<void>((resolve, reject) => {
      w.once('exit', () => resolve());
      w.once('error', reject);
    });
  const reader = thread(`
    const into = new Uint8Array(4);
    for (let i = 0; i < n; i++) {
      const pipe = new Pipe(pipes[i]);
      Atomics.store(at, 0, i + 1);
      let total = 0;
      for (let r; (r = pipe.readInto(into, 0, 4)) > 0; ) total += r;
      got[i] = total;
    }`);
  const writer = thread(`
    const one = new Uint8Array([1]);
    for (let i = 0; i < n; i++) {
      const pipe = new Pipe(pipes[i]);
      // as the reader starts to read this pipe
      while (Atomics.load(at, 0) < i + 1);
      if (i % 2) pipe.writeFrom(one, 0, 1);
      pipe.close();
    }`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<'hung'>(resolve => {
    timer = setTimeout(() => resolve('hung'), 20_000);
  });
  const outcome = await Promise.race([
    Promise.all([ended(reader), ended(writer)]).then(() => 'ended' as const),
    hung,
  ]);
  clearTimeout(timer);
  await Promise.all([reader.terminate(), writer.terminate()]);
  expect(outcome).toBe('ended');
  const lost = [...got.keys()].filter(i => got[i] !== i % 2);
  expect(lost).toEqual([]);
}, 30_000);
