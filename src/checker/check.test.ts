// threads-check on the programs of test/cases: each reports what
// test/expected/cases-<name>.txt says, which `vp run compare --update` writes
// from the tsgo fork's `own check` (compare.ts compares with the fork itself
// when it is there).
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, describe, expect, it} from 'vite-plus/test';
import {API, check, formatDiagnostic} from './index.ts';

const checker = fileURLToPath(new URL('.', import.meta.url));
const cases = join(checker, 'test/cases');
const api = new API({cwd: checker});
afterAll(() => api.close());

const lines = (text: string) => text.split('\n').filter(l => l !== '');

describe('threads-check', () => {
  it('refuses a runtime no file imports: a mistyped --runtime', () => {
    expect(() =>
      check(join(cases, 'channels/tsconfig.json'), {runtime: 'thread', api}),
    ).toThrow(/no file of the project imports the runtime as 'thread'/);
  });

  for (const name of readdirSync(cases).sort()) {
    it(`reports what the fork does on ${name}`, () => {
      const dir = join(cases, name);
      const actual = check(join(dir, 'tsconfig.json'), {
        runtime: 'threads',
        api,
      }).map(d => formatDiagnostic(d, dir));
      const expected = lines(
        readFileSync(join(checker, `test/expected/cases-${name}.txt`), 'utf8'),
      );
      expect([...actual].sort()).toEqual([...expected].sort());
    });
  }
});

// What threads-check reports and the fork does not, yet (compare.ts compares
// the two on test/cases alone): programs in test/diverging, each with what it
// should report
describe('threads-check, where it differs from the fork', () => {
  it('knows consume() and struct() under other names', () => {
    // the fork takes a call for consume() or struct() by the name it is called
    // by: an import alias, or a const that holds it, defeats it there
    const dir = join(checker, 'test/diverging/marker-aliases');
    expect(
      check(join(dir, 'tsconfig.json'), {runtime: 'threads', api})
        .map(d => formatDiagnostic(d, dir))
        .sort(),
    ).toEqual(
      [
        "alias.ts(11,7): error TS96005: 'xs' was consumed by 'send' on line 10.",
        "alias.ts(16,7): error TS96005: 'xs' was consumed by 'send' on line 15.",
        "alias.ts(22,11): error TS96021: A value of type 'Hidden' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
        "alias.ts(28,7): error TS96005: 'xs' was consumed by 'send' on line 27.",
        "alias.ts(33,7): error TS96005: 'xs' was consumed by 'send' on line 32.",
      ].sort(),
    );
  });

  it("reports no blocking call on a Channel that is not the runtime's", () => {
    const dir = join(checker, 'test/diverging/ambient-channel');
    expect(
      check(join(dir, 'tsconfig.json'), {runtime: 'threads', api}).map(d =>
        formatDiagnostic(d, dir),
      ),
    ).toEqual([]);
  });
});
