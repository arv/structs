// Where scan.ts finds struct declarations, and where it must not.

import {describe, expect, test} from 'vite-plus/test';
import {scan} from '../src/compiler/scan.ts';

const found = (source: string) =>
  scan(source).structs.map(s => (s.shared === undefined ? 'struct' : 'shared'));

describe('scan', () => {
  test('declarations', () => {
    expect(found('struct A {}')).toEqual(['struct']);
    expect(found('shared struct A {}')).toEqual(['shared']);
    expect(found('export struct A extends B {}')).toEqual(['struct']);
    expect(found('export default struct {}')).toEqual(['struct']);
    expect(found('export default shared struct extends B {}')).toEqual([
      'shared',
    ]);
    expect(found('struct Box<T> { v: T; }')).toEqual(['struct']);
    expect(found('struct A implements I {}')).toEqual(['struct']);
    expect(found('if (x) { struct A {} } struct B {}')).toEqual([
      'struct',
      'struct',
    ]);
    expect(found('let x = 1\nstruct A {}')).toEqual(['struct']);
  });

  test('positions stay where they were', () => {
    const source = 'export shared struct A { x = "struct B {}"; }';
    const {text} = scan(source);
    expect(text).toHaveLength(source.length);
    expect(text).toBe('export        class  A { x = "struct B {}"; }');
  });

  test('struct as an identifier, and in strings, comments and templates', () => {
    expect(found('const struct = 1; struct;')).toEqual([]);
    expect(found('f(struct, shared); x = struct\nA {}')).toEqual([]);
    expect(found('"struct A {}"; \'shared struct B {}\'')).toEqual([]);
    expect(found('// struct A {}\n/* struct B {} */')).toEqual([]);
    expect(found('`struct A {} ${ "x" } struct B {}`')).toEqual([]);
    expect(found('`${`struct A {}`}`; struct B {}')).toEqual(['struct']);
    expect(found('x = /struct A {}/; struct B {}')).toEqual(['struct']);
    expect(found('a = b / struct / c')).toEqual([]);
    expect(found('struct\nA {}')).toEqual([]);
    expect(found('shared\nstruct A {}')).toEqual(['struct']);
    expect(found('struct instanceof A')).toEqual([]);
    expect(found('struct {}')).toEqual([]);
  });
});
