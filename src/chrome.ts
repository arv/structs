import fs from 'node:fs';
// runs a hand-translated program in Chrome (the installed Google Chrome,
// through Playwright), on real Web Workers sharing one SharedArrayBuffer heap
//   node src/chrome.ts <mandelbrot|nbody> [options]
//   --threads=1,2,4,8   the thread counts the program runs its work with
//   --pool=N            workers started up front (default: the browser's
//                       hardwareConcurrency)
//   --trace=file.json   record a DevTools performance trace (CPU samples of
//                       every thread); open it in DevTools' Performance panel,
//                       or summarize it with trace-summary.ts
//   --headed            show the browser window (default: Chrome's headless
//                       mode)
//   --atomic-poll       clean points poll with Atomics.load instead of a plain
//                       load
//   --stats             print the runtime's counters (to stderr)
//   --check             verify every boxed value word right after storing it,
//                       poison freed blocks
// needs playwright-core (a dev dependency of this repository), found
// normally or through $PLAYWRIGHT_CORE, the path of an install's
// node_modules/playwright-core
import http from 'node:http';
import {createRequire, stripTypeScriptTypes} from 'node:module';
import type {AddressInfo} from 'node:net';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import type {BrowserType} from 'playwright-core';
import {expand} from './expand.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
// the repository: its pages are under src/, what they load is built in build/
const repo = path.resolve(here, '..');

const loadChromium = async (): Promise<BrowserType> => {
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

// this repository, cross-origin isolated (SharedArrayBuffer needs COOP and
// COEP)
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
};
const serve = async () => {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(
      new URL(req.url!, 'http://localhost').pathname,
    );
    const file = path.join(repo, pathname);
    if (
      !file.startsWith(repo) ||
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
    // TypeScript as the browser can run it: its types stripped
    if (file.endsWith('.ts'))
      res.end(stripTypeScriptTypes(fs.readFileSync(file, 'utf8')));
    else fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  // listening on a port, so its address is one
  return server as Omit<http.Server, 'address'> & {address(): AddressInfo};
};

// expands a program for the page: build/<name>.js (build/ is not committed).
// the program is one in this directory by name, or the path of a module (such
// as one the tsgo fork emitted); returns the name the page loads it by
export const expandForChrome: (
  program: string,
  options?: {atomicPoll?: boolean},
) => string = (program, {atomicPoll = false} = {}) => {
  const file =
    /\.[jt]s$/.test(program) && fs.existsSync(path.resolve(program))
      ? path.resolve(program)
      : (['.ts', '.js']
          .map(ext => path.join(here, `${program}${ext}`))
          .find(f => fs.existsSync(f)) ?? path.join(here, `${program}.js`));
  const name = path.basename(file).replace(/\.[jt]s$/, '');
  const text = fs.readFileSync(file, 'utf8');
  fs.mkdirSync(path.join(repo, 'build'), {recursive: true});
  fs.writeFileSync(
    path.join(repo, 'build', `${name}.js`),
    expand(file.endsWith('.ts') ? stripTypeScriptTypes(text) : text, {
      atomicPoll,
      runtime: '../src/runtime/runtime.ts',
    }),
  );
  return name;
};

// runs a program (expanded first, see expandForChrome) on index.html to
// completion. resolves to { ok, error, output, counters, version }
export const runInChrome = async ({
  query = {},
  trace = null,
  headed = false,
}: {
  query?: Record<string, string>;
  trace?: string | null;
  headed?: boolean;
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
      `http://127.0.0.1:${server.address().port}/src/index.html?${new URLSearchParams(query)}`,
    );
    const result = await page
      .waitForFunction(() => window.__escapeResult!, null, {
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
  const opt = (n: string, d?: string) =>
    args.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? d;
  const flag: (n: string) => boolean = n => args.includes(`--${n}`);
  const name = args.find(a => !a.startsWith('--'));
  if (!name) {
    console.error(
      'usage: node src/chrome.ts <mandelbrot|nbody> [--threads=1,2,4,8] [--trace=file.json] [--headed]',
    );
    process.exit(1);
  }
  const query: Record<string, string> = {
    program: expandForChrome(name, {atomicPoll: flag('atomic-poll')}),
    threads: opt('threads', '1,2,4,8')!,
  };
  if (opt('pool')) query.pool = opt('pool')!;
  if (flag('check')) query.check = '';
  const trace = opt('trace');
  const result = await runInChrome({
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
