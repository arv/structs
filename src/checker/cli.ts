#!/usr/bin/env -S node --experimental-strip-types
// threads-check -p <tsconfig.json> --runtime <module>: the ownership
// diagnostics of a project, in tsc's format (`file(line,col): error TS96001:
// ...`).
//
// Exit status: 0 without diagnostics, 1 with some, 2 if the tsconfig has errors
// (reported as tsc reports them, and not checked further), 3 if the project
// cannot be checked, 4 on an internal error (a bug in threads-check).

import {existsSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {check, CheckError} from './check.ts';
import {formatDiagnostic, Messages} from './messages.ts';
import type {Diagnostic} from './messages.ts';

// the checker's codes: a diagnostic of another is tsc's, of the tsconfig
const codes = new Set<number>(Object.values(Messages).map(m => m.code));

const usage = `Usage: threads-check [-p <tsconfig.json>] --runtime <module>
  Reports the ownership diagnostics of threads for JavaScript (TS${Math.min(...codes)}-TS${Math.max(...codes)}) for a project:
  <module> is the specifier its programs import the runtime from (e.g. @arv/threads).
  Exit status: 0 without diagnostics, 1 with some, 2 if the tsconfig has errors,
  3 if the project cannot be checked, 4 on an internal error.`;

function main(args: string[]): number {
  let project = '.';
  let runtime: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-p' || arg === '--project') {
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
    diagnostics = check(tsconfig, {runtime});
  } catch (e) {
    if (e instanceof CheckError) {
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

process.exitCode = main(process.argv.slice(2));
