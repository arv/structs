// What the page (wasm.ts) and the compiler's worker (compiler.ts) say to each
// other: the page asks for a program compiled, and the worker answers with
// it, or says how its download goes, that it is ready, or that it failed.
import type {Diagnostic} from '../src/runtime/compiled.ts';

export type {Diagnostic};
export type CompilerRequest = {id: number; source: string; types: string};
export type Compiled = {
  js: string | null;
  erased: string | null;
  ownership: Diagnostic[];
  types: Diagnostic[];
  ms: number;
  checkMs: number;
};
export type CompilerMessage =
  | {type: 'progress'; loaded: number; total: number}
  | {type: 'ready'; ms: number}
  | {type: 'result'; id: number; compiled: Compiled}
  | {type: 'error'; id: number | null; message: string};
