// A page whose entry module imports "@arv/threads/heap" late, or not at all:
// the runtime and the page's API load with no shared memory, their views of it
// being module constants. stop(), with no pool to stop, does nothing, and
// start() names the rule, as does the runtime should the heap be made after it
// loaded
import {expect, it} from 'vite-plus/test';

const g = globalThis as {__escapeSab?: SharedArrayBuffer};
const browser = await import('./browser.ts');
const runtime = await import('./runtime.ts');

it('stop() before the heap was made does nothing', () => {
  expect(() => browser.stop()).not.toThrow();
});

it('start() before the heap was made names the rule', () => {
  expect(() => browser.start()).toThrow(/import "@arv\/threads\/heap" first/);
});

it('the runtime, loaded before the heap was made, names the rule as it attaches', () => {
  // the heap made after the runtime loaded: a module that imports the threads
  // API evaluated first. the page's start() attaches as it begins
  g.__escapeSab = new SharedArrayBuffer(16 << 20);
  expect(() =>
    runtime.attach(
      g.__escapeSab!,
      {},
      () => {},
      () => {},
    ),
  ).toThrow(/import "@arv\/threads\/heap" first/);
});
