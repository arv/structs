// what the translation costs over plain JS, one thread, the same work:
//   node overhead.js [--reps=15]
// the presets' own functions (plain JS) against their translations, on local
// objects (nothing shared: only the $fwd checks) and on objects in the shared
// heap. each variant runs in a fresh process, so the JIT sees only that
// variant's objects
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// a Porffor checkout (github.com/arv/porffor, branch
// arv/shared-everything-threads): $PORFFOR, or ../porffor beside this
// repository. its presets are the programs compared, and it builds them
const root = path.resolve(
  process.env.PORFFOR ?? path.join(here, '..', 'porffor'),
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
const reps = Number(opt('reps', 15));
const work = path.join(here, 'build', 'overhead');

const VARIANTS = {
  'nbody plain': "the preset's functions on plain objects",
  'nbody local': 'translated, on local objects',
  'nbody local, no polls':
    'translated, on local objects, without clean-point polls',
  'nbody shared':
    'translated, on shared objects this thread owns (lock-free writes)',
  'nbody shared, locked':
    'translated, on shared objects taken over (every write locks, as with threads)',
  'mandelbrot plain': "the preset's row()",
  'mandelbrot local': 'translated row()',
};

const variant = opt('run');
if (!variant) {
  fs.mkdirSync(work, {recursive: true});
  const rows = [];
  for (const v of Object.keys(VARIANTS)) {
    const ms = Number(
      execFileSync(
        process.execPath,
        [fileURLToPath(import.meta.url), `--run=${v}`, `--reps=${reps}`],
        {encoding: 'utf8'},
      ).trim(),
    );
    rows.push([v, ms]);
    process.stderr.write(`${v}: ${ms} ms\n`);
  }
  const base = Object.fromEntries(
    rows
      .filter(([v]) => v.endsWith('plain'))
      .map(([v, ms]) => [v.split(' ')[0], ms]),
  );
  console.log(
    `median ms of the last ${reps - 5} of ${reps} repetitions, one thread\n\n| | ms | vs plain JS | |\n|---|---|---|---|`,
  );
  for (const [v, ms] of rows)
    console.log(
      `| ${v} | ${ms.toFixed(1)} | ${(ms / base[v.split(' ')[0]]).toFixed(2)}x | ${VARIANTS[v]} |`,
    );
} else {
  // the preset's own code, up to its threaded part, as a module
  const plain = async (preset, cut, names) => {
    const src = fs.readFileSync(
      path.join(root, 'threads', 'playground', 'presets', preset),
      'utf8',
    );
    const file = path.join(work, `${preset}.plain.js`);
    fs.writeFileSync(
      file,
      `${src.slice(0, src.indexOf(cut))}\nexport { ${names} };\n`,
    );
    return import(pathToFileURL(file).href);
  };
  // the translation, on the runtime attached to a heap in this thread
  const translated = async name => {
    const sab = new SharedArrayBuffer(512 << 20);
    globalThis.__escapeSab = sab;
    const R = await import('./runtime.js');
    R.initShared(sab);
    R.attach(
      sab,
      {},
      () => {},
      s => process.stderr.write(s),
    );
    R.threadBegin(1);
    const {expand} = await import('./expand.js');
    const file = path.join(work, `${name}.js`);
    fs.writeFileSync(
      file,
      expand(fs.readFileSync(path.join(here, `${name}.js`), 'utf8'), {
        noPoll: variant.endsWith('no polls'),
        runtime: pathToFileURL(path.join(here, 'runtime.js')).href,
      }),
    );
    return {R, mod: await import(pathToFileURL(file).href)};
  };

  let run;
  if (variant.startsWith('nbody')) {
    let m,
      prep = b => b;
    if (variant === 'nbody plain')
      m = await plain(
        '3-nbody.js',
        'const simulate',
        'makeBodies, accelerate, move, energy',
      );
    else {
      const {R, mod} = await translated('nbody');
      m = mod;
      if (!variant.startsWith('nbody local'))
        prep = b => {
          const h = R.$pub(b);
          if (variant === 'nbody shared, locked') {
            // as after another thread took them over: unowned, so each write
            // takes the lock
            for (let i = 0; i < 800; i++)
              R.I32[(R.$sgeti(h, i)[R.ADDR] + 4) >> 2] = 0;
          }
          return h;
        };
    }
    run = () => {
      const bodies = prep(m.makeBodies());
      const t0 = performance.now();
      for (let s = 0; s < 30; s++) {
        m.accelerate(bodies, 0, 800);
        m.move(bodies, 0, 800);
      }
      const ms = performance.now() - t0;
      if (Math.abs(m.energy(bodies) - 59093.195871) > 1e-6)
        throw new Error(`${variant}: wrong energy ${m.energy(bodies)}`);
      return ms;
    };
  } else {
    const m =
      variant === 'mandelbrot plain'
        ? await plain('2-mandelbrot.js', 'const render', 'row')
        : (await translated('mandelbrot')).mod;
    run = () => {
      const t0 = performance.now();
      let sum = 0;
      for (let y = 0; y < 32; y++) {
        const r = m.row(y);
        sum += r[0] + r[79];
      }
      const ms = performance.now() - t0;
      if (!(sum > 0)) throw new Error('mandelbrot: no rows');
      return ms;
    };
  }
  const times = [];
  for (let i = 0; i < reps; i++) times.push(run());
  const warm = times.slice(5).sort((a, b) => a - b);
  console.log(warm[warm.length >> 1]);
}
