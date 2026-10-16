// The worker `run` starts (agent.ts): it imports a module, calls one of its
// functions with the arguments it is sent, and sends back what it returns, or
// what it threw. In a browser it also sends its console output back, which a
// worker's console would keep to itself (the devtools').

import * as agent from './agent.ts';
import {ERROR, LOG, parent, RESULT} from './agent.ts';
import * as runtime from './emit.ts';
import * as structs from './index.ts';

declare global {
  // the runtime, for code loaded where "@arv/structs" cannot be resolved (a
  // blob: module, say, as the playground runs)
  var __structs: unknown;
}
globalThis.__structs = {structs, runtime, agent};

if (typeof (globalThis as any).WorkerGlobalScope !== 'undefined') {
  const forward =
    (prefix: string) =>
    (...args: unknown[]) =>
      parent!.postMessage({
        [LOG]:
          prefix +
          args.map(a => (typeof a === 'string' ? a : format(a))).join(' '),
      });
  console.log = console.info = console.debug = forward('');
  console.warn = forward('warning: ');
  console.error = forward('error: ');
}

function format(v: unknown): string {
  if (typeof v !== 'object' || v === null) return String(v);
  if (v instanceof Error) return v.stack ?? String(v);
  try {
    // a shared struct's fields are read through its Proxy
    return JSON.stringify({...v}, (_, x) =>
      typeof x === 'bigint' ? `${x}n` : x,
    );
  } catch {
    return Object.prototype.toString.call(v);
  }
}

parent!.onmessage = async ({url, name, args}) => {
  parent!.onmessage = null;
  try {
    const module = await import(/* @vite-ignore */ url);
    if (typeof module[name] !== 'function')
      throw new TypeError(`${url} exports no function ${name}`);
    parent!.postMessage({[RESULT]: await module[name](...args)});
  } catch (e) {
    const error = e as Error;
    parent!.postMessage({
      [ERROR]: {message: error?.message ?? String(e), stack: error?.stack},
    });
  }
};
