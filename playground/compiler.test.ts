// The compiler's worker (compiler.ts), with a Go whose program exits before it
// says it is ready: the page hears that the compiler failed, and a compile
// asked for fails, rather than wait for good
import {expect, it} from 'vite-plus/test';
import type {CompilerMessage, CompilerRequest} from './compiler.ts';

// a worker's globals, and what the compiler downloads
const posted: CompilerMessage[] = [];
Object.assign(globalThis, {
  postMessage: (m: CompilerMessage) => posted.push(m),
  onmessage: null,
  fetch: async (url: string) =>
    url.endsWith('.json') ? Response.json({bytes: 1}) : new Response('wasm'),
  // Go's glue defines Go: here it is already, and the glue loads as an empty
  // module
  Go: class {
    importObject = {};
    async run() {} // exits at once
  },
});
URL.createObjectURL = () => 'data:text/javascript,';
URL.revokeObjectURL = () => {};
WebAssembly.instantiateStreaming = async () =>
  ({instance: {}, module: {}}) as WebAssembly.WebAssemblyInstantiatedSource;
await import('./compiler.ts');
// what the page asks the worker
const ask = (
  globalThis as unknown as {
    onmessage: (e: {data: CompilerRequest}) => Promise<void>;
  }
).onmessage;

it('says that a compiler that exits before it is ready failed', async () => {
  const exited = 'Error: the compiler exited before it was ready';
  await expect
    .poll(() => posted)
    .toContainEqual({type: 'error', id: null, message: exited});
  await ask({data: {id: 1, source: '', types: ''}});
  expect(posted).toContainEqual({type: 'error', id: 1, message: exited});
});
