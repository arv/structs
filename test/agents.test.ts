// Shared objects across agents: Node workers that share the heap.

import {describe, expect, test} from 'vite-plus/test';
import '../src/runtime/index.ts';
import {run, startWorker} from '../src/runtime/agent.ts';
import {load} from './helpers.ts';

const worker = (name: string) =>
  startWorker(new URL(`./fixtures/${name}.ts`, import.meta.url));

describe('agents', () => {
  test('a message carries shared objects, which arrive as themselves', async () => {
    const {S} = await load(`export shared struct S { seen = false; }`);
    const s = new S();
    const w = worker('echo-worker');
    const reply = new Promise<any>(resolve => (w.onmessage = resolve));
    w.postMessage({struct: s, list: [s, 1], plain: {a: 'b'}});
    const m = await reply;
    expect(m.struct).toBe(s);
    expect(m.list[0]).toBe(s);
    expect(m.plain).toEqual({a: 'b'});
    expect(m.array[0]).toBe(s);
    expect(m.array[1]).toBe('from the worker');
    expect(s.seen).toBe(true);
    await w.exited;
  });

  test('workers count under a Mutex, and wait on a Condition', async () => {
    const {Tally} = await load(`
      export shared struct Tally {
        count = 0;
        done = 0;
        mutex = new Atomics.Mutex();
        allDone = new Atomics.Condition();
      }
    `);
    const tally = new Tally();
    const WORKERS = 4,
      EACH = 20000;
    const workers = Array.from({length: WORKERS}, () =>
      worker('counter-worker'),
    );
    for (const w of workers) w.postMessage({tally, n: EACH});
    {
      using token = Atomics.Mutex.lock(tally.mutex);
      const done = Atomics.Condition.waitFor(
        tally.allDone,
        token,
        10000,
        () => tally.done === WORKERS,
      );
      expect(done).toBe(true);
    }
    expect(tally.count).toBe(WORKERS * EACH);
    await Promise.all(workers.map(w => w.exited));
  });

  test('run calls a function on a worker, and settles with what it returns', async () => {
    const {Tally} = await load(`
      export shared struct Tally { count = 0; mutex = new Atomics.Mutex(); }
    `);
    const tally = new Tally();
    const tasks = new URL('./fixtures/tasks.ts', import.meta.url);
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => run(tasks, 'add', tally, 5000)),
    );
    expect(results).toEqual(['added', 'added', 'added', 'added']);
    expect(tally.count).toBe(20000);
    expect(await run(tasks, 'later', 21)).toBe(42);
    await expect(run(tasks, 'fail')).rejects.toThrow('it failed');
    await expect(run(tasks, 'missing')).rejects.toThrow(/exports no function/);
  });
});
