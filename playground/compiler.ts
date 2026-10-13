// The tsgo fork compiled to WebAssembly (build-wasm.ts), in a Web Worker: the
// playground compiles with it where no dev server compiles, as in a static
// build. It downloads the compiler at once, posting how far it has got, then
// compiles each program the page sends it.
type GoInstance = {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
};
declare global {
  // what wasm_exec.js, Go's glue, defines
  var Go: new () => GoInstance;
  // what the compiler defines (cmd/wasm in arv/threads-checker)
  var threadsCompile: (source: string, runtimeTypes: string) => string;
  var threadsCompilerReady: () => void;
}

// what the page and this worker say to each other
export type CompilerRequest = {id: number; source: string; types: string};
export type CompilerMessage =
  | {type: 'progress'; loaded: number; total: number}
  | {type: 'ready'; ms: number}
  | {type: 'result'; id: number; json: string}
  | {type: 'error'; id: number | null; message: string};

const post = (m: CompilerMessage) => postMessage(m);
const base = `${import.meta.env.BASE_URL}compiler/`;

async function load() {
  const t0 = performance.now();
  const get = async (file: string) => {
    const response = await fetch(base + file);
    if (!response.ok)
      throw new Error(
        `${base}${file}: ${response.status} (build it with vp run build-wasm)`,
      );
    return response;
  };
  // Go's glue, from the Go that built the compiler: a script that defines
  // globalThis.Go, which runs as a module too (from a blob: URL, since a dev
  // server will not serve a public file as a module)
  const glue = URL.createObjectURL(
    new Blob([await (await get('wasm_exec.js')).text()], {
      type: 'text/javascript',
    }),
  );
  await import(/* @vite-ignore */ glue);
  URL.revokeObjectURL(glue);
  // the size before any compression the server adds, which the body's bytes
  // count against
  const {bytes} = (await (await get('threads.wasm.json')).json()) as {
    bytes: number;
  };
  const response = await get('threads.wasm');
  let loaded = 0,
    shown = 0;
  const counted = response.body!.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        loaded += chunk.byteLength;
        if (loaded - shown > bytes / 200 || loaded >= bytes) {
          shown = loaded;
          post({type: 'progress', loaded, total: bytes});
        }
        out.enqueue(chunk);
      },
    }),
  );
  const go = new Go();
  const ready = new Promise<void>(resolve => {
    globalThis.threadsCompilerReady = resolve;
  });
  // compiled as it arrives
  const {instance} = await WebAssembly.instantiateStreaming(
    new Response(counted, {headers: {'Content-Type': 'application/wasm'}}),
    go.importObject,
  );
  void go.run(instance);
  await ready;
  post({type: 'ready', ms: Math.round(performance.now() - t0)});
}

const loading = load();
loading.catch(e => post({type: 'error', id: null, message: String(e)}));
onmessage = async ({
  data: {id, source, types},
}: MessageEvent<CompilerRequest>) => {
  try {
    await loading;
    post({type: 'result', id, json: threadsCompile(source, types)});
  } catch (e) {
    post({type: 'error', id, message: String(e)});
  }
};
