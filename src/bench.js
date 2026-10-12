// compares the hand-translated programs with Porffor's own builds of the same
// presets
//   node src/bench.js [--runs=5] [--programs=mandelbrot,nbody]
//     [--only=js-node,...]
// configurations (each a fresh process or browser per run; the median of
// --runs):
//   native      Porffor's native build (clang)
//   wasm        Porffor's wasm32-wasip1-threads build on the playground's
//               runner, in Chrome
//   js-node     the hand translation on node worker_threads
//   js-chrome   the hand translation on Web Workers, in Chrome
//   js-apoll    js-node with clean points polling by Atomics.load, not a plain
//               load
//   own-node    the program written for own and shared values
//               (<program>-own.js), on node
//   own-chrome  the same, on Web Workers in Chrome
//   ts-node     the program in TypeScript, moving and sharing objects
//               (<program>-ts.ts), as the tsgo fork emitted it
//               (build/ts/<program>-ts.js: compile first, see tsconfig.json),
//               on node
//   ts-chrome   the same, on Web Workers in Chrome
//   cells-node  own and shared values with the hot data in a shared typed-array
//               cell (<program>-cells.js)
//   cells-chrome  the same, in Chrome
//   struct-node TypeScript with SharedArray and shared struct typed layouts
//               (<program>-struct.ts, emitted as build/ts/<program>-struct.js),
//               on node
//   struct-chrome the same, in Chrome
//   chan-node   TypeScript with goroutines and channels (chan.js;
//               <program>-chan.ts, emitted as build/ts/<program>-chan.js), on
//               node
//   chan-chrome the same, in Chrome
//   chan-struct-node  goroutines and channels over a SharedArray of shared
//               structs, the channels in the barriers' place
//               (<program>-chan-struct.ts), on node
//   chan-struct-chrome  the same, in Chrome
//   v8          plain V8 (node) running the original preset, with an inline
//               Thread shim: 1 thread
// every program runs its thread counts twice, 1, 2, 4, 8 and again: the first
// pass is cold (it includes JIT warm-up in every worker), the second warm.
// checks that every configuration prints what the native build prints, timings
// aside
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInChrome, expandForChrome} from './chrome.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..'); // what is built goes in its build/
// a Porffor checkout (github.com/arv/porffor, branch
// arv/shared-everything-threads): $PORFFOR, or ../porffor beside this
// repository. its presets are the programs compared, and it builds them
const root = path.resolve(
  process.env.PORFFOR ?? path.join(repo, '..', 'porffor'),
);
if (!fs.existsSync(path.join(root, 'threads', 'playground', 'presets'))) {
  console.error(
    `no Porffor checkout at ${root}: set PORFFOR to one, on branch arv/shared-everything-threads`,
  );
  process.exit(1);
}
const args = process.argv.slice(2);
const opt = (n, d) =>
  args.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? d;
const runs = Number(opt('runs', 5));
const programs = opt('programs', 'mandelbrot,nbody').split(',');
const only = opt('only')?.split(',');
const want = c => !only || only.includes(c);
const presets = {mandelbrot: '2-mandelbrot.js', nbody: '3-nbody.js'};
const COUNTS = [1, 2, 4, 8, 1, 2, 4, 8];

const work = path.join(repo, 'build', 'bench');
fs.mkdirSync(work, {recursive: true});

// the playground's wasm build (keep in step with threads/playground/build.js)
const brew = '/opt/homebrew';
const wasmTools = {
  clang: process.env.WASM_CLANG ?? `${brew}/opt/llvm/bin/clang`,
  ld: `${brew}/opt/lld/bin`,
  sysroot: process.env.WASI_SYSROOT ?? `${brew}/share/wasi-sysroot`,
  rt:
    process.env.CLANG_RT ??
    `${brew}/opt/wasi-runtimes/share/wasi-runtimes/lib/wasm32-unknown-wasip1-threads/libclang_rt.builtins.a`,
};
const clangFlags = [
  '--target=wasm32-wasip1-threads',
  '-pthread',
  '-O2',
  '-w',
  '-D_WASI_EMULATED_MMAN',
  '-D_WASI_EMULATED_SIGNAL',
  '-D_WASI_EMULATED_PROCESS_CLOCKS',
  '-DPORF_ARENA_RESERVE=268435456ull',
  '-mllvm',
  '-wasm-enable-sjlj',
  '-mexception-handling',
  '-mllvm',
  '-wasm-use-legacy-eh=false',
];
const linkFlags = [
  '-Wl,--import-memory,--export-memory,--max-memory=1073741824',
  '-nodefaultlibs',
  '-lc',
  '-lwasi-emulated-mman',
  '-lwasi-emulated-signal',
  '-lwasi-emulated-process-clocks',
  '-lsetjmp',
];

const porf = (...a) =>
  execFileSync(
    process.execPath,
    [path.join(root, 'runtime', 'index.js'), ...a],
    {stdio: ['ignore', 'ignore', 'inherit']},
  );
const node = (...a) =>
  execFileSync(process.execPath, a, {encoding: 'utf8', maxBuffer: 1 << 26});

// "threads N  X ms" lines in order, and the output with their numbers taken out
const times = out =>
  [...out.matchAll(/threads (\d+) +(\d+) ms/g)].map(m => Number(m[2]));
const normal = out =>
  out.replace(/threads (\d+) +\d+ ms +[\d.]+x/g, 'threads $1');
const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2
    ? s[s.length >> 1]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const results = {};
for (const p of programs) {
  const original = fs.readFileSync(
    path.join(root, 'threads', 'playground', 'presets', presets[p]),
    'utf8',
  );
  if (!original.includes('[ 1, 2, 4, 8 ]'))
    throw new Error(`${p}: cannot find its thread counts`);
  const twice = path.join(work, `${p}.js`);
  fs.writeFileSync(
    twice,
    original.replace('[ 1, 2, 4, 8 ]', `[ ${COUNTS.join(', ')} ]`),
  );

  const configs = {};
  if (want('native')) {
    const bin = path.join(work, `${p}-native`);
    porf('native', twice, '-o', bin);
    configs.native = () => execFileSync(bin, {encoding: 'utf8'});
  }
  if (want('wasm')) {
    const c = path.join(work, `${p}.c`),
      wasm = path.join(work, `${p}.wasm`);
    porf('c', twice, '-o', c);
    execFileSync(
      wasmTools.clang,
      [
        ...clangFlags,
        `--sysroot=${wasmTools.sysroot}`,
        c,
        '-o',
        wasm,
        ...linkFlags,
        wasmTools.rt,
      ],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          PATH: `${wasmTools.ld}${path.delimiter}${process.env.PATH}`,
        },
      },
    );
    configs.wasm = async () => {
      const r = await runInChrome({
        page: 'wasm.html',
        query: {wasm: `bench/${p}.wasm`},
      });
      if (!r.ok) throw new Error(`wasm ${p}: ${r.error}`);
      return r.output;
    };
  }
  if (want('js-node'))
    configs['js-node'] = () =>
      node(path.join(here, 'run.js'), p, `--threads=${COUNTS}`);
  if (want('js-apoll'))
    configs['js-apoll'] = () =>
      node(
        path.join(here, 'run.js'),
        p,
        `--threads=${COUNTS}`,
        '--atomic-poll',
      );
  if (want('js-chrome'))
    configs['js-chrome'] = async () => {
      expandForChrome(p);
      const r = await runInChrome({
        query: {program: p, threads: COUNTS.join(',')},
      });
      if (!r.ok) throw new Error(`js-chrome ${p}: ${r.error}`);
      return r.output;
    };
  if (fs.existsSync(path.join(here, `${p}-own.js`))) {
    if (want('own-node'))
      configs['own-node'] = () =>
        node(path.join(here, 'run.js'), `${p}-own`, `--threads=${COUNTS}`);
    if (want('own-chrome'))
      configs['own-chrome'] = async () => {
        expandForChrome(`${p}-own`);
        const r = await runInChrome({
          query: {program: `${p}-own`, threads: COUNTS.join(',')},
        });
        if (!r.ok) throw new Error(`own-chrome ${p}: ${r.error}`);
        return r.output;
      };
  }
  // a module run on node and in Chrome, as configs <name>-node and
  // <name>-chrome
  const both = (name, file) => {
    if (!fs.existsSync(file)) return;
    if (want(`${name}-node`))
      configs[`${name}-node`] = () =>
        node(path.join(here, 'run.js'), file, `--threads=${COUNTS}`);
    if (want(`${name}-chrome`))
      configs[`${name}-chrome`] = async () => {
        const r = await runInChrome({
          query: {program: expandForChrome(file), threads: COUNTS.join(',')},
        });
        if (!r.ok) throw new Error(`${name}-chrome ${p}: ${r.error}`);
        return r.output;
      };
  };
  both('ts', path.join(repo, 'build', 'ts', `${p}-ts.js`));
  both('cells', path.join(here, `${p}-cells.js`));
  both('struct', path.join(repo, 'build', 'ts', `${p}-struct.js`));
  both('chan', path.join(repo, 'build', 'ts', `${p}-chan.js`));
  both('chan-struct', path.join(repo, 'build', 'ts', `${p}-chan-struct.js`));
  if (want('v8')) {
    // the original with an inline shim: threads run to completion when made, so
    // only 1 means anything
    const shimmed = path.join(work, `${p}-v8.js`);
    fs.writeFileSync(
      shimmed,
      `globalThis.Thread = class { constructor(f) { this.v = f(); } join() { return this.v; } };
globalThis.Lock = class { hold(f) { return f(); } };
globalThis.Condition = class { wait() { throw new Error('would block'); } notifyAll() {} notifyOne() {} };
` + original.replace('[ 1, 2, 4, 8 ]', '[ 1, 1, 1, 1, 1, 1, 1, 1 ]'),
    );
    configs.v8 = () => node(shimmed);
  }

  results[p] = {};
  let reference = null;
  for (const [name, run] of Object.entries(configs)) {
    const samples = [];
    for (let i = 0; i < runs; i++) {
      const out = await run();
      const t = times(out);
      if (t.length !== COUNTS.length)
        throw new Error(
          `${name} ${p}: expected ${COUNTS.length} timings, got ${t.length}:\n${out}`,
        );
      samples.push(t);
      if (name !== 'v8') {
        reference ??= normal(out);
        if (normal(out) !== reference)
          throw new Error(
            `${name} ${p}: output differs from ${Object.keys(configs)[0]}'s`,
          );
      }
    }
    results[p][name] = COUNTS.map((_, k) => median(samples.map(s => s[k])));
    process.stderr.write(`${p} ${name}: ${results[p][name].join(' ')}\n`);
  }
}

// medians in ms: the cold pass's 1 thread, then the warm pass
console.log(
  `median of ${runs} runs, ms (cold: first pass; warm: second pass)\n`,
);
for (const p of programs) {
  console.log(
    `${p}\n| | cold, 1 thread | warm, 1 | 2 | 4 | 8 |\n|---|---|---|---|---|---|`,
  );
  for (const [name, t] of Object.entries(results[p])) {
    const warm = name === 'v8' ? [t[4], '', '', ''] : t.slice(4);
    console.log(`| ${name} | ${t[0]} | ${warm.join(' | ')} |`);
  }
  console.log();
}
