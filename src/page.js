// the browser coordinator: makes the shared heap, starts a pool of Web Workers
// and the program's main worker, and grows the pool on demand. the page itself
// never blocks (it cannot: Atomics.wait is not allowed on a page's main
// thread). index.html?program=nbody&threads=1,2,4,8 loads build/<program>.js,
// which chrome.js expands from <program>.js
import {initShared, shutdown, counters} from './runtime.js';

const params = new URLSearchParams(location.search);
const program = params.get('program') ?? 'nbody';
const threads = (params.get('threads') ?? '1,2,4,8').split(',').map(Number);
const pool = Number(params.get('pool') ?? navigator.hardwareConcurrency ?? 8);
const out = document.getElementById('out');

const sab = new SharedArrayBuffer(Number(params.get('heap') ?? 512) << 20);
initShared(sab);

const workers = [];
let text = '',
  finished = false;
const finish = (ok, error) => {
  if (finished) return;
  finished = true;
  shutdown(sab);
  for (const w of workers) w.terminate();
  // what chrome.js waits for
  window.__escapeResult = {ok, error, output: text, counters: counters(sab)};
  document.title = ok ? 'done' : 'failed';
};
const start = role => {
  const w = new Worker(new URL('./web-worker.js', import.meta.url), {
    type: 'module',
    name: role,
  });
  workers.push(w);
  w.onmessage = ({data: m}) => {
    if (m.type === 'out') {
      text += m.text;
      out.textContent = text;
    } else if (m.type === 'grow') {
      if (!finished) start('pool');
    } else if (m.type === 'done') finish(true);
    else if (m.type === 'crash') finish(false, m.message);
  };
  w.onerror = e => finish(false, e.message);
  w.postMessage({
    sab,
    program: new URL(`../build/${program}.js`, import.meta.url).href,
    opts: {check: params.has('check')},
    role,
    threads,
  });
};

if (!crossOriginIsolated)
  finish(false, 'not cross-origin isolated: SharedArrayBuffer needs COOP/COEP');
else {
  for (let i = 0; i < pool; i++) start('pool');
  start('main');
}
