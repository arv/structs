// @arv/threads as npm installs it, in dist/ (pnpm pack builds it first, as
// prepack): what node runs, the Vite plugin and compiled.ts, compiled to
// JavaScript with their declarations (tsconfig.dist.json), since node strips no
// types under node_modules; and beside them the runtime that the page and its
// workers run, as it is, in TypeScript, which Vite compiles as it bundles them,
// with the API's declarations. The plugin finds the runtime beside itself, as
// it does in src/runtime.
//   node build-dist.ts
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(root, 'src', 'runtime'),
  dist = path.join(root, 'dist');

fs.rmSync(dist, {recursive: true, force: true});
const tsc = path.join(
  path.dirname(
    createRequire(import.meta.url).resolve('typescript/package.json'),
  ),
  'bin',
  'tsc',
);
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.dist.json'], {
  cwd: root,
  stdio: 'inherit',
});

// the runtime: the modules the package's entries import (from, import, or
// new URL for the pool's worker script), and the declarations of its API;
// compiled.d.ts, written by hand, replaces the one tsc made of compiled.ts
const copy = [
  'threads.d.ts',
  'heap.d.ts',
  'browser.d.ts',
  'compiled.d.ts',
  'threads.ts',
  'heap.ts',
  'browser.ts',
];
for (let i = 0; i < copy.length; i++) {
  const text = fs.readFileSync(path.join(runtime, copy[i]), 'utf8');
  fs.mkdirSync(path.dirname(path.join(dist, copy[i])), {recursive: true});
  fs.writeFileSync(path.join(dist, copy[i]), text);
  if (copy[i].endsWith('.d.ts')) continue;
  for (const [, , specifier] of text.matchAll(
    /(?:\bfrom|\bimport|\bnew URL\()\s*\(?\s*(['"])(\.[^'"]*)\1/g,
  )) {
    const file = path.relative(
      runtime,
      path.resolve(runtime, path.dirname(copy[i]), specifier),
    );
    if (file.startsWith('..') || path.isAbsolute(file))
      throw new Error(`${copy[i]} imports ${specifier}, outside src/runtime`);
    if (!copy.includes(file)) copy.push(file);
  }
}
console.log(`dist/: ${fs.readdirSync(dist).sort().join(' ')}`);
