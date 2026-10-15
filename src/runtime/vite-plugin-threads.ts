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
//   noEmit and all. With `tsgo` (the tsgo fork's binary) the fork compiles
//   instead, as it did before threads-check could, and the plugin serves its
//   JavaScript;
// - keys each module's registered functions by its path in the project rather
//   than import.meta.url, so the page's bundle and the workers' agree on them;
// - makes virtual:threads/modules, the modules a pool worker
//   (threads-worker.ts) loads on demand;
// - sets the headers that make a page cross-origin isolated, which
//   SharedArrayBuffer needs, on the dev and preview servers. A production
//   server must send them too;
// - with `playground: true` , compiles programs the page sends it (POST
//   /__threads/compile) two ways: compiled (by threads-check, or the fork),
//   and with the types only erased (node's type stripping, plus the one line
//   the runtime needs, registering the module's top-level functions). The
//   page imports either as virtual:threads/playground/<key>.js or
//   <key>.erased.js. Dev server only. The ownership errors come from
//   threads-check (or, with `tsgo` and no `checker`, the fork's `own check`).
//
// threads-check is the one installed beside the plugin (an optional peer
// dependency of @arv/threads), or the module `checker` names: the path of its
// entry module (in this repository, src/checker/index.ts, which node runs
// with its types stripped).
import {execFile, execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {createRequire, stripTypeScriptTypes} from 'node:module';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {parseSync, searchForWorkspaceRoot, type Plugin} from 'vite';
import {
  diagnostics,
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
const exec = promisify(execFile);
// the sources the fork compiles, and what it emits for each (a .tsx's JSX
// stays JSX with jsx: preserve, in a .jsx, for Vite to compile)
const OUTPUTS: Record<string, string[]> = {
  '.ts': ['.js'],
  '.mts': ['.mjs'],
  '.tsx': ['.js', '.jsx'],
};
const isSource = (file: string) =>
  path.extname(file) in OUTPUTS && !/\.d\.m?ts$/.test(file);
// Vite's own queries (its SPECIAL_QUERY_RE): a module's text, its URL, or a
// worker Vite makes of it
const SPECIAL_QUERY = /[?&](?:worker|sharedworker|raw|url)\b/;

// The plugin's options, described above.
export interface Options {
  tsgo?: string;
  tsconfig?: string;
  runtime?: string;
  args?: string[];
  playground?: boolean;
  checker?: string | null;
}
// A playground program compiled: its JavaScript, its ownership and type
// errors, and how long that took.
type Compiled = {
  js: string | null;
  // what compiled it: threads-check, or the tsgo fork
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
    tsgo,
    tsconfig = 'tsconfig.json',
    runtime = '@arv/threads',
    args = [],
    playground = false,
    checker = null,
  } = options;
  let root: string,
    project: string,
    rootDir: string,
    outDir: string,
    playgroundDir: string,
    registering: string[] = [];
  // whether a module imports the runtime, or exports from it, as a module
  // whose functions threads run does (the fork registers them in such a
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
  let emittedProject = false;
  let compiles = 0;

  // the entry module of the @arv/threads-check installed beside the plugin,
  // or in the project
  const installedThreadsCheck = (): string | null => {
    // (by a name in a variable, which tsc does not resolve: the plugin does
    // without it where tsgo compiles)
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
        "threads: @arv/threads-check compiles the project, and it is not installed: npm install --save-dev @arv/threads-check (or name the tsgo fork's binary with the plugin's tsgo option)",
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
  async function ownershipWithThreadsCheck(config: string) {
    await playgroundThreadsCheck();
    const t0 = performance.now();
    try {
      const found = threadsCheck!.mod.check(config, {
        runtime,
        api: threadsCheck!.api,
      });
      return {
        checker: 'threads-check',
        ms: Math.round(performance.now() - t0),
        diagnostics: found
          .filter(d => d.file?.endsWith('program.ts'))
          .map(d => ({
            line: d.line,
            col: d.col,
            code: `TS${d.code}`,
            message: d.message,
          })),
      };
    } catch (e: any) {
      return {
        checker: 'threads-check',
        ms: 0,
        diagnostics: [
          {
            line: 1,
            col: 1,
            code: 'TS0',
            message: `threads-check failed: ${e.message ?? e}`,
          },
        ],
      };
    }
  }

  // what a compiled program depends on besides its source: the runtime's types,
  // the fork's binary or threads-check's sources (a changed runtime file
  // restarts the server, and with it this)
  let fingerprint: string | null = null;
  const fingerprintOf = () => {
    const hash = crypto
      .createHash('sha1')
      .update(fs.readFileSync(path.join(RUNTIME_DIR, 'threads.d.ts')));
    // threads-check's modules: those beside the one `checker` names, or the
    // installed package's (and its package.json, which has its version)
    const entry =
      tsgo && !checker ? null : (checker ?? installedThreadsCheck());
    const checkerDir = entry && path.dirname(entry);
    let packageDir = checkerDir;
    while (packageDir && !fs.existsSync(path.join(packageDir, 'package.json')))
      packageDir =
        path.dirname(packageDir) === packageDir
          ? null
          : path.dirname(packageDir);
    for (const file of [
      ...(tsgo ? [tsgo] : []),
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

  // a playground program, compiled with the fork and with its types only
  // erased; cached by content (and by which checker reports its ownership
  // errors, the version of what a result holds, and the fingerprint of what
  // compiles it)
  async function compile(source: string) {
    fingerprint ??= fingerprintOf();
    const key = `p${crypto
      .createHash('sha1')
      .update(
        `6\0${tsgo ? 'fork' : 'threads-check'}\0${checker || !tsgo ? 'threads-check' : 'fork'}\0${fingerprint}\0${source}`,
      )
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
    const compiled: Compiled = tsgo
      ? await compileWithFork(config, dir, out)
      : await compileWithThreadsCheck(config, out);
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

  // a playground program compiled by the fork, and checked by it (or by
  // threads-check, with `checker`)
  async function compileWithFork(
    config: string,
    dir: string,
    out: string,
  ): Promise<Compiled> {
    const t0 = performance.now();
    const fork = ['-p', config, '--ownRuntime', runtime, '--pretty', 'false'];
    const emitting = exec(tsgo!, fork, {cwd: dir}).catch(e => e);
    const ownership = checker
      ? // synchronous: it runs while the fork emits
        await ownershipWithThreadsCheck(config)
      : await exec(tsgo!, ['own', 'check', ...fork], {cwd: dir})
          .catch(e => e)
          .then(r => ({
            checker: 'tsgo own check',
            ms: Math.round(performance.now() - t0),
            diagnostics: diagnostics(r.stdout),
          }));
    const emitted = await emitting;
    return {
      js: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null,
      compiler: 'the tsgo fork',
      ms: Math.round(performance.now() - t0),
      ownership: ownership.diagnostics,
      checker: ownership.checker,
      checkMs: ownership.ms,
      types: diagnostics(emitted.stdout).filter(
        d => !d.code.startsWith('TS960'),
      ),
    };
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

  // the project's modules as threads-check compiles them, by file (the
  // threads-check path)
  let compiledModules = new Map<string, CompiledModule>();
  async function compileProject() {
    compiles++;
    const mod = await loadThreadsCheck();
    emittedProject = false;
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
    emittedProject = true;
  }

  // the project's sources as the fork emits them; ordinary type errors do not
  // stop the emit
  function emit() {
    compiles++;
    fs.rmSync(outDir, {recursive: true, force: true});
    emittedProject = false;
    let failed: string | null = null;
    try {
      execFileSync(
        tsgo!,
        [
          '-p',
          project,
          '--ownRuntime',
          runtime,
          '--outDir',
          outDir,
          '--rootDir',
          rootDir,
          '--sourceMap',
          '--pretty',
          'false',
          // a Vite project's tsconfig emits nothing (noEmit). it imports .ts
          // files too (allowImportingTsExtensions), which the fork calls an
          // error once it emits (TS5096: that needs noEmit) and emits all the
          // same, the imports as they are, for Vite to resolve. type errors,
          // that one among them, are tsc's to report, not a reason to emit
          // nothing (noEmitOnError)
          '--noEmit',
          'false',
          '--noEmitOnError',
          'false',
          // an incremental build's state goes with what it emitted (kept
          // elsewhere, the next build would emit only what changed since)
          '--tsBuildInfoFile',
          path.join(outDir, 'tsbuildinfo'),
          ...args,
        ],
        {stdio: 'pipe'},
      );
    } catch (e: any) {
      // what it said, but the TS5096 the options above make it say, or why
      // it did not run
      failed =
        `${e.stdout ?? ''}${e.stderr ?? ''}`
          .split('\n')
          .filter(line => !/\berror TS5096:/.test(line))
          .join('\n')
          .trim() ||
        (typeof e.status === 'number' ? null : String(e.message ?? e));
    }
    // what it emitted is its JavaScript: a build that stopped (a file the
    // tsconfig names is missing, say) wrote its incremental build info all
    // the same
    registering = [];
    let js = 0;
    const walk: (dir: string) => void = dir => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(?:m?js|jsx)$/.test(entry.name)) {
          js++;
          if (!helpersOf(fs.readFileSync(p, 'utf8'), runtime).register)
            continue;
          const source = sourceOf(p);
          if (source) registering.push(source);
        }
      }
    };
    if (fs.existsSync(outDir)) walk(outDir);
    if (js === 0)
      throw new Error(
        failed
          ? `threads: tsgo emitted nothing for ${project}:\n${failed}`
          : `threads: tsgo emitted nothing for ${project}, and reported no error: a solution-style tsconfig (references, and "files": []) compiles nothing itself. Name the app's (tsconfig.app.json, say) with the plugin's tsconfig option`,
      );
    emittedProject = true;
  }
  // whether the last compile compiled a source (threads-check or the fork)
  const compiledSource = (file: string) =>
    tsgo ? !!emitted(file) : compiledModules.has(path.resolve(file));
  // what the fork emitted for a source, if it did
  const emitted = (file: string) => {
    const ext = path.extname(file),
      base = path
        .join(outDir, path.relative(rootDir, file))
        .slice(0, -ext.length);
    return OUTPUTS[ext]
      ?.map(out => base + out)
      .find(out => fs.existsSync(out) && sourceOf(out) === path.resolve(file));
  };
  // the source the fork emitted a file for: of those it may be (a .js may be
  // a .ts's or a .tsx's), the one there is, or the one its source map names
  const sourceOf = (out: string) => {
    const ext = path.extname(out),
      base = path
        .join(rootDir, path.relative(outDir, out))
        .slice(0, -ext.length);
    const sources = Object.keys(OUTPUTS)
      .filter(source => OUTPUTS[source].includes(ext))
      .map(source => base + source)
      .filter(source => fs.existsSync(source));
    if (sources.length < 2) return sources[0];
    try {
      const map = JSON.parse(fs.readFileSync(`${out}.map`, 'utf8'));
      const named = (map.sources as string[]).map(source =>
        path.resolve(path.dirname(out), map.sourceRoot ?? '', source),
      );
      return sources.find(source => named.includes(source)) ?? sources[0];
    } catch {
      return sources[0];
    }
  };
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
      outDir = path.join(
        config.cacheDir,
        'threads',
        config.isWorker ? 'worker' : 'page',
      );
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
      if (tsgo) emit();
      else await compileProject();
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
      if (!tsgo) return; // threads-check's code goes through transform
      const file = id.split('?')[0];
      if (!isSource(file) || SPECIAL_QUERY.test(id)) return;
      const out = emitted(file);
      if (!out) {
        // a module the fork did not compile runs with its types only erased,
        // and its functions not registered: a module that imports the
        // runtime cannot (one the tsconfig leaves out, or one reached through
        // an alias of Vite's that its paths do not have)
        if (
          !file.startsWith(RUNTIME_DIR + path.sep) &&
          fs.existsSync(file) &&
          importsRuntime(file, fs.readFileSync(file, 'utf8'))
        )
          this.error(
            `threads: ${path.relative(root, file)} was not compiled by tsgo -p ${path.relative(root, project)}: add it to the tsconfig's include or files (or mirror the alias in paths)`,
          );
        return;
      }
      const code = keyRegistration(
        fs.readFileSync(out, 'utf8'),
        runtime,
        moduleKey(file),
      ).replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
      let map = null;
      if (fs.existsSync(`${out}.map`)) {
        map = JSON.parse(fs.readFileSync(`${out}.map`, 'utf8'));
        map.sources = [file];
        map.sourcesContent = [fs.readFileSync(file, 'utf8')];
      }
      return {code, map};
    },
    // a source threads-check compiled: its TypeScript with the edits, for
    // Vite to strip the types of (this plugin's transform runs before Vite's
    // own)
    async transform(code, id) {
      if (tsgo) return;
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
    // a source changed, appeared or went: the fork compiles the whole project
    // again, and what any module compiles to may have changed with it (a
    // struct's layout is in every read of its fields), so every module is
    // invalidated, in every environment, and the page reloads (its workers
    // hold the old modules). the hook runs once per environment; the client's,
    // which runs first, does the work for all. a changed runtime file restarts
    // the server instead: Vite would mark the imports of the changed module
    // with ?t=, and a page or worker that loaded it before would run a second
    // copy of the runtime (whose threads' output, for one, goes nowhere). a
    // source the fork did not compile and no environment loaded (a script the
    // tsconfig leaves out, say) changes nothing as it changes, where the fork
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
        emittedProject &&
        !compiledSource(file) &&
        Object.values(server.environments).every(
          env => !env.moduleGraph.getModulesByFile(file)?.size,
        )
      )
        return;
      if (tsgo) emit();
      else await compileProject();
      for (const env of Object.values(server.environments)) {
        env.moduleGraph.invalidateAll();
        env.hot.send({type: 'full-reload', path: '*'});
      }
      return [];
    },
  };
}
