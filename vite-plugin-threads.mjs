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
//   virtual:threads/playground/<key>.js or <key>.erased.js. Dev server only.
import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ISOLATED = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
const MODULES = 'virtual:threads/modules', MODULES_ID = '\0threads/modules';
const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url)); // the runtime lives beside this plugin
const PLAYGROUND = 'virtual:threads/playground/';
const exec = promisify(execFile);

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
  const { tsgo, tsconfig = 'tsconfig.json', runtime = 'threads', args = [], playground = false } = options;
  if (!tsgo) throw new Error('threads: the tsgo option names the tsgo fork\'s binary');
  let project, rootDir, outDir, playgroundDir, registering = [];

  // a playground program, compiled with the fork and with its types only erased; cached by content
  async function compile(source) {
    const key = `p${crypto.createHash('sha1').update(source).digest('hex').slice(0, 12)}`;
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
    const [ emitted, checked ] = await Promise.all([
      exec(tsgo, fork, { cwd: dir }).catch(e => e),
      exec(tsgo, [ 'own', 'check', ...fork ], { cwd: dir }).catch(e => e),
    ]);
    const out = path.join(dir, 'out', 'program.js');
    const compiled = {
      js: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null,
      ms: Math.round(performance.now() - t0),
      ownership: diagnostics(checked.stdout),
      types: diagnostics(emitted.stdout).filter(d => !d.code.startsWith('TS960')),
    };
    let erased = { js: null, error: null, added: 0 };
    try {
      const names = [ ...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm) ].map(m => m[1]);
      const tail = `\n// added: the runtime finds a thread's function by module and name\nimport { __register } from "${runtime}";\n__register(import.meta.url, { ${names.join(', ')} });\n`;
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
        else if (/\.m?js$/.test(entry.name) && fs.readFileSync(p, 'utf8').includes('__register(')) registering.push(sourceOf(p));
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
        return fs.readFileSync(file, 'utf8')
          .replace(/__register\(import\.meta\.url,/, `__register(${JSON.stringify(`playground/${name}`)},`)
          .replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
      }
      if (id === MODULES_ID) {
        return `export default {\n${registering.map(f => `  ${JSON.stringify(moduleKey(f))}: () => import(${JSON.stringify(f)}),`).join('\n')}\n};\n`;
      }
      const file = id.split('?')[0];
      if (!/\.m?ts$/.test(file) || /\.d\.m?ts$/.test(file) || /[?&]raw\b/.test(id)) return; // ?raw: the source text
      const out = emitted(file);
      if (!fs.existsSync(out)) return;
      const code = fs.readFileSync(out, 'utf8')
        .replace(/__register\(import\.meta\.url,/, `__register(${JSON.stringify(moduleKey(file))},`)
        .replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
      let map = null;
      if (fs.existsSync(`${out}.map`)) {
        map = JSON.parse(fs.readFileSync(`${out}.map`, 'utf8'));
        map.sources = [ file ];
        map.sourcesContent = [ fs.readFileSync(file, 'utf8') ];
      }
      return { code, map };
    },
    // a changed source: compile again and reload the page (its workers hold the old modules)
    handleHotUpdate({ file, server }) {
      if (!/\.m?ts$/.test(file) || /\.d\.m?ts$/.test(file)) return;
      emit();
      server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}
