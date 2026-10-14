import {
  Channel,
  go,
  heapStats,
  log,
  register,
  scope,
  type Scope,
} from '@arv/threads';
// a scope whose thread throws (run.test.ts): the scope joins its other threads
// all the same, and frees each thread's block and result; the body's error is
// the one thrown, else the first thread's, or all of them. a thread's is an
// Error that says what the thread threw
import {__collect} from '@arv/threads/own';

function ok(n: number) {
  return n;
}
function bad(): number {
  throw new Error('boom');
}
function worse(): number {
  throw new Error('worse');
}
// what an error says, or what was thrown if it is not one
const said = (e: unknown) =>
  e instanceof Error ? e.message : `not an Error: ${String(e)}`;
// runs body in a scope: what the scope threw, and the blocks it left behind
function attempt(body: (s: Scope) => void) {
  const before = heapStats();
  let caught = '';
  try {
    scope(body);
  } catch (e) {
    caught =
      e instanceof AggregateError
        ? `${e.message}: [${e.errors.map(said).join(', ')}]`
        : said(e);
  }
  __collect(); // the errors' strings go a grace period later
  const after = heapStats();
  log(
    `scope threw: ${caught}; blocks left behind: ${after.allocated - after.freed - (before.allocated - before.freed)}`,
  );
}
export function main() {
  attempt(s => {
    s.spawn(bad);
    for (let i = 0; i < 5; i++) s.spawn(ok, i);
  });
  // the body throws too: its error is the one thrown
  attempt(s => {
    s.spawn(bad);
    for (let i = 0; i < 5; i++) s.spawn(ok, i);
    throw new Error('the body');
  });
  // two threads throw: both errors, in one
  attempt(s => {
    s.spawn(bad);
    s.spawn(worse);
    s.spawn(ok, 1);
  });
  // in an async function, whose worker must not block: refused before a
  // thread is spawned, which could not be joined
  const done = new Channel<string>();
  go(inAsync, done);
  done.recv();
}
async function inAsync(done: Channel<string>) {
  const before = heapStats();
  let caught = '';
  try {
    scope(s => {
      s.spawn(ok, 1);
    });
  } catch (e) {
    caught = e instanceof TypeError ? 'throws' : String(e);
  }
  const after = heapStats();
  log(
    `scope in an async function: ${caught}; blocks left behind: ${after.allocated - after.freed - (before.allocated - before.freed)}`,
  );
  await done.sendAsync('done');
}
register(import.meta.url, {ok, bad, worse, main, inAsync});
