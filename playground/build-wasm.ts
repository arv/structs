// Builds the compiler the playground runs in a browser where no dev server
// compiles (a static build): the tsgo fork's cmd/wasm, in WebAssembly, into
// public/compiler/, with the wasm_exec.js of the Go that built it and the
// compiler's size (which the page's progress bar counts against: a server may
// compress what it sends).
//   vp run build-wasm    (TSGO_FORK: a clone of arv/threads-checker, by
//                         default ~/src/arv/threads-checker)
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const fork =
  process.env.TSGO_FORK ?? path.join(homedir(), 'src/arv/threads-checker');
const out = fileURLToPath(new URL('./public/compiler/', import.meta.url));
fs.mkdirSync(out, {recursive: true});
const wasm = path.join(out, 'threads.wasm');
execFileSync(
  'go',
  ['build', '-trimpath', '-ldflags=-s -w', '-o', wasm, './cmd/wasm'],
  {
    cwd: fork,
    stdio: 'inherit',
    env: {...process.env, GOOS: 'js', GOARCH: 'wasm'},
  },
);
const goroot = execFileSync('go', ['env', 'GOROOT'], {
  cwd: fork,
  encoding: 'utf8',
}).trim();
fs.copyFileSync(
  path.join(goroot, 'lib', 'wasm', 'wasm_exec.js'),
  path.join(out, 'wasm_exec.js'),
);
const bytes = fs.statSync(wasm).size;
fs.writeFileSync(path.join(out, 'threads.wasm.json'), JSON.stringify({bytes}));
console.log(`${wasm}: ${(bytes / 1e6).toFixed(1)} MB`);
