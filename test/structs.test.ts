// Structs (§1): fixed-layout objects, sealed, made in one shot.

import {describe, expect, test} from 'vite-plus/test';
import {transpile} from '../src/compiler/index.ts';
import {errors, load, RUNTIME} from './helpers.ts';

describe('struct', () => {
  test('its fields are all defined before any initializer runs', async () => {
    const {Point, seen} = await load(`
      export const seen = [];
      export struct Point {
        x = (seen.push(Object.keys(this)), 1);
        y = 2;
        constructor() { seen.push(Object.keys(this), Object.isSealed(this)); }
      }
    `);
    const p = new Point();
    expect(seen).toEqual([['x', 'y'], ['x', 'y'], true]);
    expect({...p}).toEqual({x: 1, y: 2});
  });

  test('a literal initializer is its value, in order with the others', async () => {
    const {S} = await load(`
      export struct S { a = 'x'; #b = 2; c = -1; d = this.a + this.#b + this.c; e = 3n; f = null; }
    `);
    expect({...new S()}).toEqual({a: 'x', c: -1, d: 'x2-1', e: 3n, f: null});
    const code = transpile(`struct S { a = 'x'; b = this.a; }`, {
      fileName: 'test.js',
      runtime: RUNTIME,
    }).code;
    expect(code).toContain(`{key: "a", value: 'x'}`);
    expect(code).not.toContain('#$f1');
  });

  test('an instance is sealed, its fields writable and not configurable', async () => {
    const {S} = await load(`export struct S { x = 1; }`);
    const s = new S();
    expect(Object.isSealed(s)).toBe(true);
    expect(Object.isFrozen(s)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(s, 'x')).toEqual({
      value: 1,
      writable: true,
      enumerable: true,
      configurable: false,
    });
    expect(() => {
      s.y = 1;
    }).toThrow(TypeError);
    expect(() => {
      delete s.x;
    }).toThrow(TypeError);
    s.x = 'anything';
    expect(s.x).toBe('anything');
  });

  test('the prototype is sealed, and its parent is Object.prototype', async () => {
    const {S} = await load(`export struct S { m() {} }`);
    expect(Object.isSealed(S.prototype)).toBe(true);
    expect(Object.getPrototypeOf(S.prototype)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(new S())).toBe(S.prototype);
  });

  test('the constructor is an initializer, called with the arguments', async () => {
    const {S} = await load(`
      export struct S { a; b; constructor(a, b) { this.a = a; this.b = b; } }
    `);
    expect({...new S(1, 2)}).toEqual({a: 1, b: 2});
  });

  test('it must be called with new, and cannot be subclassed by a class', async () => {
    const {S} = await load(`export struct S {}`);
    expect(() => S()).toThrow(TypeError);
    class C extends S {}
    expect(() => new C()).toThrow(TypeError);
    expect(() => Reflect.construct(S, [], Object)).toThrow(TypeError);
  });

  test('a struct extends a struct: the fields of both, the base first', async () => {
    const {A, B, log} = await load(`
      export const log = [];
      export struct A { a = log.push('a'); constructor(x) { log.push('A ' + x); } }
      export struct B extends A { b = log.push('b'); constructor(x) { super(x + 1); log.push('B ' + x); } }
    `);
    const b = new B(1);
    expect(Object.keys(b)).toEqual(['a', 'b']);
    expect(log).toEqual(['a', 'b', 'A 2', 'B 1']);
    expect(b instanceof A && b instanceof B).toBe(true);
    expect(Object.getPrototypeOf(B)).toBe(A);
  });

  test('without super(), the parent initializer does not run', async () => {
    const {B, log} = await load(`
      export const log = [];
      struct A { constructor() { log.push('A'); } }
      export struct B extends A { constructor() { log.push('B'); } }
    `);
    new B();
    expect(log).toEqual(['B']);
  });

  test('a struct cannot extend a class', async () => {
    await expect(
      load(`class C {} export struct S extends C {}`),
    ).rejects.toThrow(TypeError);
  });

  test('extends null: no prototype parent', async () => {
    const {S} = await load(`export struct S extends null { x = 1; }`);
    const s = new S();
    expect(Object.getPrototypeOf(Object.getPrototypeOf(s))).toBe(null);
    expect(s.x).toBe(1);
  });

  test('methods check that this is an instance', async () => {
    const {A, B} = await load(`
      export struct A { x = 1; get() { return this.x; } }
      export struct B extends A { y = 2; }
    `);
    expect(new A().get()).toBe(1);
    expect(new B().get()).toBe(1);
    const get = A.prototype.get;
    expect(() => get.call({x: 1})).toThrow(TypeError);
    expect(() => get.call(undefined)).toThrow(TypeError);
    // the method itself, which checks first thing: not a wrapper
    expect(get.name).toBe('get');
    expect(Object.getPrototypeOf(get)).toBe(Function.prototype);
  });

  test('the check comes before the parameters, and covers computed names', async () => {
    const {S, ran} = await load(`
      export const ran = [];
      const k = 'computed';
      export struct S {
        m(a = ran.push('default'), {b} = {}) { return a; }
        [k](x) { return x; }
      }
    `);
    expect(new S().m(5)).toBe(5);
    expect(() => S.prototype.m.call({})).toThrow(TypeError);
    expect(ran).toEqual([]);
    expect(S.prototype.m.call(new S())).toBe(1);
    expect(ran).toEqual(['default']);
    expect(new S().computed(3)).toBe(3);
    expect(() => S.prototype.computed.call(1)).toThrow(TypeError);
  });

  test('generators and static methods are not checked', async () => {
    const {S} = await load(`
      export struct S { *gen() { yield 1; } static make() { return new S(); } }
    `);
    expect(S.make() instanceof S).toBe(true);
    expect([...S.prototype.gen.call({})]).toEqual([1]);
  });

  test('getters and setters check this, beyond the spec', async () => {
    const {S, ran} = await load(`
      export const ran = [];
      export struct S {
        x = 1;
        get g() { return this.x; }
        set g(v) { this.x = v; }
        set h({a} = (ran.push('default'), {a: 0})) { this.x = a; }
      }
    `);
    const s = new S();
    s.g = 2;
    expect(s.g).toBe(2);
    s.h = {a: 3};
    expect(s.x).toBe(3);
    const g = Object.getOwnPropertyDescriptor(S.prototype, 'g')!;
    const h = Object.getOwnPropertyDescriptor(S.prototype, 'h')!;
    expect(() => g.get!.call({x: 1})).toThrow(TypeError);
    expect(() => g.set!.call({x: 1}, 1)).toThrow(TypeError);
    // the check before the setter's parameter runs
    expect(() => h.set!.call({}, undefined)).toThrow(TypeError);
    expect(ran).toEqual([]);
  });

  test('private fields and methods', async () => {
    const {Account} = await load(`
      export struct Account {
        #balance = 10;
        #fee() { return 1; }
        withdraw(n) { this.#balance -= n + this.#fee(); return this.#balance; }
        static has(o) { return #balance in o; }
      }
    `);
    const a = new Account();
    expect(a.withdraw(4)).toBe(5);
    expect(Object.keys(a)).toEqual([]);
    expect(Account.has(a)).toBe(true);
    expect(Account.has({})).toBe(false);
  });

  test('static fields and blocks', async () => {
    const {S} = await load(`
      export struct S { static count = 0; static { S.ready = true; } constructor() { S.count++; } }
    `);
    new S();
    new S();
    expect(S.count).toBe(2);
    expect(S.ready).toBe(true);
  });

  test('computed and literal field keys', async () => {
    const {S} = await load(`
      const k = 'computed';
      export struct S { [k] = 1; 'quoted' = 2; 3 = 3; [Symbol.for('s')] = 4; }
    `);
    const s = new S();
    expect(s.computed).toBe(1);
    expect(s.quoted).toBe(2);
    expect(s[3]).toBe(3);
    expect(s[Symbol.for('s')]).toBe(4);
  });

  test('export default struct is named default', async () => {
    const m = await load(`export default struct { x = 1; }`);
    expect(m.default.name).toBe('default');
    expect(new m.default().x).toBe(1);
  });

  test('struct is not reserved', async () => {
    const m = await load(`
      const struct = 1, shared = 2;
      export const sum = struct + shared;
      export function f(struct) { return struct; }
    `);
    expect(m.sum).toBe(3);
    expect(m.f(4)).toBe(4);
  });

  test('more than one constructor is an error', () => {
    expect(errors(`struct S { constructor() {} constructor() {} }`)).toEqual([
      'a struct has more than one constructor',
    ]);
  });
});
