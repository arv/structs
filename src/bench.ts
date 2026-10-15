// compares the versions of the presets (presets/) with each other and with
// plain V8
//   node src/bench.ts [--runs=5] [--programs=mandelbrot,nbody]
//     [--only=own-node,...]
// configurations (each a fresh process or browser per run; the median of
// --runs), those whose program exists:
//   own-node    the program written for own and shared values
//               (<program>-own.ts), on node
//   own-chrome  the same, on Web Workers in Chrome
//   ts-node     the program in TypeScript, moving and sharing objects
//               (<program>-ts.ts), as threads-check compiled it
//               (build/ts/<program>-ts.js: compile first, vp run
//               build-programs), on node
//   ts-chrome   the same, on Web Workers in Chrome
//   cells-node  own and shared values with the hot data in a shared typed-array
//               cell (<program>-cells.ts)
//   cells-chrome  the same, in Chrome
//   struct-node TypeScript with SharedArray and shared struct typed layouts
//               (<program>-struct.ts, emitted as build/ts/<program>-struct.js),
//               on node
//   struct-chrome the same, in Chrome
//   chan-node   TypeScript with goroutines and channels (chan.ts;
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
// checks that every configuration prints what the first one prints, timings
// aside
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInChrome, pageProgram} from './chrome.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..'); // what is built goes in its build/
const args = process.argv.slice(2);
const opt = <D = undefined>(n: string, d?: D) =>
  args.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? d;
const runs = Number(opt('runs', 5));
// the presets (presets/<program>.js)
const programs = opt('programs', 'mandelbrot,nbody')!.split(',');
const only = opt('only')?.split(',');
const want: (c: string) => boolean = c => !only || only.includes(c);
const COUNTS = [1, 2, 4, 8, 1, 2, 4, 8];

const work = path.join(repo, 'build', 'bench');
fs.mkdirSync(work, {recursive: true});

const node = (...a: string[]) =>
  execFileSync(process.execPath, a, {encoding: 'utf8', maxBuffer: 1 << 26});

// "threads N  X ms" lines in order, and the output with their numbers taken out
const times: (out: string) => number[] = out =>
  [...out.matchAll(/threads (\d+) +(\d+) ms/g)].map(m => Number(m[2]));
const normal: (out: string) => string = out =>
  out.replace(/threads (\d+) +\d+ ms +[\d.]+x/g, 'threads $1');
const median: (xs: number[]) => number = xs => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2
    ? s[s.length >> 1]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const results: Record<string, Record<string, number[]>> = {};
for (const p of programs) {
  const original = fs.readFileSync(
    path.join(here, 'presets', `${p}.js`),
    'utf8',
  );
  if (!original.includes('[1, 2, 4, 8]'))
    throw new Error(`${p}: cannot find its thread counts`);

  const configs: Record<string, () => string | Promise<string>> = {};
  // a module run on node and in Chrome, as configs <name>-node and
  // <name>-chrome
  const both = (name: string, file: string) => {
    if (!fs.existsSync(file)) return;
    if (want(`${name}-node`))
      configs[`${name}-node`] = () =>
        node(path.join(here, 'run.ts'), file, `--threads=${COUNTS.join(',')}`);
    if (want(`${name}-chrome`))
      configs[`${name}-chrome`] = async () => {
        const r = await runInChrome({
          query: {program: pageProgram(file), threads: COUNTS.join(',')},
        });
        if (!r.ok) throw new Error(`${name}-chrome ${p}: ${r.error}`);
        return r.output;
      };
  };
  both('own', path.join(here, `${p}-own.ts`));
  both('ts', path.join(repo, 'build', 'ts', `${p}-ts.js`));
  both('cells', path.join(here, `${p}-cells.ts`));
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
` + original.replace('[1, 2, 4, 8]', '[1, 1, 1, 1, 1, 1, 1, 1]'),
    );
    configs.v8 = () => node(shimmed);
  }

  results[p] = {};
  let reference: string | null = null;
  for (const [name, run] of Object.entries(configs)) {
    const samples: number[][] = [];
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
