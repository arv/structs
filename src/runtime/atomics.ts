// The changes to Atomics (§2.3) and Reflect (§2.4): Atomics.load, store,
// exchange and compareExchange take a Shared Struct and a field (or a Shared
// Array and an index, as a string) as well as a typed array and an index.
//
// A Number field is two words, so these are made atomic by a lock (one of a
// few, by the field's address). A plain read or write of a field takes none:
// it races with them as the memory model allows, and cannot tear.

import {fieldLock, I32, lock, unlock} from './heap.ts';
import {
  addressOf,
  canBeShared,
  fieldSlot,
  K_ARRAY,
  K_STRUCT,
  read,
  requireShareable,
  write,
} from './shared.ts';

const original = {
  load: Atomics.load,
  store: Atomics.store,
  exchange: Atomics.exchange,
  compareExchange: Atomics.compareExchange,
};

// The slot of `field` in the Shared Struct or Shared Array `o`, or -1 when
// `o` is neither. A field that is not a property key is a TypeError, one `o`
// does not have a RangeError.
function slotOf(o: unknown, field: unknown) {
  const a = addressOf(o);
  if (a === undefined) return -1;
  const kind = I32[a >> 2];
  if (kind !== K_STRUCT && kind !== K_ARRAY) return -1;
  if (typeof field !== 'string' && typeof field !== 'symbol')
    throw new TypeError(
      'structs: a Shared Struct field must be a property key (a string or a symbol)',
    );
  const s = fieldSlot(a, field);
  if (s < 0) throw new RangeError(`structs: no field ${String(field)}`);
  return s;
}

function locked<T>(s: number, f: () => T): T {
  const l = fieldLock(s);
  lock(l);
  try {
    return f();
  } finally {
    unlock(l);
  }
}

// Atomics.load ( typedArrayOrStruct, indexOrField ) (§2.3.5)
function load(o: any, field: any) {
  const s = slotOf(o, field);
  if (s < 0) return original.load(o, field);
  return locked(s, () => read(s));
}

// Atomics.store ( typedArrayOrStruct, indexOrField, value ) (§2.3.6)
function store(o: any, field: any, value: any) {
  const s = slotOf(o, field);
  if (s < 0) return original.store(o, field, value);
  requireShareable(value);
  locked(s, () => write(s, value));
  return value;
}

// Atomics.exchange ( typedArrayOrStruct, indexOrField, value ) (§2.3.4)
function exchange(o: any, field: any, value: any) {
  const s = slotOf(o, field);
  if (s < 0) return original.exchange(o, field, value);
  requireShareable(value);
  return locked(s, () => {
    const old = read(s);
    write(s, value);
    return old;
  });
}

// Atomics.compareExchange ( typedArrayOrStruct, indexOrField, expectedValue,
// replacementValue ) (§2.3.3): the replacement is written when the field's
// value is the expected one (SameValue)
function compareExchange(o: any, field: any, expected: any, replacement: any) {
  const s = slotOf(o, field);
  if (s < 0) return original.compareExchange(o, field, expected, replacement);
  requireShareable(replacement);
  return locked(s, () => {
    const old = read(s);
    if (Object.is(old, expected)) write(s, replacement);
    return old;
  });
}

const overloads = {load, store, exchange, compareExchange};

// Installs the overloads on Atomics, and Reflect.canBeShared.
export function installAtomics() {
  for (const [name, f] of Object.entries(overloads)) {
    Object.defineProperty(f, 'name', {value: name});
    Object.defineProperty(Atomics, name, {
      value: f,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
  // Reflect.canBeShared ( val ) (§2.4.1)
  Object.defineProperty(Reflect, 'canBeShared', {
    value: function canBeShared_(val: unknown) {
      return canBeShared(val);
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(Reflect.canBeShared, 'name', {value: 'canBeShared'});
}
