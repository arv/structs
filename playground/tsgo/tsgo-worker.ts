// The worker tsgo runs in: TypeScript 7.1's API server in WebAssembly
// (main.go, built by build-wasm.ts). It downloads tsgo at once, posting how far
// it has got and then that it is ready, to the compiler's worker that started
// it (compiler.ts); then it runs tsgo when the compiler's channel connects
// (channel.ts, serve.ts).
import {serve, type TsgoMessage, type TsgoStart} from './serve.ts';

const post = (m: TsgoMessage) => postMessage(m);
const base = `${import.meta.env.BASE_URL}compiler/`;

async function load(): Promise<WebAssembly.Module> {
  const get = async (file: string) => {
    const response = await fetch(base + file);
    if (!response.ok)
      throw new Error(
        `${base}${file}: ${response.status} (build it with vp run build-wasm)`,
      );
    return response;
  };
  // Go's glue, from the Go that built tsgo: a script that defines
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
  const {bytes} = (await (await get('tsgo.wasm.json')).json()) as {
    bytes: number;
  };
  const response = await get('tsgo.wasm');
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
  // compiled as it arrives
  return WebAssembly.compileStreaming(
    new Response(counted, {headers: {'Content-Type': 'application/wasm'}}),
  );
}

const loading = load();
// why, without the Error: in front (the compiler's worker adds its own)
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
loading.then(
  () => post({type: 'ready'}),
  e => post({type: 'error', message: why(e)}),
);
onmessage = async ({data}: MessageEvent<TsgoStart>) => {
  try {
    await serve(await loading, data);
    post({type: 'exited'});
  } catch (e) {
    post({type: 'error', message: why(e)});
  }
};
