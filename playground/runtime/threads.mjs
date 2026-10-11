// threads for JavaScript in plain TypeScript (types: threads.d.mts): the API programs import, over
// own.mjs (own and shared values, cells, shared structs, reference counts) and chan.mjs (goroutines
// and channels). The bundler plugin (vite-plugin-threads.mjs) compiles what imports it; the helpers
// it emits (__F64, __retain, ...) come from here too
import { __sharedStruct, __heapStats } from './own.mjs';

export * from './own.mjs';
export * from './chan.mjs';

// shared structs: struct({ x: f64, next: ref() }) is a struct type, a class whose instances are
// handles on a block of shared memory. compiled, a struct value is the block's address instead (see
// own.mjs __sharedStruct); uncompiled code uses the handles
const REF = Object.freeze({ kind: 'ref' });
export const f64 = Object.freeze({ kind: 'f64' });
export const ref = () => REF;
export function struct(fields, name = 'Struct') {
  const keys = Object.keys(fields);
  return __sharedStruct(name, keys, keys.flatMap((k, i) => fields[k] === REF ? [ i ] : []));
}

// consume(x) ends x's lifetime for the ownership checker; at run time it is x
export const consume = x => x;

export const heapStats = __heapStats;
