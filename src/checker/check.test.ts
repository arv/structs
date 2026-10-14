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

  it('refuses a Thread or a Scope sent to another thread or shared', () => {
    // neither is a cell: the runtime refuses to send or share one, and the
    // fork, for which both were cells, says nothing. no field holds one, which
    // the fork reports too
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

  it("reports no blocking call on a Channel that is not the runtime's", () => {
    const dir = join(checker, 'test/diverging/ambient-channel');
    expect(
      check(join(dir, 'tsconfig.json'), {runtime: 'threads', api}).map(d =>
        formatDiagnostic(d, dir),
      ),
    ).toEqual([]);
  });
});
