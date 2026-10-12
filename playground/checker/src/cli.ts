#!/usr/bin/env -S node --experimental-strip-types
// threads-check -p <tsconfig.json> --runtime <module>: the ownership diagnostics of a project, in
// tsc's format (`file(line,col): error TS96001: ...`).
//
// Exit status: 0 without diagnostics, 1 with some, 3 if the project cannot be checked.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { check } from "./check.ts";
import { formatDiagnostic } from "./messages.ts";
import type { Diagnostic } from "./messages.ts";

const usage = `Usage: threads-check [-p <tsconfig.json>] --runtime <module>
  Reports the ownership diagnostics of threads for JavaScript (TS96001-TS96026) for a project:
  <module> is the specifier its programs import the runtime from (e.g. threads, ./threads.js).`;

function main(args: string[]): number {
  let project = ".";
  let runtime: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-p" || arg === "--project") {
      project = args[++i] ?? "";
    } else if (arg === "--runtime" || arg === "--ownRuntime") {
      runtime = args[++i];
    } else if (arg === "--pretty") {
      // tsc's flag: the output is always the plain format.
      if (args[i + 1] === "true" || args[i + 1] === "false") i++;
    } else if (arg === "-h" || arg === "--help") {
      console.log(usage);
      return 0;
    } else {
      console.error(`threads-check: unknown argument '${arg}'\n${usage}`);
      return 3;
    }
  }
  if (!runtime) {
    console.error(`threads-check: no runtime. Give the module programs import the runtime from: --runtime threads\n${usage}`);
    return 3;
  }
  let tsconfig = project;
  if (existsSync(tsconfig) && statSync(tsconfig).isDirectory()) tsconfig = join(tsconfig, "tsconfig.json");
  if (!existsSync(tsconfig)) {
    console.error(`error TS5058: The specified path does not exist: '${tsconfig}'.`);
    return 3;
  }
  let diagnostics: Diagnostic[];
  try {
    diagnostics = check(tsconfig, { runtime });
  } catch (e) {
    console.error(`threads-check: ${(e as Error).message}`);
    return 3;
  }
  for (const d of diagnostics) console.log(formatDiagnostic(d));
  return diagnostics.length > 0 ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
