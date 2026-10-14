import {spawn} from './own.ts';
import type {SpawnArgs} from './own.ts';
// a page's side of threads: start() makes the pool of Web Workers on the memory
// threads/heap made, and run(f, ...args) runs f on a thread and resolves with
// its result. the page's own thread never blocks (it cannot: Atomics.wait is
// not allowed there), so it waits for threads asynchronously
import {
  attach,
  threadBegin,
  shutdown,
  resetPool,
  STOPPED,
  $nudged,
  $waitBegin,
} from './runtime.ts';
import type {Message} from './runtime.ts';

const sab = globalThis.__escapeSab;
const workers: Worker[] = [];
let started: Promise<void> | null = null,
  // fails the start that is under way: its workers are terminated as they
  // load, and never report ready
  failStart: ((e: Error) => void) | null = null,
  stopped = false,
  // one more for each pool stopped: a run that began on a pool that is gone
  // fails rather than spawn on the next
  generation = 0;
// the runs waiting for a thread, to fail should the pool stop meanwhile
const waiting = new Set<(e: Error) => void>();

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
  // this pool's: a message of one stopped since is dropped (a grow posted as
  // it was stopped, say, would add a worker to the next)
  const g = generation;
  const onMessage: (m: Message) => void = m => {
    if (m.type === 'out') onLog(m.text);
    // every pool thread is busy: one more worker
    else if (m.type === 'grow') {
      // one that fails to load is reported; the thread that asked waits for a
      // worker that is there
      if (generation === g) add().catch(e => console.error(String(e)));
    }
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
      let ready = false;
      w.onmessage = ({data: m}: MessageEvent<Message>) => {
        if (m.type === 'ready') {
          ready = true;
          resolve();
        } else if (m.type === 'crash' && !ready)
          // the worker could not start (the runtime did not load, say): a
          // start that waits for it would wait for good
          reject(new Error(`threads: a worker failed to start: ${m.message}`));
        else onMessage(m);
      };
      w.onerror = e =>
        reject(new Error(`threads: a worker failed to start: ${e.message}`));
      w.postMessage({sab, opts: {check, nudge: true}});
    });
  // the runtime set the heap up when it loaded; a pool that was stopped left
  // it shut down, with the words of workers that are gone: a reset first,
  // which waits, without blocking the page, for workers of that pool that run
  // on. until it is done this thread is of the pool that was stopped, and
  // spawn() throws
  const begin = () => {
    attach(sab, {check}, onMessage, onLog);
    threadBegin(1);
    // the page is a running thread: it reads cells between quiescent points as
    // any thread does (a handle's reference field, a map's value, a result's
    // struct), so what it may have read uncounted is not freed until it passes
    // the next one (REFCOUNT.md). it passes one when it spawns or joins, and
    // whenever a worker nudges it (above): between tasks, with nothing
    // uncounted. as it starts, as if nudged: a worker of the pool stopped
    // before may have handed its queue to the shared list while the page was
    // waiting
    $nudged();
    return Promise.all(Array.from({length: count}, add)).then(() => {});
  };
  started = Promise.race([
    stopped
      ? resetPool(sab).then(reset => {
          // stopped again as it waited
          if (!reset || generation !== g) throw new Error(STOPPED);
          return begin();
        })
      : begin(),
    new Promise<never>((_, reject) => {
      failStart = reject;
    }),
  ]);
  stopped = false;
  // a start that fails is over: its workers (those that did start) are
  // terminated, and the next start() starts afresh, on a pool reset first;
  // without this the rejection would be every later start()'s and run()'s,
  // until stop(). those awaiting it see the rejection
  const p = started;
  p.catch(() => {
    if (started === p) stop();
  });
  return started;
}

// f must be a top-level function of a module the plugin compiled (other than
// the page's entry, which workers do not load)
export async function run<A extends unknown[], R>(
  f: (...args: A) => R,
  ...args: SpawnArgs<A>
) {
  const g = generation;
  await start();
  if (generation !== g) throw new Error(STOPPED);
  const result = spawn(f, ...args).joinAsync();
  // stop() fails what waits: a thread its worker took with it never finishes.
  // (the join may still settle, late, from a worker that ran on: nothing then
  // reports it)
  result.catch(() => {});
  let fail!: (e: Error) => void;
  const stops = new Promise<never>((_, reject) => {
    waiting.add((fail = reject));
  });
  try {
    return await Promise.race([result, stops]);
  } finally {
    waiting.delete(fail);
  }
}

// stops the pool: its workers are terminated, with the threads they ran, and
// the runs waiting for one fail. start() starts a new pool on the same heap:
// at once when the workers were between threads, else once those at work
// have ended their threads, or after a second (runtime.ts resetPool). a
// worker that ran async functions dies at work, as its threads wait on its
// event loop: stopped mid-way through them, the next start takes the second
export function stop() {
  shutdown(sab!);
  for (const w of workers.splice(0)) w.terminate();
  for (const fail of waiting) fail(new Error(STOPPED));
  waiting.clear();
  failStart?.(new Error(STOPPED));
  failStart = null;
  generation++;
  stopped = true;
  // the page's thread, if start() began it: quiescent until start() again
  if (started !== null) $waitBegin();
  started = null;
}
