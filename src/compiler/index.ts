// @arv/structs/compiler: struct syntax (§1.1, §2.2) compiled to JavaScript
// (or TypeScript) that calls the runtime.
//
//   transpile(source, options)  one file, on its own: the structs lowered,
//                               types stripped (or kept, with `typescript`)
//   compile(tsconfig, options)  a TypeScript project, type checked, with
//                               field access on shared structs made direct
//                               where the types prove the shape (fast.ts)

import {decode, encode} from '@jridgewell/sourcemap-codec';
import type {SourceMapMappings} from '@jridgewell/sourcemap-codec';
import {transformSync} from 'oxc-transform';
import {API} from 'typescript/sync';
import {scan} from './scan.ts';
import {lower} from './transform.ts';
import type {Lowered} from './transform.ts';

export {scan} from './scan.ts';
export {compile} from './project.ts';
export type {CompileOptions, CompileResult, CompiledFile} from './project.ts';

export const DEFAULT_RUNTIME = '@arv/structs/runtime';

export interface SourceMap {
  version: number;
  file?: string;
  sources: string[];
  sourcesContent?: (string | null)[];
  names: string[];
  mappings: string;
}

export interface Diagnostic {
  file: string;
  line: number; // 1-based
  col: number; // 1-based
  message: string;
}

export interface TranspileOptions {
  // the file's name: says whether it is TypeScript (.ts, .mts, .cts, .tsx)
  fileName?: string;
  // the module specifier the output imports the runtime from
  runtime?: string;
  // keep the types (TypeScript in, TypeScript out)
  typescript?: boolean;
  // an API session to use (and leave open); by default one is shared
  api?: API;
}

export interface TranspileResult {
  code: string;
  map: SourceMap;
  diagnostics: Diagnostic[];
}

let sharedApi: API | undefined;
// The TypeScript API session transpile parses with: one, started when first
// needed. closeApi ends it.
export function api() {
  return (sharedApi ??= new API({cwd: process.cwd()}));
}
export function closeApi() {
  sharedApi?.close();
  sharedApi = undefined;
}

export const isTypeScript = (fileName: string) =>
  /\.[cm]?tsx?$/i.test(fileName);

export function transpile(
  source: string,
  options: TranspileOptions = {},
): TranspileResult {
  const fileName = options.fileName ?? 'input.js';
  const scanned = scan(source);
  let lowered: Lowered | undefined;
  if (scanned.structs.length > 0) {
    const retained = (options.api ?? api()).createSourceFile(
      fileName.startsWith('/') ? fileName : '/' + fileName,
      scanned.text,
    );
    try {
      lowered = lower(source, scanned, retained.sourceFile);
    } finally {
      retained.dispose?.();
    }
  }
  const diagnostics = (lowered?.diagnostics ?? []).map(d =>
    diagnostic(fileName, source, d.start, d.message),
  );
  const emitted = finish(
    source,
    fileName,
    lowered,
    options.runtime ?? DEFAULT_RUNTIME,
  );
  if (options.typescript || !isTypeScript(fileName))
    return {...emitted, diagnostics};
  return {...toJavaScript(fileName, emitted), diagnostics};
}

// The edited text, with the runtime imported where it is used, and its map.
export function finish(
  source: string,
  fileName: string,
  lowered: Lowered | undefined,
  runtime: string,
  // what follows the import of the runtime
  prelude = '',
): {code: string; map: SourceMap} {
  if (!lowered) return {code: source, map: identityMap(fileName, source)};
  const {ms, runtimeName} = lowered;
  if (ms.hasChanged()) {
    // on the first line, so that the lines stay where they were
    const at = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;
    ms.appendLeft(
      at,
      `import * as ${runtimeName} from ${JSON.stringify(runtime)}; ${prelude}`,
    );
  }
  return {
    code: ms.toString(),
    map: ms.generateMap({
      hires: true,
      source: fileName,
      file: fileName,
      includeContent: true,
    }) as unknown as SourceMap,
  };
}

function identityMap(fileName: string, source: string): SourceMap {
  const lines: SourceMapMappings = source
    .split('\n')
    .map((_, i) => [[0, 0, i, 0]]);
  return {
    version: 3,
    file: fileName,
    sources: [fileName],
    sourcesContent: [source],
    names: [],
    mappings: encode(lines),
  };
}

export function diagnostic(
  file: string,
  text: string,
  pos: number,
  message: string,
): Diagnostic {
  const before = text.slice(0, pos).split('\n');
  return {
    file,
    line: before.length,
    col: before[before.length - 1]!.length + 1,
    message,
  };
}

export const formatDiagnostic = (d: Diagnostic) =>
  `${d.file}:${d.line}:${d.col}: ${d.message}`;

// TypeScript as JavaScript: its types stripped by OXC, with a source map from
// the original.
export function toJavaScript(
  fileName: string,
  compiled: {code: string; map: SourceMap},
  // `./x.ts` imported as `./x.js` (tsconfig's rewriteRelativeImportExtensions)
  rewriteImportExtensions = false,
): {code: string; map: SourceMap} {
  const result = transformSync(fileName, compiled.code, {
    lang: /\.tsx$/i.test(fileName) ? 'tsx' : 'ts',
    sourceType: 'module',
    target: 'esnext',
    sourcemap: true,
    jsx: 'preserve',
  });
  if (result.errors.length > 0)
    throw new Error(
      `cannot strip the types of ${fileName}: ${result.errors.map(e => e.message).join('; ')}`,
    );
  const map = result.map
    ? composeMaps(result.map as SourceMap, compiled.map)
    : compiled.map;
  // relative specifiers only, as TypeScript rewrites them (OXC's rewrite would
  // take the runtime's too, which may be a file: URL)
  const code = rewriteImportExtensions
    ? result.code.replace(
        /(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.\.?\/[^"'\n]*?)\.([cm]?)tsx?\2/g,
        '$1$2$3.$4js$2',
      )
    : result.code;
  return {code, map};
}

// The source map of two steps: `outer` maps the output to the intermediate
// code, `inner` the intermediate code to the original.
export function composeMaps(outer: SourceMap, inner: SourceMap): SourceMap {
  const innerLines = decode(inner.mappings);
  const out: SourceMapMappings = decode(outer.mappings).map(line => {
    const mapped: SourceMapMappings[number] = [];
    for (const segment of line) {
      if (segment.length < 4) {
        mapped.push([segment[0]]);
        continue;
      }
      const innerLine = innerLines[segment[2]!];
      const column = segment[3]!;
      // the last segment at or before the column
      let lo = 0,
        hi = (innerLine?.length ?? 0) - 1,
        found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (innerLine![mid]![0] <= column) {
          found = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      const target = found < 0 ? undefined : innerLine![found]!;
      if (!target || target.length < 4) mapped.push([segment[0]]);
      else mapped.push([segment[0], target[1]!, target[2]!, target[3]!]);
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
