// Hello, threads: run a function on another thread and get its result back.
import { log, scope, spawn, type Thread } from "threads";

// runs on a thread. A thread runs a top-level function; its arguments and its result are copied
// across.
function greet(name: string, n: number): string {
  let sum = 0;
  for (let i = 1; i <= n; i++) sum += i;
  return `hello from ${name}: 1 + 2 + ... + ${n} = ${sum}`;
}

// main runs on a worker too: the playground starts it as a thread, like the ones it spawns, so it
// may block (join waits for a thread)
export function main(threadCounts: readonly number[]) {
  // one thread: spawn starts it, join waits for its result
  const thread = spawn(greet, "a thread", 100);
  log(thread.join());

  // several: scope waits for every thread it started before it returns
  const count = threadCounts.at(-1) ?? 4;
  scope(s => {
    const threads: Thread<string>[] = [];
    for (let i = 0; i < count; i++) threads.push(s.spawn(greet, `thread ${i}`, 1000 * (i + 1)));
    for (const t of threads) log(t.join());
  });
}
