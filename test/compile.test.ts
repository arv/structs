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
    expect(main).toMatch(
      /Math\.sqrt\(\$struct\.getNumber\(v, \$L\d_\$struct, 0\)/,
    );
    expect(main).toMatch(/\$struct\.set\(b, \$L\d_\$struct, 4, head\)/);
    expect(main).toMatch(/b = \$struct\.get\(b, \$L\d_\$struct, 4\)/);
    // compound assignment stays a property access
    expect(main).toContain('b.x += 1');
    // an unshared struct is an ordinary object: nothing to make direct
    expect(code('shapes.ts')).toContain('++this.count');
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
    const {Vec} = await import(pathToFileURL(out + 'shapes.js').href);
    expect(m.length(new Vec(3, 4))).toBe(5);
    const head = m.chain(4);
    expect(head.name).toBe('b3');
    expect(m.total(head)).toBe(0 + 1 + 2 + 3);
    m.step(head);
    expect([head.x, head.y]).toEqual([4, -4]);
    // structurally a Vec, but not a Shared Struct: read as written
    expect(m.length({x: 6, y: 8})).toBe(10);
    expect(m.local.bump()).toBe(1);
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
