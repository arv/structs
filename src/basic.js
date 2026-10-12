// the smallest example, translated by hand by the rules in docs/prototype.md:
//
//   const counter = { n: 0 };
//   const lock = new Lock();
//   const bump = () => {
//     for (let i = 0; i < 1000; i++) lock.hold(() => { counter.n++; });
//   };
//   const t1 = new Thread(bump), t2 = new Thread(bump);
//   t1.join(); t2.join();
//   console.log(counter.n); // 2000
//
// counter starts as a plain object of the main thread. new Thread(bump) shares
// bump, and with it the environment bump reaches (counter, lock): that copies
// counter into the shared heap and forwards the local object to it. the
// threads' writes then take counter over from main (blocked in join, so at
// once) and lock it for each write
import {$closure, $fns, $newThread, $newLock, $log} from 'threads/runtime';

const FN = $fns({bump, bump_hold});

export function main() {
  // the top-level bindings functions reach (counter, lock) live in one
  // environment object
  const env = {counter: {n: 0}, lock: $newLock()};
  const t1 = $newThread($closure(FN.bump, env)),
    t2 = $newThread($closure(FN.bump, env));
  $C(t1, join);
  $C(t2, join);
  const counter = $G(env, counter);
  $log($G(counter, n));
}

// const bump = () => {
//   for (let i = 0; i < 1000; i++) lock.hold(() => { counter.n++; });
// };
function bump(env) {
  const lock = $G(env, lock);
  for (let i = 0; i < 1000; i++) {
    $C(lock, hold, $closure(FN.bump_hold, env));
    $POLL();
  }
}

// () => { counter.n++; }
function bump_hold(env) {
  const counter = $G(env, counter);
  $S(counter, n, $G(counter, n) + 1);
}
