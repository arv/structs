// A send in a try block that leaves early (return, throw, break): its catch and
// its finally see the value sent; the fork forgets it.
import { Channel, consume } from "threads";

declare function use(...values: unknown[]): void;

export function returnThenFinally(ch: Channel<number[]>) {
  const xs = [1];
  try { ch.send(xs); return; } finally { use(xs); }          // error: was sent
}
export function throwThenCatch(ch: Channel<number[]>) {
  const xs = [1];
  try { ch.send(xs); throw new Error("x"); } catch { use(xs); }  // error
}
export function breakThenFinally(ch: Channel<number[]>) {
  const xs = [1];
  for (;;) { try { ch.send(xs); break; } finally { use(xs); } }  // error
}
export function returnThenCatchThenAfter(ch: Channel<number[]>) {
  const xs = [1];
  try { ch.send(xs); return; } catch {}
  use(xs);                                                    // error: reached through the catch
}
export function sentOnlyOnTheWayOut(ch: Channel<number[]>, flag: boolean) {
  const xs = [1];
  try { if (flag) { ch.send(xs); return; } } finally {}
  use(xs);                                                    // fine: the path that sent left
}
export function finallyOverrides(ch: Channel<number[]>) {
  let xs = [1];
  try {
    try { ch.send(xs); return; } finally { xs = [2]; return; }
  } catch { use(xs); }                                        // fine: the finally's return carries the new xs
}
export function nestedFinally(ch: Channel<number[]>) {
  const xs = [1];
  try {
    try { ch.send(xs); return; } finally { use(1); }
  } finally { use(xs); }                                      // error: the inner return goes on out, sent
}
export function finallySendsOnBreak(ch: Channel<number[]>) {
  const xs = [1];
  for (;;) { try { break; } finally { ch.send(xs); } }
  use(xs);                                                    // error: the break goes on after the finally
}
export function finallyReassignsOnBreak(ch: Channel<number[]>) {
  let xs = [1];
  for (;;) { try { ch.send(xs); break; } finally { xs = [2]; } }
  use(xs);                                                    // fine: the finally gives xs a new value
}
export function finallyReturnsInsteadOfBreak(ch: Channel<number[]>) {
  const xs = [1];
  for (;;) { try { ch.send(xs); break; } finally { return; } }
  use(xs);                                                    // fine: not reached
}
export function breakThroughTwoFinallies(ch: Channel<number[]>) {
  const xs = [1];
  outer: for (;;) {
    try { for (;;) { try { break outer; } finally { use(1); } } } finally { ch.send(xs); }
  }
  use(xs);                                                    // error: sent by the outer finally
}
export function continueThroughFinally(ch: Channel<number[]>, flag: boolean) {
  const xs = [1];
  while (flag) { try { continue; } finally { ch.send(xs); } }  // error: sent again next time round
  use(xs);                                                    // error: may have been sent
}
export function finallyOfATryThatNeverEnds(ch: Channel<number[]>) {
  const xs = [1];
  outer: { try { for (;;) {} } finally { ch.send(xs); break outer; } }
  use(xs);                                                    // fine: not reached
}
export function finallyThrowsOfATryThatNeverEnds(ch: Channel<number[]>) {
  const xs = [1];
  try {
    try { for (;;) {} } finally { ch.send(xs); use(1); }
  } catch { use(xs); }                                        // fine: nothing gets here
}
// what may throw after a value is consumed (no call that sends it, which
// would throw itself): an await's rejection, a constructor; consume() and
// import() do not throw
declare const done: Promise<void>;
declare class Thing {}
declare const kept: { value: unknown };
export async function rejected() {
  const xs = [1];
  try { kept.value = consume(xs); await done; return; } catch { use(xs); }  // error: a rejection comes here
}
export function constructed() {
  const xs = [1];
  try { kept.value = consume(xs); new Thing(); return; } catch { use(xs); }  // error: the constructor may throw
}
export function neitherThrows() {
  const xs = [1];
  try { kept.value = consume(xs); void import("./try-exits.ts"); return; } catch { use(xs); }  // fine
}
declare function tag(strings: TemplateStringsArray, ...values: unknown[]): string;
export function tagged() {
  const xs = [1];
  try { kept.value = consume(xs); tag`x`; return; } catch { use(xs); }  // error: the tag may throw
}
