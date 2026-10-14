// The page's side of the compiler in WebAssembly (wasm.ts), on a worker whose
// script fails: nothing would ever answer, so what waits for a compile fails,
// and so does every compile asked for after
import {expect, it} from 'vite-plus/test';
import type {Progress} from './wasm.ts';

// the shared memory, as the page's heap import makes it: wasm.ts loads the
// runtime
(globalThis as {__escapeSab?: SharedArrayBuffer}).__escapeSab =
  new SharedArrayBuffer(16 << 20);

// a worker that answers nothing: the test fails it
class FakeWorker {
  static last: FakeWorker;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(m: unknown) {
    this.posted.push(m);
  }
  // as the browser fires an error event at it
  fail(e: ErrorEvent) {
    this.onerror?.(e);
  }
}
(globalThis as {Worker: unknown}).Worker = FakeWorker;
const {compileInBrowser, startCompiler} = await import('./wasm.ts');

it('fails the compiles of a compiler whose worker failed, now and after', async () => {
  const progress: Progress[] = [];
  startCompiler(p => progress.push(p));
  const waiting = compileInBrowser('export function main() {}', '');
  // a module worker whose script does not load: an error event, no message
  FakeWorker.last.fail({message: ''} as ErrorEvent);
  await expect(waiting).rejects.toThrow("the compiler's worker did not load");
  expect(progress).toEqual([{error: "the compiler's worker did not load"}]);
  // at once: the worker is not asked
  await expect(compileInBrowser('', '')).rejects.toThrow(
    "the compiler's worker did not load",
  );
  expect(FakeWorker.last.posted).toHaveLength(1);
});
