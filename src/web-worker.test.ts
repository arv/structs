// The browser coordinator's main worker (web-worker.ts), its globals stood in
// for on this thread, with a node worker thread of src/worker.ts as its pool:
// a main that throws what a join threw crashes with the failure the join told
// of, and the stack of the thread where it began
import {Worker} from 'node:worker_threads';
import {afterAll, expect, it} from 'vite-plus/test';
import type {WorkerData, WorkerMessage} from './worker.ts';

const sab = new SharedArrayBuffer(64 << 20);
const g = globalThis as {
  __escapeSab?: SharedArrayBuffer;
  onmessage?: unknown;
  postMessage?: unknown;
};
g.__escapeSab = sab;
// a worker's: what it posts, and the handler web-worker.ts sets
const posted: WorkerMessage[] = [];
g.postMessage = (m: WorkerMessage) => posted.push(m);
g.onmessage = null;
// the heap, set up as the runtime loads, before a pool worker attaches
await import('./runtime/runtime.ts');
const program = new URL('./runtime/test-threads.ts', import.meta.url).href;
const pool = new Worker(new URL('./worker.ts', import.meta.url), {
  workerData: {
    sab,
    program,
    opts: {},
    role: 'pool',
    threads: [],
  } satisfies WorkerData,
});
afterAll(() => pool.terminate());
await import('./web-worker.ts');

it("a main that throws a join's error crashes with the thread's failure", async () => {
  const onmessage = g.onmessage as (e: {data: WorkerData}) => Promise<void>;
  await onmessage({data: {sab, program, opts: {}, role: 'main', threads: []}});
  const crash = posted.find(m => m.type === 'crash');
  expect(crash).toMatchObject({type: 'crash', message: 'Error: boom'});
  expect(crash?.type === 'crash' && crash.stack).toMatch(
    /^Error: boom\n\s+at bad \(.*test-threads\.ts/,
  );
});
