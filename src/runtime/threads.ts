// threads for JavaScript in plain TypeScript (types: threads.d.ts): the API
// programs import, over own.ts (own and shared values, cells, shared structs,
// reference counts), chan.ts (goroutines and channels) and maps.ts (SharedMap
// and SharedSet). The bundler plugin (vite-plugin-threads.ts) compiles what
// imports it; the helpers it emits
// (__F64, __retain, ...) come from here too
import {__sharedStruct, __heapStats} from './own.ts';

export * from './own.ts';
export * from './chan.ts';
export * from './maps.ts';

// shared structs: struct({ x: f64, n: i32, done: bool, name: str, next: ref()
// }) is a struct type, a class whose instances are handles on a block of shared
// memory. compiled, a struct value is the block's address instead (see own.ts
// __sharedStruct); uncompiled code uses the handles. i32 and u8 are SharedArray
// element types too
const REF = Object.freeze({kind: 'ref'});
export const f64 = Object.freeze({kind: 'f64'});
export const i32 = Object.freeze({kind: 'i32'});
export const u8 = Object.freeze({kind: 'u8'});
export const bool = Object.freeze({kind: 'bool'});
export const str = Object.freeze({kind: 'str'});
export const ref = <T = unknown>(): Ref<T> => REF;
// own.ts __sharedStruct's kinds
const letters = {f64: 'f', ref: 'r', i32: 'i', u8: 'u', bool: 'b', str: 's'};
// a field: its kind, and for a reference, the type of what it refers to
interface Field {
  readonly kind: keyof typeof letters;
}
interface Ref<T> extends Field {
  readonly kind: 'ref';
  readonly to?: T;
}
type Fields = Record<string, Field>;
// what a field holds, as a struct's handles read and write it
type Scalars = {
  f64: number;
  i32: number;
  u8: number;
  bool: boolean;
  str: string;
};
type FieldValue<F> =
  F extends Ref<infer T>
    ? T | null
    : F extends {kind: infer K extends keyof Scalars}
      ? Scalars[K]
      : never;
type Instance<F extends Fields> = {-readonly [K in keyof F]: FieldValue<F[K]>};
export function struct<F extends Fields>(fields: F, name = 'Struct') {
  const keys = Object.keys(fields),
    kinds = keys.map(k => letters[fields[k].kind]).join('');
  return __sharedStruct<Instance<F>>(
    name,
    keys,
    keys.flatMap((k, i) => (fields[k] === REF ? [i] : [])),
    /^[fr]*$/.test(kinds) ? '' : kinds,
  );
}

// consume(x) ends x's lifetime for the ownership checker; at run time it is x
export const consume: <T>(x: T) => T = x => x;

export const heapStats = __heapStats;
