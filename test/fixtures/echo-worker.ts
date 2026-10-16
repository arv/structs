// Sends back what it is sent, with a struct of its own (test/agents.test.ts).

import {parent} from '../../src/runtime/agent.ts';

parent!.onmessage = message => {
  const array = new SharedArray(2);
  array[0] = message.struct;
  array[1] = 'from the worker';
  message.struct.seen = true;
  parent!.postMessage({...message, array});
  parent!.onmessage = null;
};
