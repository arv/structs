// Compiles a program in the proposal's syntax and imports it.

import {mkdirSync, writeFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {formatDiagnostic, transpile} from '../src/compiler/index.ts';

export const RUNTIME = new URL('../src/runtime/emit.ts', import.meta.url).href;
const out = fileURLToPath(new URL('./.out/', import.meta.url));
mkdirSync(out, {recursive: true});
let n = 0;

// The module `source` is, compiled. Its exports.
export async function load(source: string, fileName = 'test.js') {
  const result = transpile(source, {fileName, runtime: RUNTIME});
  if (result.diagnostics.length > 0)
    throw new SyntaxError(result.diagnostics.map(formatDiagnostic).join('\n'));
  const file = `${out}${process.pid}-${n++}.js`;
  writeFileSync(file, result.code);
  return import(pathToFileURL(file).href);
}

// The diagnostics of compiling `source`, as messages.
export function errors(source: string, fileName = 'test.js') {
  return transpile(source, {fileName, runtime: RUNTIME}).diagnostics.map(
    d => d.message,
  );
}
