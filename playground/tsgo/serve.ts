// Runs tsgo's API server in WebAssembly (main.go) on two pipes (pipe.ts),
// in the worker that calls it: what the compiler's worker sends when its
// channel connects (channel.ts). Go's glue (wasm_exec.js, which defines
// globalThis.Go) must be loaded first.
import {Pipe} from './pipe.ts';

type GoInstance = {
  argv: string[];
  env: Record<string, string>;
  importObject: WebAssembly.Imports;
  exited: boolean;
  run(instance: WebAssembly.Instance): Promise<void>;
};
declare global {
  // what wasm_exec.js, Go's glue, defines
  var Go: new () => GoInstance;
  // what main.go reads its stdin and stdout from
  var tsgoPipes: {in: Pipe; out: Pipe} | undefined;
}

// what starts tsgo: its arguments, and its end of the pipes
export type TsgoStart = {
  args: string[];
  // from the client to tsgo, and back
  in: SharedArrayBuffer;
  out: SharedArrayBuffer;
};

// what tsgo's worker tells the compiler's worker (tsgo-worker.ts)
export type TsgoMessage =
  | {type: 'progress'; loaded: number; total: number}
  | {type: 'ready'}
  | {type: 'exited'}
  | {type: 'error'; message: string};

// runs tsgo until the client closes its end, or tsgo exits
export async function serve(module: WebAssembly.Module, start: TsgoStart) {
  const pipes = {in: new Pipe(start.in), out: new Pipe(start.out)};
  globalThis.tsgoPipes = pipes;
  // the client may be waiting on tsgo already: whatever stops tsgo, from
  // making its instance on, closes the pipe, so the client hears it is gone
  try {
    const go = new Go();
    go.argv = ['tsgo', ...start.args];
    go.env = {};
    const instance = await WebAssembly.instantiate(module, go.importObject);
    await go.run(instance);
  } finally {
    pipes.out.close();
  }
}
