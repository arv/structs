// Moving a value: an ordinary object goes to a thread, which then owns it. The sender gives it up.
// Uncomment the last line of main: the ownership checker reports the use after the move, and with
// the types erased, the runtime throws when it happens.
import { log, spawn, type Sending } from "threads";

type Order = { id: number; items: number[] };

// runs on a thread: the order is its own now, to read and to change
function total(order: Sending<Order>): Sending<number> {
  order.items.push(5); // no other thread can see it, so changing it is safe
  return order.items.reduce((sum, item) => sum + item, 0);
}

// main runs on a worker too: the playground starts it as a thread, so it may block (join waits)
export function main(threadCounts: readonly number[]) {
  const order: Order = { id: 1, items: [10, 20, 30] };
  const thread = spawn(total, order); // order moves to the thread
  log(`total: ${thread.join()}`);
  // log(order.items.length); // error TS96001: 'order' cannot be used here: it was sent to 'spawn'
}
