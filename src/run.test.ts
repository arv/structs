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

  it('reference counting under a race reads no freed memory', () => {
    const out = run('refcount-hand', '--threads=2');
    expect(out).toMatch(/bad reads 0/);
    expect(out).toMatch(/pending 0/);
  });
});
