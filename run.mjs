// runs a hand-translated program on worker threads sharing one SharedArrayBuffer heap
//   node run.mjs <program> [options]
//   <program>: a program in this directory by name (mandelbrot, nbody, nbody-own...), or the path
//   of a module, such as one the tsgo fork emitted (build/ts/nbody-ts.mjs)
//   --threads=1,2,4,8   the thread counts the program runs its work with
//   --atomic-poll       clean points poll with Atomics.load instead of a plain load
//   --stats             print the runtime's counters (to stderr) at exit
//   --heap=MiB          shared heap size (default 512)
//   --pool=N            workers started up front (default 8; more start on demand)
//   --check             verify every boxed value word right after storing it, poison freed blocks
//   --keep              keep the expanded program (its path goes to stderr)
// node's main thread only coordinates, as the playground's page does: the program's main
// runs in a worker, so it may block, and the pool can still grow while it does
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expand } from './expand.mjs';
import { initShared, shutdown, counters } from './runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => args.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? d;
const flag = n => args.includes(`--${n}`);
const name = args.find(a => !a.startsWith('--'));
if (!name) {
  console.error('usage: node run.mjs <mandelbrot|nbody> [--threads=1,2,4,8] [--atomic-poll] [--stats]');
  process.exit(1);
}

const src = name.endsWith('.mjs') && fs.existsSync(path.resolve(name)) ? path.resolve(name) : path.resolve(here, name.endsWith('.mjs') ? name : `${name}.mjs`);
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'escape-proto-'));
const out = path.join(outDir, path.basename(src));
fs.writeFileSync(out, expand(fs.readFileSync(src, 'utf8'), {
  atomicPoll: flag('atomic-poll'),
  runtime: pathToFileURL(path.join(here, 'runtime.mjs')).href
}));
if (flag('keep')) console.error(`expanded: ${out}`);

const sab = new SharedArrayBuffer(Number(opt('heap', 512)) << 20);
initShared(sab);

const data = {
  sab,
  program: pathToFileURL(out).href,
  opts: { check: flag('check') },
  threads: opt('threads', '1,2,4,8').split(',').map(Number)
};
const workers = [];
let finished = false;
const finish = code => {
  if (finished) return;
  finished = true;
  shutdown(sab);
  if (flag('stats')) console.error(JSON.stringify(counters(sab)));
  for (const w of workers) w.terminate();
  if (!flag('keep')) fs.rmSync(outDir, { recursive: true, force: true });
  process.exitCode = code;
};
const start = role => {
  const w = new Worker(path.join(here, 'worker.mjs'), { workerData: { ...data, role } });
  workers.push(w);
  w.on('message', m => {
    if (m.type === 'grow') { if (!finished) start('pool'); }
    else if (m.type === 'done') finish(0);
    else if (m.type === 'crash') { process.stderr.write(`${m.message}\n`); finish(1); }
  });
  w.on('error', e => { process.stderr.write(`${e?.stack ?? e}\n`); finish(1); });
};
for (let i = 0; i < Number(opt('pool', 8)); i++) start('pool');
start('main');
