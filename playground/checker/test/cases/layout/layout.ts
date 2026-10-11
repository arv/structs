// Layout errors (ownLayoutErrors, in the plain API).
import { f64, ref, struct, SharedArray, type Struct } from "threads";

interface Good { a: number; b: Good | null }
const Good = struct<Good>({ a: f64, b: ref<Good>() });
const Point = struct({ x: f64, y: f64 });
type Point = Struct<typeof Point>;

export function elements(a: SharedArray<Good>, g: Good, i: number, maybe: Good | undefined, points: SharedArray<Point>) {
  a[i] = g;                                  // error: elements are inline
  points[0] = points[1]!;                    // error
  const n = maybe?.a;                        // error: optional chaining
  const m = points?.[0];                     // error
  const bad: SharedArray<string> | undefined = undefined;   // error: the elements of a SharedArray
  const worse = new SharedArray(Good as any, 3) as SharedArray<string>;    // error
  return [n, m, bad, worse];
}

export function destructure({ a }: Good, list: Good[]) {    // error: a parameter
  for (const { b } of list) {}               // error: a for-of variable
  const { a: copy } = list[0]!;              // destructured through the handle (but bound: error)
  return [a, copy];
}

export function compare(g: Good, h: Good | null) {
  if (g === h) return 1;
  if (h == null) return 2;
  switch (h) {
    case null: return 3;
    default: return `${g}` + g;
  }
}
