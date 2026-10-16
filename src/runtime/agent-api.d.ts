// The types of @arv/structs/agent (agent.ts): workers that share the heap.

export interface Agent {
  postMessage(message: unknown): void;
  onmessage: ((message: any) => void) | null;
  onerror: ((error: unknown) => void) | null;
  terminate(): void;
  readonly exited: Promise<number>;
}

// Starts a worker that runs the module at `url`, on this agent's heap.
export declare function startWorker(
  url: string | URL,
  options?: {name?: string},
): Agent;

// The agent that started this one, in a worker; null elsewhere.
export declare const parent: {
  postMessage(message: unknown): void;
  onmessage: ((message: any) => void) | null;
} | null;

// Calls the function `name` exports from the module at `url` on a new worker,
// with `args`; settles with what it returns.
export declare function run(
  url: string | URL,
  name: string,
  ...args: unknown[]
): Promise<unknown>;

// run, which can be stopped: terminate() ends the worker.
export declare function spawn(
  url: string | URL,
  name: string,
  ...args: unknown[]
): {result: Promise<unknown>; terminate(): void};

// Where the console output of run's workers goes, in a browser.
export declare function onLog(handler: ((text: string) => void) | null): void;
