// a Web Worker of a page's pool (browser.ts starts them): attaches to the
// page's shared memory and runs threads. a thread names its function by module
// and name; the worker loads that module the first time a thread needs it, from
// the list the bundler plugin makes (virtual:threads/modules), and with it
// whatever that module imports, which runs here too though it defines no
// function a thread runs. the page's entry is in the list only if it defines
// one, and then the page's API refuses to run in a worker (browser.ts
// forThePage). a module the page compiled itself (the
// playground's, compiled in WebAssembly) is a blob: URL, and its imports of the
// runtime read globalThis.__threads, the threads API, as they do on the page
declare global {
  var __threads: unknown;
}
onmessage = async ({data: {sab, opts}}) => {
  // before the runtime loads: its views are module constants
  globalThis.__escapeSab = sab;
  try {
    const R = await import('./runtime.ts');
    R.attach(
      sab,
      opts,
      m => postMessage(m),
      text => postMessage({type: 'out', text}),
    );
    const {setModuleLoader} = await import('./own.ts');
    // every cell kind's class and destroy, before the worker frees any block:
    // a thread's decrements may reach this worker (it reclaims what others
    // deferred) whatever modules its threads load
    await import('./threads.ts');
    const {default: modules} = await import('virtual:threads/modules');
    // a playground program (the plugin's dev server compiles it on request, or
    // the page in WebAssembly) is not in the list
    setModuleLoader(id =>
      modules[id]
        ? modules[id]()
        : id.startsWith('blob:')
          ? import('./threads.ts').then(api => {
              globalThis.__threads = api;
              return import(/* @vite-ignore */ id);
            })
          : id.startsWith('playground/')
            ? import(
                /* @vite-ignore */ `/@id/virtual:threads/playground/${id.slice('playground/'.length)}.js`
              )
            : undefined,
    );
    postMessage({type: 'ready'});
    await R.poolLoop();
  } catch (e: any) {
    postMessage({
      type: 'crash',
      message: String(e),
      stack: typeof e?.stack === 'string' ? e.stack : undefined,
    });
  }
};

// a module, for TypeScript (declare global)
export {};
