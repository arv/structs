// @arv/structs-compiler as npm installs it, in dist/ (pnpm pack builds it
// first, as prepack): the compiler compiled to JavaScript with its
// declarations (tsconfig.dist.json).
//   node build-dist.ts
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');

fs.rmSync(dist, {recursive: true, force: true});
const tsc = path.join(
  path.dirname(
    createRequire(import.meta.url).resolve('typescript/package.json'),
  ),
  'bin',
  'tsc',
);
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.dist.json'], {
  cwd: here,
  stdio: 'inherit',
});
// the command line: executable, with its #! line
fs.chmodSync(path.join(dist, 'cli.js'), 0o755);
console.log(`dist/: ${fs.readdirSync(dist).sort().join(' ')}`);
