// A thread that throws, joined on the page (browser.ts) from a pool of real
// workers: node worker threads, each a pool worker of src/worker.ts, stand in
// for the page's Web Workers. What a thread threw crosses to the page as text
// (an Error cannot be shared): join(), joinAsync() and run() throw an Error
// that says what it was, and whose cause has the stack where it was thrown
import {Worker as NodeWorker} from 'node:worker_threads';
import {afterAll, beforeAll, describe, expect, it} from 'vite-plus/test';
import type {WorkerData} from '../worker.ts';

const g = globalThis as {__escapeSab?: SharedArrayBuffer; Worker?: unknown};
g.__escapeSab = new SharedArrayBuffer(64 << 20);
const fnsModule = new URL('./test-threads.ts', import.meta.url).href;
// the module the workers load (one that is not there, for a worker that
// crashes)
let program = fnsModule;
// the page's Worker, as browser.ts uses it, on a node worker thread
class PageWorker {
  onmessage: ((e: {data: unknown}) => void) | null = null;
  onerror: ((e: {message: string}) => void) | null = null;
  w: NodeWorker | null = null;
  postMessage({sab, opts}: {sab: SharedArrayBuffer; opts: {check?: boolean}}) {
    this.w = new NodeWorker(new URL('../worker.ts', import.meta.url), {
      workerData: {
        sab,
        program,
        opts,
        role: 'pool',
        threads: [],
      } satisfies WorkerData,
    });
    this.w.on('message', data => this.onmessage?.({data}));
    this.w.on('error', e => this.onerror?.({message: String(e)}));
    // a pool worker of src/worker.ts tells its coordinator nothing as it
    // starts: a thread queued meanwhile waits for it
    if (program === fnsModule)
      queueMicrotask(() => this.onmessage?.({data: {type: 'ready'}}));
  }
  terminate() {
    void this.w?.terminate();
  }
}
g.Worker = PageWorker;
const browser = await import('./browser.ts');
const {spawn} = await import('./own.ts');
const fns = await import('./test-threads.ts');

// what a promise rejected with
const rejection = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('it resolved');
    },
    (e: unknown) => e,
  );
// the stack where it was thrown, from the cause of the error that tells of it
const threadStack = (e: unknown) =>
  String(((e as Error).cause as Error | undefined)?.stack);

beforeAll(() => browser.start({workers: 2}));
afterAll(() => {
  browser.stop();
});

describe('a thread that throws', () => {
  it('makes run() reject with an Error that says what it threw, and where', async () => {
    const e = await rejection(browser.run(fns.bad));
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe('Error: boom');
    expect(threadStack(e)).toMatch(/\bbad\b.*test-threads\.ts/);
  });

  it('makes joinAsync() reject with it, and join() throw it', async () => {
    const e = await rejection(spawn(fns.bad).joinAsync());
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe('Error: boom');
    expect(threadStack(e)).toMatch(/\bbad\b.*test-threads\.ts/);
    // node's main thread may block, as a worker's
    let thrown: unknown;
    try {
      spawn(fns.bad).join();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Error: boom');
    expect(threadStack(thrown)).toMatch(/\bbad\b.*test-threads\.ts/);
  });

  it('of an async function rejects with it too', async () => {
    const e = await rejection(spawn(fns.badAsync).joinAsync());
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe('TypeError: async boom');
    expect(threadStack(e)).toMatch(/\bbadAsync\b.*test-threads\.ts/);
  });

  it('that is not an error rejects with an Error that says what it was', async () => {
    const e = await rejection(browser.run(fns.thrown));
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe('a string, thrown');
    expect((e as Error).cause).toBeUndefined(); // a string has no stack
  });

  it('that String() fails on rejects with an Error that says so', async () => {
    const e = await rejection(browser.run(fns.unprintable));
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe(
      'a thrown object, which String() fails on',
    );
  });

  it('thrown on from a thread that joined it is the error it was', async () => {
    const e = await rejection(browser.run(fns.joins));
    expect((e as Error).message).toBe('Error: boom');
    expect(threadStack(e)).toMatch(/\bbad\b.*test-threads\.ts/);
  });
});

describe('a stopped pool', () => {
  it('makes a run that waits reject with an Error', async () => {
    const waits = rejection(browser.run(fns.sleep, 50));
    browser.stop();
    const e = await waits;
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe('threads: the pool was stopped');
  });
});

describe('a worker that crashes as it starts', () => {
  it('makes start() reject with an Error that says what it threw, and where', async () => {
    program = new URL('./no-such-module.ts', import.meta.url).href;
    const e = await rejection(browser.start({workers: 1}));
    expect(e).toBeInstanceOf(Error);
    const {message} = e as Error;
    expect(message).toMatch(
      /^threads: a worker failed to start: Error\b.*Cannot find module .*no-such-module\.ts/,
    );
    expect(message).not.toMatch(/\n\s+at /); // the stack is the cause's
    expect(threadStack(e)).toMatch(/no-such-module\.ts[^]*\n\s+at /);
  });
});
