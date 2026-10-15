// compile(tsconfigPath, { runtime }): what `tsgo -p <tsconfig> --ownRuntime
// <runtime>` emits for each of a project's files, on TypeScript 7.1's API
// instead of a fork of the compiler: the file's TypeScript with its typed
// layouts lowered, its references counted and its functions registered
// (transform.ts), its types left in for a type stripper to erase (Vite's OXC,
// or toJavaScript here), with a source map from the original.

import {basename, isAbsolute, resolve} from 'node:path';
import {decode, encode} from '@jridgewell/sourcemap-codec';
import type {SourceMapMappings} from '@jridgewell/sourcemap-codec';
import {transformSync} from 'oxc-transform';
import type {RequestFileSystem} from 'typescript/proto';
import {API} from 'typescript/sync';
import {
  CheckError,
  finish,
  fromApi,
  loadProgram,
  sortAndDeduplicate,
} from './check.ts';
import {createHost} from './host.ts';
import type {Host} from './host.ts';
import {computeConversions} from './layout.ts';
import {formatMessage, Messages} from './messages.ts';
import type {Diagnostic} from './messages.ts';
import {checkOwnership} from './ownership.ts';
import {checkRefCounts} from './refcount.ts';
import {Resolver} from './resolver.ts';
import {transformFile} from './transform.ts';

export interface CompileOptions {
  // the module specifier programs import the runtime from
  runtime: string;
  // an API session to use (and leave open); by default one is started and
  // closed
  api?: API;
  // also report the ownership diagnostics, as `check` does (the fork's
  // compile reports them too)
  check?: boolean;
  // also report the files' type errors (TypeScript's syntactic and semantic
  // diagnostics), as tsc and the fork's compile do
  types?: boolean;
  // the project's files, sent with the request rather than read from disk
  // (typescript/fs's createFileSystemWithLib makes one): for an API with no
  // disk of its own, such as the playground's, in WebAssembly
  fileSystem?: RequestFileSystem;
}

// A source map (version 3).
export interface SourceMap {
  version: number;
  file?: string;
  sources: string[];
  sourcesContent?: (string | null)[];
  names: string[];
  mappings: string;
}

export interface CompiledFile {
  // the source file
  fileName: string;
  // its TypeScript, with the edits; the original where nothing changed
  code: string;
  // from the original to code
  map: SourceMap;
  changed: boolean;
  // the top-level functions it registers for threads to run, if any
  registered: string[];
}

export interface CompileResult {
  files: CompiledFile[];
  // the tsconfig's errors and the project's (a module kind the runtime's
  // helpers cannot be imported into), and with `check` the ownership
  // diagnostics
  diagnostics: Diagnostic[];
  // (with `types`) the files' type errors
  typeDiagnostics: Diagnostic[];
  // the project's compiler options, as the API reads them
  compilerOptions: Record<string, unknown>;
}

export function compile(
  tsconfigPath: string,
  options: CompileOptions,
): CompileResult {
  const tsconfig = isAbsolute(tsconfigPath)
    ? tsconfigPath
    : resolve(tsconfigPath);
  const api = options.api ?? new API({cwd: process.cwd()});
  try {
    let host: Host;
    try {
      host = createHost(api, tsconfig, options.fileSystem);
    } catch (e) {
      throw new CheckError(
        `cannot load the project ${tsconfigPath}: ${(e as Error).message}`,
      );
    }
    try {
      const compilerOptions = host.program.getCompilerOptions() as Record<
        string,
        unknown
      >;
      const configErrors = host.program.getConfigFileParsingDiagnostics();
      if (configErrors.length > 0)
        return {
          files: [],
          diagnostics: sortAndDeduplicate(configErrors.map(fromApi)),
          typeDiagnostics: [],
          compilerOptions,
        };
      return compileProgram(host, tsconfig, options, compilerOptions);
    } finally {
      host.snapshot.dispose();
    }
  } finally {
    if (!options.api) api.close();
  }
}

function compileProgram(
  host: Host,
  tsconfig: string,
  options: CompileOptions,
  compilerOptions: Record<string, unknown>,
): CompileResult {
  const program = loadProgram(host, tsconfig, options.runtime, {
    runtimeRequired: false,
  });
  const c = program.own;
  for (const file of program.files) {
    if (options.check) checkOwnership(c, file);
    computeConversions(c, file);
    if (options.check) checkRefCounts(c, file);
  }
  const resolver = new Resolver(c);
  const forceModule = compilerOptions.moduleDetection === 3; // Force
  const files: CompiledFile[] = [];
  for (const file of program.files) {
    // the project's own sources only: a package's are analyzed, not emitted
    if (program.external.has(file.fileName as string)) continue;
    // nor a CommonJS one, which is an error: the compile writes ES modules
    // only
    if (program.commonJS.has(file.fileName as string)) continue;
    const result = transformFile(resolver, file, {
      runtime: options.runtime,
      esModule: true,
      forceModule,
    });
    files.push({
      fileName: file.fileName,
      code: result.code,
      map: result.map as SourceMap,
      changed: result.changed,
      registered: result.registered,
    });
  }
  let typeDiagnostics: Diagnostic[] = [];
  if (options.types) {
    // the whole program's, declaration files included, as tsc reports them
    // (skipLibCheck leaves them out)
    typeDiagnostics = sortAndDeduplicate(
      [
        ...host.program.getSyntacticDiagnostics(),
        ...host.program.getSemanticDiagnostics(),
        ...host.program.getGlobalDiagnostics(),
      ].map(fromApi),
    );
  }
  // each CommonJS file, which it does not compile
  const commonJS: Diagnostic[] = [...program.commonJS].map(fileName => ({
    file: fileName,
    start: 0,
    line: 1,
    col: 1,
    code: Messages.CommonJSInput.code,
    message: formatMessage(Messages.CommonJSInput, [basename(fileName)]),
  }));
  return {
    files,
    // the project's own (an option the runtime cannot work with, a CommonJS
    // file), and with `check` the ownership diagnostics
    diagnostics: sortAndDeduplicate([
      ...(options.check ? finish(program) : program.diagnostics),
      ...commonJS,
    ]),
    typeDiagnostics,
    compilerOptions,
  };
}

export interface JavaScriptOptions {
  // erase the imports of types only, and keep every other (tsconfig's
  // verbatimModuleSyntax); otherwise an import none of whose names is used
  // as a value goes, as tsc elides it
  verbatimModuleSyntax?: boolean;
  // `./x.ts` imports `./x.js` (tsconfig's rewriteRelativeImportExtensions)
  rewriteRelativeImportExtensions?: boolean;
}

// A compiled file as JavaScript: its types stripped by OXC (the syntax is
// left as it is written, `using` and all), with a source map from the
// original. The file name says the language (.ts, .mts, .cts, .tsx, and with
// allowJs .js, .mjs, .cjs, .jsx; JSX is left for a bundler).
export function toJavaScript(
  file: CompiledFile,
  options: JavaScriptOptions = {},
): {code: string; map: SourceMap} {
  const lang = /\.[cm]?jsx?$/i.test(file.fileName)
    ? /x$/i.test(file.fileName)
      ? 'jsx'
      : 'js'
    : /\.tsx$/i.test(file.fileName)
      ? 'tsx'
      : 'ts';
  const result = transformSync(file.fileName, file.code, {
    lang,
    sourceType: 'module',
    target: 'esnext',
    sourcemap: true,
    jsx: 'preserve',
    typescript: {
      onlyRemoveTypeImports: !!options.verbatimModuleSyntax,
      rewriteImportExtensions: options.rewriteRelativeImportExtensions
        ? 'rewrite'
        : false,
    },
  });
  if (result.errors.length > 0)
    throw new Error(
      `cannot strip the types of ${file.fileName}: ${result.errors.map(e => e.message).join('; ')}`,
    );
  const map = result.map
    ? composeMaps(result.map as SourceMap, file.map)
    : file.map;
  return {code: result.code, map};
}

// The source map of two steps: `outer` maps the output to the intermediate
// code, `inner` the intermediate code to the original. Each segment of the
// outer map goes where the inner map puts its position (the closest segment
// at or before it on its line).
export function composeMaps(outer: SourceMap, inner: SourceMap): SourceMap {
  const innerLines = decode(inner.mappings);
  const out: SourceMapMappings = decode(outer.mappings).map(line => {
    const mapped: SourceMapMappings[number] = [];
    for (const segment of line) {
      // a column mapped to nothing: it ends the segment before it
      const unmapped = () => mapped.push([segment[0]]);
      if (segment.length < 4) {
        unmapped();
        continue;
      }
      const innerLine = innerLines[segment[2]!];
      if (!innerLine || innerLine.length === 0) {
        unmapped();
        continue;
      }
      const column = segment[3]!;
      // the last segment at or before the column
      let lo = 0,
        hi = innerLine.length - 1,
        found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (innerLine[mid]![0] <= column) {
          found = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      const target = found < 0 ? undefined : innerLine[found]!;
      if (!target || target.length < 4) {
        unmapped();
        continue;
      }
      mapped.push([segment[0], target[1]!, target[2]!, target[3]!]);
    }
    return mapped;
  });
  return {
    version: 3,
    file: outer.file,
    sources: inner.sources,
    sourcesContent: inner.sourcesContent,
    names: [],
    mappings: encode(out),
  };
}
