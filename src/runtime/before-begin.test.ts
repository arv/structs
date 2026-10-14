// The runtime before its thread began, as a page is before start(): a quiescent
// point, and a wait's begin and end, write nothing, as the entry pointer is 0
// until threadBegin and the words there are the control words' (the string
// table's lock among them). the heap comes first, then the runtime, as
// test-heap.ts has it, but without the thread begun
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

it('a point before the thread began writes nothing', () => {
  const STR_LOCK = 5, // C_STR_LOCK, the word a thread's T_QS would be at ME 0
    ALLOC = 0; // C_ALLOC, where T_ALIVE would be
  const before = [runtime.I32[STR_LOCK], runtime.I32[ALLOC]];
  runtime.$quiescent();
  runtime.$waitBegin();
  runtime.$waitEnd();
  expect([runtime.I32[STR_LOCK], runtime.I32[ALLOC]]).toEqual(before);
  expect(runtime.I32[STR_LOCK]).toBe(0);
  // and once the thread began, the points are its
  runtime.threadBegin(1);
  runtime.$quiescent();
  expect(runtime.I32[STR_LOCK]).toBe(0);
  expect(runtime.I32[2048 + 8 + 5]).toBe(runtime.I32[17]); // T_QS of thread 1 is the epoch
});
