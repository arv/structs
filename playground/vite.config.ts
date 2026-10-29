// `vp dev`: the playground, whose programs the dev server compiles (POST
// /__structs/compile) with the compiler (../src/compiler) on TypeScript's native
// API. A build (vp build, after vp run build-wasm) compiles them in the
// browser instead, on tsgo in WebAssembly (compiler.ts), and is served from
// /playground/ (BASE names another path). Both send the COOP and COEP
// headers SharedArrayBuffer needs; a host that cannot gets them from a
// service worker (public/coi-sw.js).
import {fileURLToPath} from 'node:url';
import type {Plugin, ViteDevServer} from 'vite-plus';
import {lazyPlugins} from 'vite-plus';

const here: (file: string) => string = file =>
  fileURLToPath(new URL(file, import.meta.url));

const ISOLATED = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// TypeScript 7.1's API client in the browser: its channel to tsgo is ours
// (tsgo/channel.ts), on pipes to tsgo in WebAssembly, rather than its own,
// which spawns tsgo; it never dumps its timing (tsgo/timing-dump.ts), which
// would read the environment and write to disk; node's path and Buffer are
// pathe and buffer; and what
// else it (or the compiler) imports from node, it never calls here
// (tsgo/node-stubs.ts)
function apiInBrowser(): Plugin {
  const stubs = here('tsgo/node-stubs.ts');
  const modules: Record<string, string> = {
    'node:path': 'pathe',
    'node:buffer': 'buffer',
  };
  return {
    name: 'structs-playground:api-in-browser',
    enforce: 'pre',
    async resolveId(source, importer) {
      const fromClient = /\/dist\/api\/sync\/client\.js(\?|$)/.test(
        importer?.replace(/\\/g, '/') ?? '',
      );
      if (fromClient && source === '../syncChannel.js')
        return here('tsgo/channel.ts');
      if (fromClient && source === '../timingDump.js')
        return here('tsgo/timing-dump.ts');
      if (!source.startsWith('node:')) return null;
      const instead = modules[source];
      if (instead)
        return this.resolve(instead, here('vite.config.ts'), {skipSelf: true});
      return stubs;
    },
  };
}

// the dev server compiles: one API session, its tsgo a process, and the
// compiler loaded through Vite for each compile, so that an edit to it (in
// ../src, which Vite is told to watch: it is outside the root) is the next
// compile's
function compileOnServer(): Plugin {
  let api: import('typescript/sync').API | null = null;
  const start = async (server: ViteDevServer) => {
    const {API} = await import('typescript/sync');
    api ??= new API({cwd: here('.')});
    // through Vite: compile-program.ts imports the runtime's types ?raw
    const program = (await server.ssrLoadModule(
      here('compile-program.ts'),
    )) as typeof import('./compile-program.ts');
    return {api, program};
  };
  return {
    name: 'structs-playground:compile',
    configureServer(server) {
      server.watcher.add(here('../src'));
      server.middlewares.use((_req, res, next) => {
        for (const [k, v] of Object.entries(ISOLATED)) res.setHeader(k, v);
        next();
      });
      server.middlewares.use('/__structs/compile', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        try {
          let body = '';
          for await (const chunk of req) body += chunk;
          const {source} = JSON.parse(body) as {source: string};
          const {api, program} = await start(server);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(program.compileProgram(api, source, 'layer')));
        } catch (e) {
          res.statusCode = 500;
          res.end(String((e as Error).stack ?? e));
        }
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        for (const [k, v] of Object.entries(ISOLATED)) res.setHeader(k, v);
        next();
      });
    },
  };
}

export default ({
  command,
  isPreview,
}: {
  command: string;
  isPreview?: boolean;
}) => ({
  base:
    command === 'build' || isPreview
      ? (process.env.BASE ?? '/playground/')
      : '/',
  plugins: lazyPlugins(() => [apiInBrowser(), compileOnServer()]),
  // the workers: the compiler's (compiler.ts, tsgo/tsgo-worker.ts), which
  // load OXC's WebAssembly with a top-level await, and the runtime's
  // (agent-worker.ts)
  worker: {format: 'es' as const, plugins: () => [apiInBrowser()]},
  // TypeScript's API is served as it is, so the worker plugin can give the
  // client its channel, and OXC's WebAssembly binding finds its .wasm beside it
  optimizeDeps: {
    exclude: ['typescript', '@oxc-transform/binding-wasm32-wasip1'],
  },
  build: {target: 'esnext'},
});
