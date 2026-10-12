// `TSGO=<the tsgo fork>/built/local/tsgo vp dev` . The plugin compiles the page
// and the programs with the fork, and the playground's programs on request;
// "threads" is the runtime in ./runtime
import {fileURLToPath} from 'node:url';
import {lazyPlugins} from 'vite-plus';
import threads from './runtime/vite-plugin-threads.ts';

const here: (file: string) => string = file =>
  fileURLToPath(new URL(file, import.meta.url));

export default {
  // the fork compiles; threads-check (./checker, on stock TypeScript 7.1)
  // reports the ownership errors
  plugins: lazyPlugins(() => [
    threads({
      tsgo: process.env.TSGO,
      runtime: 'threads',
      playground: true,
      checker: here('./checker/src/index.ts'),
    }),
  ]),
  resolve: {
    alias: [
      {find: /^threads$/, replacement: here('./runtime/threads.ts')},
      {find: /^threads\/(heap|browser)$/, replacement: here('./runtime/$1.ts')},
    ],
  },
  build: {target: 'es2022'},
};
