// An async main (run.test.ts): run.ts awaits it. It joins threads without
// blocking, an ordinary one and an async one, and goes on after each await
import {fns, log, spawn} from '@arv/threads/own';

function square(n: number) {
  return n * n;
}
async function later(n: number) {
  await new Promise(resolve => setTimeout(resolve, 1));
  return n + 1;
}
fns({square, later});

export async function main(threadCounts: readonly number[]) {
  for (const n of threadCounts) {
    const a = await spawn(square, n).joinAsync(),
      b = await spawn(later, n).joinAsync();
    log(`${n}: ${a} ${b}`);
  }
  log('main is done');
}
