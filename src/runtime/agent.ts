// @arv/structs/agent: agents (workers) that share the heap, and messages
// between them that carry shared objects. The proposal leaves this to the
// host; an engine with shared structs lets postMessage send them. Here a
// message is copied as postMessage copies it, but for its shared objects
// (Shared Structs, Shared Arrays, Mutexes, Conditions), which arrive as the
// same objects: the receiving agent's handles on them.
//
//   main.js                                 worker.js
//   import {startWorker} from               import {parent} from
//     '@arv/structs/agent';                   '@arv/structs/agent';
//   const w = startWorker(                  parent.onmessage = counter => {
//     new URL('./worker.js', import.meta.url));   ... counter.value ...
//   w.postMessage(counter);                 };
//
// In Node the workers are worker_threads, in a browser Web Workers (module
// workers). Either way the heap goes to the worker as it starts: in Node in
// its workerData, in a browser as its first message.

// a worker that is sent shared objects needs the proposal's globals
import './index.ts';
import {inFlight, makeRecord, pin, retire, unpin} from './gc.ts';
import {attach, attached, requireHeap, SAB} from './heap.ts';
import {addressOf, handleAt} from './shared.ts';

const MARK = '__structs.shared';
const HEAP = '__structs.heap';

// A message as postMessage can copy it: its shared objects as their
// addresses, in arrays and plain objects (others are copied as they are).
// Each is pinned until the message is decoded, so that the collector keeps it
// while it is in flight (a message that never arrives keeps it for good), and
// its address goes in `pins`, if given.
export function encode(value: unknown, pins?: number[]): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const a = addressOf(value);
  if (a !== undefined) {
    pin(a);
    pins?.push(a);
    return {[MARK]: a};
  }
  if (Array.isArray(value)) return value.map(v => encode(v, pins));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = encode(v, pins);
  return out;
}

// Posts `message` encoded with `post`; a message it fails to encode or post
// (one that postMessage cannot copy) is never decoded, so its pins go.
function send(post: (encoded: unknown) => void, message: unknown) {
  const pins: number[] = [];
  try {
    post(encode(message, pins));
  } catch (e) {
    for (const a of pins) unpin(a);
    throw e;
  }
}

export function decode(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map(decode);
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  if (MARK in value) {
    requireHeap();
    const a = (value as any)[MARK];
    // only what encode made: a shared object that a message pins
    if (inFlight(a)) {
      const h = handleAt(a);
      unpin(a);
      return h;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = decode(v);
  return out;
}

export interface Agent {
  postMessage(message: unknown): void;
  // the messages that come from it, decoded
  onmessage: ((message: any) => void) | null;
  // what it threw, which ended it
  onerror: ((error: unknown) => void) | null;
  // ends it
  terminate(): void;
  // settles when it ends: with its exit code in Node, never in a browser
  // (which does not say)
  readonly exited: Promise<number>;
}

const nodeThreads = (): typeof import('node:worker_threads') | undefined =>
  (globalThis as any).process?.getBuiltinModule?.('node:worker_threads');

export interface StartOptions {
  name?: string;
}

// Starts a worker that runs the module at `url`, attached to this agent's
// heap.
export function startWorker(
  url: string | URL,
  options: StartOptions = {},
): Agent {
  requireHeap();
  const wt = nodeThreads();
  return withRecord(record =>
    wt
      ? nodeAgent(
          new wt.Worker(url, {
            name: options.name,
            workerData: {__structsHeap: SAB, __structsAgent: record},
          }),
          record,
        )
      : webAgent(new Worker(url, {type: 'module', name: options.name}), record),
  );
}

// `start`, given a record for the agent it starts (gc.ts), which is retired
// if the agent does not start
function withRecord(start: (record: number) => Pooled): Pooled {
  const record = makeRecord();
  try {
    return start(record);
  } catch (e) {
    retire(record);
    throw e;
  }
}

// an agent that `run` keeps for its next call: in Node, whether it keeps the
// process alive (not while it waits for work)
interface Pooled extends Agent {
  hold(busy: boolean): void;
}

// `record` is the worker's agent record (gc.ts): retired as it ends, in Node.
// (A browser does not say when a worker ends: one is retired a moment after
// it is terminated, by which time it runs no more; what one that ends itself,
// with close(), held stays held.)
function nodeAgent(
  w: import('node:worker_threads').Worker,
  record: number,
): Pooled {
  let exited!: (code: number) => void;
  const agent: Pooled = {
    postMessage: m => send(e => w.postMessage(e), m),
    onmessage: null,
    onerror: null,
    terminate: () => void w.terminate(),
    exited: new Promise<number>(resolve => (exited = resolve)),
    hold: busy => (busy ? w.ref() : w.unref()),
  };
  w.on('message', m => agent.onmessage?.(decode(m)));
  w.on('error', e => {
    if (agent.onerror) agent.onerror(e);
    else throw e;
  });
  w.on('exit', code => {
    retire(record);
    exited(code);
  });
  return agent;
}

// how long a terminated browser worker may still run, in milliseconds
const STOPPED = 1000;

function webAgent(w: Worker, record: number): Pooled {
  w.postMessage({[HEAP]: SAB, record});
  const agent: Pooled = {
    postMessage: m => send(e => w.postMessage(e), m),
    onmessage: null,
    onerror: null,
    terminate: () => {
      w.terminate();
      setTimeout(() => retire(record), STOPPED);
    },
    exited: new Promise(() => {}),
    hold: () => {},
  };
  w.onmessage = e => agent.onmessage?.(decode(e.data));
  w.onerror = e => {
    if (agent.onerror) agent.onerror(e);
  };
  return agent;
}

// what a worker run starts (agent-worker.ts) says back
export const RESULT = '__structs.result',
  ERROR = '__structs.error',
  LOG = '__structs.log';

let logHandler: ((text: string) => void) | null = null;
// Where the console output of the workers `run` starts goes, in a browser
// (whose workers' console is the devtools'): to `handler`, rather than to this
// agent's console. A worker's own runs' output comes up to it, and on.
export function onLog(handler: ((text: string) => void) | null) {
  logHandler = handler;
}
const log = (text: string) =>
  logHandler ? logHandler(text) : console.log(text);

// The workers `run` starts and keeps: one that has returned waits for the
// next call, with the code it has optimized (V8 makes a worker's hot code fast
// as it runs, so a worker started for each call would run it cold), and the
// modules it has imported. In Node an idle one does not keep the process
// alive.
const idle: Pooled[] = [];
const POOL = 64;

function startPooled(): Pooled {
  const wt = nodeThreads();
  return withRecord(record =>
    wt
      ? nodeAgent(
          new wt.Worker(new URL('./agent-worker.ts', import.meta.url), {
            workerData: {__structsHeap: SAB, __structsAgent: record},
          }),
          record,
        )
      : webAgent(
          new Worker(new URL('./agent-worker.ts', import.meta.url), {
            type: 'module',
          }),
          record,
        ),
  );
}

// Starts workers for `run` until `n` wait idle: so that the calls that follow
// do not wait for workers to start.
export function prestart(n: number) {
  requireHeap();
  while (idle.length < Math.min(n, POOL)) {
    const agent = startPooled();
    agent.hold(false);
    idle.push(agent);
  }
}

// Runs the function exported as `name` by the module at `url` on a worker,
// with `args` (shared objects pass as themselves, the rest as postMessage
// copies them). Settles with what it returns (or its promise does), or
// rejects with what it threw. The worker is one of the pool's: a worker that
// returned before, or a new one.
export const run = (
  url: string | URL,
  name: string,
  ...args: unknown[]
): Promise<unknown> => spawn(url, name, ...args).result;

export interface Running {
  // what the function returns, or threw
  result: Promise<unknown>;
  // ends the worker (in a browser, the workers it started end with it); the
  // result never settles then
  terminate(): void;
}

// run, which can be stopped. A worker that is stopped, or fails, is not kept.
export function spawn(
  url: string | URL,
  name: string,
  ...args: unknown[]
): Running {
  requireHeap();
  const agent = idle.pop() ?? startPooled();
  agent.hold(true);
  let ended = false;
  const end = (keep: boolean) => {
    if (ended) return;
    ended = true;
    agent.onmessage = agent.onerror = null;
    if (keep && idle.length < POOL) {
      agent.hold(false);
      idle.push(agent);
    } else agent.terminate();
  };
  const result = new Promise((resolve, reject) => {
    agent.onmessage = m => {
      if (LOG in m) return log(m[LOG]);
      end(true);
      if (ERROR in m) {
        const e = new Error(m[ERROR].message);
        if (m[ERROR].stack) e.stack = m[ERROR].stack;
        reject(e);
      } else resolve(m[RESULT]);
    };
    agent.onerror = e => {
      end(false);
      reject(
        e instanceof Error ? e : new Error(String((e as any)?.message ?? e)),
      );
    };
    agent.postMessage({url: String(url), name, args});
  });
  return {result, terminate: () => end(false)};
}

// The agent that started this one (in a worker), or null.
export const parent: Omit<Agent, 'terminate' | 'exited' | 'onerror'> | null =
  (() => {
    const wt = nodeThreads();
    if (wt) {
      const port = wt.parentPort;
      if (!port) return null;
      let handler: ((m: any) => void) | null = null;
      const listener = (m: unknown) => handler?.(decode(m));
      return {
        postMessage: (m: unknown) => send(e => port.postMessage(e), m),
        // listening keeps the worker alive: only while there is a handler
        get onmessage() {
          return handler;
        },
        set onmessage(f) {
          if (f && !handler) port.on('message', listener);
          if (!f && handler) port.off('message', listener);
          handler = f;
        },
      };
    }
    if (typeof (globalThis as any).WorkerGlobalScope === 'undefined')
      return null;
    const self = globalThis as any;
    const agent = {
      postMessage: (m: unknown) => send(e => self.postMessage(e), m),
      onmessage: null as ((m: any) => void) | null,
    };
    self.addEventListener('message', (e: MessageEvent) => {
      const data = e.data;
      if (!attached() && data && typeof data === 'object' && HEAP in data) {
        globalThis.__structsAgent = data.record;
        attach(data[HEAP]);
        return;
      }
      agent.onmessage?.(decode(data));
    });
    return agent;
  })();
