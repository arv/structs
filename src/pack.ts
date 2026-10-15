// The packages as npm installs them: pnpm pack makes their tarballs (building
// their dist/ first, as prepack), a project of its own outside this repository
// installs them, with Vite, and
//   - every file their exports maps and threads-check's bin name is in its
//     tarball, and neither tarball holds a test or the playground;
//   - each entry resolves, and node, which strips no types under node_modules,
//     loads what it runs: the Vite plugin, @arv/threads/compiled and
//     threads-check's API;
//   - threads-check reports a value used after it was sent, and nothing in the
//     page's project, and `threads-check compile` compiles it;
//   - tsc checks a module that imports every entry against their declarations;
//   - the Vite plugin, with no tsgo option, compiles the page's struct program
//     with threads-check;
//   - the page runs its main on a pool of workers in Chrome (Playwright), from
//     Vite's dev server with the plugin and from Vite's build with it: with
//     threads-check, and with $TSGO (the tsgo fork's binary) with the fork too.
//   vp run test-pack    (TSGO=<threads-checker>/built/local/tsgo)
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {stripVTControlCharacters} from 'node:util';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-pack-'));
const app = path.join(work, 'app');
const tsgo = process.env.TSGO;

const run = (command: string, args: string[], cwd: string) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
const fail = (message: string) => {
  throw new Error(`test-pack: ${message} (in ${work})`);
};
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(app, file)), {recursive: true});
  fs.writeFileSync(path.join(app, file), text);
};
// a dependency's manifest, as this repository installs it
const installed = (name: string) =>
  JSON.parse(
    fs.readFileSync(
      path.join(repo, 'node_modules', name, 'package.json'),
      'utf8',
    ),
  );
// the files an exports map (or a bin) names
const targets: (exports: unknown) => string[] = exports =>
  typeof exports === 'string'
    ? [exports]
    : Object.values(exports ?? {}).flatMap(targets);

// a package's tarball, its manifest and its files, with what they must hold
type Manifest = {
  name: string;
  exports: Record<string, unknown>;
  bin?: Record<string, string>;
};
const pack = (dir: string) => {
  const into = fs.mkdtempSync(path.join(work, 'pack-'));
  run('pnpm', ['pack', '--pack-destination', into], path.join(repo, dir));
  const tarball = path.join(into, fs.readdirSync(into)[0]);
  const files = run('tar', ['-tzf', tarball], into)
    .split('\n')
    .filter(Boolean)
    .map(f => f.replace(/^package\//, ''));
  const manifest: Manifest = JSON.parse(
    run('tar', ['-xzOf', tarball, 'package/package.json'], into),
  );
  for (const f of [...targets(manifest.exports), ...targets(manifest.bin)])
    if (!files.includes(f.replace(/^\.\//, '')))
      fail(`${manifest.name} names ${f}, which its tarball does not hold`);
  const stray = files.filter(f =>
    /\.test\.|test-heap|(^|\/)test\/|playground/.test(f),
  );
  if (stray.length) fail(`${manifest.name} holds ${stray.join(', ')}`);
  console.log(`${manifest.name}: ${files.length} files`);
  return {tarball, manifest};
};
const threads = pack('.'),
  check = pack('src/checker');

// the project: a page (main.ts), the module of the functions threads run
// (app.ts), and a module that imports every entry, for tsc (types.ts)
write(
  'package.json',
  JSON.stringify({
    name: 'app',
    private: true,
    type: 'module',
    dependencies: {
      '@arv/threads': `file:${threads.tarball}`,
      '@arv/threads-check': `file:${check.tarball}`,
      '@types/node': installed('@types/node').version,
      // Vite itself, at the version Vite+ is built on
      'vite': installed('vite').bundledVersions.vite,
    },
  }),
);
write(
  'tsconfig.json',
  JSON.stringify({
    compilerOptions: {
      target: 'es2022',
      module: 'esnext',
      moduleResolution: 'bundler',
      strict: true,
      lib: ['es2022', 'dom'],
      types: ['node'],
      rewriteRelativeImportExtensions: true,
    },
    include: ['*.ts'],
  }),
);
write(
  'app.ts',
  `import {f64, log, scope, SharedArray, struct, type Struct} from '@arv/threads';

const Body = struct({x: f64, vx: f64});
type Body = Struct<typeof Body>;

function step(bodies: SharedArray<Body>, lo: number, hi: number) {
  for (let i = lo; i < hi; i++) bodies[i].x += bodies[i].vx;
}

export function main(threads: number): number {
  const bodies = new SharedArray(Body, 100);
  for (let i = 0; i < 100; i++) bodies[i].vx = i;
  scope(s => {
    for (let t = 0; t < threads; t++)
      s.spawn(step, bodies, (t * 100) / threads, ((t + 1) * 100) / threads);
  });
  let sum = 0;
  for (let i = 0; i < 100; i++) sum += bodies[i].x;
  log(\`sum \${sum}\`);
  return sum;
}
`,
);
write(
  'main.ts',
  `import '@arv/threads/heap';
import {run} from '@arv/threads/browser';
import {main} from './app.ts';

document.body.textContent = \`result \${await run(main, 4)}\`;
`,
);
write(
  'types.ts',
  `import type {Shared} from '@arv/threads';
import {start, stop} from '@arv/threads/browser';
import {helpersOf, type Diagnostic} from '@arv/threads/compiled';
import '@arv/threads/heap';
import threads, {type Options} from '@arv/threads/vite';
import {API, check, compile, formatDiagnostic, toJavaScript} from '@arv/threads-check';

const options: Options = {tsgo: 'tsgo', tsconfig: 'tsconfig.json', args: []};
export const plugin = [threads(options).name, threads().name];
export const api = [start, stop, helpersOf, API, check, compile, toJavaScript, formatDiagnostic];
export type Types = [Shared<{x: number}>, Diagnostic];
`,
);
write('index.html', '<script type="module" src="./main.ts"></script>\n');
write(
  'vite.config.js',
  `import threads from '@arv/threads/vite';

// threads-check compiles, or with TSGO set the fork
export default {
  plugins: [threads(process.env.TSGO ? {tsgo: process.env.TSGO} : {})],
};
`,
);
write(
  'mistake/mistake.ts',
  `import {log, spawn, type Sending} from '@arv/threads';

function total(order: Sending<number[]>): Sending<number> {
  return order.length;
}

export function main() {
  const order = [1, 2, 3];
  spawn(total, order).join();
  log(order.length);
}
`,
);
write(
  'mistake/tsconfig.json',
  JSON.stringify({
    compilerOptions: {
      target: 'es2022',
      module: 'esnext',
      moduleResolution: 'bundler',
      strict: true,
      lib: ['es2022', 'dom'],
    },
    files: ['mistake.ts'],
  }),
);
// node: every entry resolves to a file, and what node runs loads
write(
  'load.js',
  `import assert from 'node:assert';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

for (const entry of process.argv.slice(2))
  assert(fs.existsSync(fileURLToPath(import.meta.resolve(entry))), entry);
const {default: threads} = await import('@arv/threads/vite');
assert.equal(threads({tsgo: 'tsgo'}).name, 'threads');
assert.equal(threads().name, 'threads');
const {helpersOf} = await import('@arv/threads/compiled');
assert.equal(helpersOf('', '@arv/threads').register, undefined);
const {check, compile, API} = await import('@arv/threads-check');
assert.equal(typeof check, 'function');
assert.equal(typeof compile, 'function');
assert.equal(typeof API, 'function');
`,
);
// the Vite plugin with no tsgo option: threads-check compiles the struct
// program (its layout lowered, main registered by the module's key), and
// Vite bundles it
write(
  'build.js',
  `import assert from 'node:assert';
import {build} from 'vite';
import threads from '@arv/threads/vite';

const output = await build({
  configFile: false,
  logLevel: 'silent',
  plugins: [threads()],
  build: {minify: false, write: false},
});
const js = [output]
  .flat()
  .flatMap(o => o.output)
  .map(chunk => chunk.code ?? '')
  .join('\\n');
assert.match(js, /register\\w*\\("app\\.ts", \\{[^}]*\\bmain\\b/);
assert.match(js, /F64\\w*\\[/);
assert.doesNotMatch(js, /\\bbodies\\[i\\]\\.x\\b/);
console.log('the plugin, with no tsgo option, compiled app.ts');
`,
);
// CI's pnpm would want a lockfile
run('pnpm', ['install', '--no-frozen-lockfile'], app);
console.log(`installed in ${app}`);

const entries = [threads.manifest, check.manifest].flatMap(m =>
  Object.keys(m.exports).map(key => m.name + key.slice(1)),
);
run(process.execPath, ['load.js', ...entries], app);
console.log(`node: ${entries.join(', ')} resolve, and the plugin loads`);

const threadsCheck = (project: string) =>
  spawnSync(
    path.join(app, 'node_modules', '.bin', 'threads-check'),
    ['-p', project, '--runtime', '@arv/threads'],
    {cwd: app, encoding: 'utf8'},
  );
const clean = threadsCheck('tsconfig.json'),
  mistake = threadsCheck('mistake/tsconfig.json');
if (clean.status !== 0)
  fail(`threads-check: ${clean.status} ${clean.stdout}${clean.stderr}`);
if (mistake.status !== 1 || !/error TS96001: 'order'/.test(mistake.stdout))
  fail(`threads-check: ${mistake.status} ${mistake.stdout}${mistake.stderr}`);
console.log(`threads-check: ${mistake.stdout.trim()}`);
const compiled = spawnSync(
  path.join(app, 'node_modules', '.bin', 'threads-check'),
  [
    'compile',
    '-p',
    'tsconfig.json',
    '--runtime',
    '@arv/threads',
    '--outDir',
    'out',
  ],
  {cwd: app, encoding: 'utf8'},
);
if (
  compiled.status !== 0 ||
  !/__register\(import\.meta\.url, \{[^}]*\bmain\b/.test(
    fs.readFileSync(path.join(app, 'out/app.js'), 'utf8'),
  )
)
  fail(
    `threads-check compile: ${compiled.status} ${compiled.stdout}${compiled.stderr}`,
  );
console.log('threads-check compile: out/app.js registers main');

run(
  process.execPath,
  [
    path.join(repo, 'node_modules/typescript/bin/tsc'),
    '-p',
    'tsconfig.json',
    '--noEmit',
  ],
  app,
);
console.log('tsc: the declarations check');

console.log(run(process.execPath, ['build.js'], app).trim());

// the page in Chrome, compiled by threads-check, and by the fork with TSGO
const compilers: [string, string | undefined][] = [
  ['threads-check', undefined],
];
if (tsgo) compilers.push(['the tsgo fork', tsgo]);
else console.log('TSGO is not set: the page is not compiled by the fork');
for (const [compiler, tsgo] of compilers) {
  const env = {...process.env, TSGO: tsgo ?? ''};
  const {chromium} = await import('playwright-core');
  const browser = await chromium.launch({channel: 'chrome'});
  // the page at url shows what its main returned, once it has run on the pool
  const shows = async (url: string, what: string) => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    let text: string | null;
    try {
      await page.goto(url);
      await page.waitForFunction(
        () => document.body?.textContent?.startsWith('result'),
        null,
        {timeout: 30_000},
      );
      text = await page.evaluate(() => document.body.textContent);
    } catch (e) {
      return fail(`${what}: ${(e as Error).message}\n${errors.join('\n')}`);
    } finally {
      await page.close();
    }
    if (text !== 'result 4950') fail(`${what}: the page shows ${text}`);
    console.log(
      `${what}, compiled by ${compiler}, in Chrome ${browser.version()}: ${text}`,
    );
  };
  try {
    // the dev server
    const dev = spawn(
      process.execPath,
      ['node_modules/vite/bin/vite.js', '--port', '0'],
      {cwd: app, env, stdio: ['ignore', 'pipe', 'inherit']},
    );
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = '';
        dev.stdout.on('data', chunk => {
          out += chunk;
          const m = /Local:\s+(http\S+)/.exec(stripVTControlCharacters(out));
          if (m) resolve(m[1]);
        });
        dev.on('exit', code => reject(new Error(`vite: ${code} ${out}`)));
      });
      await shows(url, 'vite dev');
    } finally {
      dev.kill();
    }
    // the build, served cross-origin isolated, as a production server must
    execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
      cwd: app,
      env,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const dist = path.join(app, 'dist');
    const server = http.createServer((req, res) => {
      const file = path.join(dist, new URL(req.url!, 'http://x').pathname);
      if (
        !file.startsWith(dist) ||
        !fs.statSync(file, {throwIfNoEntry: false})?.isFile()
      ) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
      });
      res.end(fs.readFileSync(file));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      const {port} = server.address() as AddressInfo;
      await shows(`http://127.0.0.1:${port}/index.html`, 'vite build');
    } finally {
      server.close();
    }
  } finally {
    await browser.close();
  }
}
fs.rmSync(work, {recursive: true, force: true});
