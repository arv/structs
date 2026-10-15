// The playground's compiler where no dev server compiles, as in a static
// build: threads-check (../src/checker), the compiler and ownership checker,
// in a Web Worker, on TypeScript 7.1's API. tsgo, which serves the API, is
// stock TypeScript compiled to WebAssembly, in a worker of its own
// (tsgo/tsgo-worker.ts); this worker talks to it as the API's client does to
// a tsgo process, synchronously, over pipes in shared memory
// (tsgo/channel.ts). The worker starts tsgo at once, posting how far its
// download has got, then compiles each program the page sends it, as the dev
// server does (vite-plugin-threads.ts): threads-check compiles and checks it,
// OXC strips the compiled program's types, and tsgo emits the program with
// its types only erased.
import {Buffer} from 'buffer';
import type {CompileResult} from '../src/checker/compile.ts';
import type {API} from '../src/checker/index.ts';
import type {Diagnostic as CheckDiagnostic} from '../src/checker/messages.ts';
import type {
  Compiled,
  CompilerMessage,
  CompilerRequest,
  Diagnostic,
} from './compiler-messages.ts';
import {connect} from './tsgo/channel.ts';
import {Pipe} from './tsgo/pipe.ts';
import type {TsgoMessage, TsgoStart} from './tsgo/serve.ts';

// the API's client sends nodes as base64 with node's global Buffer
(globalThis as {Buffer?: unknown}).Buffer ??= Buffer;

const post = (m: CompilerMessage) => postMessage(m);
const RUNTIME = '@arv/threads';
// where the program and the runtime's types are, in the files sent with each
// compile (tsgo has no disk; its lib files are built in)
const DIR = '/playground',
  CONFIG = `${DIR}/tsconfig.json`,
  PROGRAM = `${DIR}/program.ts`,
  TYPES = '/runtime/threads.d.ts',
  LIBS = 'bundled:///libs';
// the dev server's tsconfig.json for a program (vite-plugin-threads.ts)
const tsconfig = JSON.stringify({
  compilerOptions: {
    target: 'es2022',
    module: 'esnext',
    moduleResolution: 'bundler',
    strict: true,
    lib: ['es2022', 'dom'],
    skipLibCheck: true,
    outDir: 'out',
    rootDir: '.',
    paths: {[RUNTIME]: [TYPES]},
  },
  files: ['program.ts'],
});

// threads-check, loaded with start: OXC, which it strips types with, loads
// its WebAssembly with a top-level await, and a worker that awaited it at the
// top would miss the messages the page sends it meanwhile
type ThreadsCheck = typeof import('../src/checker/compile.ts');

// starts tsgo and loads threads-check, and gives the API session to tsgo once
// it is ready
async function start(): Promise<{api: API; threadsCheck: ThreadsCheck}> {
  const t0 = performance.now();
  const loading = Promise.all([
    import('../src/checker/index.ts'),
    import('../src/checker/compile.ts'),
  ]);
  // (its failure is reported where it is awaited, below)
  loading.catch(() => {});
  const tsgo = new Worker(new URL('./tsgo/tsgo-worker.ts', import.meta.url), {
    type: 'module',
  });
  await new Promise<void>((resolve, reject) => {
    tsgo.onmessage = ({data: m}: MessageEvent<TsgoMessage>) => {
      if (m.type === 'progress') post(m);
      else if (m.type === 'ready') resolve();
      else if (m.type === 'error') reject(new Error(m.message));
      // tsgo exited: its end of the pipe is closed, and what this worker
      // asks of it then fails
    };
    // its script did not load, or threw (a script that does not load has no
    // message)
    tsgo.onerror = e =>
      reject(new Error(e.message || "tsgo's worker did not load"));
  });
  // the API's client starts tsgo with its arguments, and talks to it over
  // two pipes: tsgo reads one and writes the other
  connect(args => {
    const out = new Pipe(1 << 20),
      in_ = new Pipe(1 << 20);
    tsgo.postMessage({args, in: out.sab, out: in_.sab} satisfies TsgoStart);
    return {out, in: in_, close: () => tsgo.terminate()};
  });
  const [{API}, threadsCheck] = await loading;
  const api = new API({
    cwd: DIR,
    useCaseSensitiveFileNames: true,
    // the client checks for no executable: tsgo is the worker connect starts
    tsserverPath: 'tsgo.wasm',
  });
  // tsgo answers: it is running
  api.createSnapshot().dispose();
  post({type: 'ready', ms: Math.round(performance.now() - t0)});
  return {api, threadsCheck};
}

const starting = start();
starting.catch(e => post({type: 'error', id: null, message: String(e)}));

// the files a compile sends tsgo, with its lib files: the program, its
// tsconfig and the runtime's types
const fileSystem = (source: string, types: string) => ({
  kind: 'full' as const,
  files: {[CONFIG]: tsconfig, [PROGRAM]: source, [TYPES]: types},
  symlinks: {[LIBS]: {target: LIBS, host: true}},
});

// a diagnostic as the page shows it, as the dev server sends it
const asPlayground = (d: CheckDiagnostic): Diagnostic => ({
  line: d.line,
  col: d.col,
  code: `TS${d.code}`,
  message: d.message,
});
const ofProgram = (d: CheckDiagnostic) => d.file === PROGRAM;

// the snapshot of the last compile, kept until the next one is made: tsgo
// keeps what it has parsed and bound (the lib files, above all) while a
// snapshot holds it, and the next compile starts from it
let last: Snapshot | null = null;
type Snapshot = ReturnType<API['createSnapshot']>;

function compileProgram(
  {api, threadsCheck: {compile, toJavaScript}}: Awaited<typeof starting>,
  source: string,
  types: string,
): Compiled {
  const files = fileSystem(source, types);
  const snapshot = api.createSnapshot({
    openProjects: [CONFIG],
    fileSystem: files,
  });
  last?.dispose();
  last = snapshot;
  const erased = erase(snapshot);
  const t0 = performance.now();
  let result: CompileResult;
  try {
    result = compile(CONFIG, {
      runtime: RUNTIME,
      api,
      check: true,
      types: true,
      fileSystem: files,
    });
  } catch (e) {
    return {
      js: null,
      erased,
      ownership: [
        {
          line: 1,
          col: 1,
          code: 'TS0',
          message: `threads-check failed: ${(e as Error).message ?? e}`,
        },
      ],
      types: [],
      ms: 0,
      checkMs: 0,
    };
  }
  const ms = Math.round(performance.now() - t0);
  const file = result.files.find(f => f.fileName === PROGRAM);
  const ownership = result.diagnostics.filter(ofProgram).map(asPlayground),
    typeErrors = result.typeDiagnostics.filter(ofProgram).map(asPlayground);
  let js: string | null = null;
  // OXC refuses a program that does not parse: no JavaScript, and the errors
  // say why (or, if none does, OXC)
  try {
    if (file) js = toJavaScript(file, {}).code;
  } catch (e) {
    if (typeErrors.length === 0)
      ownership.push({
        line: 1,
        col: 1,
        code: 'TS0',
        message: String((e as Error).message ?? e),
      });
  }
  return {js, erased, ownership, types: typeErrors, ms, checkMs: ms};
}

// the program with its types only erased: what tsgo emits for it
function erase(snapshot: Snapshot) {
  const output = snapshot
    .getConfiguredProject(CONFIG)
    ?.program.getJavaScriptEmit([PROGRAM]);
  if (!output || output.emitSkipped) return null;
  const [js] = [...output.outputFiles.values()];
  return js?.text ?? null;
}

onmessage = async ({
  data: {id, source, types},
}: MessageEvent<CompilerRequest>) => {
  try {
    post({
      type: 'result',
      id,
      compiled: compileProgram(await starting, source, types),
    });
  } catch (e) {
    post({type: 'error', id, message: String(e)});
  }
};
