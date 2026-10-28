// Does the module validate and run, shared and not?
//   node --experimental-wasm-shared experiments/wasm-shared/smoke.js

import {instantiate} from './body-module.js';

for (const shared of [false, true]) {
  try {
    const w = instantiate({shared});
    const b = w.new_body(1, 2, 3, 4, 5, 6, 7);
    w.set_x(b, 42);
    const a = w.new_bodies(2);
    w.bodies_set(a, 0, b);
    w.bodies_set(a, 1, w.new_body(0, 0, 0, 0, 0, 0, 1));
    console.log(
      shared ? 'shared  ' : 'unshared',
      w.get_x(w.bodies_get(a, 0)),
      2,
      w.energy(a, 2).toFixed(6),
      typeof b,
      Object.prototype.toString.call(b),
    );
  } catch (e) {
    console.log(shared ? 'shared  ' : 'unshared', 'error:', e.message);
  }
}
