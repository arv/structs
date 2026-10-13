// a string key that died and that another thread interned again
// (run.test.ts): the thread whose cache knew the old address must still find
// the key. y and x take turns through a flag; neither passes a quiescent point
// meanwhile, so the dead string's block is not yet retired
import {
  atomic,
  i32,
  log,
  register,
  SharedArray,
  SharedMap,
  spawn,
} from '@arv/threads';

function y(m: SharedMap<string, number>, turn: SharedArray<i32>) {
  m.set('k', 1); // "k" is interned, at an address y now knows
  m.delete('k'); // the map held its only count: "k" dies
  atomic.store(turn, 0, 1);
  atomic.notify(turn, 0);
  while (atomic.load(turn, 0) !== 2) atomic.wait(turn, 0, 1);
  const seen = [m.has('k'), m.get('k'), m.size];
  m.set('k', 9); // a new value for x's key, not a second key
  return [seen, m.size];
}
function x(m: SharedMap<string, number>, turn: SharedArray<i32>) {
  while (atomic.load(turn, 0) !== 1) atomic.wait(turn, 0, 0);
  m.set('k', 2); // "k" again, at another address
  atomic.store(turn, 0, 2);
  atomic.notify(turn, 0);
}
export function main() {
  const m = new SharedMap<string, number>(),
    turn = new SharedArray(i32, 1);
  const ty = spawn(y, m, turn);
  spawn(x, m, turn).join();
  log(`y: ${JSON.stringify(ty.join())}`);
  log(`entries: ${JSON.stringify([...m])} size ${m.size}`);
}
register(import.meta.url, {x, y, main});
