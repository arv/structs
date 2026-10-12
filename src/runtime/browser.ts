import {spawn} from './own.ts';
import type {SpawnArgs} from './own.ts';
// a page's side of threads: start() makes the pool of Web Workers on the memory
// threads/heap made, and run(f, ...args) runs f on a thread and resolves with
// its result. the page's own thread never blocks (it cannot: Atomics.wait is
// not allowed there), so it waits for threads asynchronously
import {attach, threadBegin, shutdown, $waitBegin} from './runtime.ts';
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
      'threads: import "threads/heap" first in the page\'s entry module',
    );
  const onMessage: (m: Message) => void = m => {
    if (m.type === 'out') onLog(m.text);
    // every pool thread is busy: one more worker
    else if (m.type === 'grow') add();
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
      w.postMessage({sab, opts: {check}});
    });
  // the runtime set the heap up when it loaded
  attach(sab, {check}, onMessage, onLog);
  threadBegin(1);
  // between tasks the page holds no uncounted address (REFCOUNT.md): quiescent
  $waitBegin();
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
  const result = spawn(f, ...args).joinAsync();
  $waitBegin();
  return result;
}

export function stop() {
  shutdown(sab!);
  for (const w of workers.splice(0)) w.terminate();
  started = null;
}
