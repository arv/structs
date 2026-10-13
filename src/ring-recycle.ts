// the ring of threads waiting for a worker, recycled (run.test.ts): a few
// threads spawn more short threads between them than the ring has slots, so
// it wraps, producers race for the tail, and consumers take slots and clear
// them while producers come round to them again
import {log, register, scope, spawn} from '@arv/threads';

const SPAWNERS = 4,
  ROUNDS = 40,
  EACH = 8; // 1280 threads: the ring, of 1024, wraps

function square(n: number) {
  return n * n;
}
// spawns ROUNDS * EACH threads, EACH at a time, and sums what they return
function spawner(): number {
  let sum = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const ts = [];
    for (let k = 0; k < EACH; k++) ts.push(spawn(square, r * EACH + k));
    for (const t of ts) sum += t.join();
  }
  return sum;
}
export function main() {
  const total = scope(s => {
    const ts = [];
    for (let p = 0; p < SPAWNERS; p++) ts.push(s.spawn(spawner));
    return ts.reduce((sum, t) => sum + t.join(), 0);
  });
  const n = ROUNDS * EACH,
    each = ((n - 1) * n * (2 * n - 1)) / 6; // the squares below n
  log(
    `${SPAWNERS * n} threads through the ring: sum ${total}, expected ${SPAWNERS * each}`,
  );
}
register(import.meta.url, {square, spawner, main});
