// a Web Worker: the program's main thread, or a pool worker that runs threads
// (see page.ts). worker.ts is the same for node
import type {WorkerData} from './worker.ts';

onmessage = async ({data}) => {
  const {sab, program, opts, role, threads}: WorkerData = data;
  // the runtime's heap views are module constants: the heap must be known
  // before it loads
  globalThis.__escapeSab = sab;
  // the runtime, once it has loaded
  let R: typeof import('./runtime/runtime.ts') | undefined;
  try {
    R = await import('./runtime/runtime.ts');
    R.attach(
      sab,
      opts,
      m => postMessage(m),
      text => postMessage({type: 'out', text}),
    );
    // the program module only defines functions: it runs nothing until main
    const mod: {main(threads: number[]): unknown} = await import(program);
    if (role === 'main') {
      R.threadBegin(1);
      await R.runMain(() => mod.main(threads));
      R.waitAllThreads();
      R.threadEnd();
      postMessage({type: 'done'});
    } else {
      postMessage({type: 'ready'});
      await R.poolLoop();
    }
  } catch (e: any) {
    // a join's error that main threw on is the failure it tells of, with the
    // stack of the thread where it began
    const [message, stack] = R?.$failureOf(e) ?? [
      String(e),
      typeof e?.stack === 'string' ? e.stack : undefined,
    ];
    postMessage({type: 'crash', message, stack});
  }
};
