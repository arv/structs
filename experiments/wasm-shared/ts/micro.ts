// The microbenchmark on our shared structs: the same two kernels as
// micro.js, compiled with the fast path (heap reads through typed-array
// views) and without (the Proxy).
//
//   node src/compiler/cli.ts compile -p experiments/wasm-shared/ts/tsconfig.json --outDir experiments/wasm-shared/fast
//   node src/compiler/cli.ts compile -p experiments/wasm-shared/ts/tsconfig.json --outDir experiments/wasm-shared/proxy --no-fast
//   node experiments/wasm-shared/fast/micro.js

import '@arv/structs';
import {N, M, LEN, report} from '../bench-util.js';

shared struct P {
  x: number = 0;
}

// get + set of one field, n times
function bump(p: P, n: number) {
  for (let i = 0; i < n; i++) p.x = p.x + 1;
}

// read one field of each struct in an array
function sum(a: SharedArray<P>) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]!.x;
  return s;
}

const p = new P();
const a = new SharedArray<P>(LEN);
for (let i = 0; i < LEN; i++) {
  const q = new P();
  q.x = i;
  a[i] = q;
}

report(process.argv[2] ?? 'ours', {
  bump: () => bump(p, N),
  sum: () => {
    let s = 0;
    for (let k = 0; k < M; k++) s += sum(a);
    return s;
  },
});
