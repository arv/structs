// A Vite plugin (its hooks are Rollup's) for threads in plain TypeScript
// (threads.d.ts):
//
//   import threads from '@arv/threads/vite';
//   export default {
//     plugins: [threads({tsgo: '/path/to/threads-checker/built/local/tsgo'})],
//   };
//
// - compiles the project's TypeScript with the tsgo fork, which lays shared
//   structs and SharedArrays out in shared memory, counts their references and
//   registers the functions threads run, and serves that output for each .ts
//   module (type errors are left to tsc, ownership errors to `tsgo own check`
//   );
// - keys each module's registered functions by its path in the project rather
//   than import.meta.url, so the page's bundle and the workers' agree on them;
// - makes virtual:threads/modules, the modules a pool worker
//   (threads-worker.ts) loads on demand;
// - sets the headers that make a page cross-origin isolated, which
//   SharedArrayBuffer needs, on the dev and preview servers. A production
//   server must send them too;
// - with `playground: true` , compiles programs the page sends it (POST
//   /__threads/compile) two ways: with the fork, and with the types only erased
//   (node's type stripping, plus the one line the runtime needs, registering
//   the module's top-level functions). The page imports either as
//   virtual:threads/playground/<key>.js or <key>.erased.js. Dev server only.
//   With `checker` (the path of threads-check's entry module) the ownership
//   errors come from threads-check, on stock TypeScript 7.1, instead of the
//   fork's `own check` .
import {execFile, execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {searchForWorkspaceRoot, type Plugin} from 'vite';
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

// The plugin's options, described above.
export interface Options {
  tsgo?: string;
  tsconfig?: string;
  runtime?: string;
  args?: string[];
  playground?: boolean;
  checker?: string | null;
}
// A playground program compiled by the fork: its JavaScript, its ownership and
// type errors, and how long that took.
type Compiled = {
  js: string | null;
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
type ThreadsCheck = {
  API: new (options: {cwd: string}) => unknown;
  check(
    config: string,
    options: {runtime: string; api: unknown},
  ): (Omit<Diagnostic, 'code'> & {file?: string; code: number})[];
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
  if (!tsgo)
    throw new Error("threads: the tsgo option names the tsgo fork's binary");
  let project: string,
    rootDir: string,
    outDir: string,
    playgroundDir: string,
    registering: string[] = [];

  // threads-check, loaded once, with one TypeScript API session for every
  // check: node imports its TypeScript sources directly (type stripping)
  let threadsCheck: {mod: ThreadsCheck; api: unknown} | null = null;
  async function ownershipWithThreadsCheck(config: string) {
    threadsCheck ??= await import(pathToFileURL(checker!).href).then(mod => ({
      mod,
      api: new mod.API({cwd: playgroundDir}),
    }));
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
  // the fork's binary and threads-check's sources (a changed runtime file
  // restarts the server, and with it this)
  let fingerprint: string | null = null;
  const fingerprintOf = () => {
    const hash = crypto
      .createHash('sha1')
      .update(fs.readFileSync(path.join(RUNTIME_DIR, 'threads.d.ts')));
    const checkerDir = checker && path.dirname(checker);
    for (const file of [
      tsgo,
      ...(checkerDir
        ? fs
            .readdirSync(checkerDir)
            .filter(name => name.endsWith('.ts'))
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
        `3\0${checker ? 'threads-check' : 'fork'}\0${fingerprint}\0${source}`,
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
    const out = path.join(dir, 'out', 'program.js');
    const compiled: Compiled = {
      js: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null,
      ms: Math.round(performance.now() - t0),
      ownership: ownership.diagnostics,
      checker: ownership.checker,
      checkMs: ownership.ms,
      types: diagnostics(emitted.stdout).filter(
        d => !d.code.startsWith('TS960'),
      ),
    };
    compiled.helpers = compiled.js
      ? Object.values(helpersOf(compiled.js, runtime))
      : [];
    let erased: Erased = {js: null, error: null, added: 0};
    try {
      const {tail, added} = registration(source, runtime);
      erased = {js: stripTypeScriptTypes(source) + tail, error: null, added};
      fs.writeFileSync(path.join(dir, 'erased.js'), erased.js!);
    } catch (e: any) {
      erased.error = String(e.message ?? e);
    }
    const result = {key, compiled, erased};
    fs.writeFileSync(cached, JSON.stringify(result));
    return result;
  }

  // the project's sources as the fork emits them; ordinary type errors do not
  // stop the emit
  function emit() {
    fs.rmSync(outDir, {recursive: true, force: true});
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
          ...args,
        ],
        {stdio: 'pipe'},
      );
    } catch (e: any) {
      if (!fs.existsSync(outDir))
        throw new Error(
          `threads: tsgo emitted nothing:\n${e.stdout}${e.stderr}`,
        );
    }
    registering = [];
    const walk: (dir: string) => void = dir => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (
          /\.m?js$/.test(entry.name) &&
          helpersOf(fs.readFileSync(p, 'utf8'), runtime).__register
        )
          registering.push(sourceOf(p));
      }
    };
    walk(outDir);
  }
  const emitted: (file: string) => string = file =>
    path
      .join(outDir, path.relative(rootDir, file))
      .replace(/\.ts$/, '.js')
      .replace(/\.mts$/, '.mjs');
  const sourceOf: (out: string) => string = out =>
    path
      .join(rootDir, path.relative(outDir, out))
      .replace(/\.js$/, '.ts')
      .replace(/\.mjs$/, '.mts');
  const moduleKey: (file: string) => string = file =>
    path.relative(rootDir, file).split(path.sep).join('/');

  return {
    name: 'threads',
    enforce: 'pre',
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
      project = path.resolve(config.root, tsconfig);
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
    buildStart() {
      emit();
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
      const file = id.split('?')[0];
      if (
        !/\.m?ts$/.test(file) ||
        /\.d\.m?ts$/.test(file) ||
        /[?&]raw\b/.test(id)
      )
        return; // ?raw: the source text
      const out = emitted(file);
      if (!fs.existsSync(out)) return;
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
    // a changed source: compile again and reload the page (its workers hold the
    // old modules). a changed runtime file restarts the server instead: Vite
    // would mark the imports of the changed module with ?t=, and a page or
    // worker that loaded it before would run a second copy of the runtime
    // (whose threads' output, for one, goes nowhere)
    handleHotUpdate({file, server}) {
      if (file.startsWith(RUNTIME_DIR + path.sep)) {
        server.restart();
        return [];
      }
      if (!/\.m?ts$/.test(file) || /\.d\.m?ts$/.test(file)) return;
      emit();
      server.ws.send({type: 'full-reload'});
      return [];
    },
  };
}
