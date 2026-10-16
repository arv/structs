// The playground: edit a program in the proposal's syntax in Monaco; see the
// JavaScript it compiles to (with direct field access where TypeScript proves
// a shared struct's layout, or with every access through the Proxy) and its
// errors; run it on a worker. The dev server compiles (POST
// /__structs/compile, vite.config.ts); without one (a static build, or ?wasm)
// the page compiles itself, on tsgo in WebAssembly (wasm.ts).
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import agentTypes from '../src/runtime/agent-api.d.ts?raw';
import {onLog, spawn} from '../src/runtime/agent.ts';
import type {Running} from '../src/runtime/agent.ts';
import apiTypes from '../src/runtime/api.d.ts?raw';
import type {Compiled, Diagnostic} from './compiler-messages.ts';
import {programUrl} from './link.ts';
import atomics from './programs/atomics.ts?raw';
import condition from './programs/condition.ts?raw';
import hello from './programs/hello.ts?raw';
import mandelbrot from './programs/mandelbrot.ts?raw';
import mistakes from './programs/mistakes.ts?raw';
import mutex from './programs/mutex.ts?raw';
import nbodyParallel from './programs/nbody-parallel.ts?raw';
import nbody from './programs/nbody.ts?raw';
import shared from './programs/shared.ts?raw';
import {compileInBrowser, startCompiler} from './wasm.ts';
import type {Progress} from './wasm.ts';

// where programs compile: on the dev server, or here in WebAssembly
const inBrowser =
  !import.meta.env.DEV || new URLSearchParams(location.search).has('wasm');

// [group, name, source]: the basics first, one idea each, then the bigger
// examples
const PRESETS: [string, string, string][] = [
  ['Basics', 'Structs', hello],
  ['Basics', 'Shared structs across workers', shared],
  ['Basics', 'Atomics.Mutex: counting together', mutex],
  ['Basics', 'Atomics.Condition: a bounded queue', condition],
  ['Basics', 'Atomics on fields: claiming work', atomics],
  ['Examples', 'Mandelbrot: rows claimed by workers', mandelbrot],
  ['Examples', 'N-body: a thousand bodies on workers', nbodyParallel],
  ['Examples', 'N-body: direct field access', nbody],
  ['Examples', 'Mistakes the compiler catches', mistakes],
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
const PROGRAM_KEY = 'structs-playground:program';
const textKey = (index: number) =>
  `structs-playground:text:${PRESETS[index]![1]}`;
const programText = (index: number) =>
  storage.get(textKey(index)) ?? PRESETS[index]![2];
const initial = Math.max(
  0,
  PRESETS.findIndex(([, name]) => name === storage.get(PROGRAM_KEY)),
);

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const diagnostics = $('diagnostics'),
  output = $('output'),
  status = $('status'),
  runButton = $<HTMLButtonElement>('run'),
  stopButton = $<HTMLButtonElement>('stop'),
  preset = $<HTMLSelectElement>('preset'),
  workersInput = $<HTMLInputElement>('workers');

let result: Compiled | null = null,
  compiling = 0,
  compilingNow = false,
  compileFailed = false,
  // the run under way: Stop ends it, and how it would have ended is not shown
  running: {t0: number; run: Running} | null = null,
  timer = 0;
const mode = () =>
  (document.querySelector('input[name="mode"]:checked') as HTMLInputElement)
    .value as 'fast' | 'proxy';
const escapeHtml = (s: string) =>
  s.replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

// ---- the editors ----
self.MonacoEnvironment = {
  getWorker: (_id, label) =>
    label === 'typescript' || label === 'javascript'
      ? new TsWorker()
      : new EditorWorker(),
};
// the editor's TypeScript does not know `struct`: it colors and completes,
// and the compiler's errors are the ones shown
const ts = monaco.typescript;
ts.typescriptDefaults.setCompilerOptions({
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  strict: true,
  lib: ['esnext', 'dom'],
  allowNonTsExtensions: true,
  noEmit: true,
});
ts.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: true,
});
ts.typescriptDefaults.addExtraLib(
  `declare module '@arv/structs' {\n${apiTypes}\n}`,
  'file:///node_modules/@arv/structs/index.d.ts',
);
ts.typescriptDefaults.addExtraLib(
  `declare module '@arv/structs/agent' {\n${agentTypes}\n}`,
  'file:///node_modules/@arv/structs/agent.d.ts',
);
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

// the runtime's calls, marked in the JavaScript: `$struct.get(` and the rest
function markAdded() {
  const marks: monaco.editor.IModelDeltaDecoration[] = [];
  jsModel.getLinesContent().forEach((line, i) => {
    for (const m of line.matchAll(/\$struct(?:_\d+)?\.\w+|\$L\d+_\$struct/g))
      marks.push({
        range: new monaco.Range(
          i + 1,
          m.index + 1,
          i + 1,
          m.index + 1 + m[0].length,
        ),
        options: {
          inlineClassName: /\.(get|getNumber|set)$|^\$L/.test(m[0])
            ? 'structs-fast'
            : 'structs-added',
        },
      });
  });
  added.set(marks);
}

function showJs() {
  if (!result) return;
  const fast = mode() === 'fast';
  $('js-title').textContent = fast
    ? 'JavaScript, direct field access'
    : 'JavaScript, every field through the Proxy';
  $('js-hint').textContent =
    `${inBrowser ? 'compiled on tsgo in WebAssembly' : 'compiled on the dev server'} in ${result.ms} ms · marked: the runtime's calls${fast ? ', in bold where a field is read or written directly' : ''}`;
  jsModel.setValue((fast ? result.fast : result.proxy) ?? '// nothing emitted');
  markAdded();
  showDiagnostics();
}

// ---- diagnostics: squiggles in the editor, and a list ----
function showDiagnostics() {
  if (!result) return;
  const ds = result.diagnostics;
  monaco.editor.setModelMarkers(
    sourceModel,
    'structs',
    ds.map(d => {
      const word = sourceModel.getWordAtPosition({
        lineNumber: d.line,
        column: d.col,
      });
      return {
        severity: monaco.MarkerSeverity.Error,
        source: '@arv/structs',
        message: d.message,
        startLineNumber: d.line,
        startColumn: d.col,
        endLineNumber: d.line,
        endColumn: word?.endColumn ?? d.col + 1,
      };
    }),
  );
  const list = (ds: Diagnostic[]) =>
    ds.length === 0
      ? ''
      : `<ul>${ds
          .map(
            d =>
              `<li data-line="${d.line}"><span class="where">${d.line}:${d.col}</span> ${escapeHtml(d.message)}</li>`,
          )
          .join('')}</ul>`;
  diagnostics.innerHTML =
    `<p class="${ds.length ? 'bad' : 'good'}">${ds.length === 0 ? 'No errors' : `${ds.length} error${ds.length === 1 ? '' : 's'}`} (TypeScript's and the structs')</p>` +
    list(ds);
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
      ? await compileInBrowser(sourceModel.getValue())
      : await compileOnServer(sourceModel.getValue());
    if (id !== compiling) return;
    result = compiled;
    compileFailed = false;
    status.textContent = 'Ready';
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
  const response = await fetch('/__structs/compile', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({source}),
  });
  if (!response.ok)
    throw new Error((await response.text()) || `HTTP ${response.status}`);
  return (await response.json()) as Compiled;
}

// the compiler's download, in WebAssembly: Go's is big
const download = $('download');
function showDownload(p: Progress) {
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
  const code = result && (mode() === 'fast' ? result.fast : result.proxy);
  runButton.disabled =
    running !== null || !code || compilingNow || compileFailed;
  stopButton.disabled = running === null;
}

// ---- running: main(workers) on a worker, which may block; its workers'
// console output comes up to the page ----
function print(html: string) {
  output.insertAdjacentHTML('beforeend', html);
  output.scrollTop = output.scrollHeight;
}
// (but the dev server's client, which says it connected in each worker, and
// what a warm-up run prints)
let quiet = false;
onLog(text => {
  if (!quiet && !text.startsWith('[vite]')) print(`${escapeHtml(text)}\n`);
});

// the worker counts to run main with: "1,2,4,8" (at most 64 each)
const workerCounts = () =>
  workersInput.value
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n > 0 && n <= 64);

runButton.addEventListener('click', async () => {
  if (!result) return;
  const fast = mode() === 'fast',
    code = fast ? result.fast : result.proxy;
  if (!code) return;
  const counts = workerCounts();
  if (counts.length === 0) counts.push(1);
  print(
    `<div class="run">${fast ? 'Direct field access' : 'Proxy only'} · ${escapeHtml(preset.selectedOptions[0]?.text ?? 'program')} · main(n) on a worker, for n = ${counts.join(', ')}</div>`,
  );
  const t0 = performance.now();
  // each count's time, from the call of main to its end
  const times: [number, number][] = [];
  try {
    // a run on the most workers first, unshown, so that each worker has
    // optimized its hot code before the runs that are timed (the pool keeps
    // them: see run in @arv/structs/agent)
    if ($<HTMLInputElement>('warm').checked) {
      const most = Math.max(...counts);
      print(`<div class="step">warming up: main(${most})</div>`);
      const current = (running = {
        t0: performance.now(),
        run: spawn(programUrl(code), 'main', most),
      });
      updateRun();
      quiet = true;
      try {
        await current.run.result;
      } finally {
        quiet = false;
      }
      if (running !== current) return;
    }
    for (const n of counts) {
      const current = (running = {
        t0: performance.now(),
        run: spawn(programUrl(code), 'main', n),
      });
      updateRun();
      if (counts.length > 1) print(`<div class="step">main(${n})</div>`);
      await current.run.result;
      // stopped meanwhile: the rest does not run
      if (running !== current) return;
      const ms = performance.now() - current.t0;
      times.push([n, ms]);
      if (counts.length > 1)
        print(
          `<div class="step">${n} worker${n === 1 ? '' : 's'}: ${ms.toFixed(0)} ms</div>`,
        );
    }
    const [, base] = times[0]!;
    print(
      `<div class="done">${
        times.length > 1
          ? times
              .map(
                ([n, ms]) =>
                  `${n}: ${ms.toFixed(0)} ms (${(base / ms).toFixed(2)}x)`,
              )
              .join(' · ')
          : `done in ${(performance.now() - t0).toFixed(0)} ms`
      }</div>`,
    );
  } catch (e) {
    if (running)
      print(
        `<div class="error">${escapeHtml(e instanceof Error ? e.message : String(e))}</div>`,
      );
  } finally {
    running = null;
    updateRun();
  }
});

// a run that does not end ends here: its worker, and the workers it started;
// the counts after it do not run
stopButton.addEventListener('click', () => {
  if (!running) return;
  running.run.terminate();
  print(
    `<div class="done">stopped after ${(performance.now() - running.t0).toFixed(0)} ms</div>`,
  );
  running = null;
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
  storage.set(PROGRAM_KEY, PRESETS[preset.selectedIndex]![1]);
  sourceModel.setValue(programText(preset.selectedIndex));
  editor.setScrollTop(0);
});
// keep the text as edited, and offer to put the original back
const reset = $<HTMLButtonElement>('reset');
function remember() {
  const index = preset.selectedIndex,
    text = sourceModel.getValue(),
    edited = text !== PRESETS[index]![2];
  if (edited) storage.set(textKey(index), text);
  else storage.remove(textKey(index));
  reset.hidden = !edited;
}
reset.addEventListener('click', () =>
  sourceModel.setValue(PRESETS[preset.selectedIndex]![2]),
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
void compile();
(window as unknown as {__playground: unknown}).__playground = {
  get result() {
    return result;
  },
  get running() {
    return running !== null;
  },
  monaco,
  editor,
  jsEditor,
};
