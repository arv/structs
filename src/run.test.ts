// The hand-written programs on node worker threads (run.ts): every thread
// count computes the same thing.
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stripVTControlCharacters} from 'node:util';
import {describe, expect, it} from 'vite-plus/test';

const run = (...args: string[]) =>
  stripVTControlCharacters(
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL('./run.ts', import.meta.url)), ...args],
      {encoding: 'utf8', timeout: 60_000},
    ),
  );

// N-body's kinetic energy, after the same steps, on each thread count
const ENERGY = 'kinetic energy 59093.195871';

describe('programs on threads', () => {
  for (const program of ['nbody-own', 'nbody-cells']) {
    it(`${program} reaches the same energy on 1, 2 and 4 threads`, () => {
      const lines = run(program, '--threads=1,2,4')
        .split('\n')
        .filter(l => l.startsWith('threads'));
      expect(lines).toHaveLength(3);
      for (const line of lines) expect(line).toContain(ENERGY);
    });
  }

  it('an async main runs to its end', () => {
    expect(run('async-main', '--threads=1,2').trim().split('\n')).toEqual([
      '1: 1 2',
      '2: 4 3',
      'main is done',
    ]);
  });

  it('join() in an async function throws before it commits to anything', () => {
    expect(run('join-on-host', '--threads=1').trim().split('\n')).toEqual([
      'join() in an async function: throws',
      'joinAsync() after it: 9',
      'another thread: 25',
    ]);
  });

  it('a key another thread interned again is found by the thread that knew it', () => {
    expect(run('intern-stale', '--threads=1').trim().split('\n')).toEqual([
      'y: [[true,2,1],1]',
      'entries: [["k",9]] size 1',
    ]);
  });

  it('a scope joins every thread when one of them throws', () => {
    expect(run('scope-throw', '--threads=1').trim().split('\n')).toEqual([
      'scope threw: Error: boom; blocks left behind: 0',
      'scope threw: Error: the body; blocks left behind: 0',
      'scope threw: AggregateError: threads: more than one thread threw: [Error: boom, Error: worse]; blocks left behind: 0',
      'scope in an async function: throws; blocks left behind: 0',
    ]);
  });

  it('the ring is recycled under threads that spawn at once', () => {
    expect(run('ring-recycle', '--threads=1').trim()).toMatch(
      /^1280 threads through the ring: sum (\d+), expected \1$/,
    );
  }, 60_000);

  it('reference counting under a race reads no freed memory', () => {
    const out = run('refcount-hand', '--threads=2');
    expect(out).toMatch(/bad reads 0/);
    expect(out).toMatch(/pending 0/);
  });
});
