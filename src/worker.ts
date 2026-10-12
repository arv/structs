import {writeSync} from 'node:fs';
// a node worker: the program's main thread, or a pool worker that runs Threads
// (see run.ts). web-worker.ts is the same for a browser
import {workerData, parentPort} from 'node:worker_threads';
import type {Message} from './runtime/runtime.ts';

// what a coordinator (run.ts, page.ts) starts a worker with
export interface WorkerData {
  sab: SharedArrayBuffer;
  // the expanded program's URL
  program: string;
  opts: {check?: boolean};
  role: 'main' | 'pool';
  threads: number[];
}
// what a worker posts to its coordinator: the runtime's messages, and the
// program's end
export type WorkerMessage = Message | {type: 'done'};

const {sab, program, opts, role, threads}: WorkerData = workerData;
// the runtime's heap views are module constants: the heap must be known before
// it loads
globalThis.__escapeSab = sab;
try {
  const R = await import('./runtime/runtime.ts');
  R.attach(
    sab,
    opts,
    m => parentPort!.postMessage(m),
    s => writeSync(1, s),
  );
  // the program module only defines functions: it runs nothing until main
  const mod: {main(threads: number[]): void} = await import(program);
  if (role === 'main') {
    R.threadBegin(1);
    mod.main(threads);
    R.waitAllThreads();
    R.threadEnd();
    parentPort!.postMessage({type: 'done'});
  } else await R.poolLoop();
} catch (e: any) {
  parentPort!.postMessage({type: 'crash', message: String(e?.stack ?? e)});
}
