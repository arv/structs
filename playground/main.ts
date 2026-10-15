// The playground: edit a program in Monaco, with TypeScript's types from the
// threads API; see the JavaScript it compiles to (with threads-check, or with
// its types only erased) and the ownership checker's errors; run it on the
// page's pool of workers. The Vite plugin's dev server compiles (POST
// /__threads/compile); the page imports the result as a module, and so do the
// workers. Without a dev server (a static build, or ?wasm) the page compiles
// itself, with threads-check on tsgo in WebAssembly (wasm.ts).
// first: the shared memory, before anything that uses it loads
import '@arv/threads/heap';
import {run, start, stop} from '@arv/threads/browser';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import threadsTypes from '../src/runtime/threads.d.ts?raw';
import asyncGoroutines from './programs/async-goroutines.ts?raw';
import atomics from './programs/atomics.ts?raw';
import channelPipeline from './programs/channel-pipeline.ts?raw';
import channelWorkers from './programs/channel-workers.ts?raw';
import hello from './programs/hello.ts?raw';
import json from './programs/json.ts?raw';
import mandelbrotChan from './programs/mandelbrot-chan.ts?raw';
import mistakes from './programs/mistakes.ts?raw';
import move from './programs/move.ts?raw';
import nbodyChanStruct from './programs/nbody-chan-struct.ts?raw';
import nbodyChan from './programs/nbody-chan.ts?raw';
import nbodyStruct from './programs/nbody-struct.ts?raw';
import nbodyTs from './programs/nbody-ts.ts?raw';
import pipeline from './programs/pipeline.ts?raw';
import refcount from './programs/refcount.ts?raw';
import share from './programs/share.ts?raw';
import sharedMap from './programs/shared-map.ts?raw';
import sharedVector from './programs/shared-vector.ts?raw';
import sieve from './programs/sieve.ts?raw';
import strings from './programs/strings.ts?raw';
import structTally from './programs/struct-tally.ts?raw';
import tutorial from './programs/tutorial.ts?raw';
import {compileInBrowser, programUrl, startCompiler} from './wasm.ts';

// where programs compile: on the dev server, or here in WebAssembly
const inBrowser =
  !import.meta.env.DEV || new URLSearchParams(location.search).has('wasm');

type Diagnostic = {line: number; col: number; code: string; message: string};
type Result = {
  key: string;
  compiled: {
    js: string | null;
    // what compiled it (the dev server's: threads-check, or the tsgo fork;
    // in WebAssembly, threads-check)
    compiler?: string;
    ms: number;
    ownership: Diagnostic[];
    checker: string;
    checkMs: number;
    types: Diagnostic[];
    helpers: string[];
  };
  erased: {js: string | null; error: string | null; added: number};
};

// [group, name, source]: the basics first, one idea each, then the bigger
// examples
const PRESETS: [string, string, string][] = [
  ['Basics', 'Hello, threads', hello],
  ['Basics', 'Moving a value to a thread', move],
  ['Basics', 'Sharing a value with threads', share],
  ['Basics', 'A shared struct', structTally],
  ['Basics', 'A SharedArray of booleans: a sieve', sieve],
  ['Basics', 'Strings in shared memory', strings],
  ['Basics', 'Atomics: claiming work, counting together', atomics],
  ['Basics', 'Channels: a pipeline', channelPipeline],
  ['Basics', 'Channels: a pool of workers', channelWorkers],
  ['Basics', 'Async goroutines: ten thousand waiting', asyncGoroutines],
  ['Basics', 'SharedMap and SharedSet: counting words', sharedMap],
  ['Examples', 'N-body: shared structs and a barrier', nbodyStruct],
  ['Examples', 'N-body: shared structs and channels', nbodyChanStruct],
  ['Examples', 'N-body: moving and sharing objects', nbodyTs],
  ['Examples', 'N-body: channels, copying objects', nbodyChan],
  ['Examples', 'Mandelbrot: goroutines and channels', mandelbrotChan],
  ['Examples', 'JSON: parsing a log on threads', json],
  ['Examples', 'Nearest centers (the tutorial)', tutorial],
  ['Examples', 'What channels cost', pipeline],
  ['Examples', 'Reference counting under a race', refcount],
  ['Examples', 'A growable SharedVector, in user space', sharedVector],
  ['Examples', 'Mistakes the checker catches', mistakes],
];

// what the page remembers in this browser: the program picked last, by name,
// and each program's text as edited (none once it is back to the original).
// storage can be blocked: then nothing is kept
const storage = {
  get: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
  remove: (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};
const PROGRAM_KEY = 'threads-playground:program';
const textKey = (index: number) =>
  `threads-playground:text:${PRESETS[index][1]}`;
// text saved before the API was the package @arv/threads imports it as threads
const programText = (index: number) =>
  storage
    .get(textKey(index))
    ?.replace(
      /(\bfrom\s*)(['"])threads(\/[\w-]+)?\2/g,
      '$1$2@arv/threads$3$2',
    ) ?? PRESETS[index][2];
const initial = Math.max(
  0,
  PRESETS.findIndex(([, name]) => name === storage.get(PROGRAM_KEY)),
);

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const diagnostics = $('diagnostics'),
  output = $('output');
const status = $('status'),
  runButton = $<HTMLButtonElement>('run'),
  stopButton = $<HTMLButtonElement>('stop'),
  preset = $<HTMLSelectElement>('preset');
const threadsInput = $<HTMLInputElement>('threads');

let result: Result | null = null,
  compiling = 0,
  compilingNow = false,
  compileFailed = false,
  // the run under way: Stop ends it, and how it would have ended is not shown
  running: {t0: number} | null = null,
  timer = 0,
  // the pool: its workers once it started, or why it did not
  workers = 0,
  failed = '';
const ready = () =>
  failed
    ? `The workers did not start: ${failed}`
    : workers
      ? `Ready · ${workers} workers`
      : 'Ready';
// the pool's state, in the status unless it shows a compile, under way or
// failed
const showReady = () => {
  if (!compilingNow && !compileFailed) status.textContent = ready();
};
const mode = () =>
  (document.querySelector('input[name="mode"]:checked') as HTMLInputElement)
    .value as 'compiled' | 'erased';
const escapeHtml = (s: string) =>
  s.replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

// ---- the editors ----
self.MonacoEnvironment = {
  getWorker: (_id, label) =>
    label === 'typescript' || label === 'javascript'
      ? new TsWorker()
      : new EditorWorker(),
};
// the editor's TypeScript sees the threads API as the module "@arv/threads", as
// tsc does
const ts = monaco.typescript;
ts.typescriptDefaults.setCompilerOptions({
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  strict: true,
  lib: ['es2022', 'esnext.disposable', 'dom'],
  allowNonTsExtensions: true,
  noEmit: true,
});
ts.typescriptDefaults.addExtraLib(
  threadsTypes,
  'file:///node_modules/@arv/threads/index.d.ts',
);
// the compiled JavaScript is for reading: no diagnostics on it
ts.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: true,
});

const dark = matchMedia('(prefers-color-scheme: dark)');
const theme = () => (dark.matches ? 'vs-dark' : 'vs');
dark.addEventListener('change', () => monaco.editor.setTheme(theme()));
const options: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  minimap: {enabled: false},
  scrollBeyondLastLine: false,
  theme: theme(),
  fontSize: 12.5,
  lineNumbersMinChars: 3,
  tabSize: 2,
  renderLineHighlight: 'none',
};
const sourceModel = monaco.editor.createModel(
  programText(initial),
  'typescript',
  monaco.Uri.parse('file:///program.ts'),
);
const editor = monaco.editor.create($('source'), {
  ...options,
  model: sourceModel,
});
const jsModel = monaco.editor.createModel(
  '',
  'javascript',
  monaco.Uri.parse('file:///compiled.js'),
);
const jsEditor = monaco.editor.create($('js'), {
  ...options,
  model: jsModel,
  readOnly: true,
  domReadOnly: true,
});
const added = jsEditor.createDecorationsCollection();

// what the compiler added (or, erased, the one line the runtime needs), marked
// in the JavaScript
function markAdded() {
  const marks: monaco.editor.IModelDeltaDecoration[] = [];
  const lines = jsModel.getLinesContent();
  if (result && mode() === 'compiled') {
    // the runtime's helpers, by the names the compile imported them as
    // (`__F64_1` where the program has its own `__F64` )
    const helpers = result.compiled.helpers;
    const helper = helpers.length
      ? new RegExp(`(?<![\\w$])(?:${helpers.join('|')})(?![\\w$])`, 'g')
      : null;
    if (helper)
      lines.forEach((line, i) => {
        for (const m of line.matchAll(helper))
          marks.push({
            range: new monaco.Range(
              i + 1,
              m.index + 1,
              i + 1,
              m.index + 1 + m[0].length,
            ),
            options: {inlineClassName: 'threads-added'},
          });
      });
  } else if (result?.erased.js) {
    const last = lines.length - (lines.at(-1) === '' ? 1 : 0);
    for (let n = last - result.erased.added + 1; n <= last; n++)
      marks.push({
        range: new monaco.Range(n, 1, n, 1),
        options: {isWholeLine: true, className: 'threads-added-line'},
      });
  }
  added.set(marks);
}

function showJs() {
  if (!result) return;
  if (mode() === 'compiled') {
    $('js-title').textContent = 'Compiled JavaScript';
    $('js-hint').textContent =
      `by ${result.compiled.compiler ?? 'the tsgo fork'}${inBrowser ? ', on tsgo in WebAssembly,' : ''} in ${result.compiled.ms} ms · marked: what the compiler added`;
    jsModel.setValue(result.compiled.js ?? '// nothing emitted');
  } else {
    $('js-title').textContent = 'JavaScript, types erased';
    $('js-hint').textContent =
      `${inBrowser ? 'tsgo, types only erased' : "node's type stripping"} · marked: the one line the runtime needs`;
    jsModel.setValue(result.erased.js ?? `// ${result.erased.error ?? ''}`);
  }
  markAdded();
  showDiagnostics();
}

// ---- diagnostics: the ownership checker's are squiggles in the editor too
// (tsc's, the editor's own TypeScript shows) ----
function showDiagnostics() {
  if (!result) return;
  const {ownership, types, checker, checkMs} = result.compiled;
  monaco.editor.setModelMarkers(
    sourceModel,
    'ownership',
    ownership.map(d => {
      const word = sourceModel.getWordAtPosition({
        lineNumber: d.line,
        column: d.col,
      });
      return {
        severity: monaco.MarkerSeverity.Error,
        source: checker,
        code: d.code,
        message: d.message,
        startLineNumber: d.line,
        startColumn: d.col,
        endLineNumber: d.line,
        endColumn: word?.endColumn ?? d.col + 1,
      };
    }),
  );
  const count = (n: number) =>
    n === 0 ? 'no errors' : `${n} error${n === 1 ? '' : 's'}`;
  const list = (ds: Diagnostic[]) =>
    ds.length === 0
      ? ''
      : `<ul>${ds
          .map(
            d =>
              `<li data-line="${d.line}"><span class="where">${d.line}:${d.col}</span> <span class="code">${d.code}</span> ${escapeHtml(d.message)}</li>`,
          )
          .join('')}</ul>`;
  diagnostics.innerHTML =
    `<p class="${ownership.length ? 'bad' : 'good'}">Ownership (${checker}, ${checkMs} ms): ${count(ownership.length)}</p>${list(ownership)}` +
    `<p class="${types.length ? 'bad' : 'good'}">Types (tsc's job): ${count(types.length)}</p>${list(types)}` +
    (mode() === 'erased'
      ? `<p class="note">With the types erased nothing checks ownership before it runs; the runtime still throws on a use after move.</p>`
      : '');
}

// a diagnostic's line, selected in the editor
diagnostics.addEventListener('click', e => {
  const item = (e.target as HTMLElement).closest('li');
  if (!item) return;
  const n = Number(item.dataset.line);
  editor.setSelection(
    new monaco.Range(n, 1, n, sourceModel.getLineMaxColumn(n)),
  );
  editor.revealLineInCenter(n);
  editor.focus();
});

// ---- compiling ----
async function compile() {
  const id = ++compiling;
  compilingNow = true;
  status.textContent = 'Compiling…';
  updateRun();
  try {
    const compiled = inBrowser
      ? await compileInBrowser(sourceModel.getValue(), threadsTypes)
      : await compileOnServer(sourceModel.getValue());
    if (id !== compiling) return;
    result = compiled;
    compileFailed = false;
    status.textContent = ready();
    showJs();
  } catch (e) {
    if (id !== compiling) return;
    compileFailed = true;
    status.textContent = inBrowser
      ? 'The compiler failed.'
      : "The playground compiles on Vite's dev server, which this page could not reach.";
    jsModel.setValue(`// ${String(e)}`);
  } finally {
    if (id === compiling) {
      compilingNow = false;
      updateRun();
    }
  }
}

async function compileOnServer(source: string) {
  const response = await fetch('/__threads/compile', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({source}),
  });
  if (!response.ok)
    throw new Error((await response.text()) || `HTTP ${response.status}`);
  return (await response.json()) as Result;
}

// the compiler's download, in WebAssembly: Go's is big
const download = $('download');
function showDownload(p: Parameters<Parameters<typeof startCompiler>[0]>[0]) {
  const mb = (n: number) => (n / 1e6).toFixed(1);
  if ('loaded' in p) {
    download.hidden = false;
    $<HTMLProgressElement>('download-bar').value = p.loaded / p.total;
    $('download-text').textContent =
      `Go's WebAssembly is huge… sorry. Downloading the compiler: ${mb(p.loaded)} of ${mb(p.total)} MB`;
  } else if ('ready' in p) download.hidden = true;
  else {
    download.hidden = false;
    $('download-bar').hidden = true;
    $('download-text').textContent = `The compiler did not load: ${p.error}`;
  }
}

function updateRun() {
  const code =
    result && (mode() === 'compiled' ? result.compiled.js : result.erased.js);
  runButton.disabled = running !== null || !code || compilingNow;
  stopButton.disabled = running === null;
}

// ---- running: the program's lines, with the 256-color backgrounds Mandelbrot
// draws with ----
const BASIC = [
  '#000',
  '#800000',
  '#008000',
  '#808000',
  '#000080',
  '#800080',
  '#008080',
  '#c0c0c0',
  '#808080',
  '#f00',
  '#0f0',
  '#ff0',
  '#00f',
  '#f0f',
  '#0ff',
  '#fff',
];
function xterm(n: number): string {
  if (n < 16) return BASIC[n];
  if (n < 232) {
    const c = n - 16,
      v = (k: number) => (k === 0 ? 0 : 55 + k * 40);
    return `rgb(${v(Math.floor(c / 36))},${v(Math.floor(c / 6) % 6)},${v(c % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}
function ansiToHtml(text: string): string {
  let html = '',
    open = false;
  for (const part of text.split(/(\x1b\[[\d;]*m)/)) {
    const m = /^\x1b\[([\d;]*)m$/.exec(part);
    if (!m) {
      html += escapeHtml(part);
      continue;
    }
    if (open) {
      html += '</span>';
      open = false;
    }
    const bg = /^48;5;(\d+)$/.exec(m[1]);
    if (bg) {
      html += `<span style="background:${xterm(Number(bg[1]))}">`;
      open = true;
    }
  }
  return open ? `${html}</span>` : html;
}
function print(html: string) {
  output.insertAdjacentHTML('beforeend', html);
  output.scrollTop = output.scrollHeight;
}

// the pool, printing what its threads print here (run() alone would start one
// that prints to the console): started as the page loads, after Stop, and by
// a run after one that did not start. the status says how it went
let pool: Promise<void> | null = null;
function startPool() {
  if (pool) return pool;
  // start() throws, or rejects, when the pool does not start
  const p = (pool = new Promise<void>(resolve =>
    resolve(start({onLog: text => print(ansiToHtml(text))})),
  ));
  p.then(
    () => {
      if (pool !== p) return;
      workers = navigator.hardwareConcurrency;
      failed = '';
      showReady();
    },
    (e: unknown) => {
      if (pool !== p) return;
      pool = null;
      failed = e instanceof Error ? e.message : String(e);
      showReady();
    },
  );
  return p;
}

runButton.addEventListener('click', async () => {
  if (!result) return;
  const counts = threadsInput.value
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n > 0);
  const erased = mode() === 'erased',
    name = erased ? `${result.key}.erased` : result.key,
    code = erased ? result.erased.js : result.compiled.js;
  const current = (running = {t0: performance.now()});
  updateRun();
  print(
    `<div class="run">${erased ? 'Types erased' : 'Compiled'} · ${preset.selectedOptions[0]?.text ?? 'program'} · main(${JSON.stringify(counts)}) on a worker</div>`,
  );
  try {
    const program = await import(
      /* @vite-ignore */ inBrowser
        ? programUrl(code!)
        : `/@id/virtual:threads/playground/${name}.js`
    );
    if (typeof program.main !== 'function')
      throw new Error('the program exports no main(threadCounts)');
    await startPool();
    // stopped meanwhile: it does not start
    if (running !== current) return;
    // main runs on a worker, like any thread; the page awaits it
    await run(program.main, counts);
    if (running === current)
      print(
        `<div class="done">done in ${(performance.now() - current.t0).toFixed(0)} ms</div>`,
      );
  } catch (e) {
    if (running === current)
      // an Error's message (a thread's failure says what it threw)
      print(
        `<div class="error">${escapeHtml(e instanceof Error ? e.message : String(e))}</div>`,
      );
  } finally {
    if (running === current) {
      running = null;
      updateRun();
    }
  }
});

// a run that does not end (main waits for good, say) ends here: the pool stops,
// with every thread on it, and another starts
stopButton.addEventListener('click', () => {
  if (!running) return;
  print(
    `<div class="done">stopped after ${(performance.now() - running.t0).toFixed(0)} ms</div>`,
  );
  running = null;
  pool = null;
  workers = 0;
  stop();
  showReady();
  void startPool();
  updateRun();
});

// ---- the rest of the page ----
for (const [group, name] of PRESETS) {
  let optgroup = [...preset.querySelectorAll('optgroup')].find(
    g => g.label === group,
  );
  if (!optgroup)
    preset.append(
      (optgroup = Object.assign(document.createElement('optgroup'), {
        label: group,
      })),
    );
  optgroup.append(new Option(name));
}
preset.selectedIndex = initial;
preset.addEventListener('change', () => {
  storage.set(PROGRAM_KEY, PRESETS[preset.selectedIndex][1]);
  sourceModel.setValue(programText(preset.selectedIndex));
  editor.setScrollTop(0);
});
// keep the text as edited, and offer to put the original back
const reset = $<HTMLButtonElement>('reset');
function remember() {
  const index = preset.selectedIndex,
    text = sourceModel.getValue(),
    edited = text !== PRESETS[index][2];
  if (edited) storage.set(textKey(index), text);
  else storage.remove(textKey(index));
  reset.hidden = !edited;
}
reset.addEventListener('click', () =>
  sourceModel.setValue(PRESETS[preset.selectedIndex][2]),
);
sourceModel.onDidChangeContent(() => {
  remember();
  clearTimeout(timer);
  timer = window.setTimeout(compile, 400);
});
remember();
for (const radio of document.querySelectorAll('input[name="mode"]'))
  radio.addEventListener('change', () => {
    showJs();
    updateRun();
  });
$('clear').addEventListener('click', () => {
  output.textContent = '';
});

if (inBrowser) startCompiler(showDownload);
compile();
void startPool();
(window as unknown as {__playground: unknown}).__playground = {
  get result() {
    return result;
  },
  monaco,
  editor,
  jsEditor,
};
