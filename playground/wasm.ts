// Compiling in the page, where no dev server compiles (a static build, or
// ?wasm): the tsgo fork in WebAssembly, in a worker (compiler.ts). And running
// what it compiled: a program is a blob: module, whose imports of the runtime
// read globalThis.__threads, the threads API, which this page sets; the pool's
// workers load the same blob: URL, and set it too (threads-worker.ts).
import * as api from '@arv/threads';
import {helpersOf, registration, type Diagnostic} from '@arv/threads/compiled';
import type {CompilerMessage, CompilerRequest} from './compiler.ts';

declare global {
  var __threads: unknown;
}
globalThis.__threads = api;

const RUNTIME = '@arv/threads';

// what the compiler returns (cmd/wasm in arv/threads-checker)
type Compiled = {
  js: string | null;
  erased: string | null;
  ownership: Diagnostic[];
  types: Diagnostic[];
  ms: number;
  checkMs: number;
};
// how the download goes
export type Progress =
  | {loaded: number; total: number}
  | {ready: number}
  | {error: string};

let worker: Worker | null = null,
  next = 0;
const waiting = new Map<
  number,
  {resolve: (c: Compiled) => void; reject: (e: Error) => void}
>();

// starts downloading the compiler
export function startCompiler(onProgress: (p: Progress) => void) {
  worker = new Worker(new URL('./compiler.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = ({data: m}: MessageEvent<CompilerMessage>) => {
    if (m.type === 'progress') onProgress(m);
    else if (m.type === 'ready') onProgress({ready: m.ms});
    else if (m.type === 'result') {
      waiting.get(m.id)?.resolve(JSON.parse(m.json) as Compiled);
      waiting.delete(m.id);
    } else if (m.id === null) {
      onProgress({error: m.message});
      for (const w of waiting.values()) w.reject(new Error(m.message));
      waiting.clear();
    } else {
      waiting.get(m.id)?.reject(new Error(m.message));
      waiting.delete(m.id);
    }
  };
}

// source compiled as the dev server compiles it (vite-plugin-threads.ts), but
// with `tsgo own check`'s ownership errors, and tsgo erasing the types
export async function compileInBrowser(source: string, types: string) {
  const id = ++next;
  const c = await new Promise<Compiled>((resolve, reject) => {
    waiting.set(id, {resolve, reject});
    worker!.postMessage({id, source, types} satisfies CompilerRequest);
  });
  const {tail, added} = registration(source, RUNTIME);
  return {
    key: '',
    compiled: {
      js: c.js,
      ms: c.ms,
      ownership: c.ownership,
      checker: 'tsgo own check, in WebAssembly',
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
