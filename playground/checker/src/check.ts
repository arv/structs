// check(tsconfigPath, { runtime }): the diagnostics that `tsgo own check -p <tsconfig> --ownRuntime
// <runtime>` reports, computed with TypeScript 7.1's API instead of a fork of the compiler.

import { isAbsolute, resolve } from "node:path";
import { API } from "typescript/sync";
import type { SourceFile } from "typescript/ast";
import { Own } from "./context.ts";
import { createHost, ModuleKind } from "./host.ts";
import type { Host } from "./host.ts";
import { computeConversions } from "./layout.ts";
import { formatMessage, Messages } from "./messages.ts";
import type { Diagnostic } from "./messages.ts";
import { checkOwnership } from "./ownership.ts";
import { checkRefCounts } from "./refcount.ts";
import { K } from "./syntax.ts";
import type { Node } from "./syntax.ts";

export interface CheckOptions {
  // The module specifier programs import the runtime from (`threads`, `./threads.mjs`): its exports
  // are the markers.
  runtime: string;
  // An API session to use (and leave open); by default one is started and closed.
  api?: API;
}

// An error that means the project could not be checked (a missing tsconfig, an API failure).
export class CheckError extends Error {}

export function check(tsconfigPath: string, options: CheckOptions): Diagnostic[] {
  const tsconfig = isAbsolute(tsconfigPath) ? tsconfigPath : resolve(tsconfigPath);
  const api = options.api ?? new API({ cwd: process.cwd() });
  try {
    let host: Host;
    try {
      host = createHost(api, tsconfig);
    } catch (e) {
      throw new CheckError(`cannot load the project ${tsconfigPath}: ${(e as Error).message}`);
    }
    try {
      return checkProgram(host, tsconfig, options.runtime);
    } finally {
      host.snapshot.dispose();
    }
  } finally {
    if (!options.api) api.close();
  }
}

function checkProgram(host: Host, tsconfig: string, runtime: string): Diagnostic[] {
  const { api, program } = host;
  const diagnostics: Diagnostic[] = [];

  // The runtime helpers are imported with an ES `import` (program.go).
  // (CompilerOptions.GetEmitModuleKind: `module`, or one the target implies.)
  const compilerOptions = program.getCompilerOptions() as { module?: number; target?: number };
  const target = compilerOptions.target || 99;
  const moduleKind = compilerOptions.module || (target >= 2 /* ES2015 */ ? ModuleKind.ES2015 : ModuleKind.CommonJS);
  if (moduleKind < ModuleKind.ES2015) diagnostics.push(optionDiagnostic(host, tsconfig, "ownRuntime"));

  // The program's files, but for the default library and the declaration files of packages (which
  // the fork looks at too, but which never use the runtime: fetching them would be costly).
  const names = program.getSourceFileNames();
  const metadata = api.batch(...names.map((name) => program.getSourceFileMetadata.gen(name)));
  const wanted = names.filter((name, i) => !metadata[i]?.isDefaultLibrary && !(metadata[i]?.isFromExternalLibrary && /\.d\.([^./]+\.)?[cm]?ts$/i.test(name)));
  const files = api.batch(...wanted.map((name) => program.getSourceFile.gen(name))).filter((f): f is SourceFile => !!f);

  // The files the runtime specifier resolves to, from any file that imports it.
  const runtimeFiles = new Map<string, SourceFile>();
  for (const file of files) {
    for (const specifier of file.imports as Node[]) {
      if (specifier.text !== runtime) continue;
      const resolved = program.getResolvedModuleFromModuleSpecifier(specifier as any, file.fileName);
      if (!resolved?.resolvedFileName) continue;
      const target = program.getSourceFile(resolved.resolvedFileName);
      if (target) runtimeFiles.set(target.path, target);
    }
  }

  const checked = files.filter((f) => !f.isDeclarationFile);
  const c = new Own(host, runtime, [...runtimeFiles.values()], checked);
  // (The fork runs these checks after checking each file; the API's checker answers questions in
  // the order they are asked, and its diagnostics come from other checkers, so there is no checking
  // a file first here.)
  for (const file of checked) host.prefetch(file);
  for (const file of checked) {
    checkOwnership(c, file);
    computeConversions(c, file);
    checkRefCounts(c, file);
  }

  const byFile = new Map(checked.map((f) => [f.fileName as string, f]));
  for (const d of c.diagnostics) {
    const file = byFile.get(d.file!);
    if (!file || !isSuppressed(file, d.start)) diagnostics.push(d);
  }
  return sortAndDeduplicate(diagnostics);
}

// The diagnostic of an option (program.go's createDiagnosticForOptionName): on the option's key in
// the tsconfig's compilerOptions, or else on the `compilerOptions` key, or else global.
function optionDiagnostic(host: Host, tsconfig: string, option: string): Diagnostic {
  const message = formatMessage(Messages.RuntimeNeedsESModules, [option]);
  const code = Messages.RuntimeNeedsESModules.code;
  const config = host.program.getConfigSourceFile(tsconfig);
  const root = (config?.statements[0] as Node | undefined)?.expression as Node | undefined;
  const property = (literal: Node | undefined, name: string): Node | undefined =>
    literal?.kind === K.ObjectLiteralExpression
      ? (literal.properties as Node[]).find((p) => p.kind === K.PropertyAssignment && p.name.text === name)
      : undefined;
  const compilerOptions = property(root, "compilerOptions");
  const key = (property(compilerOptions?.initializer, option) ?? compilerOptions)?.name as Node | undefined;
  if (!config || !key) return { file: undefined, start: 0, line: 0, col: 0, code, message };
  const start = key.getStart(config);
  const { line, character } = config.getLineAndCharacterOfPosition(start);
  return { file: config.fileName, start, line: line + 1, col: character + 1, code, message };
}

// Reports whether a `// @ts-ignore` or `// @ts-expect-error` comment above a position suppresses a
// diagnostic there (the program's filter of semantic diagnostics), looking up through blank and
// comment lines.
function isSuppressed(file: SourceFile, pos: number): boolean {
  const text = file.text;
  const starts = file.getLineStarts();
  let line = file.getLineAndCharacterOfPosition(pos).line - 1;
  for (; line >= 0; line--) {
    const lineText = text.slice(starts[line], line + 1 < starts.length ? starts[line + 1] : text.length).trim();
    if (/^\/\/\/?\s*@ts-(expect-error|ignore)\b/.test(lineText) || /^\/\*+\s*@ts-(expect-error|ignore)\b/.test(lineText)) return true;
    if (lineText !== "" && !lineText.startsWith("//") && !lineText.startsWith("/*") && !lineText.startsWith("*")) return false;
  }
  return false;
}

// compiler.SortAndDeduplicateDiagnostics: by file, position, code and message.
export function sortAndDeduplicate(diagnostics: Diagnostic[]): Diagnostic[] {
  const sorted = [...diagnostics].sort((a, b) =>
    compare(a.file ?? "", b.file ?? "") || a.start - b.start || a.code - b.code || compare(a.message, b.message));
  return sorted.filter((d, i) => {
    const p = sorted[i - 1];
    return !p || p.file !== d.file || p.start !== d.start || p.code !== d.code || p.message !== d.message;
  });
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
