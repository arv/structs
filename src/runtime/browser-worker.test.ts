// The page's API on a worker: a pool worker loads every module that defines a
// function a thread runs, the page's entry module too should it define one, and
// with it what the entry runs as it loads. start() there would make a pool in
// the worker and take the page's thread; start(), run() and stop() refuse.
// This file is a worker as far as browser.ts can tell: its global object is
// an instance of WorkerGlobalScope
import {expect, it} from 'vite-plus/test';

const g = globalThis as {
  WorkerGlobalScope?: unknown;
  __escapeSab?: SharedArrayBuffer;
};
g.__escapeSab = new SharedArrayBuffer(16 << 20);
g.WorkerGlobalScope = Object; // globalThis instanceof Object
const browser = await import('./browser.ts');
const {fns} = await import('./own.ts');

function work() {
  return 1;
}

it('start(), run() and stop() refuse to run on a worker', async () => {
  fns({work});
  expect(() => browser.start()).toThrow(/start\(\) is for the page/);
  await expect(browser.run(work)).rejects.toThrow(/run\(\) is for the page/);
  expect(() => browser.stop()).toThrow(/stop\(\) is for the page/);
});
