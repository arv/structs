// @arv/structs-compiler/register: Node runs the proposal's syntax.
//
//   node --import @arv/structs-compiler/register main.js
//
// A module whose source has a struct declaration is compiled as it loads
// (transpile: one file at a time, no type checking), in this thread and in
// the workers it starts, which inherit the flag.
//
// The compiler parses with TypeScript 7's API, which runs tsgo as a process,
// and a worker thread cannot start it (tsgo's stderr is inherited, and a
// worker has none of its own). So a compile is kept, on disk, by the file, its
// source and the compiler: a worker mostly loads what the main thread did,
// and reads it there; one that finds nothing compiles in a child process.

import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isMainThread} from 'node:worker_threads';
import {formatDiagnostic, transpile} from './index.ts';
import type {TranspileResult} from './index.ts';

// the runtime the compiled code imports: @arv/structs, which is installed
// beside this package (its peer)
const RUNTIME = import.meta.resolve('@arv/structs/runtime');
// the compiler's version, from its package.json (by the package's own name:
// beside the source, above the build)
const VERSION = (
  JSON.parse(
    readFileSync(
      fileURLToPath(import.meta.resolve('@arv/structs-compiler/package.json')),
      'utf8',
    ),
  ) as {version: string}
).version;
const CACHE = join(tmpdir(), 'structs-compiler-cache');
// beside this module, as it is run: the source, or the build
const CHILD = new URL(
  import.meta.url.endsWith('.ts')
    ? './transpile-child.ts'
    : './transpile-child.js',
  import.meta.url,
);

function compile(fileName: string, source: string): TranspileResult {
  const key = createHash('sha256')
    .update(`${VERSION}\0${RUNTIME}\0${fileName}\0${source}`)
    .digest('hex');
  const kept = join(CACHE, `${key}.json`);
  try {
    return JSON.parse(readFileSync(kept, 'utf8')) as TranspileResult;
  } catch {}
  const out = isMainThread
    ? transpile(source, {fileName, runtime: RUNTIME})
    : (JSON.parse(
        execFileSync(
          process.execPath,
          [fileURLToPath(CHILD), fileName, RUNTIME],
          {
            input: source,
            encoding: 'utf8',
            maxBuffer: 1 << 28,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        ),
      ) as TranspileResult);
  // whole, or not at all: written beside it, then renamed
  mkdirSync(CACHE, {recursive: true});
  const partial = `${kept}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(partial, JSON.stringify(out));
  renameSync(partial, kept);
  return out;
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith('file:') || !/\.[cm]?[jt]s$/.test(url)) return result;
    const raw = result.source;
    const source =
      typeof raw === 'string'
        ? raw
        : raw
          ? new TextDecoder().decode(raw as ArrayBufferView | ArrayBuffer)
          : '';
    if (!/\bstruct\b/.test(source)) return result;
    const out = compile(fileURLToPath(url), source);
    if (out.diagnostics.length > 0)
      throw new SyntaxError(out.diagnostics.map(formatDiagnostic).join('\n'));
    if (out.code === source) return result;
    const map = Buffer.from(JSON.stringify(out.map)).toString('base64');
    return {
      format: 'module',
      source: `${out.code}\n//# sourceMappingURL=data:application/json;base64,${map}\n`,
      shortCircuit: true,
    };
  },
});
