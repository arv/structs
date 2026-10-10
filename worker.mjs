// a node worker: the program's main thread, or a pool worker that runs Threads (see run.mjs).
// web-worker.mjs is the same for a browser
import { workerData, parentPort } from 'node:worker_threads';
import { writeSync } from 'node:fs';

const { sab, program, opts, role, threads } = workerData;
// the runtime's heap views are module constants: the heap must be known before it loads
globalThis.__escapeSab = sab;
try {
  const R = await import('./runtime.mjs');
  R.attach(sab, opts, m => parentPort.postMessage(m), s => writeSync(1, s));
  // the program module only defines functions: it runs nothing until main
  const mod = await import(program);
  if (role === 'main') {
    R.threadBegin(1);
    mod.main(threads);
    R.waitAllThreads();
    R.threadEnd();
    parentPort.postMessage({ type: 'done' });
  } else R.poolLoop();
} catch (e) {
  parentPort.postMessage({ type: 'crash', message: String(e?.stack ?? e) });
}
