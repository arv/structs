import fs from 'node:fs';
// runs a hand-translated program in Chrome (the installed Google Chrome, through Playwright),
// on real Web Workers sharing one SharedArrayBuffer heap
//   node chrome.js <mandelbrot|nbody> [options]
//   --threads=1,2,4,8   the thread counts the program runs its work with
//   --pool=N            workers started up front (default: the browser's hardwareConcurrency)
//   --trace=file.json   record a DevTools performance trace (CPU samples of every thread);
//                       open it in DevTools' Performance panel, or summarize it with trace-summary.js
//   --headed            show the browser window (default: Chrome's headless mode)
//   --atomic-poll       clean points poll with Atomics.load instead of a plain load
//   --stats             print the runtime's counters (to stderr)
//   --check             verify every boxed value word right after storing it, poison freed blocks
// --wasm=file.wasm instead runs a Porffor program built for wasm32-wasip1-threads (see bench.js)
// on the playground's runner, in the same browser.
// needs playwright-core (a dev dependency of this repository), found normally or through
// $PLAYWRIGHT_CORE, the path of an install's node_modules/playwright-core
import http from 'node:http';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {expand} from './expand.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// wasm.html runs a Porffor build on Porffor's playground runner, served from a Porffor checkout
// (github.com/arv/porffor, branch arv/shared-everything-threads) under /porffor/: $PORFFOR, or
// ../porffor beside this repository
const porffor = path.resolve(
  process.env.PORFFOR ?? path.join(here, '..', 'porffor'),
);

const loadChromium = async () => {
  const pw = await (process.env.PLAYWRIGHT_CORE
    ? import(
        pathToFileURL(
          createRequire(path.join(process.env.PLAYWRIGHT_CORE, 'x.js')).resolve(
            process.env.PLAYWRIGHT_CORE,
          ),
        ).href
      )
    : import('playwright-core'));
  return pw.chromium ?? pw.default.chromium; // a CommonJS module, imported
};

// this repository, and a Porffor checkout under /porffor/, cross-origin isolated (SharedArrayBuffer
// needs COOP and COEP)
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
};
const serve = async () => {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(
      new URL(req.url, 'http://localhost').pathname,
    );
    const root = pathname.startsWith('/porffor/') ? porffor : here;
    const file = path.join(
      root,
      root === porffor ? pathname.slice('/porffor'.length) : pathname,
    );
    if (
      !file.startsWith(root) ||
      !fs.existsSync(file) ||
      !fs.statSync(file).isFile()
    ) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'content-type': types[path.extname(file)] ?? 'application/octet-stream',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return server;
};

// expands a program for the page: build/<name>.js (build/ is not committed). the program is one in
// this directory by name, or the path of a module (such as one the tsgo fork emitted); returns the
// name the page loads it by
export const expandForChrome = (program, {atomicPoll = false} = {}) => {
  const file =
    program.endsWith('.js') && fs.existsSync(path.resolve(program))
      ? path.resolve(program)
      : path.join(here, `${program}.js`);
  const name = path.basename(file, '.js');
  fs.mkdirSync(path.join(here, 'build'), {recursive: true});
  fs.writeFileSync(
    path.join(here, 'build', `${name}.js`),
    expand(fs.readFileSync(file, 'utf8'), {
      atomicPoll,
      runtime: '../runtime.js',
    }),
  );
  return name;
};

// runs one page to completion: index.html (a program, expanded first) or wasm.html (a Porffor
// wasm build under build/). resolves to { ok, error, output, counters, version }
export const runInChrome = async ({
  page: pageName = 'index.html',
  query = {},
  trace = null,
  headed = false,
}) => {
  const chromium = await loadChromium();
  const server = await serve();
  const browser = await chromium.launch({channel: 'chrome', headless: !headed});
  try {
    const page = await browser.newPage();
    page.on('console', m => {
      if (m.type() === 'error' && !m.text().includes('404'))
        console.error(`console: ${m.text()}`);
    });
    page.on('pageerror', e => console.error(`page: ${e.message}`));
    if (trace)
      await browser.startTracing(page, {
        path: path.resolve(trace),
        categories: [
          '__metadata',
          'toplevel',
          'devtools.timeline',
          'disabled-by-default-devtools.timeline',
          'v8.execute',
          'disabled-by-default-v8.cpu_profiler',
          'blink.user_timing',
        ],
      });
    await page.goto(
      `http://127.0.0.1:${server.address().port}/${pageName}?${new URLSearchParams(query)}`,
    );
    const result = await page
      .waitForFunction(() => window.__escapeResult, null, {
        timeout: 0,
        polling: 100,
      })
      .then(h => h.jsonValue());
    if (trace) await browser.stopTracing();
    return {...result, version: browser.version()};
  } finally {
    await browser.close();
    server.close();
  }
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const opt = (n, d) =>
    args.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? d;
  const flag = n => args.includes(`--${n}`);
  const name = args.find(a => !a.startsWith('--'));
  const wasm = opt('wasm');
  if (!name && !wasm) {
    console.error(
      'usage: node chrome.js <mandelbrot|nbody> [--threads=1,2,4,8] [--trace=file.json] [--headed]',
    );
    process.exit(1);
  }
  const query = {};
  if (opt('pool')) query.pool = opt('pool');
  if (wasm)
    query.wasm = path.relative(path.join(here, 'build'), path.resolve(wasm));
  else {
    query.program = expandForChrome(name, {atomicPoll: flag('atomic-poll')});
    query.threads = opt('threads', '1,2,4,8');
    if (flag('check')) query.check = '';
  }
  const trace = opt('trace');
  const result = await runInChrome({
    page: wasm ? 'wasm.html' : 'index.html',
    query,
    trace,
    headed: flag('headed'),
  });
  process.stdout.write(result.output);
  if (trace) console.error(`trace: ${path.resolve(trace)}`);
  if (!result.ok) console.error(result.error);
  if (flag('stats') && result.counters)
    console.error(JSON.stringify(result.counters));
  console.error(`chrome ${result.version}`);
  process.exitCode = result.ok ? 0 : 1;
}
