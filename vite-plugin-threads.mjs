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
//   dev and preview servers. A production server must send them too.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ISOLATED = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
const MODULES = 'virtual:threads/modules', MODULES_ID = '\0threads/modules';
const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url)); // the runtime lives beside this plugin

export default function threads(options = {}) {
  const { tsgo, tsconfig = 'tsconfig.json', runtime = 'threads', args = [] } = options;
  if (!tsgo) throw new Error('threads: the tsgo option names the tsgo fork\'s binary');
  let project, rootDir, outDir, registering = [];

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
    },
    buildStart() {
      emit();
    },
    resolveId(id) {
      if (id === MODULES) return MODULES_ID;
    },
    load(id) {
      if (id === MODULES_ID) {
        return `export default {\n${registering.map(f => `  ${JSON.stringify(moduleKey(f))}: () => import(${JSON.stringify(f)}),`).join('\n')}\n};\n`;
      }
      const file = id.split('?')[0];
      if (!/\.m?ts$/.test(file) || /\.d\.m?ts$/.test(file)) return;
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
