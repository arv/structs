// A Vite plugin (its hooks are Rollup's) for threads in plain TypeScript
// (threads.d.ts):
//
//   import threads from '@arv/threads/vite';
//   export default {plugins: [threads()]};
//
// - compiles the project's TypeScript with threads-check (@arv/threads-check,
//   on stock TypeScript 7.1), which lays shared structs and SharedArrays out
//   in shared memory, counts their references and registers the functions
//   threads run, and hands each .ts or .tsx module's TypeScript, with those
//   edits and a source map, on to Vite, which strips the types (type errors
//   are left to tsc, ownership errors to threads-check). The project is
//   `tsconfig` (tsconfig.json by default; the app's, tsconfig.app.json say,
//   where tsconfig.json only references others), as create-vite writes it,
//   noEmit and all;
// - keys each module's registered functions by its path in the project rather
//   than import.meta.url, so the page's bundle and the workers' agree on them;
// - makes virtual:threads/modules, the modules a pool worker
//   (threads-worker.ts) loads on demand;
// - sets the headers that make a page cross-origin isolated, which
//   SharedArrayBuffer needs, on the dev and preview servers. A production
//   server must send them too;
// - with `playground: true` , compiles programs the page sends it (POST
//   /__threads/compile) two ways: compiled by threads-check, and with the types only erased (node's type stripping, plus the one line
//   the runtime needs, registering the module's top-level functions). The
//   page imports either as virtual:threads/playground/<key>.js or
//   <key>.erased.js. Dev server only. The ownership errors come from
//   threads-check.
//
// threads-check is the one installed beside the plugin (an optional peer
// dependency of @arv/threads), or the module `checker` names: the path of its
// entry module (in this repository, src/checker/index.ts, which node runs
// with its types stripped).
import crypto from 'node:crypto';
import fs from 'node:fs';
import {createRequire, stripTypeScriptTypes} from 'node:module';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseSync, searchForWorkspaceRoot, type Plugin} from 'vite';
import {
  helpersOf,
  keyRegistration,
  registration,
  type Diagnostic,
} from './compiled.ts';

const ISOLATED = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
const MODULES = 'virtual:threads/modules',
  MODULES_ID = '\0threads/modules';
// the runtime lives beside this plugin
const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLAYGROUND = 'virtual:threads/playground/';
// the sources threads-check compiles
const isSource = (file: string) =>
  /\.(?:ts|mts|tsx)$/.test(file) && !/\.d\.m?ts$/.test(file);
// Vite's own queries (its SPECIAL_QUERY_RE): a module's text, its URL, or a
// worker Vite makes of it
const SPECIAL_QUERY = /[?&](?:worker|sharedworker|raw|url)\b/;

// The plugin's options, described above.
export interface Options {
  tsconfig?: string;
  runtime?: string;
  playground?: boolean;
  checker?: string | null;
}
// A playground program compiled: its JavaScript, its ownership and type
// errors, and how long that took.
type Compiled = {
  js: string | null;
  // what compiled it: threads-check
  compiler: string;
  ms: number;
  ownership: Diagnostic[];
  checker: string;
  checkMs: number;
  types: Diagnostic[];
  helpers?: string[];
};
// A playground program with its types erased (or why it could not be), and
// how many lines that added.
type Erased = {js: string | null; error: string | null; added: number};
// What threads-check's entry module exports, as this plugin uses it.
type CheckDiagnostic = Omit<Diagnostic, 'code'> & {file?: string; code: number};
type ThreadsCheck = {
  API: new (options: {cwd: string}) => {close(): void};
  check(
    config: string,
    options: {runtime: string; api: unknown},
  ): CheckDiagnostic[];
  compile(
    config: string,
    options: {runtime: string; api: unknown; check?: boolean; types?: boolean},
  ): {
    files: {
      fileName: string;
      code: string;
      map: SourceMap;
      registered: string[];
    }[];
    diagnostics: CheckDiagnostic[];
    typeDiagnostics: CheckDiagnostic[];
    compilerOptions: Record<string, unknown>;
  };
  toJavaScript(
    file: unknown,
    options: {
      verbatimModuleSyntax?: boolean;
      rewriteRelativeImportExtensions?: boolean;
    },
  ): {code: string};
  formatDiagnostic(d: CheckDiagnostic, cwd?: string): string;
};
type SourceMap = {
  version: number;
  sources: string[];
  sourcesContent?: (string | null)[];
  names: string[];
  mappings: string;
};
// A module threads-check compiled: its source as compiled, and its
// TypeScript with the edits.
type CompiledModule = {
  source: string;
  code: string;
  map: SourceMap;
  registers: boolean;
};

export default function threads(options: Options = {}): Plugin {
  const {
    tsconfig = 'tsconfig.json',
    runtime = '@arv/threads',
    playground = false,
    checker = null,
  } = options;
  let root: string,
    project: string,
    rootDir: string,
    playgroundDir: string,
    registering: string[] = [];
  // whether a module imports the runtime, or exports from it, as a module
  // whose functions threads run does (threads-check registers them in such a
  // module only, by any import or export from, for a side effect, of types
  // only or of nothing): by its declarations as Vite's parser reads them,
  // not by what its comments or strings say
  const importsRuntime = (file: string, source: string) =>
    parseSync(file, source).program.body.some(
      node =>
        (node.type === 'ImportDeclaration' ||
          node.type === 'ExportNamedDeclaration' ||
          node.type === 'ExportAllDeclaration') &&
        node.source?.value === runtime,
    );
  // whether the last compile compiled the project, so that what it did not
  // compile is not the project's; and how many compiles have run (for tests)
  let compiledProject = false;
  let compiles = 0;

  // the entry module of the @arv/threads-check installed beside the plugin,
  // or in the project
  const installedThreadsCheck = (): string | null => {
    // (by a name in a variable, which tsc does not resolve: it is an optional
    // peer dependency)
    const name = '@arv/threads-check';
    try {
      return fileURLToPath(import.meta.resolve(name));
    } catch {}
    try {
      return createRequire(path.join(root, 'package.json')).resolve(name);
    } catch {}
    return null;
  };

  // threads-check, loaded once: the module `checker` names (node imports its
  // TypeScript sources directly, with their types stripped), or the package
  // installed beside the plugin, or in the project
  let threadsCheckModule: Promise<ThreadsCheck> | null = null;
  const loadThreadsCheck = () =>
    (threadsCheckModule ??= (async () => {
      if (checker) return import(pathToFileURL(checker).href);
      const resolved = installedThreadsCheck();
      if (resolved) return import(pathToFileURL(resolved).href);
      throw new Error(
        'threads: @arv/threads-check compiles the project, and it is not installed: npm install --save-dev @arv/threads-check',
      );
    })());
  // one TypeScript API session for the playground's compiles and checks
  let threadsCheck: {mod: ThreadsCheck; api: unknown} | null = null;
  async function playgroundThreadsCheck(): Promise<{
    mod: ThreadsCheck;
    api: unknown;
  }> {
    if (!threadsCheck) {
      const mod = await loadThreadsCheck();
      threadsCheck = {mod, api: new mod.API({cwd: playgroundDir})};
    }
    return threadsCheck;
  }

  // what a compiled program depends on besides its source: the runtime's types,
  // and threads-check's sources (a changed runtime file
  // restarts the server, and with it this)
  let fingerprint: string | null = null;
  const fingerprintOf = () => {
    const hash = crypto
      .createHash('sha1')
      .update(fs.readFileSync(path.join(RUNTIME_DIR, 'threads.d.ts')));
    // threads-check's modules: those beside the one `checker` names, or the
    // installed package's (and its package.json, which has its version)
    const entry = checker ?? installedThreadsCheck();
    const checkerDir = entry && path.dirname(entry);
    let packageDir = checkerDir;
    while (packageDir && !fs.existsSync(path.join(packageDir, 'package.json')))
      packageDir =
        path.dirname(packageDir) === packageDir
          ? null
          : path.dirname(packageDir);
    for (const file of [
      ...(packageDir ? [path.join(packageDir, 'package.json')] : []),
      ...(checkerDir
        ? fs
            .readdirSync(checkerDir)
            .filter(name => /\.(ts|js|json)$/.test(name))
            .map(name => path.join(checkerDir, name))
        : []),
    ]) {
      try {
        const stat = fs.statSync(file);
        hash.update(`${file}\0${stat.size}\0${stat.mtimeMs}\0`);
      } catch {}
    }
    return hash.digest('hex');
  };

  // a playground program, compiled by threads-check and with its types only
  // erased; cached by content (and by the version of what a result holds, and
  // the fingerprint of what compiles it)
  async function compile(source: string) {
    fingerprint ??= fingerprintOf();
    const key = `p${crypto
      .createHash('sha1')
      .update(`6\0${fingerprint}\0${source}`)
      .digest('hex')
      .slice(0, 12)}`;
    const dir = path.join(playgroundDir, key),
      cached = path.join(dir, 'result.json');
    if (fs.existsSync(cached))
      return JSON.parse(fs.readFileSync(cached, 'utf8'));
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'program.ts'), source);
    const config = path.join(dir, 'tsconfig.json');
    fs.writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          target: 'es2022',
          module: 'esnext',
          moduleResolution: 'bundler',
          strict: true,
          lib: ['es2022', 'dom'],
          skipLibCheck: true,
          outDir: 'out',
          rootDir: '.',
          paths: {[runtime]: [path.join(RUNTIME_DIR, 'threads.d.ts')]},
        },
        files: ['program.ts'],
      }),
    );
    const out = path.join(dir, 'out', 'program.js');
    const compiled = await compileWithThreadsCheck(config, out);
    compiled.helpers = compiled.js
      ? Object.values(helpersOf(compiled.js, runtime))
      : [];
    let erased: Erased = {js: null, error: null, added: 0};
    try {
      const {tail, added} = registration(source, runtime, compiled.js);
      erased = {js: stripTypeScriptTypes(source) + tail, error: null, added};
      fs.writeFileSync(path.join(dir, 'erased.js'), erased.js!);
    } catch (e: any) {
      erased.error = String(e.message ?? e);
    }
    const result = {key, compiled, erased};
    fs.writeFileSync(cached, JSON.stringify(result));
    return result;
  }

  // a playground program compiled and checked by threads-check, its types
  // stripped by OXC
  async function compileWithThreadsCheck(
    config: string,
    out: string,
  ): Promise<Compiled> {
    const {mod, api} = await playgroundThreadsCheck();
    const t0 = performance.now();
    const asPlayground = (d: CheckDiagnostic) => ({
      line: d.line,
      col: d.col,
      code: `TS${d.code}`,
      message: d.message,
    });
    try {
      const result = mod.compile(config, {
        runtime,
        api,
        check: true,
        types: true,
      });
      const ms = Math.round(performance.now() - t0);
      const file = result.files.find(f => f.fileName.endsWith('program.ts'));
      const ofProgram = (d: CheckDiagnostic) => d.file?.endsWith('program.ts');
      const ownership = result.diagnostics.filter(ofProgram).map(asPlayground),
        types = result.typeDiagnostics.filter(ofProgram).map(asPlayground);
      let js: string | null = null;
      // OXC refuses a program that does not parse: no JavaScript, and the
      // errors say why (or, if none does, OXC). The page in WebAssembly does
      // the same (playground/compiler.ts)
      try {
        if (file) {
          js = mod.toJavaScript(file, {}).code;
          fs.mkdirSync(path.dirname(out), {recursive: true});
          fs.writeFileSync(out, js);
        }
      } catch (e: any) {
        js = null;
        if (types.length === 0)
          ownership.push({
            line: 1,
            col: 1,
            code: 'TS0',
            message: String(e.message ?? e),
          });
      }
      return {
        js,
        compiler: 'threads-check',
        ms,
        ownership,
        checker: 'threads-check',
        checkMs: ms,
        types,
      };
    } catch (e: any) {
      return {
        js: null,
        compiler: 'threads-check',
        ms: 0,
        ownership: [
          {
            line: 1,
            col: 1,
            code: 'TS0',
            message: `threads-check failed: ${e.message ?? e}`,
          },
        ],
        checker: 'threads-check',
        checkMs: 0,
        types: [],
      };
    }
  }

  // the project's modules as threads-check compiles them, by file
  let compiledModules = new Map<string, CompiledModule>();
  async function compileProject() {
    compiles++;
    const mod = await loadThreadsCheck();
    compiledProject = false;
    compiledModules = new Map();
    registering = [];
    const api = new mod.API({cwd: root});
    let result: ReturnType<ThreadsCheck['compile']>;
    try {
      result = mod.compile(project, {runtime, api});
    } catch (e: any) {
      throw new Error(
        `threads: threads-check cannot compile ${project}: ${e.message ?? e}`,
      );
    } finally {
      api.close();
    }
    // the tsconfig's own errors
    if (result.diagnostics.length > 0)
      throw new Error(
        `threads: threads-check cannot compile ${project}:\n${result.diagnostics.map(d => mod.formatDiagnostic(d, root)).join('\n')}`,
      );
    for (const file of result.files) {
      if (!isSource(file.fileName)) continue;
      const fileName = path.resolve(file.fileName);
      compiledModules.set(fileName, {
        source:
          file.map.sourcesContent?.[0] ?? fs.readFileSync(fileName, 'utf8'),
        code: file.code,
        map: file.map,
        registers: file.registered.length > 0,
      });
      if (file.registered.length > 0) registering.push(fileName);
    }
    if (compiledModules.size === 0)
      throw new Error(
        `threads: threads-check compiled nothing for ${project}, and reported no error: a solution-style tsconfig (references, and "files": []) compiles nothing itself. Name the app's (tsconfig.app.json, say) with the plugin's tsconfig option`,
      );
    compiledProject = true;
  }

  const moduleKey: (file: string) => string = file =>
    path.relative(rootDir, file).split(path.sep).join('/');

  return {
    name: 'threads',
    enforce: 'pre',
    // how many times the project was compiled
    api: {
      get compiles() {
        return compiles;
      },
    },
    config: user => ({
      // the dev server serves the project and the runtime (its pool worker
      // script among them)
      server: {
        headers: ISOLATED,
        // the workspace, as Vite allows by default (its dependencies are in
        // its root's node_modules), and the runtime, wherever it is
        fs: {
          allow: [
            searchForWorkspaceRoot(path.resolve(user.root ?? process.cwd())),
            RUNTIME_DIR,
          ],
        },
      },
      preview: {headers: ISOLATED},
      // the workers' bundle needs the same compile
      worker: {format: 'es', plugins: () => [threads(options)]},
      optimizeDeps: {exclude: [runtime]},
    }),
    configResolved(config) {
      root = config.root;
      project = path.resolve(root, tsconfig);
      rootDir = path.dirname(project);
      playgroundDir = path.join(config.cacheDir, 'threads', 'playground');
    },
    configureServer(server) {
      if (!playground) return;
      server.middlewares.use('/__threads/compile', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        try {
          const result = await compile(JSON.parse(body).source);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.statusCode = 500;
          res.end(String(e?.stack ?? e));
        }
      });
    },
    async buildStart() {
      await compileProject();
    },
    resolveId(id) {
      if (id === MODULES) return MODULES_ID;
      if (id.startsWith(PLAYGROUND)) return id;
    },
    load(id) {
      if (id.startsWith(PLAYGROUND)) {
        // <key>.js compiled, <key>.erased.js with its types erased
        const name = id.slice(PLAYGROUND.length).replace(/\.js$/, ''),
          [key, variant] = name.split('.');
        const file =
          variant === 'erased'
            ? path.join(playgroundDir, key, 'erased.js')
            : path.join(playgroundDir, key, 'out', 'program.js');
        return keyRegistration(
          fs.readFileSync(file, 'utf8'),
          runtime,
          `playground/${name}`,
        ).replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
      }
      if (id === MODULES_ID) {
        return `export default {\n${registering.map(f => `  ${JSON.stringify(moduleKey(f))}: () => import(${JSON.stringify(f)}),`).join('\n')}\n};\n`;
      }
    },
    // a source threads-check compiled: its TypeScript with the edits, for
    // Vite to strip the types of (this plugin's transform runs before Vite's
    // own)
    async transform(code, id) {
      const file = id.split('?')[0];
      if (!isSource(file) || SPECIAL_QUERY.test(id) || file.startsWith('\0'))
        return;
      let compiled = compiledModules.get(path.resolve(file));
      // a source that changed since (its change not yet seen): compiled again
      if (compiled && compiled.source !== code) {
        await compileProject();
        compiled = compiledModules.get(path.resolve(file));
        if (compiled && compiled.source !== code)
          this.error(
            `threads: ${path.relative(root, file)} reached the plugin changed from what is on disk, which threads-check compiled: put the threads plugin before the plugin that changes it`,
          );
      }
      if (!compiled) {
        // a module threads-check did not compile runs with its types only
        // erased, and its functions not registered: a module that imports the
        // runtime cannot (one the tsconfig leaves out, or one reached through
        // an alias of Vite's that its paths do not have)
        if (
          !file.startsWith(RUNTIME_DIR + path.sep) &&
          importsRuntime(file, code)
        )
          this.error(
            `threads: ${path.relative(root, file)} was not compiled by threads-check -p ${path.relative(root, project)}: add it to the tsconfig's include or files (or mirror the alias in paths)`,
          );
        return;
      }
      return {
        code: keyRegistration(compiled.code, runtime, moduleKey(file)),
        map: {...compiled.map, sources: [file]},
      };
    },
    // a source changed, appeared or went: threads-check compiles the whole
    // project again, and what any module compiles to may have changed with it
    // (a struct's layout is in every read of its fields), so every module is
    // invalidated, in every environment, and the page reloads (its workers
    // hold the old modules). the hook runs once per environment; the client's,
    // which runs first, does the work for all. a changed runtime file restarts
    // the server instead: Vite would mark the imports of the changed module
    // with ?t=, and a page or worker that loaded it before would run a second
    // copy of the runtime (whose threads' output, for one, goes nowhere). a
    // source threads-check did not compile and no environment loaded (a script
    // the tsconfig leaves out, say) changes nothing as it changes, where it
    // compiled the project last (after a compile that failed, nothing was
    // compiled); one that appeared may be what a module failed to import, and
    // one that went a module the workers' table names
    async hotUpdate({type, file, server}) {
      if (this.environment.name !== 'client') return [];
      if (file.startsWith(RUNTIME_DIR + path.sep)) {
        void server.restart();
        return [];
      }
      if (!isSource(file)) return;
      if (
        type === 'update' &&
        compiledProject &&
        !compiledModules.has(path.resolve(file)) &&
        Object.values(server.environments).every(
          env => !env.moduleGraph.getModulesByFile(file)?.size,
        )
      )
        return;
      await compileProject();
      for (const env of Object.values(server.environments)) {
        env.moduleGraph.invalidateAll();
        env.hot.send({type: 'full-reload', path: '*'});
      }
      return [];
    },
  };
}
