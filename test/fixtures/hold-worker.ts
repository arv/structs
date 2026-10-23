// Holds a big array until it ends (test/gc.test.ts).

import {parent} from '../../src/runtime/agent.ts';

declare global {
  var held: unknown;
}

parent!.onmessage = () => {
  globalThis.held = new SharedArray(1 << 20);
  parent!.postMessage('holding');
  parent!.onmessage = null;
  setInterval(() => {}, 1000);
};
