// compile(tsconfig): a TypeScript project in the proposal's syntax, type
// checked and compiled. TypeScript sees each struct as the class scan.ts
// spells it (a layer over the files on disk), so it checks fields, methods
// and `new` as it checks a class's; the errors that hold for a class but not
// for a struct (a derived constructor without super(), say) are left out.
// Then each file is lowered (transform.ts), its shared struct field access
// made direct where the types allow (fast.ts), and its types stripped (or
// kept, with `typescript`).

import {readFileSync} from 'node:fs';
import {dirname, isAbsolute, resolve} from 'node:path';
import {SyntaxKind as K} from 'typescript/ast';
import type {RequestFileSystem} from 'typescript/proto';
import {API} from 'typescript/sync';
import type {Checker, Program, Type} from 'typescript/sync';
import {fastAccess} from './fast.ts';
import type {Layout} from './fast.ts';
import {DEFAULT_RUNTIME, diagnostic, finish, toJavaScript} from './index.ts';
import type {Diagnostic, SourceMap} from './index.ts';
import {scan} from './scan.ts';
import type {Scan} from './scan.ts';
import {children, lower} from './transform.ts';
import type {Lowered, Node, StructInfo} from './transform.ts';

export interface CompileOptions {
  // the module specifier the output imports the runtime from
  runtime?: string;
  // keep the types (TypeScript out)
  typescript?: boolean;
  // make shared struct field access direct where the types allow (default)
  fast?: boolean;
  // also compile each file without direct field access (CompiledFile's
  // withoutFast), from the same type check
  alsoWithoutFast?: boolean;
  // an API session to use (and leave open); by default one is started and
  // closed
  api?: API;
  // the project's files, the tsconfig among them, rather than the disk's
  // (with a symlink to the lib files): for an API with no disk of its own,
  // such as tsgo in WebAssembly
  fileSystem?: RequestFileSystem;
}

export interface CompiledFile {
  fileName: string;
  code: string;
  map: SourceMap;
  // with alsoWithoutFast: every field access through the Proxy
  withoutFast?: {code: string; map: SourceMap};
}

export interface CompileResult {
  files: CompiledFile[];
  // the configuration's, TypeScript's and the structs' errors
  diagnostics: Diagnostic[];
  // the tsconfig's outDir and rootDir, if it has them
  outDir?: string;
  rootDir?: string;
}

// TypeScript's errors that a struct does not have: its constructor is an
// initializer, run once the instance is made, so it needs no super() call
const CLASS_ONLY = new Set([
  2376, // a super() call must be the first statement
  2377, // a derived class's constructor must call super()
  2401, // a super() call must be a root-level statement
  17009, // super() must be called before `this` is used
]);

export function compile(
  tsconfigPath: string,
  options: CompileOptions = {},
): CompileResult {
  const tsconfig = isAbsolute(tsconfigPath)
    ? tsconfigPath
    : resolve(tsconfigPath);
  const api = options.api ?? new API({cwd: dirname(tsconfig)});
  try {
    const given = options.fileSystem;
    // the project's sources: those the tsconfig names, or (given files) every
    // source among them
    const config = given ? undefined : api.parseConfigFile(tsconfig);
    const diagnostics: Diagnostic[] = (config?.errors ?? []).map(d =>
      fromApi(d, undefined),
    );
    const names = config
      ? (config.fileNames as string[])
      : Object.keys(given!.files).filter(f => /\.[cm]?[jt]sx?$/.test(f));
    // the files that have structs, spelled as classes
    const sources = new Map<string, string>();
    const scans = new Map<string, Scan>();
    const layer: Record<string, string> = {};
    for (const fileName of names) {
      if (/\.d\.[cm]?ts$/.test(fileName)) continue;
      const text = given
        ? given.files[fileName]!
        : readFileSync(fileName, 'utf8');
      sources.set(fileName, text);
      const scanned = scan(text);
      scans.set(fileName, scanned);
      if (scanned.structs.length > 0) layer[fileName] = scanned.text;
    }
    const snapshot = api.createSnapshot({
      openProjects: [tsconfig],
      fileSystem: given
        ? {...given, files: {...given.files, ...layer}}
        : {kind: 'layer', files: layer},
    });
    try {
      const project =
        snapshot.getConfiguredProject(tsconfig) ?? snapshot.getProjects()[0];
      if (!project) throw new Error(`cannot open the project ${tsconfigPath}`);
      const compilerOptions = (config?.options ??
        project.program.getCompilerOptions()) as Record<string, unknown>;
      if (!config)
        for (const d of project.program.getConfigFileParsingDiagnostics())
          diagnostics.push(fromApi(d, undefined));
      return {
        ...compileProgram(
          project.program,
          project.checker,
          sources,
          scans,
          diagnostics,
          options,
          !!compilerOptions.rewriteRelativeImportExtensions,
        ),
        outDir: compilerOptions.outDir as string | undefined,
        rootDir: compilerOptions.rootDir as string | undefined,
      };
    } finally {
      snapshot.dispose();
    }
  } finally {
    if (!options.api) api.close();
  }
}

function compileProgram(
  program: Program,
  checker: Checker,
  sources: Map<string, string>,
  scans: Map<string, Scan>,
  diagnostics: Diagnostic[],
  options: CompileOptions,
  rewriteImportExtensions: boolean,
): CompileResult {
  const runtime = options.runtime ?? DEFAULT_RUNTIME;
  // every file lowered first, to know every struct
  const lowered = new Map<string, {file: Node; lowered: Lowered}>();
  const structs = new Map<string, StructInfo>();
  const keyOf = (node: Node) => `${node.getSourceFile().fileName}:${node.pos}`;
  for (const [fileName, text] of sources) {
    const file = program.getSourceFile(fileName) as Node | undefined;
    if (!file) continue;
    const l = lower(text, scans.get(fileName)!, file as any);
    lowered.set(fileName, {file, lowered: l});
    for (const s of l.structs) structs.set(keyOf(s.node), s);
    for (const d of l.diagnostics)
      diagnostics.push(diagnostic(fileName, text, d.start, d.message));
  }

  // TypeScript's errors, but those a struct does not have
  const ranges = [...structs.values()].map(s => ({
    file: s.node.getSourceFile().fileName as string,
    pos: s.node.pos as number,
    end: s.node.end as number,
  }));
  for (const d of [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ]) {
    if (
      CLASS_ONLY.has(d.code) &&
      ranges.some(r => r.file === d.fileName && d.pos >= r.pos && d.pos < r.end)
    )
      continue;
    diagnostics.push(fromApi(d, sources.get(d.fileName ?? '')));
  }

  // the layouts of the shared structs: their keys, the parents' first
  const layouts = new Map<StructInfo, Layout | null>();
  const structOfClass = (classType: Type | undefined) => {
    const decl = classType
      ?.getSymbol()
      ?.declarations?.find(d => d.kind === K.ClassDeclaration);
    const node = decl?.resolve() as Node | undefined;
    return node && structs.get(keyOf(node));
  };
  const layoutOfStruct = (s: StructInfo): Layout | null => {
    if (layouts.has(s)) return layouts.get(s)!;
    layouts.set(s, null); // a cycle has no layout
    let layout: Layout | null = null;
    if (s.shared && s.ownKeys) {
      const ext = s.node.heritageClauses?.find(
        (h: Node) => h.token === K.ExtendsKeyword,
      );
      if (!ext) layout = {keys: s.ownKeys};
      else {
        const expr = children(ext.types[0])[0]!;
        // the type of the class (typeof P) has the class's symbol
        const parent = structOfClass(checker.getTypeAtLocation(expr as any));
        const up = parent && layoutOfStruct(parent);
        if (up) layout = {keys: [...new Set([...up.keys, ...s.ownKeys])]};
      }
    }
    layouts.set(s, layout);
    return layout;
  };

  const typeOf = (expression: Node) =>
    checker.getTypeAtLocation(expression as any);
  const layoutOfType = (type: Type) => {
    const s = structOfClass(type);
    return (s && layoutOfStruct(s)) ?? undefined;
  };

  const fieldNames = new Set<string>();
  for (const s of structs.values())
    if (s.shared) for (const k of s.ownKeys ?? []) fieldNames.add(k);

  const files: CompiledFile[] = [];
  for (const [fileName, {file, lowered: l}] of lowered) {
    const text = sources.get(fileName)!;
    const used = new Map<string, string>();
    const toJs = (emitted: {code: string; map: SourceMap}) =>
      options.typescript
        ? emitted
        : toJavaScript(fileName, emitted, rewriteImportExtensions);
    // before the direct access: the same lowering, every access a property's
    const withoutFast = options.alsoWithoutFast
      ? toJs(finish(text, fileName, {...l, ms: l.ms.clone()}, runtime))
      : undefined;
    let declared = '';
    if (options.fast !== false && fieldNames.size > 0)
      declared = fastAccess(file, {
        ms: l.ms,
        checker,
        rt: l.runtimeName,
        fieldNames,
        layouts: used,
        layoutOf: expression => layoutOfType(typeOf(expression)),
        nullableLayoutOf: expression =>
          layoutOfType(checker.getNonNullableType(typeOf(expression))),
        isSharedArray: expression =>
          typeOf(expression).getSymbol()?.name === 'SharedArray',
        // a SharedArray<S>: the global interface of the runtime's types
        elementLayoutOf: expression => {
          const type = typeOf(expression);
          if (type.getSymbol()?.name !== 'SharedArray') return undefined;
          const [element] = checker.getTypeArguments(type as any);
          return element ? layoutOfType(element) : undefined;
        },
      });
    const prelude = [...used]
      .map(
        ([keys, name]) => `const ${name} = ${l.runtimeName}.layout(${keys}); `,
      )
      .join('')
      .concat(declared);
    const emitted = finish(text, fileName, l, runtime, prelude);
    files.push({fileName, ...toJs(emitted), ...(withoutFast && {withoutFast})});
  }
  return {files, diagnostics};
}

function fromApi(
  d: {fileName?: string; pos?: number; text: string; code?: number},
  text: string | undefined,
): Diagnostic {
  const message = d.code ? `${d.text} (TS${d.code})` : d.text;
  if (!d.fileName || text === undefined || d.pos === undefined)
    return {file: d.fileName ?? '', line: 0, col: 0, message};
  return diagnostic(d.fileName, text, d.pos, message);
}
