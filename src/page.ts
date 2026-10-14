// the browser coordinator: makes the shared heap, starts a pool of Web Workers
// and the program's main worker, and grows the pool on demand. the page itself
// never blocks (it cannot: Atomics.wait is not allowed on a page's main
// thread). index.html?program=src/nbody-own.ts&threads=1,2,4,8 loads the
// program by its path in the repository (chrome.ts's server points its imports
// of the runtime at src/runtime/)
import type {WorkerData, WorkerMessage} from './worker.ts';

// what a page leaves for chrome.ts once its program has finished
export interface PageResult {
  ok: boolean;
  error?: string;
  output: string;
  counters: Record<string, number>;
}
declare global {
  interface Window {
    __escapeResult?: PageResult;
    // how the page failed before it reported, as chrome.ts records it
    __escapeFailure?: string;
  }
}

const params = new URLSearchParams(location.search);
const program = params.get('program') ?? 'src/nbody-own.ts';
const threads = (params.get('threads') ?? '1,2,4,8').split(',').map(Number);
const pool = Number(params.get('pool') ?? navigator.hardwareConcurrency ?? 8);
const out = document.getElementById('out')!;

let text = '';
// what chrome.ts waits for
const report = (
  ok: boolean,
  error?: string,
  counters: Record<string, number> = {},
) => {
  window.__escapeResult = {ok, error, output: text, counters};
  document.title = ok ? 'done' : 'failed';
};

async function run() {
  const {sharedHeap, shutdown, counters, workersComing} =
    await import('./runtime/runtime.ts');
  // a heap refused (a ?heap= that is not a whole number of MB from 2 to 2047)
  // fails the page as finish would, with no heap to shut down
  let sab: SharedArrayBuffer;
  try {
    sab = sharedHeap(Number(params.get('heap') ?? 512));
  } catch (e) {
    report(false, String(e));
    throw e;
  }

  const workers: Worker[] = [];
  let finished = false;
  const finish = (ok: boolean, error?: string) => {
    if (finished) return;
    finished = true;
    shutdown(sab);
    for (const w of workers) w.terminate();
    report(ok, error, counters(sab));
  };
  const start: (role: WorkerData['role']) => void = role => {
    const w = new Worker(new URL('./web-worker.ts', import.meta.url), {
      type: 'module',
      name: role,
    });
    workers.push(w);
    w.onmessage = ({data: m}: MessageEvent<WorkerMessage>) => {
      if (m.type === 'out') {
        text += m.text;
        out.textContent = text;
      } else if (m.type === 'grow') {
        if (!finished) start('pool');
      } else if (m.type === 'done') finish(true);
      else if (m.type === 'crash') finish(false, m.stack ?? m.message);
    };
    // the page reports a worker's error itself (uncanceled, it would be the
    // page's own too); one whose module did not load has no message
    w.onerror = e => {
      e.preventDefault();
      finish(false, e.message || `a ${role} worker did not load`);
    };
    w.postMessage({
      sab,
      program: new URL(`../${program}`, import.meta.url).href,
      opts: {check: params.has('check')},
      role,
      threads,
    });
  };

  workersComing(sab, pool);
  for (let i = 0; i < pool; i++) start('pool');
  start('main');
}

// SharedArrayBuffer is defined only on a cross-origin isolated page, and the
// runtime makes one as it loads: it is imported once the page is known to be
if (!crossOriginIsolated)
  report(false, 'not cross-origin isolated: SharedArrayBuffer needs COOP/COEP');
else await run();
