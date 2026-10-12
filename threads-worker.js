// a Web Worker of a page's pool (browser.js starts them): attaches to the page's shared memory and
// runs threads. a thread names its function by module and name; the worker loads that module the first
// time a thread needs it, from the list the bundler plugin makes (virtual:threads/modules), so the
// page's own entry module never runs here
onmessage = async ({ data: { sab, opts } }) => {
  globalThis.__escapeSab = sab; // before the runtime loads: its views are module constants
  try {
    const R = await import('./runtime.js');
    R.attach(sab, opts, m => postMessage(m), text => postMessage({ type: 'out', text }));
    const { setModuleLoader } = await import('./own.js');
    const { default: modules } = await import('virtual:threads/modules');
    // a playground program (the plugin's dev server compiles it on request) is not in the list
    setModuleLoader(id => modules[id] ? modules[id]() : id.startsWith('playground/')
      ? import(/* @vite-ignore */ `/@id/virtual:threads/playground/${id.slice('playground/'.length)}.js`) : undefined);
    postMessage({ type: 'ready' });
    await R.poolLoop();
  } catch (e) {
    postMessage({ type: 'crash', message: String(e?.stack ?? e) });
  }
};
