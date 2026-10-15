// `vp dev` . The plugin compiles the page and the programs with threads-check
// (../src/checker, on stock TypeScript 7.1), and the playground's programs on
// request; with `TSGO=<the tsgo fork>/built/local/tsgo` the fork compiles
// them instead. "@arv/threads" is the runtime in ../src/runtime. A build (vp
// build, after vp run build-wasm) compiles the programs in the browser instead,
// with threads-check in a worker (compiler.ts), on tsgo in WebAssembly, and is
// served from threads.arv.tools/playground/ (BASE names another path)
import {fileURLToPath} from 'node:url';
import type {Plugin} from 'vite-plus';
import {lazyPlugins} from 'vite-plus';
import threads from '../src/runtime/vite-plugin-threads.ts';

const here: (file: string) => string = file =>
  fileURLToPath(new URL(file, import.meta.url));

// TypeScript 7.1's API client, and threads-check on it, in the browser: the
// client's channel to tsgo is ours (tsgo/channel.ts), on pipes to tsgo in
// WebAssembly, rather than its own, which spawns tsgo; node's path and Buffer
// are pathe and buffer; and what else it imports from node, it never calls
// here (tsgo/node-stubs.ts)
function apiInBrowser(): Plugin {
  const stubs = here('tsgo/node-stubs.ts');
  const modules: Record<string, string> = {
    'node:path': 'pathe',
    'node:buffer': 'buffer',
  };
  return {
    name: 'threads-playground:api-in-browser',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (
        source === '../syncChannel.js' &&
        /\/dist\/api\/sync\/client\.js(\?|$)/.test(
          importer?.replace(/\\/g, '/') ?? '',
        )
      )
        return here('tsgo/channel.ts');
      if (!source.startsWith('node:')) return null;
      const instead = modules[source];
      if (instead)
        return this.resolve(instead, here('vite.config.ts'), {skipSelf: true});
      return stubs;
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
  // threads-check (../src/checker) compiles, or the fork with TSGO, and
  // threads-check reports the ownership errors; and the compiler's workers
  // get the API in the browser (on the dev server, where workers are served
  // like any module, too)
  plugins: lazyPlugins(() => [
    apiInBrowser(),
    threads({
      tsgo: process.env.TSGO,
      playground: true,
      checker: here('../src/checker/index.ts'),
    }),
  ]),
  // the compiler's workers (compiler.ts, tsgo/tsgo-worker.ts): modules, which
  // load OXC's WebAssembly with a top-level await
  worker: {format: 'es' as const, plugins: () => [apiInBrowser()]},
  // TypeScript's API is served as it is, so the worker plugin can give the
  // client its channel, and OXC's WebAssembly binding finds its .wasm beside it
  optimizeDeps: {
    exclude: ['typescript', '@oxc-transform/binding-wasm32-wasip1'],
  },
  resolve: {
    alias: [
      {find: /^@arv\/threads$/, replacement: here('../src/runtime/threads.ts')},
      {
        find: /^@arv\/threads\/(heap|browser|compiled)$/,
        replacement: here('../src/runtime/$1.ts'),
      },
    ],
  },
  build: {target: 'es2022'},
});
