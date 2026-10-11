// the demo app's build: `TSGO=<tsgo fork>/built/local/tsgo vite threads/escape-proto/app` (dev), or
// `vite build` and `vite preview`. "threads" is the runtime one directory up
import { fileURLToPath } from 'node:url';
import threads from '../vite-plugin-threads.mjs';

const up = file => fileURLToPath(new URL(`../${file}`, import.meta.url));

export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [ threads({ tsgo: process.env.TSGO, runtime: 'threads' }) ],
  resolve: {
    alias: [
      { find: /^threads$/, replacement: up('threads.mjs') },
      { find: /^threads\/(heap|browser)$/, replacement: up('$1.mjs') },
    ],
  },
  build: { target: 'es2022' },
};
