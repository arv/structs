// What a playground program compiles to (compile-program.ts), and what the
// page (wasm.ts) and the compiler's worker (compiler.ts) say to each other.

export type Diagnostic = {line: number; col: number; message: string};

export type Compiled = {
  // with direct field access where the types allow it, and with every field
  // access through the Proxy; null when it did not compile
  fast: string | null;
  proxy: string | null;
  // the program's errors: TypeScript's and the structs'
  diagnostics: Diagnostic[];
  ms: number;
};

export type CompilerRequest = {id: number; source: string};
export type CompilerMessage =
  | {type: 'progress'; loaded: number; total: number}
  | {type: 'ready'; ms: number}
  | {type: 'result'; id: number; compiled: Compiled}
  | {type: 'error'; id: number | null; message: string};
