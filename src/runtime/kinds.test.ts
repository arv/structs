// A thread that has not loaded maps.ts (a pool worker whose threads never import
// the API's maps, or the page) still counts a SharedMap's or SharedSet's
// block: a decrement of one, reclaimed from what another thread deferred, is
// applied rather than skipped as uncounted. This file loads the runtime and
// own.ts alone
import {expect, it} from 'vite-plus/test';

const g = globalThis as {__escapeSab?: SharedArrayBuffer};
g.__escapeSab = new SharedArrayBuffer(16 << 20);
const runtime = await import('./runtime.ts');
runtime.attach(
  g.__escapeSab,
  {},
  () => {},
  () => {},
);
runtime.threadBegin(1);
const own = await import('./own.ts');

it('a map or set is counted on a thread that has not loaded maps.ts', () => {
  for (const kind of [25, 26]) {
    // a block as a map's or set's starts: [kind][count]
    const a = runtime.$allocBlock(32);
    runtime.I32[a >> 2] = kind;
    runtime.I32[(a >> 2) + 1] = 2;
    own.release(a);
    expect(runtime.I32[(a >> 2) + 1]).toBe(1); // applied, not skipped
    // its last count: freeing it needs maps.ts, which says so
    expect(() => own.release(a)).toThrow(/has not loaded maps.ts/);
  }
});
