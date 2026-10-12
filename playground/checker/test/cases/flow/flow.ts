// Control flow, closures and the map rule of the ownership analysis (the fork's ownSharedFlow, in
// the plain API). Lines marked "error" are expected to be reported.
import { consume, f64, struct, type Sending, type Shared } from "threads";

type Box = { v: number; next?: Box };
declare function send<T>(x: Sending<T>): void;
declare function share<T>(x: Sending<T>): Shared<T>;
declare function make(): Sending<Box>;
declare function use(x: unknown): void;
declare const flag: boolean;

export function joins() {
  const a = make();
  if (flag) { send(a); }
  use(a);                                   // error: may have been sent
  const b = make();
  if (flag) { send(b); } else { send(b); }
  use(b);                                   // error: sent on both paths
  const c = make(), d = make();
  const e = flag ? c : d;
  send(e);
  use(d);                                   // error: d shares objects with e
  const f = make();
  flag && send(f);
  use(f);                                   // error: may have been sent
}

export function switches(k: number) {
  const a = make();
  switch (k) {
    case 0: send(a); break;
    case 1: use(a);
    default: break;
  }
  use(a);                                   // error: may have been sent
}

export function loops() {
  const a = make();
  for (let i = 0; i < 3; i++) {
    use(a);                                 // error: sent in the previous iteration
    send(a);
  }
  for (let i = 0; i < 3; i++) {
    const fresh = make();
    send(fresh);                            // fine: a new value every iteration
  }
  const b = make();
  outer: while (flag) {
    while (flag) {
      if (flag) break outer;
      continue outer;
    }
  }
  send(b);                                  // fine
  for (const x of [make()]) send(x);        // error on the next iteration: elements share the array's region
  do { send(b); } while (flag);             // error: sent in an earlier iteration
}

export function tries() {
  const a = make();
  try { send(a); } catch (e) { send(e); } finally { use(a); } // errors: e is captured, a may have been sent
}

export function destructuring(o: Sending<{ p: Box; q: Box }>) {
  const { p, q } = o;
  send(p);
  use(q);                                   // error: q shares objects with p
  const [first, ...rest] = [make(), make()];
  send(rest);
  use(first);                               // error: first shares objects with rest
}

export function consumes(x: Sending<Box>) {
  const y = consume(x);
  use(y);
  use(x);                                   // error: consumed
  send(consume(y));
  use(y);                                   // error: consumed by send
}

export class C {
  f: Box = { v: 1 };
  m() { send(this.f); }                     // error: this is the caller's
  n = () => send(this.f);                   // error: this is captured
  static { send(this); }                    // error: this is the caller's
  get g() { return this.f; }
}

export function closures() {
  const a = make();
  const f = () => a.v;
  send(f);
  use(a);                                   // error: a shares objects with f
  const c = make();
  [1, 2].forEach(i => { send(c); });        // error: c is captured
  function local() { return c.v; }
  send(local);                              // fine? local captures c, which is OUTER in forEach's callback only
  use(c);
}

export function maps(xs: Box[]) {
  const fresh = xs.map(x => ({ v: x.v }));
  send(fresh);                              // fine: the callback builds fresh objects
  const nums = xs.map(x => x.v);
  send(nums);                               // fine
  const aliased = xs.map(x => x);
  send(aliased);                            // error: holds the caller's objects
  const filtered = xs.filter(x => x.v > 0);
  send(filtered);                           // error: filter aliases the receiver
  const flat = xs.flatMap(x => [x.v]);
  send(flat);                               // fine
}

export function sharedValues(p: Shared<Box[]>, q: readonly Shared<Box>[]) {
  p[0]!.v = 1;                              // error
  p[0]!.v++;                                // error
  delete p[0]!.next;                        // error
  p.sort();                                 // error
  use(q.length + Math.max(1, 2));
  const s = share({ v: 1 });
  s.v = 2;                                  // error
  let u: Box[] | undefined;
  for (const x of q) { if (u) u.push(x); else u = []; } // fine: u is not a shared value
}

const Counter = struct({ n: f64, total: f64 });
export function structs(c: InstanceType<typeof Counter>) {
  c.n++;                                    // fine: struct fields are cells
  const d = new Counter();
  [1].forEach(() => use(d));                // fine
  return c.total;
}

export const giveBack = (x: Box): Sending<Box> => x; // error: x is the caller's
export const fresh = (): Sending<Box> => ({ v: 1 });
export function* generator(): Generator<Box, void, Box> {
  const got = yield { v: 1 };
  send(got);                                // error: the caller's
}
export async function awaits(p: Promise<Box>) {
  const b = await p;
  send(b);                                  // fine: the awaited value is fresh
  send(`${b.v}` + b);
  send(/re/);
}

const top = make();
send(top);
use(top);                                   // error: top-level code is analyzed too
