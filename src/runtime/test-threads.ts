// The functions thread-error.test.ts and web-worker.test.ts run on threads.
// The test, as the page or the program's main worker, and its pool workers
// (src/worker.ts) load this module, and find each one by its key: this
// module's URL and the function's name
import {register, spawn} from './own.ts';

export function bad(): number {
  throw new Error('boom');
}
export async function badAsync(): Promise<number> {
  await Promise.resolve(); // it throws once it has waited
  throw new TypeError('async boom');
}
export function thrown(): number {
  throw 'a string, thrown';
}
// String() of an object with no prototype throws
export function unprintable(): number {
  throw Object.create(null);
}
// joins a thread that threw, and so throws what its join threw
export function joins(): number {
  return spawn(bad).join();
}
// a program's main (web-worker.test.ts) that throws what a join threw
export function main(): number {
  return joins();
}
export function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  return ms;
}
register(import.meta.url, {
  bad,
  badAsync,
  thrown,
  unprintable,
  joins,
  sleep,
});
