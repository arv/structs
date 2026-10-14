// A page's side of threads: a pool of Web Workers, and functions run on it. The
// page's entry module imports "@arv/threads/heap" first.
import type {Sending} from '@arv/threads';

/**
 * Starts the pool of workers (by default one per core); run() starts it if
 * needed, with the defaults. The options are the first start()'s: a later
 * start() with other options throws, until stop().
 */
export declare function start(options?: {
  workers?: number;
  check?: boolean;
  onLog?: (text: string) => void;
}): Promise<void>;
/**
 * Runs `f` on a thread and resolves with its result, which moves to the page.
 * Every argument is sent. If `f` throws, rejects with an Error that says what
 * it threw, as joining its thread would.
 */
export declare function run<A extends unknown[], R>(
  f: (...args: A) => Sending<R>,
  ...args: Sending<A>
): Promise<Sending<R>>;
/**
 * Stops the pool: its workers are terminated, with the threads they ran, and
 * the runs waiting fail. A spawn throws until start() starts a new pool on the
 * same heap, which is also how a stuck pool is recovered.
 */
export declare function stop(): void;
// start(), run() and stop() are for the page: on a worker (which loads every
// module that defines a function a thread runs, the page's entry too should it
// define one) they throw
