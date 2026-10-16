// Compiling in the page, where no dev server compiles (a static build, or
// ?wasm): the compiler on tsgo in WebAssembly, in a worker (compiler.ts).
import type {
  Compiled,
  CompilerMessage,
  CompilerRequest,
} from './compiler-messages.ts';

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
  worker.onerror = e => gone(e.message || "the compiler's worker did not load");
  worker.onmessageerror = () =>
    gone("the compiler's worker sent what this page could not read");
}

export async function compileInBrowser(source: string): Promise<Compiled> {
  if (failure) throw failure;
  const id = ++next;
  return new Promise<Compiled>((resolve, reject) => {
    waiting.set(id, {resolve, reject});
    worker!.postMessage({id, source} satisfies CompilerRequest);
  });
}
