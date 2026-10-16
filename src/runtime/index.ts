// @arv/structs: the runtime of the structs proposal. Importing it installs
// what the proposal adds to the global object, where the engine has none of
// it: SharedArray, Atomics.Mutex, Atomics.Condition, the Atomics overloads for
// Shared Structs, and Reflect.canBeShared. The struct syntax itself is the
// compiler's (src/compiler), whose output imports this.

import {installAtomics} from './atomics.ts';
import {canBeShared, SharedArray} from './shared.ts';
import {Condition, Mutex, UnlockToken} from './sync.ts';

export {attach, heapStats} from './heap.ts';
export {canBeShared, Condition, Mutex, SharedArray, UnlockToken};

const define = (on: object, name: string, value: unknown) =>
  Object.defineProperty(on, name, {
    value,
    writable: true,
    enumerable: false,
    configurable: true,
  });

if (!('Mutex' in Atomics)) {
  define(Atomics, 'Mutex', Mutex);
  define(Atomics, 'Condition', Condition);
  define(globalThis, 'SharedArray', SharedArray);
  installAtomics();
}
