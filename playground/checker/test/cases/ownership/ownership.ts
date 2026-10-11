// The region analysis on ordinary values (ownership.go), in the plain API.
import { Barrier, Channel, consume, scope, share, spawn, take, partition, type Sending, type Shared } from "threads";

declare const flag: boolean;
declare function use(...values: unknown[]): void;

export function maybeSent(ch: Channel<number[]>) {
  const xs = [1, 2];
  if (flag) ch.send(xs);
  return xs.length;                          // error: may have been sent
}

export function maybeShares(ch: Channel<number[][]>) {
  const xs = [1, 2];
  const all = [xs];
  if (flag) ch.send(all);
  return xs.length;                          // error: shares objects with all, which may have been sent
}

export function maybeConsumed(ch: Channel<number[]>) {
  const xs = [1, 2];
  if (flag) ch.send(consume(xs));
  return xs.length;                          // error: may have been consumed
}

export function returnsSending(xs: number[]): Sending<number[]> {
  return xs;                                 // error: may be referenced by the caller
}

export function returnsFresh(n: number): Sending<number[]> {
  return [n];
}

export const arrowSending = (xs: number[]): Sending<number[]> => xs;   // error

export function sharedWrites(table: Shared<number[]>, rows: Shared<number[][]>) {
  table[0] = 1;                              // error: shared
  rows[0]![1] = 2;                           // error
  table.push(3);                             // error
  const frozen = share([1, 2, 3]);
  frozen.sort();                             // error
  for (const row of rows) row.push(1);       // error
  return table.length + frozen.length;
}

export function loops(ch: Channel<number[]>) {
  let xs = [1];
  for (let i = 0; i < 3; i++) {
    ch.send(xs);                             // error: sent in an earlier iteration
  }
  while (flag) {
    const ys = [2];
    ch.send(ys);                             // fresh in every iteration
    if (flag) break;
  }
  outer: for (const k of [1, 2]) {
    for (const j of [3]) {
      if (k > j) continue outer;
      xs = [k, j];
    }
  }
  return xs;
}

export function branches(ch: Channel<number[]>, k: number) {
  const xs = [1];
  switch (k) {
    case 0:
      ch.send(xs);
      break;
    case 1:
      return xs.length;
    default:
      ch.send(consume(xs));
  }
  try {
    use(xs);                                 // error: may have been sent
  } catch (e) {
    ch.send(e as number[]);                  // error: captured from an outer scope (what was thrown)
  } finally {
    use(k);
  }
  return 0;
}

export function closures(ch: Channel<number[]>) {
  const xs = [1];
  const f = () => xs.length;
  ch.send(xs);
  return f;                                  // error: f shares objects with xs
}

export function threads(job: number[], mine: Sending<number[]>) {
  const parts = partition(mine, 2);
  const first = take(parts, 0);
  scope((s) => {
    s.spawn((p: Sending<number[]>) => p.length, first);
    spawn((p: Sending<number[]>) => p.length, job);   // error: the caller may reference job
  });
  return first;                              // error: sent
}

export class Counter {
  items: number[] = [];
  send(ch: Channel<number[]>) {
    ch.send(this.items);                     // error: the caller may reference this
  }
}

export function barrier(b: Barrier, ch: Channel<number[]>) {
  const xs = [1, 2];
  const copy = { items: xs, label: "x" };
  const { items } = copy;
  ch.send(xs);
  b.wait();
  return items.length;                       // error: shares objects with xs
}
