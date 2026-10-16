#!/usr/bin/env node
// structs: the compiler's command line.
//
//   structs compile -p tsconfig.json [--outDir dir] [--runtime specifier]
//                   [--no-fast] [--typescript]
//       type checks a TypeScript project and compiles it to outDir (the
//       tsconfig's, or build/), each file with its source map
//
//   structs transpile file.js [-o out.js] [--runtime specifier]
//       compiles one file, JavaScript or TypeScript, without type checking

import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, relative, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {
  closeApi,
  compile,
  DEFAULT_RUNTIME,
  formatDiagnostic,
  transpile,
} from './index.ts';
import type {SourceMap} from './index.ts';

const USAGE = `usage:
  structs compile -p tsconfig.json [--outDir dir] [--runtime specifier] [--no-fast] [--typescript]
  structs transpile file [-o out] [--runtime specifier] [--typescript]`;

function write(file: string, code: string, map: SourceMap) {
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(file, `${code}\n//# sourceMappingURL=${basename(file)}.map\n`);
  writeFileSync(`${file}.map`, JSON.stringify({...map, file: basename(file)}));
}

const outName = (file: string, typescript: boolean) =>
  typescript ? file : file.replace(/\.([cm]?)tsx?$/, '.$1js');

// the deepest directory that holds all of the files
function commonDir(files: string[]) {
  let dir = dirname(files[0]!);
  while (!files.every(f => !relative(dir, f).startsWith('..')))
    dir = dirname(dir);
  return dir;
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const {values, positionals} = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      'project': {type: 'string', short: 'p'},
      'outDir': {type: 'string'},
      'out': {type: 'string', short: 'o'},
      'runtime': {type: 'string'},
      'no-fast': {type: 'boolean'},
      'typescript': {type: 'boolean'},
    },
  });
  const runtime = values.runtime ?? DEFAULT_RUNTIME;
  const typescript = !!values.typescript;
  if (command === 'compile') {
    const tsconfig = values.project ?? positionals[0] ?? 'tsconfig.json';
    const result = compile(tsconfig, {
      runtime,
      typescript,
      fast: !values['no-fast'],
    });
    for (const d of result.diagnostics) console.error(formatDiagnostic(d));
    if (result.diagnostics.length > 0) return 1;
    if (result.files.length === 0) return 0;
    const outDir = resolve(values.outDir ?? result.outDir ?? 'build');
    const root = result.rootDir ?? commonDir(result.files.map(f => f.fileName));
    for (const f of result.files)
      write(
        join(outDir, outName(relative(root, f.fileName), typescript)),
        f.code,
        f.map,
      );
    return 0;
  }
  if (command === 'transpile') {
    const file = positionals[0];
    if (!file) {
      console.error(USAGE);
      return 2;
    }
    const result = transpile(readFileSync(file, 'utf8'), {
      fileName: file,
      runtime,
      typescript,
    });
    closeApi();
    for (const d of result.diagnostics) console.error(formatDiagnostic(d));
    if (result.diagnostics.length > 0) return 1;
    if (values.out) write(values.out, result.code, result.map);
    else process.stdout.write(result.code);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
