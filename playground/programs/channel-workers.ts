// A pool of workers: jobs go into one channel, whichever worker is free takes the next, and results
// come back on another channel, in the order the workers finish them.
import { Channel, go, log } from "threads";

type Result = { job: number; worker: number; value: number };

function work(id: number, jobs: Channel<number>, results: Channel<Result>) {
  for (const job of jobs) {
    let value = 0;
    for (let i = 0; i < job * 200_000; i++) value += Math.sqrt(i); // something slow, longer for later jobs
    results.send({ job, worker: id, value: Math.round(value) });
  }
}

// main runs on a worker too: the playground starts it as a thread, so it may block like the workers:
// send waits while the job channel is full, recv while no result has come back
export function main(threadCounts: readonly number[]) {
  const workers = threadCounts.at(-1) ?? 4, jobs = new Channel<number>(32), results = new Channel<Result>(32);
  for (let w = 0; w < workers; w++) go(work, w, jobs, results);
  for (let j = 1; j <= 16; j++) jobs.send(j);
  jobs.close(); // the workers stop once the jobs run out
  for (let j = 1; j <= 16; j++) {
    const r = results.recv()!;
    log(`job ${r.job} done by worker ${r.worker}: ${r.value}`);
  }
}
