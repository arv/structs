// A shared struct whose fields are declared number: typed, so read and
// written with no check of their words (test/compile.test.ts).

import '@arv/structs';
import {Vec} from './shapes.ts';

export shared struct P {
  x: number = 0;
  label: string = '';
}

export function get(p: P): number {
  return p.x;
}

export function put(p: P, x: number): number {
  p.x = x;
  return p.x;
}

// checked at each access
export function getAssigned(p: P | Vec): number {
  p = p as P;
  return p.x;
}

// compound: the slot read and written with no check of its word
export function bump(p: P, n: number): number {
  p.x += n;
  return p.x++;
}
