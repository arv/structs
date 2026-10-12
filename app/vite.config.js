// the playground: `TSGO=<tsgo fork>/built/local/tsgo vp -C app dev` at the repository's root.
// it compiles on the dev server, so a production build (`vp -C app build`) shows the page but cannot
// compile. "threads" is the runtime one directory up
import { fileURLToPath } from 'node:url';
import { lazyPlugins } from 'vite-plus';
import threads from '../vite-plugin-threads.js';

const up = file => fileURLToPath(new URL(`../${file}`, import.meta.url));

export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: lazyPlugins(() => [ threads({ tsgo: process.env.TSGO, runtime: 'threads', playground: true }) ]),
  resolve: {
    alias: [
      { find: /^threads$/, replacement: up('threads.js') },
      { find: /^threads\/(heap|browser)$/, replacement: up('$1.js') },
    ],
  },
  build: { target: 'es2022' },
  // microlighter loads its grammars with a relative dynamic import, which pre-bundling would break
  optimizeDeps: { exclude: [ 'microlighter' ] },
};
