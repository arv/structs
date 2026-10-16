// Bindings that keep their value: their address is checked once
// (test/compile.test.ts).

import {Vec} from './shapes.ts';

// parameters never assigned
export function dot(a: Vec, b: Vec): number {
  return a.x * b.x + a.y * b.y;
}

// a for-of const: in its block
export function sum(vs: Vec[]): number {
  let s = 0;
  for (const v of vs) {
    s += v.x + v.y;
  }
  return s;
}

// a const; statements with no semicolons
export function scale(v: Vec, k: number) {
  const w = v
  w.x = w.x * k
  w.y = w.y * k
  return w
}

// a let that is assigned: checked at each access
export function last(vs: Vec[]): number {
  let v = vs[0]!;
  for (const u of vs) v = u;
  return v.x;
}

// a field written, then read
export function put(v: Vec, x: number): number {
  v.x = x;
  return v.x;
}
