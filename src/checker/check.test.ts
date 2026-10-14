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
const YIELDED =
  "A value of type 'Node & Cell' cannot be yielded, or returned by a generator: it would be stored in an IteratorResult, an ordinary object, which the caller keeps past the generator's count of it.";

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
  it('refuses a counted value yielded, or returned by a generator', () => {
    // the fork has no rule for yield: the value lands in an IteratorResult,
    // an ordinary object, past the generator's count of it. an async
    // generator awaits what it yields, so a promise of one counts, and a
    // narrowed handle, with a count of its own, does not
    const dir = join(checker, 'test/diverging/generators');
    expect(
      check(join(dir, 'tsconfig.json'), {runtime: 'threads', api})
        .map(d => formatDiagnostic(d, dir))
        .sort(),
    ).toEqual(
      [
        'generators.ts(9,9): error TS96032: ' + YIELDED,
        'generators.ts(10,10): error TS96032: ' + YIELDED,
        'generators.ts(13,9): error TS96032: ' + YIELDED,
        'generators.ts(23,9): error TS96032: ' + YIELDED,
        'generators.ts(24,10): error TS96032: ' + YIELDED,
      ].sort(),
    );
  });

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

  it('checks what a yield* or a spread takes from an iteration', () => {
    // the fork skips every yield* and every spread: a channel's values, a
    // map's, an ambient generator's land in an IteratorResult, an ordinary
    // array or an arguments list
    const dir = join(checker, 'test/diverging/delegates-and-spreads');
    expect(
      check(join(dir, 'tsconfig.json'), {runtime: 'threads', api})
        .map(d => formatDiagnostic(d, dir))
        .sort(),
    ).toEqual(
      [
        "delegates.ts(16,52): error TS96032: A value of type 'Node' cannot be yielded, or returned by a generator: it would be stored in an IteratorResult, an ordinary object, which the caller keeps past the generator's count of it.",
        "delegates.ts(17,63): error TS96032: A value of type 'Node' cannot be yielded, or returned by a generator: it would be stored in an IteratorResult, an ordinary object, which the caller keeps past the generator's count of it.",
        "delegates.ts(18,35): error TS96032: A value of type 'Node' cannot be yielded, or returned by a generator: it would be stored in an IteratorResult, an ordinary object, which the caller keeps past the generator's count of it.",
        "delegates.ts(19,41): error TS96032: A value of type 'Node' cannot be yielded, or returned by a generator: it would be stored in an IteratorResult, an ordinary object, which the caller keeps past the generator's count of it.",
        "delegates.ts(20,62): error TS96032: A value of type '{ x: number; } & Cell' cannot be yielded, or returned by a generator: it would be stored in an IteratorResult, an ordinary object, which the caller keeps past the generator's count of it.",
        "delegates.ts(21,63): error TS96032: A value of type '[string, { x: number; } & Cell]' cannot be yielded, or returned by a generator: it would be stored in an IteratorResult, an ordinary object, which the caller keeps past the generator's count of it.",
        "delegates.ts(29,19): error TS96021: A value of type 'Node' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
        "delegates.ts(30,18): error TS96021: A value of type '{ x: number; } & Cell' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
        "delegates.ts(31,18): error TS96021: A value of type '{ x: number; } & Cell' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
        "delegates.ts(32,10): error TS96021: A value of type 'Node' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
        "delegates.ts(39,45): error TS96032: A value of type 'Node' cannot be yielded, or returned by a generator: it would be stored in an IteratorResult, an ordinary object, which the caller keeps past the generator's count of it.",
        "delegates.ts(41,41): error TS96021: A value of type 'Node' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
        "delegates.ts(43,13): error TS96021: A value of type 'Node' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
        "delegates.ts(45,7): error TS96021: A value of type 'Node' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
        "delegates.ts(56,37): error TS96021: A value of type 'Node' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
        "delegates.ts(57,39): error TS96032: A value of type 'Node' cannot be yielded, or returned by a generator: it would be stored in an IteratorResult, an ordinary object, which the caller keeps past the generator's count of it.",
        "delegates.ts(63,36): error TS96032: A value of type 'Node' cannot be yielded, or returned by a generator: it would be stored in an IteratorResult, an ordinary object, which the caller keeps past the generator's count of it.",
        "delegates.ts(67,49): error TS96032: A value of type 'Node' cannot be yielded, or returned by a generator: it would be stored in an IteratorResult, an ordinary object, which the caller keeps past the generator's count of it.",
        "delegates.ts(74,48): error TS96032: A value of type 'Node' cannot be yielded, or returned by a generator: it would be stored in an IteratorResult, an ordinary object, which the caller keeps past the generator's count of it.",
        "delegates.ts(78,7): error TS96021: A value of type 'Node' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
        "delegates.ts(79,13): error TS96021: A value of type 'Node' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
        "delegates.ts(84,45): error TS96032: A value of type 'Node' cannot be yielded, or returned by a generator: it would be stored in an IteratorResult, an ordinary object, which the caller keeps past the generator's count of it.",
        "delegates.ts(88,13): error TS96021: A value of type 'Node' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
        "delegates.ts(89,18): error TS96021: A value of type 'Node' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
        "delegates.ts(89,65): error TS96021: A value of type 'Node' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
        "delegates.ts(90,16): error TS96021: A value of type 'Node' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
        "delegates.ts(90,71): error TS96021: A value of type 'Node' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
        "delegates.ts(91,17): error TS96021: A value of type 'Node' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
        "delegates.ts(100,17): error TS96021: A value of type 'Node' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
        "delegates.ts(101,22): error TS96021: A value of type 'Node' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
        "delegates.ts(115,7): error TS96021: A value of type 'Node' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
        "delegates.ts(128,14): error TS96021: A value of type '[string, number | ({ x: number; } & Cell)]' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
        "delegates.ts(130,86): error TS96032: A value of type '[string, number | ({ x: number; } & Cell)]' cannot be yielded, or returned by a generator: it would be stored in an IteratorResult, an ordinary object, which the caller keeps past the generator's count of it.",
      ].sort(),
    );
  });

  it('sees a send in a try block that leaves early, in its catch and finally', () => {
    // the fork starts a catch or a finally from the try block's entry when the
    // block ends in a return, a throw or a break, forgetting a send in it, and
    // takes a break or continue to its target before the finally it crosses
    const dir = join(checker, 'test/diverging/try-exits');
    expect(
      check(join(dir, 'tsconfig.json'), {runtime: 'threads', api})
        .map(d => formatDiagnostic(d, dir))
        .sort(),
    ).toEqual(
      [
        "try-exits.ts(9,46): error TS96001: 'xs' cannot be used here: it was sent to 'send' on line 9.",
        "try-exits.ts(87,69): error TS96006: 'xs' may have been consumed by 'consume' on line 87.",
        "try-exits.ts(91,70): error TS96006: 'xs' may have been consumed by 'consume' on line 91.",
        "try-exits.ts(100,65): error TS96006: 'xs' may have been consumed by 'consume' on line 100.",
        "try-exits.ts(13,58): error TS96002: 'xs' cannot be used here: it may have been sent to 'send' on line 13.",
        "try-exits.ts(17,56): error TS96001: 'xs' cannot be used here: it was sent to 'send' on line 17.",
        "try-exits.ts(22,7): error TS96002: 'xs' cannot be used here: it may have been sent to 'send' on line 21.",
        "try-exits.ts(39,19): error TS96001: 'xs' cannot be used here: it was sent to 'send' on line 38.",
        "try-exits.ts(44,7): error TS96001: 'xs' cannot be used here: it was sent to 'send' on line 43.",
        "try-exits.ts(61,7): error TS96001: 'xs' cannot be used here: it was sent to 'send' on line 59.",
        "try-exits.ts(65,54): error TS96002: 'xs' cannot be used here: it may have been sent to 'send' on line 65.",
        "try-exits.ts(66,7): error TS96002: 'xs' cannot be used here: it may have been sent to 'send' on line 65.",
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
