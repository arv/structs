// Builds tsgo for the playground to run in a browser where no dev server
// compiles (a static build): TypeScript 7.1's API server (what `tsc --api`
// serves), from stock TypeScript at the commit the typescript package that
// the compiler (../src/compiler) runs on was built from, compiled to WebAssembly with
// tsgo/main.go as its entry point. Into public/compiler/ go tsgo.wasm, the
// wasm_exec.js of the Go that built it, and tsgo's size (which the page's
// progress bar counts against: a server may compress what it sends).
//   vp run build-wasm    (TS_SOURCE: a checkout of microsoft/TypeScript to
//                         build in; by default one is fetched, at the commit,
//                         into node_modules/.cache/typescript)
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));
// the commit: the one the compiler's typescript package names, so the API's
// client and tsgo speak the same protocol (it has no version)
const typescript = createRequire(here('../package.json'))(
  'typescript/package.json',
) as {version: string; gitHead: string};
const commit = typescript.gitHead;

const run = (cmd: string, args: string[], cwd: string, env = process.env) =>
  execFileSync(cmd, args, {cwd, stdio: 'inherit', env});

let source = process.env.TS_SOURCE;
if (!source) {
  source = here('node_modules/.cache/typescript');
  fs.mkdirSync(source, {recursive: true});
  if (!fs.existsSync(path.join(source, '.git'))) {
    run('git', ['init', '-q'], source);
    run(
      'git',
      [
        'remote',
        'add',
        'origin',
        'https://github.com/microsoft/TypeScript.git',
      ],
      source,
    );
    // tsgo's sources only (tsc/): the rest of the repository is big
    run('git', ['sparse-checkout', 'set', 'tsc'], source);
  }
  const head = () =>
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: source,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  let at = '';
  try {
    at = head();
  } catch {}
  if (at !== commit) {
    run(
      'git',
      ['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', commit],
      source,
    );
    run('git', ['checkout', '-q', '--force', 'FETCH_HEAD'], source);
  }
}
const tsc = path.join(source, 'tsc');
// the entry point, in the module, where it may import tsgo's internal
// packages
const entry = path.join(tsc, 'cmd', 'threadsapi');
fs.mkdirSync(entry, {recursive: true});
fs.copyFileSync(here('tsgo/main.go'), path.join(entry, 'main.go'));

const out = here('public/compiler/');
fs.rmSync(out, {recursive: true, force: true});
fs.mkdirSync(out, {recursive: true});
const wasm = path.join(out, 'tsgo.wasm');
run(
  'go',
  ['build', '-trimpath', '-ldflags=-s -w', '-o', wasm, './cmd/threadsapi'],
  tsc,
  // GOWORK: the workspace names tools/, which the sparse checkout leaves out
  {...process.env, GOOS: 'js', GOARCH: 'wasm', GOWORK: 'off'},
);
const goroot = execFileSync('go', ['env', 'GOROOT'], {
  cwd: tsc,
  encoding: 'utf8',
}).trim();
fs.copyFileSync(
  path.join(goroot, 'lib', 'wasm', 'wasm_exec.js'),
  path.join(out, 'wasm_exec.js'),
);
const bytes = fs.statSync(wasm).size;
fs.writeFileSync(path.join(out, 'tsgo.wasm.json'), JSON.stringify({bytes}));
console.log(
  `${wasm}: ${(bytes / 1e6).toFixed(1)} MB, TypeScript ${typescript.version} (${commit.slice(0, 12)})`,
);
