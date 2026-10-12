// A variable declared in a loop's body is a fresh binding in every iteration (the fork's
// ownSharedLoopBindings, in the plain API). Lines marked "error" are expected to be reported.
import type { Sending, Shared } from "threads";

type Pos = { x: number };
type Positions = { t: number; pos: Pos[] };
declare function share<T>(x: Sending<T>): Shared<T>;
declare function send<T>(x: Sending<T>): void;
declare function recv(): Sending<Positions> | undefined;
declare function use(xs: readonly Shared<Pos>[]): void;

export function gather(steps: number, threads: number) {
  for (let s = 0; s < steps; s++) {
    const slots: Pos[][] = [];
    for (let k = 0; k < threads; k++) {
      const m = recv()!;
      slots[m.t] = m.pos;
    }
    const all = share(slots.flat());
    use(all);
  }
}

export function nested(steps: number) {
  for (let s = 0; s < steps; s++) {
    do {
      const { pos } = recv()!;              // destructured: fresh bindings too
      send(pos);
    } while (steps > s);
    let last: Pos[] = [];
    while (last.length < 3) {
      const next = recv()!.pos;
      last.push(...next);
    }
    send(last);
  }
}

export function outside(steps: number) {
  const slots: Pos[][] = [];
  for (let s = 0; s < steps; s++) {
    const all = share(slots.flat());        // error: sent in an earlier iteration
    use(all);
  }
}

export function linked(steps: number) {
  const outer: Pos[] = [];
  for (let s = 0; s < steps; s++) {
    const inner = outer;                    // error: a fresh binding, but `outer` was sent through it
    send(inner);                            // error: in an earlier iteration
  }
}

export function sameIteration(steps: number) {
  for (let s = 0; s < steps; s++) {
    const xs: Pos[] = [];
    send(xs);
    xs.push({ x: 1 });                      // error: sent above, in this iteration
  }
}

export function caught(steps: number) {
  for (let s = 0; s < steps; s++) {
    try {
      send(recv()!);
    } catch (e) {
      const again = e as Pos[];
      send(again);                          // error: what was thrown is captured
    }
  }
}
