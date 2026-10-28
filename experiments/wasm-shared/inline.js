// Does V8 inline the module's exports into JS? Times 10M calls from a hot JS
// loop to each, on shared and unshared types: a call that is inlined costs
// about what the JS around it does (~1 ns), one that is not costs a call into
// Wasm. Run with --trace-turbo-inlining (and grep for "wasm") to see the
// decisions.
//
//   node --experimental-wasm-shared experiments/wasm-shared/inline.js [shared|unshared]

import {instantiate} from './body-module.js';

const shared = (process.argv[2] ?? 'shared') === 'shared';
const w = instantiate({shared});
const N = 10_000_000;
const b = w.new_body(1, 0, 0, 0, 0, 0, 0);
const {add1, get_x, any_get_x, xget_x} = w;

const cases = {
  'add1(f64) -> f64': () => {
    let s = 0;
    for (let i = 0; i < N; i++) s = add1(s);
    return s;
  },
  'get_x((ref null $Body))': () => {
    let s = 0;
    for (let i = 0; i < N; i++) s += get_x(b);
    return s;
  },
  [`any_get_x(${shared ? '(shared any)' : 'anyref'})`]: () => {
    let s = 0;
    for (let i = 0; i < N; i++) s += any_get_x(b);
    return s;
  },
};
cases[`xget_x(${shared ? '(shared extern)' : 'externref'})`] = () => {
  let s = 0;
  for (let i = 0; i < N; i++) s += xget_x(b);
  return s;
};

console.log(shared ? 'shared types' : 'unshared types');
for (const [name, f] of Object.entries(cases)) {
  let best = Infinity;
  for (let r = 0; r < 7; r++) {
    const t = performance.now();
    f();
    best = Math.min(best, performance.now() - t);
  }
  console.log(`  ${name.padEnd(28)} ${((best * 1e6) / N).toFixed(2)} ns/call`);
}
