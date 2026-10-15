// The compiler's worker (compiler.ts), with a tsgo worker whose WebAssembly
// does not load: the page hears that the compiler failed, and a compile asked
// for fails, rather than wait for good
import {expect, it} from 'vite-plus/test';
import type {CompilerMessage, CompilerRequest} from './compiler-messages.ts';

// a worker's globals, and a tsgo worker that says it failed
const posted: CompilerMessage[] = [];
Object.assign(globalThis, {
  postMessage: (m: CompilerMessage) => posted.push(m),
  onmessage: null,
  Worker: class {
    onmessage: ((e: {data: unknown}) => void) | null = null;
    onerror: unknown = null;
    constructor() {
      queueMicrotask(() =>
        this.onmessage?.({
          data: {type: 'error', message: 'tsgo.wasm: 404'},
        }),
      );
    }
    postMessage() {}
    terminate() {}
  },
});
await import('./compiler.ts');
// what the page asks the worker
const ask = (
  globalThis as unknown as {
    onmessage: (e: {data: CompilerRequest}) => Promise<void>;
  }
).onmessage;

it('says that a compiler whose tsgo did not load failed', async () => {
  const failed = 'Error: tsgo.wasm: 404';
  await expect
    .poll(() => posted)
    .toContainEqual({type: 'error', id: null, message: failed});
  await ask({data: {id: 1, source: '', types: ''}});
  expect(posted).toContainEqual({type: 'error', id: 1, message: failed});
});
