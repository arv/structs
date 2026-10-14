// how the pool asks for workers, on one thread (no worker ever comes): a thread
// queued with no worker idle asks for one, unless one is on its way already
import {describe, expect, it} from 'vite-plus/test';
import type {Message} from './runtime.ts';
import {logged, own, runtime} from './test-heap.ts';

const sab = globalThis.__escapeSab!;
const pool = () => runtime.counters(sab);
// what this thread posts to its coordinator
const asked: Message[] = [];
const attach = (post: (m: Message) => void) =>
  runtime.attach(sab, {}, post, text => logged.push(text));

function noop() {}

describe('the pool grows', () => {
  it('by a worker for a thread none is idle or on its way for', () => {
    attach(m => asked.push(m));
    own.fns({noop});
    // the pool a coordinator starts with: on their way, not in it yet
    runtime.workersComing(sab, 2);
    own.spawn(noop);
    own.spawn(noop);
    expect(asked).toEqual([]);
    expect(pool()).toMatchObject({queued: 2, idle: 0, coming: 2});
    own.spawn(noop);
    expect(asked).toEqual([{type: 'grow'}]);
    expect(pool()).toMatchObject({queued: 3, coming: 3});
    // the one asked for is on its way too: a fourth thread asks again
    own.spawn(noop);
    expect(asked).toEqual([{type: 'grow'}, {type: 'grow'}]);
    expect(pool()).toMatchObject({queued: 4, coming: 4});
  });

  it('not by an ask it could not post, which a later thread makes again', () => {
    const warn = console.warn,
      warned: string[] = [];
    console.warn = (m: string) => warned.push(m);
    try {
      attach(() => {
        throw new Error('gone');
      });
      own.spawn(noop);
    } finally {
      console.warn = warn;
    }
    expect(warned).toEqual([
      'threads: could not ask for a worker: Error: gone',
    ]);
    expect(pool()).toMatchObject({queued: 5, coming: 4});
    attach(m => asked.push(m));
    own.spawn(noop);
    // two short now: this thread asks for one
    expect(asked).toHaveLength(3);
    expect(pool()).toMatchObject({queued: 6, coming: 5});
  });

  it('by fewer once a worker asked for does not start, and from none after a reset', async () => {
    runtime.workersComing(sab, -1);
    expect(pool().coming).toBe(4);
    runtime.shutdown(sab);
    expect(await runtime.resetPool(sab)).toBe(true);
    expect(pool()).toMatchObject({queued: 0, idle: 0, coming: 0});
  });
});
