// threads-check, the command (cli.ts): its usage, and what it prints and exits
// with for the checker's diagnostics, the tsconfig's errors, a project it
// cannot check and a bug of its own.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vite-plus/test';
import {Messages} from './messages.ts';

const checker = fileURLToPath(new URL('.', import.meta.url));

// runs threads-check in the checker's directory, with node's options before it
const run = (args: string[], node: string[] = []) => {
  const r = spawnSync(process.execPath, [...node, 'cli.ts', ...args], {
    cwd: checker,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  return {status: r.status, out: r.stdout, err: r.stderr};
};
const project = (path: string, runtime = 'threads') => [
  '-p',
  path,
  '--runtime',
  runtime,
];

// a bug in the checker: a TypeError deep in check(), as it sorts what it found
// (the callers are the stack's frames past sort's own, which names this
// module's data: URL, and with it its source)
const bug = `data:text/javascript,${encodeURIComponent(`
  const sort = Array.prototype.sort;
  Array.prototype.sort = function (...args) {
    const callers = new Error().stack.split('\\n').slice(2);
    if (callers.some(frame => frame.includes('sortAndDeduplicate'))) null.bug;
    return sort.apply(this, args);
  };`)}`;

describe('threads-check, the command', () => {
  it('names the range of its codes in its usage', () => {
    const codes = Object.values(Messages).map(m => m.code);
    const {status, out} = run(['--help']);
    expect(out).toContain(`(TS${Math.min(...codes)}-TS${Math.max(...codes)})`);
    expect(status).toBe(0);
  });

  it("exits 1 with the checker's diagnostics", () => {
    const {status, out} = run(project('test/cases/channels'));
    expect(out).toMatch(/^test\/cases\/channels\/\S+\(\d+,\d+\): error TS96/);
    expect(status).toBe(1);
  });

  it("exits 2 with the tsconfig's errors, as tsc reports them", () => {
    const noInputs = run(project('test/config-errors/no-inputs'));
    expect(noInputs.out).toMatch(
      /^error TS18003: No inputs were found in config file '/,
    );
    expect(noInputs.status).toBe(2);
    const malformed = run(project('test/config-errors/malformed'));
    expect(malformed.out).toBe(
      "test/config-errors/malformed/tsconfig.json(9,5): error TS1005: ',' expected.\n",
    );
    expect(malformed.status).toBe(2);
  });

  it('exits 3 with what it cannot check, and why', () => {
    const runtime = run(project('test/cases/channels', 'thread'));
    expect(runtime.err).toMatch(
      /^threads-check: no file of the project imports the runtime as 'thread',[^\n]*\n$/,
    );
    expect(runtime.status).toBe(3);
    const program = run(project('test/config-errors/malformed/send.ts'));
    expect(program.err).toBe(
      "threads-check: 'test/config-errors/malformed/send.ts' is a program, not a project: -p takes a tsconfig.json, or a directory with one\n",
    );
    expect(program.status).toBe(3);
  });

  it('exits 4 on a bug of its own, with the stack', () => {
    const {status, err} = run(project('test/cases/channels'), [
      '--import',
      bug,
    ]);
    expect(err).toMatch(
      /^threads-check: internal error, a bug in threads-check:\nTypeError: Cannot read properties of null \(reading 'bug'\)\n/,
    );
    expect(err).toMatch(/\n {4}at sortAndDeduplicate /);
    expect(status).toBe(4);
  });
});
