// `vp dev` . The plugin compiles the page and the programs with threads-check
// (../src/checker, on stock TypeScript 7.1), and the playground's programs on
// request; with `TSGO=<the tsgo fork>/built/local/tsgo` the fork compiles
// them instead. "@arv/threads" is the runtime in ../src/runtime. A build (vp
// build, after vp run build-wasm) compiles the programs in the browser instead,
// with the fork's WebAssembly build, and is served from
// threads.arv.tools/playground/ (BASE names another path)
import {fileURLToPath} from 'node:url';
import {lazyPlugins} from 'vite-plus';
import threads from '../src/runtime/vite-plugin-threads.ts';

const here: (file: string) => string = file =>
  fileURLToPath(new URL(file, import.meta.url));

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
  // threads-check reports the ownership errors
  plugins: lazyPlugins(() => [
    threads({
      tsgo: process.env.TSGO,
      playground: true,
      checker: here('../src/checker/index.ts'),
    }),
  ]),
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
