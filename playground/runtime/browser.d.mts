// A page's side of threads: a pool of Web Workers, and functions run on it. The page's entry module
// imports "threads/heap" first.
import type { Sending } from "./threads.mjs";

/** Starts the pool of workers (by default one per core); run() starts it if needed. */
export declare function start(options?: { workers?: number; check?: boolean; onLog?: (text: string) => void }): Promise<void>;
/** Runs `f` on a thread and resolves with its result, which moves to the page. Every argument is sent. */
export declare function run<A extends unknown[], R>(f: (...args: A) => Sending<R>, ...args: Sending<A>): Promise<Sending<R>>;
/** Stops the pool. */
export declare function stop(): void;
