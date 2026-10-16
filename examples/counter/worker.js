import {parent} from '../../src/runtime/agent.ts';

parent.onmessage = ({tally, n}) => {
  for (let i = 0; i < n; i++) {
    using _ = Atomics.Mutex.lock(tally.mutex);
    tally.count++;
  }
  using _ = Atomics.Mutex.lock(tally.mutex);
  tally.done++;
  Atomics.Condition.notify(tally.allDone);
  parent.onmessage = null;
};
