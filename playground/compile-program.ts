// A playground program compiled: the compiler (../src/compiler) on a project
// of one file, the program, with the runtime's types where the repository has
// the runtime (the program is in playground/programs/, and imports the agent
// module as ../../src/runtime/agent.ts). The same on the
// dev server (vite.config.ts, on TypeScript's native API) and in the browser
// (compiler.ts, on tsgo in WebAssembly): only the file system differs.

import type {RequestFileSystem} from 'typescript/proto';
import type {API} from 'typescript/sync';
import {compile} from '../src/compiler/project.ts';
import agentTypes from '../src/runtime/agent-api.d.ts?raw';
import apiTypes from '../src/runtime/api.d.ts?raw';
import type {Compiled} from './compiler-messages.ts';

export const DIR = '/playground/programs',
  CONFIG = `${DIR}/tsconfig.json`,
  PROGRAM = `${DIR}/program.ts`;
// the globals' types, and the agent module, as its types
const TYPES = '/src/runtime/api.d.ts',
  AGENT = '/src/runtime/agent.ts';
// what the compiled program imports the runtime as (link.ts)
export const RUNTIME = '../../src/runtime/emit.ts';

const tsconfig = JSON.stringify({
  compilerOptions: {
    target: 'esnext',
    module: 'esnext',
    moduleResolution: 'bundler',
    strict: true,
    lib: ['esnext', 'dom'],
    types: [],
    skipLibCheck: true,
    noEmit: true,
    allowImportingTsExtensions: true,
  },
  // the runtime's types as a root: its globals (Atomics.Mutex and the rest)
  // are there whether or not the program imports it
  files: ['program.ts', TYPES],
});

// the program's files: over the disk's (a layer, on the dev server, where
// the lib files are tsgo's own), or all of them (in WebAssembly, where the
// lib files are those built into tsgo)
export function files(
  source: string,
  kind: 'layer' | 'full',
): RequestFileSystem {
  return {
    kind,
    files: {
      [CONFIG]: tsconfig,
      [PROGRAM]: source,
      [TYPES]: apiTypes,
      [AGENT]: agentTypes,
    },
    ...(kind === 'full' && {
      symlinks: {'bundled:///libs': {target: 'bundled:///libs', host: true}},
    }),
  };
}

export function compileProgram(
  api: API,
  source: string,
  kind: 'layer' | 'full',
): Compiled {
  const t0 = performance.now();
  try {
    const result = compile(CONFIG, {
      api,
      runtime: RUNTIME,
      fileSystem: files(source, kind),
      alsoWithoutFast: true,
    });
    const file = result.files.find(f => f.fileName === PROGRAM);
    return {
      fast: file?.code ?? null,
      proxy: file?.withoutFast?.code ?? null,
      diagnostics: result.diagnostics
        .filter(d => d.file === PROGRAM)
        .map(({line, col, message}) => ({line, col, message})),
      ms: Math.round(performance.now() - t0),
    };
  } catch (e) {
    // OXC refuses a program that does not parse
    return {
      fast: null,
      proxy: null,
      diagnostics: [
        {line: 1, col: 1, message: String((e as Error).message ?? e)},
      ],
      ms: Math.round(performance.now() - t0),
    };
  }
}
