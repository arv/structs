// A Vite plugin (its hooks are Rollup's) for threads in plain TypeScript (threads.d.mts):
//
//   import threads from 'threads/vite-plugin';
//   export default { plugins: [threads({ tsgo: '/path/to/tsgo-own/built/local/tsgo' })] };
//
// - compiles the project's TypeScript with the tsgo fork, which lays shared structs and SharedArrays
//   out in shared memory, counts their references and registers the functions threads run, and serves
//   that output for each .ts module (type errors are left to tsc, ownership errors to `tsgo own check`);
// - keys each module's registered functions by its path in the project rather than import.meta.url,
//   so the page's bundle and the workers' agree on them;
// - makes virtual:threads/modules, the modules a pool worker (threads-worker.mjs) loads on demand;
// - sets the headers that make a page cross-origin isolated, which SharedArrayBuffer needs, on the
//   dev and preview servers. A production server must send them too;
// - with `playground: true`, compiles programs the page sends it (POST /__threads/compile) two ways:
//   with the fork, and with the types only erased (node's type stripping, plus the one line the
//   runtime needs, registering the module's top-level functions). The page imports either as
//   virtual:threads/playground/<key>.js or <key>.erased.js. Dev server only. With `checker` (the path
//   of threads-check's entry module) the ownership errors come from threads-check, on stock
//   TypeScript 7.1, instead of the fork's `own check`.
import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const ISOLATED = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
const MODULES = 'virtual:threads/modules', MODULES_ID = '\0threads/modules';
const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url)); // the runtime lives beside this plugin
const PLAYGROUND = 'virtual:threads/playground/';
const exec = promisify(execFile);

// The runtime helpers the fork's emit imports. It imports them under other names (`__register as
// __register_1`) where a module declares or uses the name itself, and so does the erased variant here.
const HELPERS = new Set([ '__F64', '__I32', '__OOB', '__U8', '__box', '__cellAddress', '__hold', '__intern', '__newSharedArray', '__newStruct',
  '__quiescent', '__ref', '__register', '__release', '__retain', '__sharedStruct', '__store', '__str', '__unbox' ]);

// The local names of the helpers that compiled code imports from `runtime`: the specifiers of its
// first import of nothing but helpers.
function helpersOf(code, runtime) {
  for (const m of code.matchAll(/^import \{ ([^}]*) \} from "([^"]*)";$/gm)) {
    if (m[2] !== runtime) continue;
    const pairs = m[1].split(',').map(s => s.trim().split(/\s+as\s+/));
    if (pairs.every(([ name ]) => HELPERS.has(name))) return Object.fromEntries(pairs.map(([ name, local ]) => [ name, local ?? name ]));
  }
  return {};
}

// A name like `name` that no identifier in `source` has, as TypeScript makes one: name, name_1, ...
function uniqueName(source, name) {
  const used = new Set(source.match(/[A-Za-z_$][\w$]*/g));
  let unique = name;
  for (let n = 1; used.has(unique); n++) unique = `${name}_${n}`;
  return unique;
}

// Code that registers its functions (`__register(import.meta.url, { ... })`, its last statement, under
// whatever name it imported __register as) with `key` in place of import.meta.url.
function keyRegistration(code, runtime, key) {
  const register = helpersOf(code, runtime).__register;
  if (!register) return code;
  const call = `${register}(import.meta.url, {`, at = code.lastIndexOf(call);
  if (at < 0) return code;
  return `${code.slice(0, at)}${register}(${JSON.stringify(key)}, {${code.slice(at + call.length)}`;
}

// `file(line,col): error TS1234: message` lines, with their indented continuations
function diagnostics(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /^[^()\n]*\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
    if (m) out.push({ line: Number(m[1]), col: Number(m[2]), code: m[3], message: m[4] });
    else if (out.length !== 0 && /^\s+\S/.test(line)) out.at(-1).message += ` ${line.trim()}`;
  }
  return out;
}

export default function threads(options = {}) {
  const { tsgo, tsconfig = 'tsconfig.json', runtime = 'threads', args = [], playground = false, checker = null } = options;
  if (!tsgo) throw new Error('threads: the tsgo option names the tsgo fork\'s binary');
  let project, rootDir, outDir, playgroundDir, registering = [];

  // threads-check, loaded once, with one TypeScript API session for every check: node imports its
  // TypeScript sources directly (type stripping)
  let threadsCheck = null;
  async function ownershipWithThreadsCheck(config) {
    threadsCheck ??= await import(pathToFileURL(checker).href).then(mod => ({ mod, api: new mod.API({ cwd: playgroundDir }) }));
    const t0 = performance.now();
    try {
      const found = threadsCheck.mod.check(config, { runtime, api: threadsCheck.api });
      return { checker: 'threads-check', ms: Math.round(performance.now() - t0),
        diagnostics: found.filter(d => d.file?.endsWith('program.ts')).map(d => ({ line: d.line, col: d.col, code: `TS${d.code}`, message: d.message })) };
    } catch (e) {
      return { checker: 'threads-check', ms: 0, diagnostics: [ { line: 1, col: 1, code: 'TS0', message: `threads-check failed: ${e.message ?? e}` } ] };
    }
  }

  // a playground program, compiled with the fork and with its types only erased; cached by content
  // (and by which checker reports its ownership errors, and the version of what a result holds)
  async function compile(source) {
    const key = `p${crypto.createHash('sha1').update(`3\0${checker ? 'threads-check' : 'fork'}\0${source}`).digest('hex').slice(0, 12)}`;
    const dir = path.join(playgroundDir, key), cached = path.join(dir, 'result.json');
    if (fs.existsSync(cached)) return JSON.parse(fs.readFileSync(cached, 'utf8'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'program.ts'), source);
    const config = path.join(dir, 'tsconfig.json');
    fs.writeFileSync(config, JSON.stringify({
      compilerOptions: { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true, lib: [ 'es2022', 'dom' ], skipLibCheck: true,
        outDir: 'out', rootDir: '.', paths: { [runtime]: [ path.join(RUNTIME_DIR, 'threads.d.mts') ] } },
      files: [ 'program.ts' ],
    }));
    const t0 = performance.now();
    const fork = [ '-p', config, '--ownRuntime', runtime, '--pretty', 'false' ];
    const emitting = exec(tsgo, fork, { cwd: dir }).catch(e => e);
    const ownership = checker
      ? await ownershipWithThreadsCheck(config) // synchronous: it runs while the fork emits
      : await exec(tsgo, [ 'own', 'check', ...fork ], { cwd: dir }).catch(e => e)
        .then(r => ({ checker: 'tsgo own check', ms: Math.round(performance.now() - t0), diagnostics: diagnostics(r.stdout) }));
    const emitted = await emitting;
    const out = path.join(dir, 'out', 'program.js');
    const compiled = {
      js: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null,
      ms: Math.round(performance.now() - t0),
      ownership: ownership.diagnostics,
      checker: ownership.checker,
      checkMs: ownership.ms,
      types: diagnostics(emitted.stdout).filter(d => !d.code.startsWith('TS960')),
    };
    compiled.helpers = compiled.js ? Object.values(helpersOf(compiled.js, runtime)) : [];
    let erased = { js: null, error: null, added: 0 };
    try {
      const names = [ ...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm) ].map(m => m[1]);
      const register = uniqueName(source, '__register'), specifier = register === '__register' ? register : `__register as ${register}`;
      const tail = `\n// added: the runtime finds a thread's function by module and name\nimport { ${specifier} } from "${runtime}";\n${register}(import.meta.url, { ${names.join(', ')} });\n`;
      erased = { js: stripTypeScriptTypes(source) + tail, error: null, added: tail.split('\n').length - 2 };
      fs.writeFileSync(path.join(dir, 'erased.js'), erased.js);
    } catch (e) {
      erased.error = String(e.message ?? e);
    }
    const result = { key, compiled, erased };
    fs.writeFileSync(cached, JSON.stringify(result));
    return result;
  }

  // the project's sources as the fork emits them; ordinary type errors do not stop the emit
  function emit() {
    fs.rmSync(outDir, { recursive: true, force: true });
    try {
      execFileSync(tsgo, [ '-p', project, '--ownRuntime', runtime, '--outDir', outDir, '--rootDir', rootDir, '--sourceMap', ...args ], { stdio: 'pipe' });
    } catch (e) {
      if (!fs.existsSync(outDir)) throw new Error(`threads: tsgo emitted nothing:\n${e.stdout}${e.stderr}`);
    }
    registering = [];
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.m?js$/.test(entry.name) && helpersOf(fs.readFileSync(p, 'utf8'), runtime).__register) registering.push(sourceOf(p));
      }
    };
    walk(outDir);
  }
  const emitted = file => path.join(outDir, path.relative(rootDir, file)).replace(/\.ts$/, '.js').replace(/\.mts$/, '.mjs');
  const sourceOf = out => path.join(rootDir, path.relative(outDir, out)).replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts');
  const moduleKey = file => path.relative(rootDir, file).split(path.sep).join('/');

  return {
    name: 'threads',
    enforce: 'pre',
    config: user => ({
      // the dev server serves the project and the runtime (its pool worker script among them)
      server: { headers: ISOLATED, fs: { allow: [ path.resolve(user.root ?? process.cwd()), RUNTIME_DIR ] } },
      preview: { headers: ISOLATED },
      worker: { format: 'es', plugins: () => [ threads(options) ] }, // the workers' bundle needs the same compile
      optimizeDeps: { exclude: [ runtime ] },
    }),
    configResolved(config) {
      project = path.resolve(config.root, tsconfig);
      rootDir = path.dirname(project);
      outDir = path.join(config.cacheDir, 'threads', config.isWorker ? 'worker' : 'page');
      playgroundDir = path.join(config.cacheDir, 'threads', 'playground');
    },
    configureServer(server) {
      if (!playground) return;
      server.middlewares.use('/__threads/compile', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        for await (const chunk of req) body += chunk;
        try {
          const result = await compile(JSON.parse(body).source);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
        } catch (e) {
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
      if (id.startsWith(PLAYGROUND)) { // <key>.js compiled, <key>.erased.js with its types erased
        const name = id.slice(PLAYGROUND.length).replace(/\.js$/, ''), [ key, variant ] = name.split('.');
        const file = variant === 'erased' ? path.join(playgroundDir, key, 'erased.js') : path.join(playgroundDir, key, 'out', 'program.js');
        return keyRegistration(fs.readFileSync(file, 'utf8'), runtime, `playground/${name}`)
          .replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
      }
      if (id === MODULES_ID) {
        return `export default {\n${registering.map(f => `  ${JSON.stringify(moduleKey(f))}: () => import(${JSON.stringify(f)}),`).join('\n')}\n};\n`;
      }
      const file = id.split('?')[0];
      if (!/\.m?ts$/.test(file) || /\.d\.m?ts$/.test(file) || /[?&]raw\b/.test(id)) return; // ?raw: the source text
      const out = emitted(file);
      if (!fs.existsSync(out)) return;
      const code = keyRegistration(fs.readFileSync(out, 'utf8'), runtime, moduleKey(file))
        .replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
      let map = null;
      if (fs.existsSync(`${out}.map`)) {
        map = JSON.parse(fs.readFileSync(`${out}.map`, 'utf8'));
        map.sources = [ file ];
        map.sourcesContent = [ fs.readFileSync(file, 'utf8') ];
      }
      return { code, map };
    },
    // a changed source: compile again and reload the page (its workers hold the old modules). a
    // changed runtime file restarts the server instead: Vite would mark the imports of the changed
    // module with ?t=, and a page or worker that loaded it before would run a second copy of the
    // runtime (whose threads' output, for one, goes nowhere)
    handleHotUpdate({ file, server }) {
      if (file.startsWith(RUNTIME_DIR + path.sep)) {
        server.restart();
        return [];
      }
      if (!/\.m?ts$/.test(file) || /\.d\.m?ts$/.test(file)) return;
      emit();
      server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}
