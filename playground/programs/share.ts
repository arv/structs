// Sharing a value: share() turns a value into a deeply immutable one, which any number of threads
// read. Each thread gets its own copy, once. Nobody can change it: TypeScript already rejects a write
// (uncomment the line in convert).
import { log, scope, share, type Shared, type Thread } from "threads";

type Rates = { [currency: string]: number };

// runs on a thread: reads the shared rates
function convert(amount: number, currency: string, rates: Shared<Rates>): number {
  // rates[currency] = 1; // error TS2542: Index signature in type ... only permits reading
  return amount * (rates[currency] ?? NaN);
}

// main runs on a worker too: the playground starts it as a thread, so it may block (scope waits for
// the threads it started)
export function main(threadCounts: readonly number[]) {
  const rates = share<Rates>({ USD: 1, EUR: 0.92, SEK: 10.5 });
  const currencies = ["USD", "EUR", "SEK"];
  scope(s => {
    const threads: Thread<number>[] = [];
    for (const currency of currencies) threads.push(s.spawn(convert, 100, currency, rates));
    threads.forEach((t, i) => log(`100 USD is ${t.join().toFixed(2)} ${currencies[i]}`));
  });
}
