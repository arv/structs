// Async goroutines. A goroutine of a plain function is a whole worker, a thread, which may block. A
// goroutine of an async function is light: a worker runs any number of them, and each one waiting is a
// suspended async function, a few hundred bytes. They wait with await: sendAsync, recvAsync, for await
// and selectAsync never block the worker they share (and a call that would, like recv(), throws there).
//
// Here ten thousand requests wait for a database replica to reach the position each needs, as the
// request handlers of a Go server do, and then a pipeline of async goroutines squares numbers.
import { atomic, Channel, go, i32, log, ref, selectAsync, struct } from "threads";

interface Db { done: Channel<void> | null }
const Db = struct<Db>({ done: ref<Channel<void>>() });

// a replica's position, and a channel that is closed, and replaced, on every change: closing it wakes
// everyone waiting on it at once. only advance() writes `changed`
interface Replica { txid: i32; changed: Channel<void> | null; db: Db | null }
const Replica = struct<Replica>({ txid: i32, changed: ref<Channel<void>>(), db: ref<Db>() });

// Go's
//   for {
//     notify := r.Notify()
//     if r.Pos().TXID >= txID { return nil }
//     select {
//     case <-notify:
//     case <-ctx.Done(): return fmt.Errorf("waiting for position %d: %w", txID, context.Cause(ctx))
//     case <-r.db.ctx.Done(): return ErrDatabaseNotOpen
//     }
//   }
async function waitForPos(r: Replica, txID: i32, cancel: Channel<void>): Promise<string> {
  for (;;) {
    const notify = r.changed!;
    if (atomic.load(r, "txid") >= txID) return "reached";
    const [which] = await selectAsync(notify, cancel, r.db!.done!);
    if (which === 1) return "cancelled";
    if (which === 2) return "database closed";
  }
}

function advance(r: Replica, txid: i32) {
  atomic.store(r, "txid", txid);
  const changed = r.changed;
  r.changed = new Channel<void>();
  changed?.close();
}

// a request: waits until the replica has what it needs, and answers
async function request(r: Replica, txID: i32, cancel: Channel<void>, answers: Channel<string>) {
  await answers.sendAsync(await waitForPos(r, txID, cancel));
}

// stages of a pipeline
async function numbers(n: number, out: Channel<number>) {
  for (let i = 1; i <= n; i++) await out.sendAsync(i);
  out.close();
}
async function squares(input: Channel<number>, out: Channel<number>) {
  for await (const x of input) await out.sendAsync(x * x);
  out.close();
}

// main is async too, so it waits as the others do: the playground runs it on a worker among them
export async function main(threadCounts: readonly number[]) {
  const db = new Db(), r = new Replica();
  db.done = new Channel<void>();
  r.db = db;
  r.changed = new Channel<void>();
  const N = 10_000, answers = new Channel<string>(N), cancel = new Channel<void>();

  let t0 = performance.now();
  for (let k = 0; k < N; k++) go(request, r, k % 1000 + 1, cancel, answers);
  log(`${N} requests started in ${(performance.now() - t0).toFixed(0)} ms; each waits for a position from 1 to 1000`);

  const counts: Record<string, number> = {};
  const tally = async (n: number) => {
    for (let k = 0; k < n; k++) {
      const answer = (await answers.recvAsync())!;
      counts[answer] = (counts[answer] ?? 0) + 1;
    }
  };
  t0 = performance.now();
  for (let txid = 1; txid <= 900; txid++) advance(r, txid);
  await tally(N * 9 / 10);
  log(`the replica advanced to 900: ${counts.reached} requests answered in ${(performance.now() - t0).toFixed(0)} ms`);
  cancel.close();
  await tally(N / 10);
  log(`then the rest were cancelled: ${JSON.stringify(counts)}`);

  const naturals = new Channel<number>(64), squared = new Channel<number>(64), M = 100_000;
  t0 = performance.now();
  go(numbers, M, naturals);
  go(squares, naturals, squared);
  let sum = 0;
  for await (const x of squared) sum += x;
  log(`a pipeline of async goroutines: ${M} numbers squared and summed in ${(performance.now() - t0).toFixed(0)} ms (${sum})`);
}
