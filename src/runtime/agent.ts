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
import {attach, attached, requireHeap, SAB} from './heap.ts';
import {addressOf, handleAt} from './shared.ts';

const MARK = '__structs.shared';
const HEAP = '__structs.heap';

// A message as postMessage can copy it: its shared objects as their
// addresses, in arrays and plain objects (others are copied as they are).
export function encode(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const a = addressOf(value);
  if (a !== undefined) return {[MARK]: a};
  if (Array.isArray(value)) return value.map(encode);
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = encode(v);
  return out;
}

export function decode(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map(decode);
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  if (MARK in value) {
    requireHeap();
    return handleAt((value as any)[MARK]);
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
  let agent: Agent;
  if (wt) {
    const w = new wt.Worker(url, {
      name: options.name,
      workerData: {__structsHeap: SAB},
    });
    let exited!: (code: number) => void;
    const done = new Promise<number>(resolve => (exited = resolve));
    agent = {
      postMessage: m => w.postMessage(encode(m)),
      onmessage: null,
      onerror: null,
      terminate: () => void w.terminate(),
      exited: done,
    };
    w.on('message', m => agent.onmessage?.(decode(m)));
    w.on('error', e => {
      if (agent.onerror) agent.onerror(e);
      else throw e;
    });
    w.on('exit', code => exited(code));
  } else {
    const w = new Worker(url, {type: 'module', name: options.name});
    w.postMessage({[HEAP]: SAB});
    agent = {
      postMessage: m => w.postMessage(encode(m)),
      onmessage: null,
      onerror: null,
      terminate: () => w.terminate(),
      exited: new Promise(() => {}),
    };
    w.onmessage = e => agent.onmessage?.(decode(e.data));
    w.onerror = e => {
      if (agent.onerror) agent.onerror(e);
    };
  }
  return agent;
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
        postMessage: (m: unknown) => port.postMessage(encode(m)),
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
      postMessage: (m: unknown) => self.postMessage(encode(m)),
      onmessage: null as ((m: any) => void) | null,
    };
    self.addEventListener('message', (e: MessageEvent) => {
      const data = e.data;
      if (!attached() && data && typeof data === 'object' && HEAP in data) {
        attach(data[HEAP]);
        return;
      }
      agent.onmessage?.(decode(data));
    });
    return agent;
  })();
