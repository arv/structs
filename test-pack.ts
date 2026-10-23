// The packages as npm installs them: @arv/structs and @arv/structs-compiler,
// packed (pnpm pack, which builds each one's dist/ as prepack), installed with
// npm in a project of their own, and used there as the README says:
//
// - a program in the proposal's syntax, run by node with the compiler's load
//   hook, on workers that share the heap;
// - a TypeScript project compiled by the `structs` command, and run;
// - the packages' types, checked by tsc.
//
//   vp run test-pack
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'structs-pack-'));
const packs = path.join(work, 'packs'),
  project = path.join(work, 'project');
fs.mkdirSync(packs);
fs.mkdirSync(project);

const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
const check = (what: string, ok: boolean, got: string) => {
  if (!ok) {
    console.error(`test-pack: ${what}, but got:\n${got}`);
    process.exit(1);
  }
  console.log(`ok   ${what}`);
};

try {
  for (const dir of [root, path.join(root, 'src', 'compiler')])
    run('pnpm', ['pack', '--pack-destination', packs], dir);
  const tarballs = fs.readdirSync(packs).map(f => path.join(packs, f));
  for (const t of tarballs) {
    // what npm sees: the built files, and the exports that name them
    const manifest = JSON.parse(
      run('tar', ['-xOzf', t, 'package/package.json'], work),
    );
    const exported = JSON.stringify(manifest.exports);
    check(
      `${manifest.name} exports its built files`,
      exported.includes('./dist/') && !/\.\/(src\/|[\w-]+\.ts")/.test(exported),
      exported,
    );
  }

  fs.writeFileSync(
    path.join(project, 'package.json'),
    JSON.stringify({name: 'structs-pack-test', private: true, type: 'module'}),
  );
  run('npm', ['install', '--no-audit', '--no-fund', ...tarballs], project);

  // struct syntax, through the load hook, on workers
  fs.writeFileSync(
    path.join(project, 'main.js'),
    `import {parent, run} from '@arv/structs/agent';

shared struct Counter {
  count = 0;
  lock = new Atomics.Mutex();
}

export function count(counter, n) {
  for (let i = 0; i < n; i++) {
    using _ = Atomics.Mutex.lock(counter.lock);
    counter.count++;
  }
}

// the workers import this module too: only the main thread starts them
if (!parent) {
  const counter = new Counter();
  await Promise.all([1, 2, 3, 4].map(() => run(import.meta.url, 'count', counter, 1000)));
  console.log(\`count: \${counter.count}\`);
}
`,
  );
  const counted = run(
    'node',
    ['--import', '@arv/structs-compiler/register', 'main.js'],
    project,
  );
  check(
    'the load hook runs struct syntax on workers',
    counted.trim() === 'count: 4000',
    counted,
  );

  // a TypeScript project, compiled by the command line
  fs.mkdirSync(path.join(project, 'ts'));
  fs.writeFileSync(
    path.join(project, 'ts', 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'esnext',
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        lib: ['esnext', 'dom'],
        types: [],
        noEmit: true,
        outDir: 'out',
      },
      include: ['*.ts'],
    }),
  );
  fs.writeFileSync(
    path.join(project, 'ts', 'points.ts'),
    `import '@arv/structs';

shared struct Point {
  x: number = 0;
  y: number = 0;
}

const points = new SharedArray<Point>(10);
for (let i = 0; i < points.length; i++) {
  const p = new Point();
  p.x = i;
  p.y = 2 * i;
  points[i] = p;
}
// in a function, an element is its address (not at the top of a module, which
// may await)
function total(points: SharedArray<Point>) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    sum += p.x + p.y;
  }
  return sum;
}
console.log(\`sum: \${total(points)}\`);
`,
  );
  run(
    'npx',
    ['structs', 'compile', '-p', 'tsconfig.json'],
    path.join(project, 'ts'),
  );
  const compiled = fs.readFileSync(
    path.join(project, 'ts', 'out', 'points.js'),
    'utf8',
  );
  check(
    'the command line compiles a project, its fields direct',
    compiled.includes('"@arv/structs/runtime"') && compiled.includes('.elem('),
    compiled,
  );
  const summed = run(
    'node',
    [path.join('out', 'points.js')],
    path.join(project, 'ts'),
  );
  check('the compiled project runs', summed.trim() === 'sum: 135', summed);

  // the types
  fs.writeFileSync(
    path.join(project, 'types.ts'),
    `import {run, startWorker} from '@arv/structs/agent';
import {Mutex, SharedArray, canBeShared} from '@arv/structs';
const m: Atomics.Mutex = new Atomics.Mutex();
const token: Atomics.UnlockToken = Atomics.Mutex.lock(m);
token.unlock();
const a = new SharedArray<number>(3);
const n: number = a.length;
const ok: boolean = canBeShared(a) && Reflect.canBeShared(m);
const p: Promise<unknown> = run('./x.js', 'f');
void [Mutex, n, ok, p, startWorker];
`,
  );
  fs.writeFileSync(
    path.join(project, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'esnext',
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        lib: ['esnext', 'esnext.disposable', 'dom'],
        types: [],
        noEmit: true,
      },
      files: ['types.ts'],
    }),
  );
  const tsc = path.join(project, 'node_modules', 'typescript', 'bin', 'tsc');
  let typed = '';
  try {
    typed = run('node', [tsc, '-p', 'tsconfig.json'], project);
  } catch (e) {
    typed = String((e as {stdout?: string}).stdout ?? e);
  }
  check("the packages' types check", typed.trim() === '', typed);
} finally {
  fs.rmSync(work, {recursive: true, force: true});
}
