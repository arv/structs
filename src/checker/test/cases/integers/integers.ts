// Integers (ownLayoutIntegerStores, in the plain API): what flows into an i32
// or a u8 (a field, an element, a variable, a parameter, a return value) must
// be an integer, and an atomic operation acts on an i32.
import { atomic, f64, i32, u8, struct, SharedArray, type Struct } from "threads";

const Counter = struct({ count: i32, level: u8, ratio: f64 });
type Counter = Struct<typeof Counter>;

function take(k: i32): i32 { return k; }

export function fractions(c: Counter, ints: SharedArray<i32>, bytes: SharedArray<u8>, n: number) {
  c.count = 0.5;                                  // error: a fraction
  c.level = n / 2;                                // error: a quotient, into a u8
  ints[0] = c.ratio;                              // error: an f64
  bytes[0] = Math.random() * 256;                 // error
  c.count /= 2;                                   // error
  c.level /= 2;                                   // error
  const k: i32 = n;                               // error: a number
  take(n);                                        // error: a number argument
  return take(n / 2);                             // error
}
export function returned(n: number): i32 { return n * 1.5; }     // error
export function returnedByte(n: number): u8 { return n; }         // error

export function integers(c: Counter, ints: SharedArray<i32>, bytes: SharedArray<u8>, n: number): i32 {
  c.count = n | 0;
  c.level = Math.round(c.ratio * 255);
  c.count = Math.trunc(n) + Math.floor(n);
  ints[0] = 3;
  bytes[0] = 300;                                 // an integer: wraps, as integers do
  c.count += 1;
  c.level *= 2;
  let total = 0;
  for (let i = 0; i < ints.length; i++) total += ints[i]!;
  c.count = total;
  return take(c.count * 2 + c.level);
}

export function atomics(c: Counter, ints: SharedArray<i32>, key: "count", n: number) {
  atomic.add(c, "count", 1);
  atomic.add(ints, 0, 1);
  atomic.store(ints, 1, atomic.load(c, "count") + 1);
  atomic.add(c, "ratio" as never, 1);             // error: an f64 field
  atomic.add(c, "level" as never, 1);             // error: a u8 field
  atomic.add(c, key, 1);                          // error: not named by a string literal
  atomic.add(c, "count", n);                      // error: a number argument
}
