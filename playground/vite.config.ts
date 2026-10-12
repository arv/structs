// `TSGO=<the tsgo fork>/built/local/tsgo vp dev` . The plugin compiles the page
// and the programs with the fork, and the playground's programs on request;
// "threads" is the runtime in ../src/runtime
import {fileURLToPath} from 'node:url';
import {lazyPlugins} from 'vite-plus';
import threads from '../src/runtime/vite-plugin-threads.ts';

const here: (file: string) => string = file =>
  fileURLToPath(new URL(file, import.meta.url));

export default {
  // the fork compiles; threads-check (../src/checker, on stock TypeScript 7.1)
  // reports the ownership errors
  plugins: lazyPlugins(() => [
    threads({
      tsgo: process.env.TSGO,
      runtime: 'threads',
      playground: true,
      checker: here('../src/checker/index.ts'),
    }),
  ]),
  resolve: {
    alias: [
      {find: /^threads$/, replacement: here('../src/runtime/threads.ts')},
      {
        find: /^threads\/(heap|browser)$/,
        replacement: here('../src/runtime/$1.ts'),
      },
    ],
  },
  build: {target: 'es2022'},
};
