// a Web Worker: the program's main thread, or a pool worker that runs Threads
// (see page.ts). worker.ts is the same for node
import type {WorkerData} from './worker.ts';

onmessage = async ({data}) => {
  const {sab, program, opts, role, threads}: WorkerData = data;
  // the runtime's heap views are module constants: the heap must be known
  // before it loads
  globalThis.__escapeSab = sab;
  try {
    const R = await import('./runtime/runtime.ts');
    R.attach(
      sab,
      opts,
      m => postMessage(m),
      text => postMessage({type: 'out', text}),
    );
    // the program module only defines functions: it runs nothing until main
    const mod: {main(threads: number[]): void} = await import(program);
    if (role === 'main') {
      R.threadBegin(1);
      mod.main(threads);
      R.waitAllThreads();
      R.threadEnd();
      postMessage({type: 'done'});
    } else {
      postMessage({type: 'ready'});
      await R.poolLoop();
    }
  } catch (e: any) {
    postMessage({type: 'crash', message: String(e?.stack ?? e)});
  }
};
