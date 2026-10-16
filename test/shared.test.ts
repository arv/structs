// Shared Structs (§2) and Shared Arrays (§3).

import {describe, expect, test} from 'vite-plus/test';
import '../src/runtime/index.ts';
import {errors, load} from './helpers.ts';

describe('shared struct', () => {
  test('an instance has no prototype, and is sealed', async () => {
    const {S} = await load(`export shared struct S { x = 1; y; }`);
    const s = new S();
    expect(Object.getPrototypeOf(s)).toBe(null);
    expect(Object.isSealed(s)).toBe(true);
    expect(Object.keys(s)).toEqual(['x', 'y']);
    expect({...s}).toEqual({x: 1, y: undefined});
    expect(Reflect.canBeShared(s)).toBe(true);
    expect(Object.isSealed(S)).toBe(true);
  });

  test('its fields hold primitives and shared objects, not other objects', async () => {
    const {S} = await load(`export shared struct S { v; }`);
    const s = new S();
    for (const v of [
      undefined,
      null,
      true,
      false,
      0,
      -0,
      1.5,
      NaN,
      -Infinity,
      'a string',
      '',
      'ünïcödé ☃',
      12345678901234567890n,
      Symbol.for('registered'),
      Symbol.iterator,
      s,
    ]) {
      s.v = v;
      expect(s.v).toBe(v);
    }
    for (const v of [{}, [], () => {}, Symbol('unregistered'), new Map()]) {
      expect(() => {
        s.v = v;
      }).toThrow(TypeError);
      expect(Reflect.canBeShared(v)).toBe(false);
    }
  });

  test('a field initializer that is not shareable throws', async () => {
    const {S} = await load(`export shared struct S { v = {}; }`);
    expect(() => new S()).toThrow(TypeError);
  });

  test('the internal methods (§2.1.5 to §2.1.10)', async () => {
    const {S} = await load(`export shared struct S { x = 1; }`);
    const s = new S();
    expect(Object.getOwnPropertyDescriptor(s, 'x')).toEqual({
      value: 1,
      writable: true,
      enumerable: true,
      configurable: false,
    });
    expect('x' in s).toBe(true);
    expect('y' in s).toBe(false);
    expect('toString' in s).toBe(false);
    expect(s.y).toBe(undefined);
    expect(Reflect.set(s, 'y', 1)).toBe(false);
    expect(Reflect.deleteProperty(s, 'x')).toBe(false);
    expect(Reflect.defineProperty(s, 'x', {value: 2})).toBe(true);
    expect(s.x).toBe(2);
    expect(Reflect.defineProperty(s, 'x', {enumerable: false})).toBe(false);
    expect(Reflect.defineProperty(s, 'x', {get() {}})).toBe(false);
    expect(Reflect.setPrototypeOf(s, {})).toBe(false);
    expect(JSON.stringify(s)).toBe('{"x":2}');
  });

  test('an instance is the same object every time it is read', async () => {
    const {Node} = await load(`export shared struct Node { next = null; }`);
    const a = new Node(),
      b = new Node();
    a.next = b;
    b.next = a;
    expect(a.next).toBe(b);
    expect(a.next.next).toBe(a);
  });

  test('extends: a shared struct only', async () => {
    const {A, B} = await load(`
      export shared struct A { a = 1; constructor(x) { this.a = x; } }
      export shared struct B extends A { b = 2; constructor(x) { super(x * 10); } }
    `);
    const b = new B(4);
    expect({...b}).toEqual({a: 40, b: 2});
    expect(Object.getPrototypeOf(B)).toBe(A);
    await expect(
      load(`struct A {} export shared struct B extends A {}`),
    ).rejects.toThrow(TypeError);
  });

  test('statics live on the constructor, which is sealed after them', async () => {
    const {S} = await load(`
      export shared struct S { static #made = 0; static made() { return S.#made; } static { S.#made = 1; } }
    `);
    expect(S.made()).toBe(1);
    expect(Object.isSealed(S)).toBe(true);
  });

  test('instance methods and private names are errors (§2.2.3)', () => {
    expect(errors(`shared struct S { m() {} }`)).toEqual([
      'a shared struct cannot have instance methods or accessors (§2.2.3)',
    ]);
    expect(errors(`shared struct S { get x() { return 1; } }`)).toHaveLength(1);
    expect(errors(`shared struct S { #x; }`)).toEqual([
      'a shared struct cannot have private fields (§2.2.3)',
    ]);
    expect(errors(`shared struct S { static #c = 0; x = S.#c; }`)).toEqual([
      'a shared struct field initializer cannot use private names (§2.2.3)',
    ]);
    expect(errors(`shared struct S { static m() {} static #p() {} }`)).toEqual(
      [],
    );
  });

  test('`shared` and `struct` on different lines are not a shared struct', async () => {
    const m = await load(`
      export const shared = 1
      struct S { x = 2; }
      export const s = new S();
    `);
    expect(Object.getPrototypeOf(m.s)).not.toBe(null);
  });
});

describe('SharedArray', () => {
  test('a length, or elements', () => {
    const a = new SharedArray(3);
    expect(a.length).toBe(3);
    expect(Object.keys(a)).toEqual(['0', '1', '2']);
    expect(a[0]).toBe(undefined);
    a[2] = 'x';
    expect(a[2]).toBe('x');
    const b = new SharedArray<unknown>(1, 'two', a);
    expect([b[0], b[1], b[2]]).toEqual([1, 'two', a]);
    expect(new SharedArray().length).toBe(0);
  });

  test('its length is fixed, and its elements must be shareable', () => {
    const a = new SharedArray<unknown>(2);
    expect(Object.isSealed(a)).toBe(true);
    expect(Object.getPrototypeOf(a)).toBe(null);
    expect(Reflect.set(a, 'length', 5)).toBe(false);
    expect(Reflect.set(a, 2, 1)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(a, 'length')).toEqual({
      value: 2,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    expect(() => {
      a[0] = {};
    }).toThrow(TypeError);
  });

  test('called without new, or with a bad length', () => {
    expect(() => (SharedArray as any)(1)).toThrow(TypeError);
    expect(() => new SharedArray(1.5)).toThrow(TypeError);
    expect(() => new SharedArray(-1)).toThrow(RangeError);
  });
});
