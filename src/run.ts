import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
// runs a program on worker threads sharing one SharedArrayBuffer heap
//   node src/run.ts <program> [options]
//   <program>: a program in this directory by name (nbody-own, nbody-cells...),
//   or the path of a module, such as one threads-check compiled (vp run
//   build-programs: build/ts/nbody-ts.js)
//   --threads=1,2,4,8   the thread counts the program runs its work with
//   --stats             print the runtime's counters and the number of workers
//                       started (to stderr) at exit
//   --heap=MiB          shared heap size, a whole number from 2 to 2047
//                       (default 512)
//   --pool=N            workers started up front (default 8; more start on
//                       demand)
//   --check             poison freed blocks
// node's main thread only coordinates, as the playground's page does: the
// program's main runs in a worker, so it may block, and the pool can still grow
// while it does
import {Worker} from 'node:worker_threads';
import {findProgram} from './program.ts';
import {
  sharedHeap,
  shutdown,
  counters,
  workersComing,
} from './runtime/runtime.ts';
import type {WorkerData} from './worker.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = <D>(n: string, d: D) =>
  args.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? d;
const flag: (n: string) => boolean = n => args.includes(`--${n}`);
const name = args.find(a => !a.startsWith('--'));
if (!name) {
  console.error(
    'usage: node src/run.ts <program> [--threads=1,2,4,8] [--stats]',
  );
  process.exit(1);
}

const sab = sharedHeap(Number(opt('heap', 512)));

const data = {
  sab,
  program: pathToFileURL(findProgram(name)).href,
  opts: {check: flag('check')},
  threads: opt('threads', '1,2,4,8').split(',').map(Number),
} satisfies Omit<WorkerData, 'role'>;
const workers: Worker[] = [];
let finished = false;
const finish: (code: number) => void = code => {
  if (finished) return;
  finished = true;
  shutdown(sab);
  if (flag('stats'))
    console.error(JSON.stringify({...counters(sab), workers: workers.length}));
  for (const w of workers) void w.terminate();
  process.exitCode = code;
};
const start: (role: WorkerData['role']) => void = role => {
  const w = new Worker(path.join(here, 'worker.ts'), {
    workerData: {...data, role},
  });
  workers.push(w);
  w.on('message', m => {
    if (m.type === 'grow') {
      if (!finished) start('pool');
    } else if (m.type === 'done') finish(0);
    else if (m.type === 'crash') {
      process.stderr.write(`${m.stack ?? m.message}\n`);
      finish(1);
    }
  });
  w.on('error', e => {
    process.stderr.write(`${e?.stack ?? e}\n`);
    finish(1);
  });
};
const pool = Number(opt('pool', 8));
workersComing(sab, pool);
for (let i = 0; i < pool; i++) start('pool');
start('main');
