// Tests run the runtime on one thread. Its views of shared memory are module
// constants, so the memory comes first, then the runtime, attached as a pool
// worker attaches, then what uses it.
const g = globalThis as {__escapeSab?: SharedArrayBuffer};
g.__escapeSab = new SharedArrayBuffer(64 << 20);
const runtime = await import('./runtime.ts');
/** What `log` wrote, a line each. */
export const logged: string[] = [];
runtime.attach(
  g.__escapeSab,
  {},
  () => {},
  (text: string) => logged.push(text),
);
runtime.threadBegin(1);
export const own = await import('./own.ts');
export const threads = await import('./threads.ts');
