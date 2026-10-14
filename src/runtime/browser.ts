import {spawn} from './own.ts';
import type {SpawnArgs} from './own.ts';
// a page's side of threads: start() makes the pool of Web Workers on the memory
// threads/heap made, and run(f, ...args) runs f on a thread and resolves with
// its result. the page's own thread never blocks (it cannot: Atomics.wait is
// not allowed there), so it waits for threads asynchronously
import {attach, threadBegin, shutdown, $nudged, $waitBegin} from './runtime.ts';
import type {Message} from './runtime.ts';

const sab = globalThis.__escapeSab;
const workers: Worker[] = [];
let started: Promise<void> | null = null;

// how start() makes the pool
type Options = {
  workers?: number;
  check?: boolean;
  onLog?: (text: string) => void;
};

export function start({
  workers: count = navigator.hardwareConcurrency ?? 8,
  check = false,
  onLog = text => console.log(text.replace(/\n$/, '')),
}: Options = {}) {
  if (started) return started;
  if (!sab)
    throw new Error(
      'threads: import "@arv/threads/heap" first in the page\'s entry module',
    );
  const onMessage: (m: Message) => void = m => {
    if (m.type === 'out') onLog(m.text);
    // every pool thread is busy: one more worker
    else if (m.type === 'grow') add();
    // the page holds up freeing: between tasks, as now, it holds no uncounted
    // address (REFCOUNT.md), so it passes a quiescent point, and frees what
    // that makes safe
    else if (m.type === 'nudge') $nudged();
    else if (m.type === 'crash')
      console.error(`threads: a worker crashed: ${m.message}`);
  };
  const add = () =>
    new Promise<void>((resolve, reject) => {
      const w = new Worker(new URL('./threads-worker.ts', import.meta.url), {
        type: 'module',
        name: 'threads',
      });
      workers.push(w);
      w.onmessage = ({data: m}: MessageEvent<Message>) =>
        m.type === 'ready' ? resolve() : onMessage(m);
      w.onerror = e =>
        reject(new Error(`threads: a worker failed to start: ${e.message}`));
      w.postMessage({sab, opts: {check, nudge: true}});
    });
  // the runtime set the heap up when it loaded
  attach(sab, {check}, onMessage, onLog);
  threadBegin(1);
  // the page is a running thread: it reads cells between quiescent points as
  // any thread does (a handle's reference field, a map's value, a result's
  // struct), so what it may have read uncounted is not freed until it passes
  // the next one (REFCOUNT.md). it passes one when it spawns or joins, and
  // whenever a worker nudges it (above): between tasks, with nothing uncounted.
  // as it starts, as if nudged: a worker of a pool stopped before may have
  // handed its queue to the shared list while the page was waiting
  $nudged();
  started = Promise.all(Array.from({length: count}, add)).then(() => {});
  return started;
}

// f must be a top-level function of a module the plugin compiled (other than
// the page's entry, which workers do not load)
export async function run<A extends unknown[], R>(
  f: (...args: A) => R,
  ...args: SpawnArgs<A>
) {
  await start();
  return spawn(f, ...args).joinAsync();
}

export function stop() {
  shutdown(sab!);
  for (const w of workers.splice(0)) w.terminate();
  // the page's thread, if start() began it: quiescent until start() again
  if (started !== null) $waitBegin();
  started = null;
}
