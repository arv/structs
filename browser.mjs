// a page's side of threads: start() makes the pool of Web Workers on the memory threads/heap made,
// and run(f, ...args) runs f on a thread and resolves with its result. the page's own thread never
// blocks (it cannot: Atomics.wait is not allowed there), so it waits for threads asynchronously
import { attach, threadBegin, shutdown, $waitBegin } from './runtime.mjs';
import { spawn } from './own.mjs';

const sab = globalThis.__escapeSab;
const workers = [];
let started = null;

export function start({ workers: count = navigator.hardwareConcurrency ?? 8, check = false, onLog = text => console.log(text.replace(/\n$/, '')) } = {}) {
  if (started) return started;
  if (!sab) throw new Error('threads: import "threads/heap" first in the page\'s entry module');
  const onMessage = m => {
    if (m.type === 'out') onLog(m.text);
    else if (m.type === 'grow') add(); // every pool thread is busy: one more worker
    else if (m.type === 'crash') console.error(`threads: a worker crashed: ${m.message}`);
  };
  const add = () => new Promise((resolve, reject) => {
    const w = new Worker(new URL('./threads-worker.mjs', import.meta.url), { type: 'module', name: 'threads' });
    workers.push(w);
    w.onmessage = ({ data: m }) => m.type === 'ready' ? resolve() : onMessage(m);
    w.onerror = e => reject(new Error(`threads: a worker failed to start: ${e.message}`));
    w.postMessage({ sab, opts: { check } });
  });
  attach(sab, { check }, onMessage, onLog); // the runtime set the heap up when it loaded
  threadBegin(1);
  $waitBegin(); // between tasks the page holds no uncounted address (REFCOUNT.md): quiescent
  started = Promise.all(Array.from({ length: count }, add)).then(() => {});
  return started;
}

// f must be a top-level function of a module the plugin compiled (other than the page's entry, which
// workers do not load)
export async function run(f, ...args) {
  await start();
  const result = spawn(f, ...args).joinAsync();
  $waitBegin();
  return result;
}

export function stop() {
  shutdown(sab);
  for (const w of workers.splice(0)) w.terminate();
  started = null;
}
