// The TypeScript project mode: type checked, and shared struct field access
// made direct where the types allow (src/compiler/fast.ts).

import {mkdirSync, writeFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {describe, expect, test} from 'vite-plus/test';
import {compile} from '../src/compiler/index.ts';
import {RUNTIME} from './helpers.ts';

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}/tsconfig.json`, import.meta.url));

describe('compile', () => {
  const result = compile(fixture('project'), {runtime: RUNTIME});
  const code = (name: string) =>
    result.files.find(f => f.fileName.endsWith(name))!.code;

  test('no errors: a struct constructor needs no super()', () => {
    expect(result.diagnostics).toEqual([]);
  });

  test('field reads and writes go to the slots directly', () => {
    const main = code('main.ts');
    expect(main).toMatch(/\$struct\.layout\(\[\s*"x",\s*"y"\s*\]\)/);
    // a parameter never assigned: its address is checked once, and a number
    // field read in the heap's views, but for an object of another layout
    expect(main).toMatch(
      /const (\$a\d_\$struct) = \$struct\.addr\(v, \$L\d_\$struct\);[\s\S]*?return Math\.sqrt\(\(\1 < 0 \|\| \$I_\$struct\[\(\1 >> 2\) \+ 4\] !== 1 \? \$struct\.getNumberAt\(v, \1, \$L\d_\$struct, 0\) : \$F_\$struct\[\(\1 >> 3\) \+ 3\]\)/,
    );
    // a const, a field that is not a number
    expect(main).toMatch(
      /const b = new Body\(i, -i\), (\$a\d_\$struct) = \$struct\.addr\(b, \$L\d_\$struct\);\s*\$struct\.setAt\(b, \1, \$L\d_\$struct, 4, head\)/,
    );
    // a parameter that is assigned: checked at each access
    expect(main).toMatch(/b = \$struct\.get\(b, \$L\d_\$struct, 4\)/);
    expect(main).toMatch(/\$struct\.getNumber\(b, \$L\d_\$struct, 0\)/);
    // a compound assignment: the slot read, and written in place
    expect(main).toMatch(
      /(\$t\d+_\$struct) = \((\$a\d_\$struct) < 0 \|\| \$I_\$struct\[\(\2 >> 2\) \+ 4\] !== 1 \? \$struct\.getNumberAt\(b, \2, \$L\d_\$struct, 0\) : \$F_\$struct\[\(\2 >> 3\) \+ 3\]\) \+ 1, \2 < 0 \|\| typeof \1 !== "number" \|\| [^?]+\? \$struct\.setAt\(b, \2, \$L\d_\$struct, 0, \1\) : \$F_\$struct\[\(\2 >> 3\) \+ 3\] = \1;/,
    );
    // an unshared struct is an ordinary object: nothing to make direct
    expect(code('shapes.ts')).toContain('++this.count');
  });

  test('a binding that keeps its value is checked once', () => {
    const hoist = code('hoist.ts');
    expect(hoist).toMatch(
      /function dot\(a, b\) \{\s*const \$a\d_\$struct = \$struct\.addr\(a, \$L\d_\$struct\);[\s\S]*?const \$a\d_\$struct = \$struct\.addr\(b, /,
    );
    // in the for-of's block
    expect(hoist).toMatch(
      /for \(const v of vs\) \{\s*const \$a\d_\$struct = \$struct\.addr\(v, /,
    );
    expect(hoist).toMatch(/const w = v, \$a\d_\$struct = \$struct\.addr\(w, /);
    // the heap's views and the scratch variable, locals of the function
    expect(hoist).toMatch(
      /function put\(v, x\) \{[\s\S]*?const \{ I32: \$I_\$struct, F64: \$F_\$struct \} = \$struct\.views\(\);\s*let \$v_\$struct;/,
    );
    // a number written in the heap's views if it is a Number, through the
    // runtime if not
    expect(hoist).toMatch(
      /\$v_\$struct = x, (\$a\d_\$struct) < 0 \|\| typeof \$v_\$struct !== "number" \|\| \$I_\$struct\[\(\1 >> 2\) \+ 4\] !== 1 \? \$struct\.setAt\(v, \1, \$L\d_\$struct, 0, \$v_\$struct\) : \$F_\$struct\[\(\1 >> 3\) \+ 3\] = \$v_\$struct;/,
    );
    // a let that is assigned
    expect(hoist).toMatch(/return \$struct\.getNumber\(v, \$L\d_\$struct, 0\)/);
  });

  test('a struct from a SharedArray or a field is its address, with no Proxy', () => {
    const heap = code('heap.ts');
    // arr[i]: the element's word, and arr itself checked once
    expect(heap).toMatch(
      /const (\$a\d+_\$struct) = \$struct\.elem\((\$a\d+_\$struct), i, \$L\d_\$struct\), p = \1 < 0 \? arr\[i\] : undefined;/,
    );
    expect(heap).toMatch(/\$a\d+_\$struct = \$struct\.addrArray\(arr\)/);
    // its length, from its header
    expect(heap).toMatch(
      /i < \((\$a\d+_\$struct) < 0 \? arr\.length : \$I_\$struct\[\(\1 >> 2\) \+ 1\]\)/,
    );
    // s.next: the field's word
    expect(heap).toMatch(
      /const (\$a\d+_\$struct) = \$struct\.ref\(\$a\d+_\$struct, 1, \$L\d_\$struct\), n = \1 < 0 \?/,
    );
    // used other than for its fields: made, and checked
    expect(heap).toMatch(
      /const q = arr\[0\], \$a\d+_\$struct = \$struct\.addr\(q, /,
    );
    // a `p` of another block, used as itself, is another binding
    expect(heap).toMatch(
      /function twice[\s\S]*?const p = arr\[i\];[\s\S]*?\$struct\.elem\(\$a\d+_\$struct, i, \$L\d_\$struct\), p = /,
    );
    // an async function reads the runtime's views
    expect(heap).toMatch(/async function later[\s\S]*?\$struct\.I32\[/);
  });

  test('the compiled program runs', async () => {
    const out = fileURLToPath(new URL('./.out/project/', import.meta.url));
    mkdirSync(out, {recursive: true});
    for (const f of result.files)
      writeFileSync(
        out + f.fileName.split('/').pop()!.replace(/\.ts$/, '.js'),
        f.code,
      );
    const m = await import(pathToFileURL(out + 'main.js').href);
    const {Body, Vec} = await import(pathToFileURL(out + 'shapes.js').href);
    expect(m.length(new Vec(3, 4))).toBe(5);
    const head = m.chain(4);
    expect(head.name).toBe('b3');
    expect(m.total(head)).toBe(0 + 1 + 2 + 3);
    m.step(head);
    expect([head.x, head.y]).toEqual([4, -4]);
    // structurally a Vec, but not a Shared Struct: read as written
    expect(m.length({x: 6, y: 8})).toBe(10);
    expect(m.local.bump()).toBe(1);

    const heap = await import(pathToFileURL(out + 'heap.js').href);
    const arr = heap.points(3);
    expect(heap.sumX(arr)).toBe(0 + 1 + 2);
    expect(heap.firstY(arr)).toBe(0);
    expect(await heap.later(arr)).toBe(6);
    expect(heap.twice(arr)).toBe(1 + 0 + 1 + 2);
    // the slow paths: an element that is no Node, a next that is null
    const holes = new SharedArray(2);
    expect(() => heap.sumX(holes)).toThrow(TypeError);
    const lone = new heap.Node();
    expect(() => heap.nextX(lone)).toThrow(TypeError);
    lone.next = new heap.Node();
    lone.next.x = 7;
    expect(heap.nextX(lone)).toBe(7);
    const h = await import(pathToFileURL(out + 'hoist.js').href);
    const [a, b] = [new Vec(1, 2), new Vec(3, 4)];
    expect(h.dot(a, b)).toBe(11);
    expect(h.sum([a, b])).toBe(10);
    expect(h.last([a, b])).toBe(3);
    expect(h.scale(b, 2)).toBe(b);
    expect([b.x, b.y]).toEqual([6, 8]);
    // not Shared Structs of the layout: read and written as written
    const plain = {x: 1, y: 1};
    expect(h.dot(plain, a)).toBe(3);
    expect(h.scale(plain, 3)).toEqual({x: 3, y: 3});
    expect(h.dot(new Body(1, 1), a)).toBe(3);
    // the types do not hold: what is not a Number goes through the runtime
    expect(h.put(a, 'one')).toBe('one');
    expect(a.x).toBe('one');
    expect(h.dot(a, a)).toBeNaN();
    expect(h.put(a, 7)).toBe(7);
    expect(h.dot(a, b)).toBe(7 * 6 + 2 * 8);
    expect(() => h.put(a, {})).toThrow(TypeError);
    expect(a.x).toBe(7);
  });

  test('compound assignments and updates: the slot, with no Proxy', () => {
    const update = code('update.ts');
    // none is left a property access, but where its temporaries have no
    // scope: a parameter's default, a class field's initializer
    expect(
      update.match(
        /\.(n|s|big|v|next) *(\+\+|--|[-+*/%&|^<>?]+=)|(\+\+|--)[\w.()[\]]*\.(n|s|big|v)\b/g,
      ),
    ).toEqual(['.n++', '.n++']);
    expect(update).toContain('function defaults(c, k = c.n++)');
    expect(update).toContain('first = Holder.top.n++;');
    // c.n++: the old value, after ToNumeric, kept in a temporary of its own
    expect(update).toMatch(
      /\((\$t\d+_\$struct) = \$a\d+_\$struct < 0 [^;]*?\$struct\.getNumberAt\(c, [^;]*?, (\$t\d+_\$struct) = \1\+\+, [^;]*?\$struct\.setAt\(c, \$a\d+_\$struct, \$L\d_\$struct, 0, \1\) : [^;]*? = \1, \2\)/,
    );
    // c.v ??= f('first'): written only if it is null or undefined
    expect(update).toMatch(
      /\$struct\.getAt\(c, \$a\d+_\$struct, \$L\d_\$struct, 3\) \?\? \((\$t\d+_\$struct) = f\("first"\), \$struct\.setAt\(c, \$a\d+_\$struct, \$L\d_\$struct, 3, \1\)\)/,
    );
    // an arrow's expression body, made a block for its temporaries
    expect(update).toMatch(
      /const inc = \(c\) => \{\s*let \$t\d+_\$struct, [^;]+;\s*return /,
    );
  });

  test('compound assignments and updates do as the Proxy does', async () => {
    const both = compile(fixture('project'), {
      runtime: RUNTIME,
      alsoWithoutFast: true,
    });
    const load = async (dir: string, fast: boolean) => {
      const out = fileURLToPath(new URL(`./.out/${dir}/`, import.meta.url));
      mkdirSync(out, {recursive: true});
      for (const f of both.files)
        writeFileSync(
          out + f.fileName.split('/').pop()!.replace(/\.ts$/, '.js'),
          fast ? f.code : f.withoutFast!.code,
        );
      return import(pathToFileURL(out + 'update.js').href);
    };
    const fast = await load('update-fast', true);
    const proxy = await load('update-proxy', false);
    for (const name of Object.keys(proxy.cases)) {
      const expected = await proxy.cases[name]();
      expect([name, await fast.cases[name]()]).toEqual([name, expected]);
    }
    expect(await fast.cases.nested()).toEqual(await proxy.cases.nested());
    // each receiver evaluated once, before the value
    expect(await proxy.cases.receivers()).toEqual([
      ['pick 11', 'pick 3'],
      2,
      3,
      122,
      2,
      2,
    ]);
  });

  test('type errors and struct errors', () => {
    const {diagnostics} = compile(fixture('errors'), {runtime: RUNTIME});
    const messages = diagnostics.map(d => `${d.line}: ${d.message}`);
    expect(messages).toEqual([
      '3: a shared struct cannot have instance methods or accessors (§2.2.3)',
      expect.stringMatching(
        /^6: Type 'string' is not assignable to type 'number'/,
      ),
    ]);
  });
});
