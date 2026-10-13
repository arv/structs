// join() in an async function (run.test.ts): it would block the worker that
// hosts the function, so it throws, and it throws before it commits to
// anything: the thread goes on, its block stays its own, and joinAsync() still
// joins it
import {Channel, go, log, register, spawn} from '@arv/threads';

function square(n: number) {
  return n * n;
}
async function joiner(done: Channel<string>) {
  const t = spawn(square, 3);
  try {
    t.join();
  } catch (e) {
    log(
      `join() in an async function: ${e instanceof TypeError ? 'throws' : String(e)}`,
    );
  }
  log(`joinAsync() after it: ${await t.joinAsync()}`);
  log(`another thread: ${await spawn(square, 5).joinAsync()}`);
  await done.sendAsync('done');
}
export function main() {
  const done = new Channel<string>();
  go(joiner, done);
  done.recv();
}
register(import.meta.url, {square, joiner, main});
