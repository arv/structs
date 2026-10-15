// Compiling in the page, where no dev server compiles (a static build, or
// ?wasm): threads-check on tsgo in WebAssembly, in a worker (compiler.ts). And running
// what it compiled: a program is a blob: module, whose imports of the runtime
// read globalThis.__threads, the threads API, which this page sets; the pool's
// workers load the same blob: URL, and set it too (threads-worker.ts).
import * as api from '@arv/threads';
import {helpersOf, registration} from '@arv/threads/compiled';
import type {
  Compiled,
  CompilerMessage,
  CompilerRequest,
} from './compiler-messages.ts';

declare global {
  var __threads: unknown;
}
globalThis.__threads = api;

const RUNTIME = '@arv/threads';

// how the download goes
export type Progress =
  | {loaded: number; total: number}
  | {ready: number}
  | {error: string};

let worker: Worker | null = null,
  next = 0,
  // why the compiler is gone, once it is: what is asked of it then fails at
  // once
  failure: Error | null = null;
const waiting = new Map<
  number,
  {resolve: (c: Compiled) => void; reject: (e: Error) => void}
>();

// starts downloading the compiler
export function startCompiler(onProgress: (p: Progress) => void) {
  worker = new Worker(new URL('./compiler.ts', import.meta.url), {
    type: 'module',
  });
  // the compiler is gone: nothing answers what waits for it
  const gone = (message: string) => {
    onProgress({error: message});
    failure = new Error(message);
    for (const w of waiting.values()) w.reject(failure);
    waiting.clear();
  };
  worker.onmessage = ({data: m}: MessageEvent<CompilerMessage>) => {
    if (m.type === 'progress') onProgress(m);
    else if (m.type === 'ready') onProgress({ready: m.ms});
    else if (m.type === 'result') {
      waiting.get(m.id)?.resolve(m.compiled);
      waiting.delete(m.id);
    } else if (m.id === null) gone(m.message);
    else {
      waiting.get(m.id)?.reject(new Error(m.message));
      waiting.delete(m.id);
    }
  };
  // its script did not load, or threw (a script that does not load has no
  // message)
  worker.onerror = e => gone(e.message || "the compiler's worker did not load");
  worker.onmessageerror = () =>
    gone("the compiler's worker sent what this page could not read");
}

// source compiled as the dev server compiles it (vite-plugin-threads.ts), but
// with tsgo, rather than node, erasing the types
export async function compileInBrowser(source: string, types: string) {
  if (failure) throw failure;
  const id = ++next;
  const c = await new Promise<Compiled>((resolve, reject) => {
    waiting.set(id, {resolve, reject});
    worker!.postMessage({id, source, types} satisfies CompilerRequest);
  });
  const {tail, added} = registration(source, RUNTIME, c.js);
  return {
    key: '',
    compiled: {
      js: c.js,
      compiler: 'threads-check',
      ms: c.ms,
      ownership: c.ownership,
      checker: 'threads-check, on tsgo in WebAssembly',
      checkMs: c.checkMs,
      types: c.types,
      helpers: c.js ? Object.values(helpersOf(c.js, RUNTIME)) : [],
    },
    erased: {
      js: c.erased === null ? null : c.erased + tail,
      error: c.erased === null ? 'nothing emitted' : null,
      added,
    },
  };
}

// a program's imports of the runtime as reads of globalThis.__threads: a blob:
// module cannot resolve "@arv/threads"
const link = (code: string) =>
  code.replace(
    /\bimport\s*(\{[^}]*\}|\*\s*as\s+[\w$]+)\s*from\s*(['"])@arv\/threads\2\s*;?/g,
    (_, what: string) =>
      `const ${what.startsWith('*') ? what.replace(/^\*\s*as\s+/, '') : what.replace(/\bas\b/g, ':')} = globalThis.__threads;`,
  );

// the URL a program is imported by, by its code: one per program, kept, since
// a worker may load it whenever a thread first needs it
const urls = new Map<string, string>();
export function programUrl(code: string) {
  let url = urls.get(code);
  if (url === undefined) {
    url = URL.createObjectURL(
      new Blob([link(code)], {type: 'text/javascript'}),
    );
    urls.set(code, url);
  }
  return url;
}
