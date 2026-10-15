// threads-check on the programs of test/cases: each reports what
// test/expected/cases-<name>.txt says, which `vp run compare --update` writes
// from the tsgo fork's `own check` (compare.ts compares with the fork itself
// when it is there).
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, describe, expect, it} from 'vite-plus/test';
import {API, check, formatDiagnostic} from './index.ts';

const checker = fileURLToPath(new URL('.', import.meta.url));
const cases = join(checker, 'test/cases');
const api = new API({cwd: checker});
afterAll(() => api.close());

const lines = (text: string) => text.split('\n').filter(l => l !== '');
const LAID_OUT =
  "A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.";
const YIELDED =
  "A value of type 'Node & Cell' cannot be yielded, or returned by a generator: it would be stored in an IteratorResult, an ordinary object, which the caller keeps past the generator's count of it.";

describe('threads-check', () => {
  it('refuses a runtime no file imports: a mistyped --runtime', () => {
    expect(() =>
      check(join(cases, 'channels/tsconfig.json'), {runtime: 'thread', api}),
    ).toThrow(/no file of the project imports the runtime as 'thread'/);
  });

  it('reports a tsconfig that names no files, as tsc does', () => {
    const tsconfig = join(
      checker,
      'test/config-errors/no-inputs/tsconfig.json',
    );
    expect(
      check(tsconfig, {runtime: 'threads', api}).map(d => formatDiagnostic(d)),
    ).toEqual([
      `error TS18003: No inputs were found in config file '${tsconfig}'. Specified 'include' paths were '["src/**/*.ts"]' and 'exclude' paths were '[]'.`,
    ]);
  });

  it('reports a tsconfig that does not parse where it does not, and checks nothing', () => {
    // the lenient parse reads the program and its paths past the missing
    // comma: send.ts uses what it sent, which a valid tsconfig reports
    const dir = join(checker, 'test/config-errors/malformed');
    expect(
      check(join(dir, 'tsconfig.json'), {runtime: 'threads', api}).map(d =>
        formatDiagnostic(d, dir),
      ),
    ).toEqual(["tsconfig.json(9,5): error TS1005: ',' expected."]);
  });

  it('analyzes a finally once for each way in, however deep it is nested', () => {
    // a finally runs for each state it may be reached with, and runs that
    // start alike are one, what the try's block declares, and the regions
    // only that held, aside: 20 finallies nested in each other's are not
    // 2 ** 20 runs of the innermost
    const depth = 20;
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nested-finallies-')));
    try {
      const program = [
        'import { Channel, consume } from "threads";',
        'declare function use(...values: unknown[]): void;',
        'export function nested(ch: Channel<number[]>) {',
        '  const xs = [1];',
        ...Array.from(
          {length: depth},
          () =>
            'try { use(1); const local = [[]]; const deep = { a: [1], b: { c: [2] } }; const alias = [xs]; const gone = [1]; consume(gone); } finally {',
        ),
        'ch.send(xs); use(xs);',
        ...Array.from({length: depth}, () => '}'),
        '}',
      ];
      writeFileSync(join(dir, 'nested.ts'), program.join('\n') + '\n');
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'es2022',
            module: 'esnext',
            moduleResolution: 'bundler',
            strict: true,
            lib: ['es2022'],
            noEmit: true,
            paths: {threads: [join(checker, '../runtime/threads.d.ts')]},
          },
          include: ['*.ts'],
        }),
      );
      const start = performance.now();
      const diagnostics = check(join(dir, 'tsconfig.json'), {
        runtime: 'threads',
        api,
      }).map(d => formatDiagnostic(d, dir));
      expect(performance.now() - start).toBeLessThan(2000);
      const line = depth + 5;
      expect(diagnostics).toEqual([
        `nested.ts(${line},18): error TS96001: 'xs' cannot be used here: it was sent to 'send' on line ${line}.`,
      ]);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
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
    // by: an import alias, or a const that holds it, defeats it there. a field
    // marker or an atomic operation read by element access is the runtime's
    // as one read by its property is
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
        "alias.ts(38,73): error TS96036: Field 'n' is marked i32 but typed 'number': its values are stored as its marker says and checked as its type says, so type it 'i32' or mark it f64.",
        'alias.ts(41,3): error TS96028: An atomic operation takes an i32 field of a shared struct, named by a string literal, or an element of a SharedArray<i32>.',
        'alias.ts(42,3): error TS96028: An atomic operation takes an i32 field of a shared struct, named by a string literal, or an element of a SharedArray<i32>.',
        'alias.ts(49,3): error TS96028: An atomic operation takes an i32 field of a shared struct, named by a string literal, or an element of a SharedArray<i32>.',
        'alias.ts(50,3): error TS96028: An atomic operation takes an i32 field of a shared struct, named by a string literal, or an element of a SharedArray<i32>.',
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
    // takes a break or continue to its target before the finally it crosses.
    // it goes on after a finally from the block's entry too, so a send in a
    // block that completes is one that may have been made. a throw no call
    // makes (a getter's, an operator's, a setter's, an iterator's, a
    // disposal's) is taken to come where it may, after what was evaluated
    // before it: in the finally, a send in the block is one that may have
    // been made
    const dir = join(checker, 'test/diverging/try-exits');
    expect(
      check(join(dir, 'tsconfig.json'), {runtime: 'threads', api})
        .map(d => formatDiagnostic(d, dir))
        .sort(),
    ).toEqual(
      [
        "try-exits.ts(9,46): error TS96002: 'xs' cannot be used here: it may have been sent to 'send' on line 9.",
        "try-exits.ts(87,69): error TS96006: 'xs' may have been consumed by 'consume' on line 87.",
        "try-exits.ts(91,70): error TS96006: 'xs' may have been consumed by 'consume' on line 91.",
        "try-exits.ts(100,65): error TS96006: 'xs' may have been consumed by 'consume' on line 100.",
        "try-exits.ts(13,58): error TS96002: 'xs' cannot be used here: it may have been sent to 'send' on line 13.",
        "try-exits.ts(17,56): error TS96002: 'xs' cannot be used here: it may have been sent to 'send' on line 17.",
        "try-exits.ts(22,7): error TS96002: 'xs' cannot be used here: it may have been sent to 'send' on line 21.",
        "try-exits.ts(39,19): error TS96002: 'xs' cannot be used here: it may have been sent to 'send' on line 38.",
        "try-exits.ts(44,7): error TS96001: 'xs' cannot be used here: it was sent to 'send' on line 43.",
        "try-exits.ts(61,7): error TS96001: 'xs' cannot be used here: it was sent to 'send' on line 59.",
        "try-exits.ts(65,54): error TS96002: 'xs' cannot be used here: it may have been sent to 'send' on line 65.",
        "try-exits.ts(66,7): error TS96002: 'xs' cannot be used here: it may have been sent to 'send' on line 65.",
        "try-exits.ts(107,7): error TS96001: 'xs' cannot be used here: it was sent to 'send' on line 106.",
        "try-exits.ts(112,7): error TS96001: 'xs' cannot be used here: it was sent to 'send' on line 111.",
        "try-exits.ts(119,69): error TS96001: 'xs' cannot be used here: it was sent to 'send' on line 119.",
        "try-exits.ts(123,65): error TS96001: 'xs' cannot be used here: it was sent to 'send' on line 123.",
        "try-exits.ts(129,54): error TS96001: 'xs' cannot be used here: it was sent to 'send' on line 128.",
        "try-exits.ts(137,7): error TS96002: 'xs' cannot be used here: it may have been sent to 'send' on line 135.",
        "try-exits.ts(144,19): error TS96002: 'xs' cannot be used here: it may have been sent to 'send' on line 141.",
        "try-exits.ts(149,67): error TS96005: 'xs' was consumed by 'consume' on line 149.",
        "try-exits.ts(153,86): error TS96005: 'xs' was consumed by 'consume' on line 153.",
        "try-exits.ts(157,57): error TS96006: 'xs' may have been consumed by 'consume' on line 157.",
        "try-exits.ts(181,72): error TS96006: 'xs' may have been consumed by 'consume' on line 181.",
        "try-exits.ts(185,71): error TS96006: 'xs' may have been consumed by 'consume' on line 185.",
        "try-exits.ts(189,68): error TS96006: 'xs' may have been consumed by 'consume' on line 189.",
        "try-exits.ts(193,65): error TS96005: 'xs' was consumed by 'consume' on line 193.",
        "try-exits.ts(197,69): error TS96006: 'xs' may have been consumed by 'consume' on line 197.",
        "try-exits.ts(201,73): error TS96006: 'xs' may have been consumed by 'consume' on line 201.",
        "try-exits.ts(205,66): error TS96006: 'xs' may have been consumed by 'consume' on line 205.",
        "try-exits.ts(209,68): error TS96006: 'xs' may have been consumed by 'consume' on line 209.",
        "try-exits.ts(213,65): error TS96006: 'xs' may have been consumed by 'consume' on line 213.",
        "try-exits.ts(217,62): error TS96006: 'xs' may have been consumed by 'consume' on line 217.",
        "try-exits.ts(221,71): error TS96006: 'xs' may have been consumed by 'consume' on line 221.",
        "try-exits.ts(225,85): error TS96006: 'xs' may have been consumed by 'consume' on line 225.",
        "try-exits.ts(229,92): error TS96005: 'xs' was consumed by 'consume' on line 229.",
        "try-exits.ts(233,75): error TS96006: 'xs' may have been consumed by 'consume' on line 233.",
        "try-exits.ts(237,79): error TS96005: 'xs' was consumed by 'consume' on line 237.",
        "try-exits.ts(242,73): error TS96006: 'xs' may have been consumed by 'consume' on line 242.",
        "try-exits.ts(248,111): error TS96006: 'xs' may have been consumed by 'consume' on line 248.",
        "try-exits.ts(252,102): error TS96006: 'xs' may have been consumed by 'consume' on line 252.",
        "try-exits.ts(265,73): error TS96005: 'xs' was consumed by 'consume' on line 265.",
        "try-exits.ts(269,75): error TS96006: 'xs' may have been consumed by 'consume' on line 269.",
        "try-exits.ts(273,3): error TS96005: 'ys' was consumed by 'consume' on line 273.",
        "try-exits.ts(277,4): error TS96005: 'ys' was consumed by 'consume' on line 277.",
        "try-exits.ts(282,7): error TS96005: 'zs' was consumed by 'consume' on line 281.",
        "try-exits.ts(287,3): error TS96001: 'box' cannot be used here: it was sent to 'send' on line 287.",
        "try-exits.ts(304,4): error TS96010: Cannot change 'frozen': it is a shared value, which is immutable.",
        "try-exits.ts(308,3): error TS96006: 'xs' may have been consumed by 'consume' on line 308.",
        "try-exits.ts(314,87): error TS96002: 'row' cannot be used here: it may have been sent to 'send' on line 314.",
        "try-exits.ts(324,3): error TS96006: 'xs' may have been consumed by 'consume' on line 324.",
        "try-exits.ts(328,3): error TS96006: 'box' may have been consumed by 'consume' on line 328.",
        "try-exits.ts(333,72): error TS96006: 'xs' may have been consumed by 'consume' on line 333.",
        "try-exits.ts(337,85): error TS96005: 'xs' was consumed by 'consume' on line 337.",
        "try-exits.ts(341,86): error TS96001: 'ys' cannot be used here: it was sent to 'send' on line 341.",
        "try-exits.ts(345,7): error TS96001: 'ys' cannot be used here: it was sent to 'send' on line 344.",
        "try-exits.ts(350,46): error TS96002: 'row' cannot be used here: it may have been sent to 'send' on line 350.",
        "try-exits.ts(357,87): error TS96006: 'xs' may have been consumed by 'consume' on line 357.",
        "try-exits.ts(369,80): error TS96006: 'xs' may have been consumed by 'consume' on line 369.",
        "try-exits.ts(374,87): error TS96005: 'xs' was consumed by 'consume' on line 374.",
        "try-exits.ts(378,104): error TS96006: 'xs' may have been consumed by 'consume' on line 378.",
        "try-exits.ts(383,3): error TS96001: 'box' cannot be used here: it was sent to 'send' on line 383.",
        "try-exits.ts(389,64): error TS96005: 'xs' was consumed by 'consume' on line 389.",
        "try-exits.ts(393,93): error TS96005: 'xs' was consumed by 'consume' on line 393.",
        "try-exits.ts(398,93): error TS96006: 'xs' may have been consumed by 'consume' on line 398.",
        "try-exits.ts(409,100): error TS96006: 'xs' may have been consumed by 'consume' on line 409.",
        "try-exits.ts(418,95): error TS96006: 'xs' may have been consumed by 'consume' on line 418.",
        "try-exits.ts(430,10): error TS96003: 'C' cannot be used here: it shares objects with 'xs', which was sent to 'send' on line 429.",
        "try-exits.ts(442,70): error TS96006: 'xs' may have been consumed by 'consume' on line 442.",
        "try-exits.ts(455,10): error TS96003: 'Derived' cannot be used here: it shares objects with 'xs', which was sent to 'send' on line 454.",
        "try-exits.ts(459,24): error TS96001: 'xs' cannot be used here: it was sent to 'send' on line 461.",
        "try-exits.ts(462,14): error TS96003: 'Derived' cannot be used here: it shares objects with 'xs', which was sent to 'send' on line 461.",
        "try-exits.ts(469,10): error TS96003: 'C' cannot be used here: it shares objects with 'xs', which was sent to 'send' on line 468.",
        "try-exits.ts(475,10): error TS96003: 'K' cannot be used here: it shares objects with 'xs', which was sent to 'send' on line 474.",
        "try-exits.ts(495,7): error TS96003: 'b' cannot be used here: it shares objects with 'a.items', which was sent to 'send' on line 494.",
        "try-exits.ts(501,23): error TS96001: 'xs' cannot be used here: it was sent to 'send' on line 502.",
        "try-exits.ts(503,14): error TS96003: 'C' cannot be used here: it shares objects with 'xs', which was sent to 'send' on line 502.",
        "try-exits.ts(515,11): error TS96007: 'new K().items' cannot be sent: it may be referenced by the caller. Declare the parameter 'Sending<T>' to take ownership.",
        "try-exits.ts(524,14): error TS96003: 'C' cannot be used here: it shares objects with 'xs', which was sent to 'send' on line 523.",
        "try-exits.ts(531,7): error TS96003: 'b' cannot be used here: it shares objects with 'a.items', which was sent to 'send' on line 530.",
        "try-exits.ts(537,36): error TS96001: 'xs' cannot be used here: it was sent to 'send' on line 539.",
        "try-exits.ts(540,14): error TS96003: 'Derived' cannot be used here: it shares objects with 'xs', which was sent to 'send' on line 539.",
        "try-exits.ts(546,21): error TS96001: 'xs' cannot be used here: it was sent to 'send' on line 550.",
        "try-exits.ts(551,14): error TS96003: 'C' cannot be used here: it shares objects with 'xs', which was sent to 'send' on line 550.",
        "try-exits.ts(558,67): error TS96007: 'new K().items' cannot be sent: it may be referenced by the caller. Declare the parameter 'Sending<T>' to take ownership.",
        "try-exits.ts(565,7): error TS96003: 'b' cannot be used here: it shares objects with 'a.items', which was sent to 'send' on line 564.",
        "try-exits.ts(573,7): error TS96003: 'b' cannot be used here: it shares objects with 'a.items', which was sent to 'send' on line 572.",
        "try-exits.ts(579,11): error TS96007: 'new K().items' cannot be sent: it may be referenced by the caller. Declare the parameter 'Sending<T>' to take ownership.",
      ].sort(),
    );
  });

  it('refuses a struct used as a struct of another layout', () => {
    // TypeScript relates struct types by their members; a struct's fields are
    // read at their places. the fork does not compare layouts
    const dir = join(checker, 'test/diverging/struct-layouts');
    expect(
      check(join(dir, 'tsconfig.json'), {runtime: 'threads', api})
        .map(d => formatDiagnostic(d, dir))
        .sort(),
    ).toEqual(
      [
        "layouts.ts(26,41): error TS96033: A value of type 'Child & Cell' cannot be used as 'Node': field 'value' is at place 1 of 'Child' and 0 of 'Node'. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(28,39): error TS96033: A value of type 'Child & Cell' cannot be used as 'Node': field 'value' is at place 1 of 'Child' and 0 of 'Node'. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(29,46): error TS96033: A value of type 'Child & Cell' cannot be used as 'Node': field 'value' is at place 1 of 'Child' and 0 of 'Node'. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(30,64): error TS96033: A value of type 'Child & Cell' cannot be used as 'Node': field 'value' is at place 1 of 'Child' and 0 of 'Node'. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(31,39): error TS96033: A value of type 'B & Cell' cannot be used as 'A': field 'x' is at place 1 of 'B' and 0 of 'A'. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(32,41): error TS96033: A value of type 'Index & Cell' cannot be used as 'Count': field 'n' is of another kind in 'Index' than in 'Count'. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(33,54): error TS96033: A value of type 'SharedArray<Child & Cell, \"other\">' cannot be used as 'SharedArray<Node, \"other\">': the elements are 'Child' structs, which 'Node' structs, of another layout or size, cannot stand for. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(34,53): error TS96033: A value of type 'Child' cannot be used as 'Node | null': field 'value' is at place 1 of 'Child' and 0 of 'Node'. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(41,48): error TS96033: A value of type 'Node' cannot be used as 'Child': 'Node' has no field 'extra'. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(44,69): error TS96033: A value of type 'SharedArray<Child & Cell, \"other\">' cannot be used as 'SharedArray<Node, \"other\"> | null': the elements are 'Child' structs, which 'Node' structs, of another layout or size, cannot stand for. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(47,20): error TS96034: 'Twice' is declared a shared struct again, laid out otherwise: [b: f64, a: f64] here, [a: f64, b: f64] at its other declaration. The checker reads a struct type's values by one layout, so a type has one; declare the other as a type of its own.",
        "layouts.ts(72,43): error TS96033: A value of type 'ChildBox & Cell' cannot be used as 'NodeBox': field 'item' of 'ChildBox' refers to what that of 'NodeBox' cannot stand for: field 'value' is at place 1 of 'Child' and 0 of 'Node'. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(77,51): error TS96033: A value of type '{ (x: string): Child; (x: number): Node; }' cannot be used as '(x: string) => Node': what it returns: field 'value' is at place 1 of 'Child' and 0 of 'Node'. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(81,53): error TS96033: A value of type '() => () => () => () => Child' cannot be used as '() => () => () => () => Node': what it returns: what it returns: what it returns: what it returns: field 'value' is at place 1 of 'Child' and 0 of 'Node'. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(84,17): error TS96034: 'Measure' is declared a shared struct again, laid out otherwise: [n: f64] here, [n: i32] at its other declaration. The checker reads a struct type's values by one layout, so a type has one; declare the other as a type of its own.",
        "layouts.ts(85,40): error TS96036: Field 'n' is marked i32 but typed 'number': its values are stored as its marker says and checked as its type says, so type it 'i32' or mark it f64.",
        "layouts.ts(52,81): error TS96033: A value of type 'SharedArray<Child & Cell, \"other\">' cannot be used as 'SharedArray<number, \"other\"> | SharedArray<Node, \"other\">': the elements are 'Child' structs, which 'Node' structs, of another layout or size, cannot stand for. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(59,37): error TS96033: A value of type '() => Child & Cell' cannot be used as '() => Node': what it returns: field 'value' is at place 1 of 'Child' and 0 of 'Node'. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(61,48): error TS96033: A value of type '(n: Node) => number' cannot be used as '(c: Child) => number': what it is called with, parameter 1: field 'value' is at place 1 of 'Child' and 0 of 'Node'. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(64,43): error TS96033: A value of type '() => Child & Cell' cannot be used as '() => Node': what it returns: field 'value' is at place 1 of 'Child' and 0 of 'Node'. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(89,29): error TS96033: A value of type '0 | Child' cannot be used as 'Node': field 'value' is at place 1 of 'Child' and 0 of 'Node'. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(92,34): error TS96033: A value of type '(() => Child) | (() => Node)' cannot be used as '() => Node': what it returns: field 'value' is at place 1 of 'Child' and 0 of 'Node'. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(96,43): error TS96033: A value of type '() => Promise<Child>' cannot be used as '() => Promise<Node>': what it returns: what it resolves to: field 'value' is at place 1 of 'Child' and 0 of 'Node'. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(97,40): error TS96033: A value of type 'Promise<Child>' cannot be used as 'Promise<Node>': what it resolves to: field 'value' is at place 1 of 'Child' and 0 of 'Node'. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(102,65): error TS96033: A value of type 'Child & Cell' cannot be used as 'Node': field 'value' is at place 1 of 'Child' and 0 of 'Node'. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
        "layouts.ts(104,39): error TS96033: A value of type 'StructType<Child>' cannot be used as 'StructType<Node>': what it constructs: field 'value' is at place 1 of 'Child' and 0 of 'Node'. A shared struct's fields are read and written by their place, so a struct used as another must lay out that one's fields first, in its order and of its kinds.",
      ].sort(),
    );
  });

  it('checks what a spread argument passes', () => {
    // a tuple's values go into the parameters from the spread's place on, an
    // array's into the rest; the fork does not check them
    const dir = join(checker, 'test/diverging/spread-arguments');
    expect(
      check(join(dir, 'tsconfig.json'), {runtime: 'threads', api})
        .map(d => formatDiagnostic(d, dir))
        .sort(),
    ).toEqual(
      [
        'spreads.ts(14,8): error TS96029: This value may not be an integer, which an i32 would truncate silently: convert it explicitly, as with Math.round(), Math.trunc() or | 0.',
        'spreads.ts(15,11): error TS96029: This value may not be an integer, which an i32 would truncate silently: convert it explicitly, as with Math.round(), Math.trunc() or | 0.',
        'spreads.ts(20,18): error TS96029: This value may not be an integer, which an i32 would truncate silently: convert it explicitly, as with Math.round(), Math.trunc() or | 0.',
        'spreads.ts(31,18): error TS96029: This value may not be an integer, which an i32 would truncate silently: convert it explicitly, as with Math.round(), Math.trunc() or | 0.',
        'spreads.ts(33,17): error TS96029: This value may not be an integer, which an i32 would truncate silently: convert it explicitly, as with Math.round(), Math.trunc() or | 0.',
        'spreads.ts(34,35): error TS96029: This value may not be an integer, which an i32 would truncate silently: convert it explicitly, as with Math.round(), Math.trunc() or | 0.',
        "spreads.ts(43,7): error TS96001: 'xs' cannot be used here: it was sent to 'sendFirst' on line 42.",
        'spreads.ts(58,16): error TS96029: This value may not be an integer, which an i32 would truncate silently: convert it explicitly, as with Math.round(), Math.trunc() or | 0.',
        'spreads.ts(77,12): error TS96029: This value may not be an integer, which an i32 would truncate silently: convert it explicitly, as with Math.round(), Math.trunc() or | 0.',
        'spreads.ts(83,11): error TS96029: This value may not be an integer, which an i32 would truncate silently: convert it explicitly, as with Math.round(), Math.trunc() or | 0.',
        'spreads.ts(88,40): error TS96029: This value may not be an integer, which an i32 would truncate silently: convert it explicitly, as with Math.round(), Math.trunc() or | 0.',
        'spreads.ts(93,13): error TS96029: This value may not be an integer, which an i32 would truncate silently: convert it explicitly, as with Math.round(), Math.trunc() or | 0.',
        'spreads.ts(102,11): error TS96029: This value may not be an integer, which an i32 would truncate silently: convert it explicitly, as with Math.round(), Math.trunc() or | 0.',
        'spreads.ts(103,15): error TS96029: This value may not be an integer, which an i32 would truncate silently: convert it explicitly, as with Math.round(), Math.trunc() or | 0.',
        'spreads.ts(104,16): error TS96029: This value may not be an integer, which an i32 would truncate silently: convert it explicitly, as with Math.round(), Math.trunc() or | 0.',
      ].sort(),
    );
  });

  it('refuses an ordinary object where a struct goes', () => {
    // TypeScript takes an object literal, or an instance of a class, for a
    // struct type declared with an interface, by its members, and a cast for
    // any struct type; the place holds an address, which the runtime cannot
    // make of the object. so does a function's result, or a promise's, taken
    // for one. the fork lets them through
    const dir = join(checker, 'test/diverging/ordinary-objects');
    const notAStruct = (
      at: string,
      type: string,
      place: string,
      make: string,
    ) =>
      `objects.ts(${at}): error TS96035: A value of type '${type}' cannot be used as '${place}': it is an ordinary object, not a shared struct, which 'new ${make}()' makes.`;
    const literal = '{ value: number; next: null; }';
    expect(
      check(join(dir, 'tsconfig.json'), {runtime: 'threads', api})
        .map(d => formatDiagnostic(d, dir))
        .sort(),
    ).toEqual(
      [
        notAStruct('18,46', literal, 'Node', 'Node'),
        notAStruct('19,43', literal, 'Node', 'Node'),
        notAStruct('20,46', 'Plain', 'Node', 'Node'),
        notAStruct('21,44', literal, 'Node | null', 'Node'),
        notAStruct('23,41', literal, 'Node', 'Node'),
        notAStruct('24,51', literal, 'Node', 'Node'),
        notAStruct('25,37', literal, 'Node', 'Node'),
        notAStruct('26,33', '{ x: number; }', '{ x: number; } & Cell', 'Point'),
        notAStruct('27,37', literal, 'Node', 'Node'),
        notAStruct('28,61', literal, 'Node', 'Node'),
        notAStruct('29,64', 'Plain', 'Node | null', 'Node'),
        notAStruct(
          '39,65',
          literal,
          'Node | SharedArray<number, "other">',
          'Node',
        ),
        notAStruct('42,64', literal, 'Node', 'Node'),
        `objects.ts(45,33): error TS96033: A value of type '() => ${literal}' cannot be used as '() => Node': what it returns: '${literal}' is an ordinary object, not a shared struct. ${LAID_OUT}`,
        `objects.ts(47,43): error TS96033: A value of type '() => Promise<${literal}>' cannot be used as '() => Promise<Node>': what it returns: what it resolves to: '${literal}' is an ordinary object, not a shared struct. ${LAID_OUT}`,
        notAStruct('54,28', 'IntegerField<i32, "i32">', 'Tag', 'Tag'),
        `objects.ts(57,59): error TS96033: A value of type '() => SharedArray<Node, "other"> | ${literal}' cannot be used as '() => Node | SharedArray<Node, "other">': what it returns: '${literal}' is an ordinary object, not a shared struct. ${LAID_OUT}`,
        "objects.ts(60,46): error TS96035: A value of type '{ readonly value: 1; readonly next: null; }' cannot be used as 'Node': it is an ordinary object, not a shared struct, which 'new Node()' makes.",
        "objects.ts(63,37): error TS96035: A value of type '{ value: number; next: null; }' cannot be used as 'Node': it is an ordinary object, not a shared struct, which 'new Node()' makes.",
        "objects.ts(65,41): error TS96035: A value of type '{ value: number; next: null; }' cannot be used as 'Node': it is an ordinary object, not a shared struct, which 'new Node()' makes.",
        "objects.ts(67,51): error TS96035: A value of type '{ value: number; next: null; }' cannot be used as 'Node': it is an ordinary object, not a shared struct, which 'new Node()' makes.",
        "objects.ts(71,35): error TS96035: A value of type '{ value: number; next: null; }' cannot be used as 'Node | undefined': it is an ordinary object, not a shared struct, which 'new Node()' makes.",
        "objects.ts(74,51): error TS96035: A value of type '{ value: number; next: null; }' cannot be used as 'Node | undefined': it is an ordinary object, not a shared struct, which 'new Node()' makes.",
        "objects.ts(74,54): error TS96021: A value of type 'Node' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle.",
      ].sort(),
    );
  });

  it('refuses a number field whose marker and type disagree', () => {
    // TypeScript takes an i32 marker for a number field and an f64 one for an
    // i32 field; the runtime lays the field out by its marker, the checker
    // checks the integers stored into it by its type. a marker typed a Field
    // of a number is followed to the runtime's own, else refused. the fork
    // does not compare them
    const dir = join(checker, 'test/diverging/field-markers');
    expect(
      check(join(dir, 'tsconfig.json'), {runtime: 'threads', api})
        .map(d => formatDiagnostic(d, dir))
        .sort(),
    ).toEqual(
      [
        "markers.ts(10,31): error TS96036: Field 'n' is marked i32 but typed 'number': its values are stored as its marker says and checked as its type says, so type it 'i32' or mark it f64.",
        "markers.ts(12,33): error TS96036: Field 'n' is marked f64 but typed 'i32': its values are stored as its marker says and checked as its type says, so type it 'number' or mark it i32.",
        "markers.ts(14,29): error TS96036: Field 'n' is marked u8 but typed 'i32': its values are stored as its marker says and checked as its type says, so type it 'u8' or mark it i32.",
        "markers.ts(22,39): error TS96036: Field 'n' is marked u8 but typed 'i32': its values are stored as its marker says and checked as its type says, so type it 'u8' or mark it i32.",
        "markers.ts(28,33): error TS96036: Field 'n' is marked i32 but typed 'number': its values are stored as its marker says and checked as its type says, so type it 'i32' or mark it f64.",
        "markers.ts(31,35): error TS96038: Field 'n' is marked with a value whose kind the checker cannot tell: a Field of a number may be an f64, an i32 or a u8. Mark it with one of them, or with a const that holds one.",
        "markers.ts(40,43): error TS96036: Field 'n' is marked i32 but typed 'number': its values are stored as its marker says and checked as its type says, so type it 'i32' or mark it f64.",
      ].sort(),
    );
  });

  it('refuses recvOk in an async function, as it does recv', () => {
    // the fork's table of blocking calls has no recvOk: an async function
    // waits with recvOkAsync, and a plain one may block
    const dir = join(checker, 'test/diverging/recv-ok');
    expect(
      check(join(dir, 'tsconfig.json'), {runtime: 'threads', api}).map(d =>
        formatDiagnostic(d, dir),
      ),
    ).toEqual([
      "recv-ok.ts(6,20): error TS96030: 'recvOk' blocks its thread, and with it every async function waiting on the same worker: in an async function, use 'recvOkAsync'.",
    ]);
  });

  it('refuses a Thread or a Scope sent to another thread or shared', () => {
    // neither is a cell: the runtime refuses to send or share one, and the
    // fork, for which both were cells, says nothing. no field holds one, which
    // the fork reports too. a spread tuple's elements after the function go to
    // the Sending arguments, so a tuple declared outside is one that cannot be
    // sent
    const dir = join(checker, 'test/diverging/threads-stay');
    const thread =
      "error TS96037: A value of type 'Thread<number>' cannot be sent to another thread or shared: it stays on the thread that made it, which joins it.";
    const scope =
      "error TS96037: A value of type 'Scope' cannot be sent to another thread or shared: it stays on the thread that made it, which spawns on it in its body.";
    expect(
      check(join(dir, 'tsconfig.json'), {runtime: 'threads', api})
        .map(d => formatDiagnostic(d, dir))
        .sort(),
    ).toEqual(
      [
        `threads.ts(13,17): ${thread}`,
        `threads.ts(14,18): ${scope}`,
        `threads.ts(15,14): ${thread}`,
        `threads.ts(16,11): ${thread}`,
        `threads.ts(17,14): ${thread}`,
        `threads.ts(18,9): ${thread}`,
        `threads.ts(19,9): ${thread}`,
        `threads.ts(20,9): ${thread}`,
        'threads.ts(24,33): error TS96015: A shared struct field must be a number, a boolean, a string, a shared struct, a SharedArray or a Channel.',
        // from the review: a constraint, an intersection, a map's or a set's
        // entries, a map's computed value, and spread tuples
        `threads.ts(36,9): ${thread}`,
        `threads.ts(37,9): ${scope}`,
        `threads.ts(40,9): ${thread}`,
        `threads.ts(41,9): ${scope}`,
        `threads.ts(44,17): ${thread}`,
        `threads.ts(45,17): ${thread}`,
        `threads.ts(46,30): ${thread}`,
        `threads.ts(53,12): ${thread}`,
        `threads.ts(54,9): ${thread}`,
        `threads.ts(55,14): ${scope}`,
        "threads.ts(53,12): error TS96008: 'toSpawn' cannot be sent: it is captured from an outer scope.",
        "threads.ts(54,9): error TS96008: 'toGo' cannot be sent: it is captured from an outer scope.",
        "threads.ts(55,14): error TS96008: 'toScope' cannot be sent: it is captured from an outer scope.",
        `threads.ts(56,20): ${thread}`,
        // from the second review: interfaces that extend a Thread or a Scope
        // (and not an iterable's own properties, line 69)
        "threads.ts(64,9): error TS96037: A value of type 'LocalThread' cannot be sent to another thread or shared: it stays on the thread that made it, which joins it.",
        "threads.ts(65,9): error TS96037: A value of type 'LocalScope' cannot be sent to another thread or shared: it stays on the thread that made it, which spawns on it in its body.",
        // from the third review: mapped views, the overload a callback is
        // called by (not line 83's), and a union of tuples spread
        "threads.ts(76,9): error TS96037: A value of type 'Readonly<Thread<number>>' cannot be sent to another thread or shared: it stays on the thread that made it, which joins it.",
        "threads.ts(77,9): error TS96037: A value of type 'Readonly<Scope>' cannot be sent to another thread or shared: it stays on the thread that made it, which spawns on it in its body.",
        "threads.ts(78,9): error TS96037: A value of type 'Partial<Thread<number>>' cannot be sent to another thread or shared: it stays on the thread that made it, which joins it.",
        `threads.ts(84,30): ${thread}`,
        `threads.ts(88,18): ${thread}`,
        // from the fourth review: views of a constrained type parameter, of an
        // intersection and Shared<T>'s (and not line 105's, which makes
        // booleans of a Thread's properties)
        "threads.ts(96,9): error TS96037: A value of type 'Readonly<T>' cannot be sent to another thread or shared: it stays on the thread that made it, which joins it.",
        "threads.ts(97,9): error TS96037: A value of type 'Readonly<S>' cannot be sent to another thread or shared: it stays on the thread that made it, which spawns on it in its body.",
        "threads.ts(100,9): error TS96037: A value of type 'Readonly<Thread<number> & { tag: number; }>' cannot be sent to another thread or shared: it stays on the thread that made it, which joins it.",
        "threads.ts(101,9): error TS96037: A value of type 'Partial<Scope & { tag: number; }>' cannot be sent to another thread or shared: it stays on the thread that made it, which spawns on it in its body.",
        "threads.ts(102,9): error TS96037: A value of type '{ readonly join: () => number; readonly joinAsync: () => Promise<number>; }' cannot be sent to another thread or shared: it stays on the thread that made it, which joins it.",
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
