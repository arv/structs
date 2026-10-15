#!/usr/bin/env node
// threads-check -p <tsconfig.json> --runtime <module>: the ownership
// diagnostics of a project, in tsc's format (`file(line,col): error TS96001:
// ...`).
//
// threads-check compile -p <tsconfig.json> --runtime <module> [--outDir <dir>]
// [--sourceMap]: the same, and the project's files compiled to JavaScript in
// outDir (the tsconfig's by default), as the fork's `tsgo -p` emits them:
// typed layouts lowered, references counted, functions registered, types
// stripped (by OXC). Like tsc, it writes the files whatever it reports.
//
// Exit status: 0 without diagnostics, 1 with some, 2 if the tsconfig has errors
// (reported as tsc reports them, and not checked further), 3 if the project
// cannot be checked, 4 on an internal error (a bug in threads-check).

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {basename, dirname, join, relative, resolve} from 'node:path';
import {check, CheckError} from './check.ts';
import {compile, toJavaScript} from './compile.ts';
import type {CompiledFile} from './compile.ts';
import {formatDiagnostic, Messages} from './messages.ts';
import type {Diagnostic} from './messages.ts';

// the checker's codes: a diagnostic of another is tsc's, of the tsconfig
const codes = new Set<number>(Object.values(Messages).map(m => m.code));

const usage = `Usage: threads-check [-p <tsconfig.json>] --runtime <module>
       threads-check compile [-p <tsconfig.json>] --runtime <module> [--outDir <dir>] [--sourceMap]
  Reports the ownership diagnostics of threads for JavaScript (TS${Math.min(...codes)}-TS${Math.max(...codes)}) for a project:
  <module> is the specifier its programs import the runtime from (e.g. @arv/threads).
  compile also writes the project's files as JavaScript, compiled for the runtime,
  to <dir> (the tsconfig's outDir by default).
  Exit status: 0 without diagnostics, 1 with some, 2 if the tsconfig has errors,
  3 if the project cannot be checked, 4 on an internal error.`;

function main(args: string[]): number {
  let project = '.';
  let runtime: string | undefined;
  let compiling = false;
  let outDir: string | undefined;
  let sourceMap: boolean | undefined;
  if (args[0] === 'compile') {
    compiling = true;
    args = args.slice(1);
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (compiling && arg === '--outDir') {
      outDir = args[++i];
    } else if (compiling && arg === '--sourceMap') {
      sourceMap =
        args[i + 1] === 'false'
          ? (i++, false)
          : args[i + 1] === 'true'
            ? (i++, true)
            : true;
    } else if (arg === '-p' || arg === '--project') {
      project = args[++i] ?? '';
    } else if (arg === '--runtime' || arg === '--ownRuntime') {
      runtime = args[++i];
    } else if (arg === '--pretty') {
      // tsc's flag: the output is always the plain format.
      if (args[i + 1] === 'true' || args[i + 1] === 'false') i++;
    } else if (arg === '-h' || arg === '--help') {
      console.log(usage);
      return 0;
    } else {
      console.error(`threads-check: unknown argument '${arg}'\n${usage}`);
      return 3;
    }
  }
  if (!runtime) {
    console.error(
      `threads-check: no runtime. Give the module programs import the runtime from: --runtime @arv/threads\n${usage}`,
    );
    return 3;
  }
  let tsconfig = project;
  if (existsSync(tsconfig) && statSync(tsconfig).isDirectory())
    tsconfig = join(tsconfig, 'tsconfig.json');
  if (!existsSync(tsconfig)) {
    console.error(
      `error TS5058: The specified path does not exist: '${tsconfig}'.`,
    );
    return 3;
  }
  // tsc reads any file as a tsconfig, and a program as one is all syntax
  // errors
  if (/\.[cm]?[jt]sx?$/i.test(tsconfig)) {
    console.error(
      `threads-check: '${tsconfig}' is a program, not a project: -p takes a tsconfig.json, or a directory with one`,
    );
    return 3;
  }
  let diagnostics: Diagnostic[];
  try {
    if (compiling) {
      const result = compile(tsconfig, {runtime, check: true, types: true});
      // the tsconfig's errors stop it; type errors and ownership errors are
      // reported, and the files written all the same, as tsc does
      if (result.diagnostics.some(d => !codes.has(d.code))) {
        for (const d of result.diagnostics) console.log(formatDiagnostic(d));
        return 2;
      }
      writeOutput(tsconfig, result, outDir, sourceMap);
      diagnostics = [...result.typeDiagnostics, ...result.diagnostics];
      for (const d of diagnostics) console.log(formatDiagnostic(d));
      return diagnostics.length > 0 ? 1 : 0;
    } else {
      diagnostics = check(tsconfig, {runtime});
    }
  } catch (e) {
    if (e instanceof CheckError || e instanceof CompileOutputError) {
      console.error(`threads-check: ${e.message}`);
      return 3;
    }
    console.error(
      `threads-check: internal error, a bug in threads-check:\n${(e instanceof Error && e.stack) || String(e)}`,
    );
    return 4;
  }
  for (const d of diagnostics) console.log(formatDiagnostic(d));
  if (diagnostics.some(d => !codes.has(d.code))) return 2;
  return diagnostics.length > 0 ? 1 : 0;
}

// Writes a compiled project's files: each as JavaScript at its place under
// rootDir (the tsconfig's, or the directory of its files) in outDir.
function writeOutput(
  tsconfig: string,
  result: ReturnType<typeof compile>,
  outDirOption: string | undefined,
  sourceMapOption: boolean | undefined,
): void {
  const options = result.compilerOptions;
  const outDir = outDirOption
    ? resolve(outDirOption)
    : typeof options.outDir === 'string'
      ? options.outDir
      : undefined;
  const sourceMap = sourceMapOption ?? !!options.sourceMap;
  const files = result.files;
  const rootDir =
    typeof options.rootDir === 'string'
      ? options.rootDir
      : commonDirectory(
          files.map(f => dirname(f.fileName)),
          tsconfig,
        );
  // nothing written over a source (a JavaScript input, with allowJs and no
  // outDir), and nothing written twice
  const inputs = new Set(files.map(f => resolve(f.fileName)));
  const outputs = new Map<string, string>();
  for (const file of files) {
    const out = resolve(outputPath(file, rootDir, outDir));
    if (inputs.has(out) || outputs.has(out))
      throw new CompileOutputError(
        `cannot write ${relative(process.cwd(), out)}: it would overwrite ${inputs.has(out) ? 'an input of the project' : `the output of ${relative(process.cwd(), outputs.get(out)!)}`}. Name an output directory (--outDir, or the tsconfig's outDir)`,
      );
    outputs.set(out, file.fileName);
  }
  for (const file of files) {
    // an imported JSON file (resolveJsonModule), copied as it is
    if (/\.json$/i.test(file.fileName)) {
      const out = outputPath(file, rootDir, outDir);
      mkdirSync(dirname(out), {recursive: true});
      copyFileSync(file.fileName, out);
      continue;
    }
    const js = toJavaScript(file, {
      verbatimModuleSyntax: !!options.verbatimModuleSyntax,
      rewriteRelativeImportExtensions:
        !!options.rewriteRelativeImportExtensions,
    });
    const out = outputPath(file, rootDir, outDir);
    mkdirSync(dirname(out), {recursive: true});
    let code = js.code;
    if (sourceMap) {
      const map = {
        ...js.map,
        file: basename(out),
        sources: js.map.sources.map(s => relative(dirname(out), s)),
      };
      writeFileSync(`${out}.map`, JSON.stringify(map));
      code += `${code.endsWith('\n') ? '' : '\n'}//# sourceMappingURL=${basename(out)}.map\n`;
    }
    writeFileSync(out, code);
  }
}

// An output that cannot be written, which stops the compile before it writes
// anything.
class CompileOutputError extends Error {}

// Where a file's JavaScript goes: .ts as .js, .mts as .mjs, .cts as .cjs, .tsx
// as .jsx (its JSX left for a bundler); beside it without an outDir.
function outputPath(
  file: CompiledFile,
  rootDir: string,
  outDir: string | undefined,
): string {
  const name = file.fileName
    .replace(/\.([cm]?)ts$/i, '.$1js')
    .replace(/\.tsx$/i, '.jsx');
  return outDir ? join(outDir, relative(rootDir, name)) : name;
}

// The longest directory that holds every file's (tsc's common source
// directory), or the tsconfig's for none.
function commonDirectory(dirs: string[], tsconfig: string): string {
  if (dirs.length === 0) return dirname(tsconfig);
  let common = dirs[0]!.split('/');
  for (const dir of dirs.slice(1)) {
    const parts = dir.split('/');
    let n = 0;
    while (n < common.length && n < parts.length && common[n] === parts[n]) n++;
    common = common.slice(0, n);
  }
  return common.join('/') || '/';
}

process.exitCode = main(process.argv.slice(2));
