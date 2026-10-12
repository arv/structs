// expand.ts: the access macros of a hand translation, as a publish-on-escape
// transform would emit them.
import {describe, expect, it} from 'vite-plus/test';
import {expand} from './expand.ts';

const body = (src: string, options = {}) =>
  expand(src, {runtime: '/rt/runtime.ts', ...options})
    .split('\n')
    .slice(2) // the runtime's import, and the poll word
    .join('\n')
    .trim();

describe('expand', () => {
  it('reads and writes a named property as plain JS', () => {
    expect(body('const a = $G(o, x); $S(o, y, 1); $C(o, f, 1, 2);')).toBe(
      'const a = o.x; (o.y = 1); o.f(1, 2);',
    );
  });

  it('checks $fwd first for what an array has, and names the key', () => {
    const out = expand('const n = $G(a, length);', {runtime: '/rt/runtime.ts'});
    expect(out).toContain(
      'const n = (a.$fwd === undefined ? a.length : $sget(a.$fwd, K_length));',
    );
    expect(out).toContain('const K_length = $key("length");');
  });

  it('reads an element through a stub per site', () => {
    const out = body('const b = $GI(xs, i); $SI(xs, i, 2);');
    expect(out).toContain(
      'const b = (xs.$fwd === undefined ? xs[i] : $gi0(xs.$fwd, i));',
    );
    expect(out).toContain(
      '(xs.$fwd === undefined ? (xs[i] = 2) : $sseti(xs.$fwd, i, 2));',
    );
    expect(out).toContain('function $gi0(h, i) {');
  });

  it('polls at a clean point, plainly or with Atomics.load, or not at all', () => {
    expect(body('$POLL();')).toBe('($P[1] !== 0 && $clean());');
    expect(body('$POLL();', {atomicPoll: true})).toBe(
      '(Atomics.load($P, 1) !== 0 && $clean());',
    );
    expect(body('$POLL();', {noPoll: true})).toBe('0;');
  });

  it("points the runtime's imports at its modules", () => {
    // as the tsgo fork emits a program's import of the API
    expect(body("import {go} from '@arv/threads';")).toBe(
      "import {go} from '/rt/threads.ts';",
    );
    expect(body("import {$closure} from '@arv/threads/runtime';")).toBe(
      "import {$closure} from '/rt/runtime.ts';",
    );
    expect(body('import {spawn} from "@arv/threads/own";')).toBe(
      "import {spawn} from '/rt/own.ts';",
    );
    expect(body("log('@arv/threads');")).toBe("log('@arv/threads');");
    expect(body("import {go} from 'threads';")).toBe(
      "import {go} from 'threads';",
    );
    expect(body("import {x} from './threads.ts';")).toBe(
      "import {x} from './threads.ts';",
    );
  });

  it('leaves strings and comments alone', () => {
    const src = "const s = '$G(o, x)'; // $S(o, y, 1)";
    expect(body(src)).toBe(src);
  });

  it('refuses what a transform would not emit', () => {
    expect(() => body('$C(o, f, 1, 2, 3, 4);')).toThrow(/at most 3 arguments/);
    expect(() => body('$G(o.p, x);')).toThrow(/expected an identifier/);
  });
});
