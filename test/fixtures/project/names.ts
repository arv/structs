// Names that look like the compiler's own (test/compile.test.ts): what it
// declares is named apart from them.

import {Vec} from './shapes.ts';

export function bump(v: Vec): number[] {
  const $t0_$struct = 10,
    $a0_$struct = 20;
  v.x += $t0_$struct;
  v.y++;
  return [v.x, v.y, $t0_$struct + $a0_$struct];
}
