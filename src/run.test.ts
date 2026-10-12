// The prototype's programs on node worker threads (run.ts): every thread
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

describe('the prototype on threads', () => {
  it('publish on escape: two threads count to 2000 under a lock', () => {
    expect(run('basic').trim()).toBe('2000');
  });

  for (const program of ['nbody', 'nbody-own', 'nbody-cells']) {
    it(`${program} reaches the same energy on 1, 2 and 4 threads`, () => {
      const lines = run(program, '--threads=1,2,4')
        .split('\n')
        .filter(l => l.startsWith('threads'));
      expect(lines).toHaveLength(3);
      for (const line of lines) expect(line).toContain(ENERGY);
    });
  }

  it('mandelbrot draws the same picture on 1 and 3 threads', () => {
    const picture = (threads: number) =>
      run('mandelbrot', `--threads=${threads}`)
        .split('\n')
        .filter(l => !l.startsWith('threads'))
        .join('\n');
    expect(picture(3)).toBe(picture(1));
  });

  it('reference counting under a race reads no freed memory', () => {
    const out = run('refcount-hand', '--threads=2');
    expect(out).toMatch(/bad reads 0/);
    expect(out).toMatch(/pending 0/);
  });
});
