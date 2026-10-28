// What a shared Wasm struct is, seen from JS, and which JS values a shared
// externref takes (strings? objects?): what would stand in for our interned
// strings and for fields that hold any JS value.
//
//   node --experimental-wasm-shared experiments/wasm-shared/interop.js

import {instantiate} from './body-module.js';

const show = (label, f) => {
  try {
    console.log(label.padEnd(44), f());
  } catch (e) {
    console.log(label.padEnd(44), `${e.constructor.name}: ${e.message}`);
  }
};

const w = instantiate({shared: true});
const b = w.new_body(1, 2, 3, 4, 5, 6, 7);
show('typeof b', () => typeof b);
show('b.x', () => b.x);
show('Object.keys(b)', () => JSON.stringify(Object.keys(b)));
show('Object.getPrototypeOf(b)', () => Object.getPrototypeOf(b));
show('b.foo = 1, then b.foo', () => ((b.foo = 1), b.foo));
show("'use strict'; b.foo = 1", () =>
  (function () {
    'use strict';
    b.foo = 1;
  })(),
);
show('Object.setPrototypeOf(b, {})', () => Object.setPrototypeOf(b, {}));
show('Object.isFrozen(b)', () => Object.isFrozen(b));
show('new WeakRef(b)', () => typeof new WeakRef(b));
show('new Map([[b, 1]]).get(b)', () => new Map([[b, 1]]).get(b));
for (const [label, v] of [
  ['a string literal', 'hello'],
  ['a computed string', ['hel', 'lo'].join('')],
  ['a number', 42],
  ['a plain object', {}],
  ['a shared Wasm struct', b],
  ['null', null],
]) {
  show(`xid(${label}) on (shared extern)`, () => {
    const r = w.xid(v);
    return r === v ? 'ok, same value back' : r;
  });
}
const u = instantiate({shared: false});
show('unshared xid(a plain object) on externref', () =>
  u.xid(globalThis) === globalThis ? 'ok, same value back' : 'different',
);
