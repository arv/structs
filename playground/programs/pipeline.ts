// goroutines and channels (chan.mjs) in plain TypeScript on threads.mjs, and what they cost:
// an unbuffered ping-pong, a buffered producer and consumer, two producers merged with select, and
// big arrays sent as copies and as SharedArrays, which move by address.
import { Channel, go, log, select, SharedArray } from "threads";

type Item = { id: number; label: string };

// answers every number on `ping` with the next one on `pong`
function echo(ping: Channel<number>, pong: Channel<number>) {
  for (const n of ping) pong.send(n + 1);
}

// sends `count` items numbered from `first`, then closes the channel
function produce(out: Channel<Item>, first: number, count: number) {
  for (let i = 0; i < count; i++) out.send({ id: first + i, label: `item ${first + i}` });
  out.close();
}

// BUFFERS arrays of BIG numbers: as ordinary arrays, copied into each message and out again
function fillArrays(out: Channel<number[]>) {
  for (let k = 0; k < BUFFERS; k++) {
    const a: number[] = [];
    for (let i = 0; i < BIG; i++) a.push(k + i);
    out.send(a);
  }
  out.close();
}

// the same as SharedArrays: only the address crosses, and the receiver owns the array
function fillShared(out: Channel<SharedArray<number>>) {
  for (let k = 0; k < BUFFERS; k++) {
    const a = new SharedArray(Number, BIG);
    for (let i = 0; i < a.length; i++) a[i] = k + i;
    out.send(a);
  }
  out.close();
}

const ROUNDS = 10000, ITEMS = 100000, BUFFERS = 200, BIG = 100000;

export function main(threadCounts: readonly number[]) {
  // one value back and forth: each send waits for its receiver
  const ping = new Channel<number>(), pong = new Channel<number>();
  go(echo, ping, pong);
  let n = 0;
  const t0 = performance.now();
  for (let i = 0; i < ROUNDS; i++) {
    ping.send(n);
    n = pong.recv()!;
  }
  const roundTrip = (performance.now() - t0) * 1000 / ROUNDS;
  ping.close();
  log(`unbuffered: ${ROUNDS} round trips, ${roundTrip.toFixed(1)} us each (n = ${n})`);

  // a producer runs ahead of its consumer, up to the channel's capacity
  const items = new Channel<Item>(1024);
  const t1 = performance.now();
  go(produce, items, 0, ITEMS);
  let sum = 0;
  for (const item of items) sum += item.id;
  const each = (performance.now() - t1) * 1e6 / ITEMS;
  log(`buffered: ${ITEMS} items, ${each.toFixed(0)} ns each (sum of ids ${sum})`);

  // select takes from whichever producer is ready; a closed channel leaves the set
  const a = new Channel<Item>(64), b = new Channel<Item>(64);
  go(produce, a, 0, 1000);
  go(produce, b, 1000, 1000);
  let open = [a, b], fromA = 0, fromB = 0;
  while (open.length > 0) {
    const [i, item] = select(...open);
    if (item === undefined) open = open.filter((_, k) => k !== i);
    else if (item.id < 1000) fromA++;
    else fromB++;
  }
  log(`select: ${fromA} items from a, ${fromB} from b`);

  const arrays = new Channel<number[]>(4);
  const t2 = performance.now();
  go(fillArrays, arrays);
  let last = 0;
  for (const a of arrays) last += a[BIG - 1];
  const copied = (performance.now() - t2) / BUFFERS;
  const shared = new Channel<SharedArray<number>>(4);
  const t3 = performance.now();
  go(fillShared, shared);
  for (const a of shared) last += a[BIG - 1];
  const moved = (performance.now() - t3) / BUFFERS;
  log(`${BUFFERS} arrays of ${BIG} numbers: ${copied.toFixed(2)} ms each copied, ${moved.toFixed(2)} ms each moved by address (check ${last})`);
}
