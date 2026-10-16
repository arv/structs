// The playground's compiler where no dev server compiles (a static build, or
// ?wasm): the compiler (../src/compiler) in a Web Worker, on TypeScript 7.1's API.
// tsgo, which serves the API, is stock TypeScript compiled to WebAssembly, in
// a worker of its own (tsgo/tsgo-worker.ts); this worker talks to it as the
// API's client does to a tsgo process, synchronously, over pipes in shared
// memory (tsgo/channel.ts). It starts tsgo at once, posting how far its
// download has got, then compiles each program the page sends it
// (compile-program.ts), as the dev server does.
import {Buffer} from 'buffer';
import type {API} from 'typescript/sync';
import type {CompilerMessage, CompilerRequest} from './compiler-messages.ts';
import {connect} from './tsgo/channel.ts';
import {Pipe} from './tsgo/pipe.ts';
import type {TsgoMessage, TsgoStart} from './tsgo/serve.ts';

// the API's client sends nodes as base64 with node's global Buffer
(globalThis as {Buffer?: unknown}).Buffer ??= Buffer;

const post = (m: CompilerMessage) => postMessage(m);
type Program = typeof import('./compile-program.ts');

// starts tsgo and loads the compiler, and gives the API session to tsgo once
// it is ready. (The compiler is imported here, not at the top: OXC loads its
// WebAssembly with a top-level await, and a worker that awaited it at the top
// would miss the messages the page sends it meanwhile.)
async function start(): Promise<{api: API; program: Program}> {
  const t0 = performance.now();
  const loading = Promise.all([
    import('typescript/sync'),
    import('./compile-program.ts'),
  ]);
  loading.catch(() => {});
  const tsgo = new Worker(new URL('./tsgo/tsgo-worker.ts', import.meta.url), {
    type: 'module',
  });
  await new Promise<void>((resolve, reject) => {
    tsgo.onmessage = ({data: m}: MessageEvent<TsgoMessage>) => {
      if (m.type === 'progress') post(m);
      else if (m.type === 'ready') resolve();
      else if (m.type === 'error') reject(new Error(m.message));
    };
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
  const [{API}, program] = await loading;
  const api = new API({
    cwd: program.DIR,
    useCaseSensitiveFileNames: true,
    // the client checks for no executable: tsgo is the worker connect starts
    tsserverPath: 'tsgo.wasm',
  } as ConstructorParameters<typeof API>[0]);
  // tsgo answers: it is running
  api.createSnapshot().dispose();
  post({type: 'ready', ms: Math.round(performance.now() - t0)});
  return {api, program};
}

const starting = start();
starting.catch(e => post({type: 'error', id: null, message: String(e)}));

onmessage = async ({data: {id, source}}: MessageEvent<CompilerRequest>) => {
  try {
    const {api, program} = await starting;
    post({
      type: 'result',
      id,
      compiled: program.compileProgram(api, source, 'full'),
    });
  } catch (e) {
    post({type: 'error', id, message: String(e)});
  }
};
