// The playground's static build, as GitHub Pages serves it, in Chrome (the
// installed one, through Playwright): served with no COOP or COEP headers, so
// the service worker must isolate it, it compiles every program in the
// browser (threads-check on tsgo in WebAssembly), and runs each, compiled and
// with its types erased. The dev server, where threads-check compiles on
// TypeScript's native API, does the same, and the two must agree: the same
// compiled JavaScript, ownership errors and type errors, and the same output
// from each run (its lines in any order, as threads print them, and its
// timings left out). It prints how long each compile took in the page.
//   vp run build-wasm && vp run test-build
//   --compare=<dir>   also time the compiles of another static build (an
//                     older one, say), served the same way
//   --only=<text>     the programs whose names include it
//   --threads=1,2     the thread counts each run runs with
import fs from 'node:fs';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Browser} from 'playwright-core';
import {build, createServer} from 'vite-plus';

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));
const arg = (name: string) =>
  process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const threads = arg('threads') ?? '1,2';
const only = arg('only');
const compare = arg('compare');

const fail = (message: string): never => {
  console.error(`test-build: ${message}`);
  process.exit(1);
};
if (!fs.existsSync(here('public/compiler/tsgo.wasm')))
  fail('no public/compiler/tsgo.wasm: build it with vp run build-wasm');

// the build, served from /playground/ as Pages serves it
const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-playground-'));
process.env.BASE = '/playground/';
await build({
  configFile: here('vite.config.ts'),
  root: here('.'),
  logLevel: 'error',
  build: {outDir: dist, emptyOutDir: true},
});

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
};
// a directory at /playground/, with no headers but the content type
async function serveStatic(root: string) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x').pathname;
    let file = url.startsWith('/playground/')
      ? path.join(root, decodeURIComponent(url.slice('/playground/'.length)))
      : '';
    if (fs.statSync(file, {throwIfNoEntry: false})?.isDirectory())
      file = path.join(file, 'index.html');
    if (
      !file.startsWith(root) ||
      !fs.statSync(file, {throwIfNoEntry: false})?.isFile()
    ) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    });
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const {port} = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/playground/`,
    close: () => server.close(),
  };
}

type Diagnostic = {line: number; col: number; code: string; message: string};
type Program = {
  name: string;
  // how long the page took, from asking for the compile to its result
  ms: number;
  js: string | null;
  ownership: Diagnostic[];
  types: Diagnostic[];
  // each run's lines: compiled, and with its types erased
  runs: Record<'compiled' | 'erased', string[]>;
};

// what the page compiles and prints for each program
async function programs(
  browser: Browser,
  url: string,
  options: {run: boolean},
): Promise<Program[]> {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(url);
    // isolated (on Pages, after the service worker's reload), its compiler
    // loaded and the first program compiled
    for (;;) {
      try {
        await page.waitForFunction(
          () =>
            crossOriginIsolated &&
            (window as any).__playground?.result &&
            document.getElementById('status')!.textContent!.startsWith('Ready'),
          null,
          {timeout: 120_000},
        );
        break;
      } catch (e) {
        // the page loaded again meanwhile: wait on the new one
        if (!/context was destroyed|navigation/i.test((e as Error).message))
          throw e;
      }
    }
    await page.fill('#threads', threads);
    const names = await page.$$eval('#preset option', os =>
      os.map(o => o.textContent!),
    );
    // the first is compiled already: it comes last, after another
    const order = [...names.keys()].slice(1).concat(0);
    const results: Program[] = [];
    for (const i of order) {
      if (only && !names[i]!.includes(only) && i !== 0) continue;
      const compiled = await page.evaluate(
        async ([i, deadline]) => {
          const pg = (window as any).__playground;
          const status = document.getElementById('status')!;
          const preset = document.getElementById('preset') as HTMLSelectElement;
          const before = pg.result;
          let t0 = 0,
            t1 = 0;
          const seen = new MutationObserver(() => {
            const compiling = status.textContent!.startsWith('Compiling');
            if (compiling && !t0) t0 = performance.now();
            else if (!compiling && t0 && !t1) t1 = performance.now();
          });
          seen.observe(status, {
            childList: true,
            characterData: true,
            subtree: true,
          });
          try {
            preset.selectedIndex = i;
            preset.dispatchEvent(new Event('change'));
            // done: a result, or a compile that failed (the page keeps the
            // result before, and says so)
            const end = performance.now() + deadline;
            while (!t1) {
              if (performance.now() > end)
                throw new Error(
                  `no compile in ${deadline} ms: ${status.textContent}`,
                );
              await new Promise(r => setTimeout(r, 10));
            }
            if (pg.result === before)
              throw new Error(`the compile failed: ${status.textContent}`);
          } finally {
            seen.disconnect();
          }
          const {js, ownership, types} = pg.result.compiled;
          return {ms: Math.round(t1 - t0), js, ownership, types};
        },
        [i, 120_000] as const,
      );
      const runs = {compiled: [] as string[], erased: [] as string[]};
      if (options.run && (!only || names[i]!.includes(only)))
        for (const mode of ['compiled', 'erased'] as const)
          runs[mode] = await page.evaluate(
            async ([mode, deadline]) => {
              const out = document.getElementById('output')!;
              const run = document.getElementById('run') as HTMLButtonElement;
              const end = performance.now() + deadline;
              const until = async (done: () => boolean, what: string) => {
                while (!done()) {
                  if (performance.now() > end)
                    throw new Error(`${what} in ${deadline} ms`);
                  await new Promise(r => setTimeout(r, 20));
                }
              };
              (
                document.querySelector(
                  `input[name="mode"][value="${mode}"]`,
                ) as HTMLInputElement
              ).click();
              await until(() => !run.disabled, 'Run never enabled');
              const from = out.childNodes.length;
              run.click();
              const isError = (n: Node) =>
                n instanceof HTMLElement && n.classList.contains('error');
              await until(
                () =>
                  [...out.childNodes]
                    .slice(from)
                    .some(
                      n =>
                        isError(n) ||
                        (n instanceof HTMLElement &&
                          n.classList.contains('done')),
                    ),
                'the run did not end',
              );
              // a failure as such: the page shows only its message
              return [...out.childNodes]
                .slice(from)
                .map(
                  n =>
                    (isError(n) ? 'Error: ' : '') +
                    ((n as HTMLElement).innerText ?? n.textContent),
                )
                .join('\n')
                .split('\n');
            },
            [mode, 300_000] as const,
          );
      if (!only || names[i]!.includes(only))
        results.push({name: names[i]!, ...compiled, runs});
    }
    if (errors.length) fail(`${url}: ${errors.join('\n')}`);
    return results;
  } finally {
    await page.close();
  }
}

// what in a program's output depends on how its threads were scheduled, by
// program: it differs from one run to the next
const SCHEDULED: Record<string, RegExp> = {
  // which thread claimed which rows
  'Atomics: claiming work, counting together':
    /(?<=rows drawn by each )[\d, ]+/g,
  // which worker took which job
  'Channels: a pool of workers': /(?<=done by worker )\d+/g,
  // what the race decides: how far the heap grew, the blocks allocated and
  // freed, and the decrements left pending (but not its errors, which must
  // be 0, nor the churn's sum)
  'Reference counting under a race':
    /(?<=heap (grew )?)\d+|(?<=(blocks allocated|freed|allocated - freed|decrements pending) )\d+/g,
  // how many times the reader read while the writers pushed, and how far the
  // heap grew meanwhile
  'A growable SharedVector, in user space':
    /(?<=reader: )\d+(?= reads)|(?<=heap grew )\d+/g,
};

// a run's lines, as two runs of a program may differ: in any order, its
// timings and speedups left out, and what depends on scheduling
const normalized = (name: string, lines: string[]) =>
  lines
    .map(line =>
      line
        .replace(SCHEDULED[name] ?? /$^/, '#')
        .replace(/\d+(\.\d+)?(\s*)(ms|us|ns|µs|x)\b/g, '#$3')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .sort();

const {chromium} = await import('playwright-core');
const browser = await chromium.launch({channel: 'chrome'});
let failures = 0;
try {
  const built = await serveStatic(dist);
  let inBrowser: Program[];
  try {
    inBrowser = await programs(browser, built.url, {run: true});
  } finally {
    built.close();
  }
  const server = await createServer({
    configFile: here('vite.config.ts'),
    root: here('.'),
    logLevel: 'error',
    server: {port: 0, host: '127.0.0.1'},
  });
  await server.listen();
  let onServer: Program[];
  try {
    onServer = await programs(browser, server.resolvedUrls!.local[0]!, {
      run: true,
    });
  } finally {
    await server.close();
  }
  let other: Program[] = [];
  if (compare) {
    const served = await serveStatic(path.resolve(compare));
    try {
      other = await programs(browser, served.url, {run: false});
    } finally {
      served.close();
    }
  }

  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  const rows: string[] = [];
  for (const p of inBrowser) {
    const s = onServer.find(q => q.name === p.name)!;
    const differ: string[] = [];
    if (p.js !== s.js) differ.push('compiled JavaScript');
    if (!same(p.ownership, s.ownership)) differ.push('ownership errors');
    if (!same(p.types, s.types)) differ.push('type errors');
    for (const mode of ['compiled', 'erased'] as const) {
      if (
        !same(
          normalized(p.name, p.runs[mode]),
          normalized(p.name, s.runs[mode]),
        )
      )
        differ.push(`output (${mode})`);
      if (
        p.runs[mode].some(l => /^Error|error:/i.test(l)) &&
        !/Mistakes/.test(p.name)
      )
        differ.push(`an error (${mode}): ${p.runs[mode].join(' / ')}`);
    }
    if (differ.length) failures++;
    const o = other.find(q => q.name === p.name);
    rows.push(
      `${differ.length ? 'FAIL' : 'ok  '} ${p.name.padEnd(44)} ${String(p.ms).padStart(5)} ms${o ? `  (compare: ${String(o.ms).padStart(5)} ms)` : ''}${differ.length ? `  differs: ${differ.join(', ')}` : ''}`,
    );
    if (differ.length && process.env.VERBOSE)
      for (const mode of ['compiled', 'erased'] as const) {
        const a = normalized(p.name, p.runs[mode]),
          b = normalized(p.name, s.runs[mode]);
        console.log(
          `${p.name} (${mode}): only in the browser:\n  ${a.filter(l => !b.includes(l)).join('\n  ')}\nonly on the server:\n  ${b.filter(l => !a.includes(l)).join('\n  ')}`,
        );
      }
  }
  console.log(
    `Chrome ${browser.version()}: the static build, compiling in the browser, against the dev server\n${rows.join('\n')}`,
  );
} finally {
  await browser.close();
  fs.rmSync(dist, {recursive: true, force: true});
}
if (failures) fail(`${failures} programs differ`);
