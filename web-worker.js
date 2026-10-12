// a Web Worker: the program's main thread, or a pool worker that runs Threads (see page.js).
// worker.js is the same for node
onmessage = async ({ data }) => {
  const { sab, program, opts, role, threads } = data;
  // the runtime's heap views are module constants: the heap must be known before it loads
  globalThis.__escapeSab = sab;
  try {
    const R = await import('./runtime.js');
    R.attach(sab, opts, m => postMessage(m), text => postMessage({ type: 'out', text }));
    // the program module only defines functions: it runs nothing until main
    const mod = await import(program);
    if (role === 'main') {
      R.threadBegin(1);
      mod.main(threads);
      R.waitAllThreads();
      R.threadEnd();
      postMessage({ type: 'done' });
    } else {
      postMessage({ type: 'ready' });
      await R.poolLoop();
    }
  } catch (e) {
    postMessage({ type: 'crash', message: String(e?.stack ?? e) });
  }
};
