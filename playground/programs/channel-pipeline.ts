// Channels, Go's way: goroutines connected by channels. numbers sends 1, 2, ..., n; squares squares
// what comes in; main adds up what comes out. Closing a channel ends the loops that read it.
import { Channel, go, log } from "threads";

function numbers(n: number, out: Channel<number>) {
  for (let i = 1; i <= n; i++) out.send(i);
  out.close();
}

function squares(input: Channel<number>, out: Channel<number>) {
  for (const x of input) out.send(x * x);
  out.close();
}

// main runs on a worker too: the playground starts it as a thread, so three threads run here (main,
// numbers, squares), and main may block like the others: its loop waits for each square
export function main(threadCounts: readonly number[]) {
  const naturals = new Channel<number>(16), squared = new Channel<number>(16);
  go(numbers, 1000, naturals);
  go(squares, naturals, squared);
  let sum = 0;
  for (const x of squared) sum += x;
  log(`1² + 2² + ... + 1000² = ${sum}`);
}
