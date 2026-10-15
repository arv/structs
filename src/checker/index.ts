// The ownership checker and compiler of threads for JavaScript, on TypeScript
// 7.1's API: `check` reports what `tsgo own check` reports for programs
// written against the plain TypeScript API (threads.d.ts), and `compile` emits
// what `tsgo -p` emits for them.

export {check, CheckError} from './check.ts';
export type {CheckOptions} from './check.ts';
// compile(tsconfigPath, { runtime }): what the fork's `tsgo -p` emits for each
// file, as TypeScript with the edits (and a source map), for a type stripper to
// erase the types of; toJavaScript strips them with OXC
export {compile, composeMaps, toJavaScript} from './compile.ts';
export type {
  CompiledFile,
  CompileOptions,
  CompileResult,
  JavaScriptOptions,
  SourceMap,
} from './compile.ts';
export {formatDiagnostic, Messages} from './messages.ts';
export type {Diagnostic} from './messages.ts';
// an API session to pass to check() as `api` , so a long-running caller (the
// playground's dev server) opens TypeScript once
export {API} from 'typescript/sync';
