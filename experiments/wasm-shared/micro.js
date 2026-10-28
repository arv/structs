// The microbenchmark, on everything but our runtime (ts/micro.ts has that):
// a field get + set from JS, and a read of a field of each struct in an
// array, on
//   plain        a plain JS object / Array
//   js-shared    V8's own JS shared structs (SharedStructType, --harmony-struct)
//   wasm         Wasm GC structs, through the module's exported accessors
//                on typed refs (get_x, bodies_get)
//   wasm-shared  the same, the struct types shared
//   xwasm        Wasm GC structs, through the accessors on externrefs
//                (xget_x, xbodies_get), which V8 can inline
//   xwasm-shared the same, the struct types shared
//
//   node --experimental-wasm-shared experiments/wasm-shared/micro.js wasm-shared
//   node --harmony-struct experiments/wasm-shared/micro.js js-shared

import {N, M, LEN, report} from './bench-util.js';

const which = process.argv[2] ?? 'wasm-shared';

if (which === 'plain') {
  const bump = (p, n) => {
    for (let i = 0; i < n; i++) p.x = p.x + 1;
  };
  const sum = a => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i].x;
    return s;
  };
  const p = {x: 0};
  const a = Array.from({length: LEN}, (_, i) => ({x: i}));
  report(which, {bump: () => bump(p, N), sum: () => loop(() => sum(a))});
} else if (which === 'js-shared') {
  const P = new SharedStructType(['x']);
  const bump = (p, n) => {
    for (let i = 0; i < n; i++) p.x = p.x + 1;
  };
  const sum = a => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i].x;
    return s;
  };
  const p = new P();
  p.x = 0;
  const a = new SharedArray(LEN);
  for (let i = 0; i < LEN; i++) {
    const q = new P();
    q.x = i;
    a[i] = q;
  }
  report(which, {bump: () => bump(p, N), sum: () => loop(() => sum(a))});
} else {
  const {instantiate} = await import('./body-module.js');
  const w = instantiate({shared: which.endsWith('-shared')});
  const x = which.startsWith('x') ? 'x' : '';
  const get_x = w[`${x}get_x`],
    set_x = w[`${x}set_x`],
    bodies_get = w[`${x}bodies_get`];
  const bump = (p, n) => {
    for (let i = 0; i < n; i++) set_x(p, get_x(p) + 1);
  };
  const sum = (a, len) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += get_x(bodies_get(a, i));
    return s;
  };
  const p = w.new_body(0, 0, 0, 0, 0, 0, 0);
  const a = w.new_bodies(LEN);
  for (let i = 0; i < LEN; i++)
    w.bodies_set(a, i, w.new_body(i, 0, 0, 0, 0, 0, 0));
  report(which, {bump: () => bump(p, N), sum: () => loop(() => sum(a, LEN))});
}

function loop(f) {
  let s = 0;
  for (let k = 0; k < M; k++) s += f();
  return s;
}
