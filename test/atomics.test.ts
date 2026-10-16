// The Atomics overloads (§2.3), and Mutex and Condition (§4) in one agent.

import {describe, expect, test} from 'vite-plus/test';
import '../src/runtime/index.ts';
import {load} from './helpers.ts';

describe('Atomics on Shared Structs', () => {
  test('load, store, exchange, compareExchange', async () => {
    const {S} = await load(`export shared struct S { n = 0; s = 'a'; }`);
    const s = new S();
    expect(Atomics.store(s, 'n', 5)).toBe(5);
    expect(Atomics.load(s, 'n')).toBe(5);
    expect(Atomics.exchange(s, 'n', 6)).toBe(5);
    expect(Atomics.compareExchange(s, 'n', 6, 7)).toBe(6);
    expect(Atomics.compareExchange(s, 'n', 6, 8)).toBe(7);
    expect(s.n).toBe(7);
    expect(Atomics.compareExchange(s, 's', 'a', s)).toBe('a');
    expect(Atomics.load(s, 's')).toBe(s);
  });

  test('errors: a field that is not a key, or not there, or a value that is not shareable', async () => {
    const {S} = await load(`export shared struct S { n = 0; }`);
    const s = new S();
    expect(() => Atomics.load(s, 0 as any)).toThrow(TypeError);
    expect(() => Atomics.load(s, 'missing' as any)).toThrow(RangeError);
    expect(() => Atomics.store(s, 'n', {} as any)).toThrow(TypeError);
  });

  test('on a Shared Array, by index as a string', () => {
    const a = new SharedArray<number>(2);
    Atomics.store(a, '1' as any, 3);
    expect(a[1]).toBe(3);
  });

  test('typed arrays work as they did', () => {
    const t = new Int32Array(new SharedArrayBuffer(8));
    expect(Atomics.store(t, 0, 3)).toBe(3);
    expect(Atomics.load(t, 0)).toBe(3);
    expect(Atomics.compareExchange(t, 0, 3, 4)).toBe(3);
  });
});

describe('Mutex', () => {
  test('lock gives an UnlockToken, which unlocks once', () => {
    const m = new Atomics.Mutex();
    expect(Reflect.canBeShared(m)).toBe(true);
    expect(Object.getPrototypeOf(m)).toBe(null);
    const token = Atomics.Mutex.lock(m);
    expect(token).toBeInstanceOf(Atomics.Mutex.UnlockToken);
    expect(token.locked).toBe(true);
    expect(token.unlock()).toBe(true);
    expect(token.locked).toBe(false);
    expect(token.unlock()).toBe(false);
  });

  test('locking a Mutex this agent holds is a TypeError', () => {
    const m = new Atomics.Mutex();
    const token = Atomics.Mutex.lock(m);
    expect(() => Atomics.Mutex.lock(m)).toThrow(TypeError);
    expect(() => Atomics.Mutex.lockIfAvailable(m, 0)).toThrow(TypeError);
    token.unlock();
  });

  test('using unlocks at the end of the block', () => {
    const m = new Atomics.Mutex();
    {
      using _ = Atomics.Mutex.lock(m);
    }
    const again = Atomics.Mutex.lockIfAvailable(m, 0);
    expect(again?.locked).toBe(true);
    again!.unlock();
  });

  test('a token is reused, but not while it holds a Mutex', () => {
    const m = new Atomics.Mutex();
    const token = new Atomics.Mutex.UnlockToken();
    expect(token.locked).toBe(false);
    expect(Atomics.Mutex.lock(m, token)).toBe(token);
    expect(() => Atomics.Mutex.lock(new Atomics.Mutex(), token)).toThrow(
      TypeError,
    );
    token.unlock();
    expect(Atomics.Mutex.lock(m, token)).toBe(token);
    token[Symbol.dispose]();
    expect(token.locked).toBe(false);
  });

  test('constructors need new, and the statics need a Mutex', () => {
    expect(() => (Atomics.Mutex as any)()).toThrow(TypeError);
    expect(() => Atomics.Mutex.lock({} as any)).toThrow(TypeError);
    expect(() =>
      Atomics.Mutex.lockIfAvailable(new Atomics.Mutex(), '1' as any),
    ).toThrow(TypeError);
  });
});

describe('Condition', () => {
  test('waitFor times out, or returns when the predicate holds', () => {
    const m = new Atomics.Mutex(),
      cv = new Atomics.Condition();
    using token = Atomics.Mutex.lock(m);
    const start = performance.now();
    expect(Atomics.Condition.waitFor(cv, token, 20)).toBe(false);
    expect(performance.now() - start).toBeGreaterThanOrEqual(15);
    expect(token.locked).toBe(true);
    expect(Atomics.Condition.waitFor(cv, token, 1000, () => true)).toBe(true);
  });

  test('notify with nobody waiting wakes nobody', () => {
    const cv = new Atomics.Condition();
    expect(Atomics.Condition.notify(cv)).toBe(0);
    expect(Atomics.Condition.notify(cv, 1)).toBe(0);
    expect(() => Atomics.Condition.notify(cv, 1.5)).toThrow(TypeError);
  });

  test('waiting needs a token that holds a Mutex', () => {
    const cv = new Atomics.Condition();
    expect(() =>
      Atomics.Condition.wait(cv, new Atomics.Mutex.UnlockToken()),
    ).toThrow(TypeError);
  });
});
