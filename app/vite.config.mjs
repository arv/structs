// the playground: `TSGO=<tsgo fork>/built/local/tsgo vite --config app/vite.config.mjs`.
// it compiles on the dev server, so a production build (`vite build`) shows the page but cannot
// compile. "threads" is the runtime one directory up
import { fileURLToPath } from 'node:url';
import threads from '../vite-plugin-threads.mjs';

const up = file => fileURLToPath(new URL(`../${file}`, import.meta.url));

export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [ threads({ tsgo: process.env.TSGO, runtime: 'threads', playground: true }) ],
  resolve: {
    alias: [
      { find: /^threads$/, replacement: up('threads.mjs') },
      { find: /^threads\/(heap|browser)$/, replacement: up('$1.mjs') },
    ],
  },
  build: { target: 'es2022' },
  // microlighter loads its grammars with a relative dynamic import, which pre-bundling would break
  optimizeDeps: { exclude: [ 'microlighter' ] },
};
