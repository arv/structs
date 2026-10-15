// A send in a try block that leaves early (return, throw, break): its catch and
// its finally see the value sent; the fork forgets it.
import { Channel, consume, share } from "threads";

declare function use(...values: unknown[]): void;

export function returnThenFinally(ch: Channel<number[]>) {
  const xs = [1];
  try { ch.send(xs); return; } finally { use(xs); }          // error: may have been sent, by a throw before it
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
  const xs = [1]; let held: unknown;
  try { held = consume(xs); void import("./try-exits.ts"); return; } catch { use(xs, held); }  // fine
}
declare function tag(strings: TemplateStringsArray, ...values: unknown[]): string;
export function tagged() {
  const xs = [1];
  try { kept.value = consume(xs); tag`x`; return; } catch { use(xs); }  // error: the tag may throw
}
// a try that completes normally goes on after its finally as its block ended,
// not as it began
export function sentInTryThenAfter(ch: Channel<number[]>) {
  const xs = [1];
  try { ch.send(xs); } finally {}
  use(xs);                                                    // error: was sent
}
export function sentInTryThenFinallyThenAfter(ch: Channel<number[]>) {
  const xs = [1];
  try { ch.send(xs); } finally { use(1); }
  use(xs);                                                    // error: was sent
}
// a throw that no call makes (a getter's, a division's) may reach a finally
// that nothing else does: the finally is checked all the same
declare const getter: { readonly value: number };
export function getterThenForever(ch: Channel<number[]>) {
  const xs = [1];
  try { void getter.value; for (;;) {} } finally { ch.send(xs); use(xs); }  // error
}
export function divisionThenForever(ch: Channel<number[]>, n: bigint) {
  const xs = [1];
  try { void (1n / n); for (;;) {} } finally { ch.send(xs); use(xs); }  // error
}
// such a throw may also come in a try that completes, before what it does
export function getterThenReassigned(ch: Channel<number[]>) {
  let xs = [1];
  ch.send(xs);
  try { void getter.value; xs = [2]; } finally { use(xs); }  // error: the getter may throw before xs is new
  use(xs);                                                    // fine: the try completed, xs is new
}
// what such a throw reaches the finally with goes where the finally goes
export function implicitThenBreak(ch: Channel<number[]>) {
  let xs = [1];
  ch.send(xs);
  outer: { try { void getter.value; xs = [2]; } finally { break outer; } }
  use(xs);                                                    // error: the getter may throw before xs is new
}
export function implicitThenReturn(ch: Channel<number[]>) {
  let xs = [1];
  ch.send(xs);
  try {
    try { void getter.value; xs = [2]; } finally { return; }
  } finally { use(xs); }                                      // error: so may the return
}
// a throw no call makes comes where it may: after what the block did before
export function consumedThenGetter() {
  let xs = [1];
  try { consume(xs); void getter.value; xs = [2]; } finally { use(xs); }  // error: the getter may throw before xs is new
}
export function consumedInCatchThenGetter() {
  let xs = [1];
  try { throw 0; } catch { consume(xs); void getter.value; xs = [2]; } finally { use(xs); }  // error
}
export function writtenAfterConsume() {
  const xs = [1];
  try { kept.value = consume(xs); return; } catch { use(xs); }  // error: a setter may throw
}
// what is not evaluated where it is written throws nothing there
export function declarationsOnly(ch: Channel<number[]>) {
  const xs = [1];
  ch.send(xs);
  outer: { try { let unused: number; interface X { value: number } const f = () => getter.value; for (;;) {} } finally { break outer; } }
  use(xs);                                                    // fine: not reached
}
// each evaluation that may throw does so after what came before it: a
// destructuring's property reads and iterator steps, after the defaults
// before them, and the iterator's closing; a substitution's conversion; a
// spread argument's iteration; a compound assignment's read, before its right
// side; the place of an assignment, before its value; leaving a for-of loop;
// defining a class or an enum; disposing of a `using` declaration's value
declare const pair: { a?: unknown; b: unknown };
declare const items: unknown[];
declare function many(...values: unknown[]): void;
declare class Many { constructor(...values: unknown[]); }
declare const counter: { n: number };
declare const boxes: { box: { value: unknown } };
declare const resource: Disposable;
export function declaredObjectPattern() {
  let xs = [1];
  try { const { a = consume(xs), b } = pair; xs = [2]; } finally { use(xs); }  // error: b's getter may throw
}
export function declaredArrayPattern() {
  let xs = [1];
  try { const [a = consume(xs), b] = items; xs = [2]; } finally { use(xs); }  // error: the next step may throw
}
export function declaredArrayClose() {
  let xs = [1];
  try { const [a = consume(xs)] = items; xs = [2]; } finally { use(xs); }  // error: closing the iterator may throw
}
export function substitutions() {
  let xs = [1];
  try { consume(xs); `${pair}${(xs = [2], 0)}`; } finally { use(xs); }  // error: pair's conversion may throw
}
export function spreadArgument() {
  let xs = [1];
  try { consume(xs); many(...items, (xs = [2], 0)); } finally { use(xs); }  // error: the spread may throw
}
export function spreadConstructorArgument() {
  let xs = [1];
  try { consume(xs); new Many(...items, (xs = [2], 0)); } finally { use(xs); }  // error
}
export function compoundRead() {
  let xs = [1];
  try { consume(xs); counter.n += (xs = [2], 1); } finally { use(xs); }  // error: n's getter may throw
}
export function assignedObjectPattern() {
  let xs = [1]; let a: unknown; let b: unknown;
  try { ({ a = consume(xs), b } = pair); xs = [2]; } finally { use(xs, a, b); }  // error
}
export function assignedArrayPattern() {
  let xs = [1]; let a: unknown; let b: unknown;
  try { [a = consume(xs), b] = items; xs = [2]; } finally { use(xs, a, b); }  // error
}
export function assignedArrayClose() {
  let xs = [1]; let a: unknown;
  try { [a = consume(xs)] = items; xs = [2]; } finally { use(xs, a); }  // error
}
export function placeBeforeValue() {
  let xs = [1];
  try { consume(xs); boxes.box.value = (xs = [2], 0); } finally { use(xs); }  // error: boxes.box may throw
}
export function leftForOf() {
  let xs = [1];
  try { for (const item of items) { consume(xs); break; } xs = [2]; } finally { use(xs); }  // error: closing the iterator may throw
}
export function definedClass() {
  let xs = [1];
  try { consume(xs); class Late { static value = getter.value; } xs = [2]; } finally { use(xs); }  // error
}
export function disposed() {
  let xs = [1];
  try { { using held = resource; consume(xs); } xs = [2]; } finally { use(xs); }  // error: disposing may throw
}
export function definedEnum() {
  let xs = [1];
  try { consume(xs); enum Late { A = getter.value } xs = [2]; } finally { use(xs); }  // error: its member may throw
}
// a `using` declaration gets its value's dispose method as it is declared
export function usingAcquired() {
  let xs = [1];
  try { using held = (consume(xs), resource); xs = [2]; } finally { use(xs); }  // error: getting the method may throw
}
// a scope's cleanup comes as a jump leaves it, after the finallies inside it,
// and throws to the try around it; a jump that stays inside cleans up nothing
export function closedPastInnerCatch() {
  let xs = [1];
  try { for (const item of items) { try { consume(xs); break; } catch { xs = [2]; } } xs = [3]; } catch { use(xs); }  // error: closing throws to this catch
}
export function closedOnReturnPastInnerCatch() {
  let xs = [1];
  try { for (const item of items) { try { consume(xs); return; } catch { xs = [2]; } } } catch { use(xs); }  // error
}
export function jumpInsideUsing() {
  let xs = [1];
  try { { using held = resource; for (;;) { consume(xs); break; } xs = [2]; } } catch { use(xs); }  // fine: the break stays in the block
}
export function usingAroundTry() {
  let xs = [1];
  { using held = resource; try { consume(xs); return; } catch { use(xs); } }  // fine: disposing throws outside the try
}
// an assignment's place is evaluated before its value, once, and written after
export function placeOnceBeforeValue() {
  let xs = [1];
  try { (xs = [2], kept).value = consume(xs); xs = [3]; } finally { use(xs); }  // error: the setter may throw
}
export function logicalPlaceOnce() {
  let xs = [1];
  try { (xs = [2], kept).value ??= consume(xs); xs = [3]; } finally { use(xs); }  // error
}
export function storedIntoWhatItConsumes() {
  const ys: { next: unknown } = { next: null };
  ys.next = consume(ys);                                      // error: ys is written after it is consumed
}
export function assertedReceiver() {
  const ys: { next: unknown } = { next: null };
  (ys as { next: unknown }).next = consume(ys);              // error: ys is written after it is consumed
}
export function assertedConsume() {
  const zs = [1];
  kept.value = consume(zs as number[]);
  use(zs);                                                    // error: zs was consumed
}
// what is written to is the object the place held before the value was made
export function sentThenReplaced(ch: Channel<{ n: number }>) {
  let box = { n: 0 };
  box.n = (ch.send(box), box = { n: 1 }, 2);                  // error: the first box, which was sent, is written
}
export function replacedThenConsumed() {
  let xs = [8];
  xs[0] = (xs = [2], consume(xs).length);                     // fine: the first xs, still owned, is written
}
// a block disposes of a `using` declaration's value only once it has run
export function returnBeforeUsing(flag: boolean) {
  let xs = [1];
  try { consume(xs); if (flag) return; xs = [2]; using held = resource; } catch { use(xs); }  // fine
}
export function breakBeforeUsing(flag: boolean) {
  let xs = [1];
  outer: { try { consume(xs); if (flag) break outer; xs = [2]; using held = resource; } catch { use(xs); } }  // fine
}
export function assertedIncrement() {
  const frozen = share({ n: 1 });
  (frozen.n as number)++;                                     // error: a write through a shared value
}
export function conditionallyReplacedThenConsumed(flag: boolean) {
  let xs = [8];
  xs[0] = flag ? (xs = [2], consume(xs).length) : consume(xs).length;  // error: on the false path the first xs, consumed, is written
}
// a finally's run is shared with another only for the very same state
declare function mayThrow(): void;
export function finallyRunsAlike(ch: Channel<number[]>) {
  let rows = [[1], [2]];
  for (let row of rows) { rows = []; try { mayThrow(); row = [3]; } finally { ch.send(row); continue; } }  // error: a row the loop goes on to take is sent
}
// a destructuring evaluates its target before it reads
export function targetBeforeRead() {
  let xs = [1];
  try { consume(xs); ({ a: (xs = [2], kept).value } = pair); } finally { use(xs); }  // fine: xs is new before anything may throw
}
// what a place was read from, consumed and then given another value
export function consumedThenReplaced() {
  let xs = [8];
  xs[0] = (consume(xs), xs = [2], 0);                         // error: the first xs, consumed, is written
}
export function consumedBoxThenReplaced() {
  let box = { n: 0 };
  box.n = (consume(box), box = { n: 1 }, 2);                  // error
}
// an array pattern gets its iterator before it evaluates a target
export function iteratorBeforeTarget() {
  let xs = [1];
  try { consume(xs); [(xs = [2], kept).value] = items; } finally { use(xs); }  // error: getting the iterator may throw
}
export function enumInitializers() {
  let xs = [1];
  try { enum E { A = (consume(xs), 1), B = getter.value } xs = [2]; } finally { use(xs); }  // error: B's getter may throw after A consumed xs
}
// a `var` the try's block declares is in scope in the finally, and after
export function varInFinally(ch: Channel<number[]>) {
  try { var ys: number[] | undefined = [1]; ch.send(ys); mayThrow(); } finally { use(ys); }  // error: ys was sent
}
export function varAfterTry(ch: Channel<number[]>) {
  try { var ys: number[] | undefined = [1]; ch.send(ys); mayThrow(); } finally { use(1); }
  use(ys);                                                    // error: ys was sent
}
// a finally's run keeps what a loop iterates, which no binding may hold
export function iteratorKeepsItsRegion(ch: Channel<number[]>) {
  let rows = new Array<number[]>(2).fill([1]);
  for (let row of rows) { rows = []; ch.send(row); row = []; try {} finally {} }  // error: the next row is one sent
}
// a computed key is converted before the target is evaluated
declare const source: Record<string, unknown>;
declare const anyKey: any;
export function keyBeforeTarget() {
  let xs = [1];
  try { consume(xs); ({ [anyKey]: (xs = [2], kept).value } = source); } finally { use(xs); }  // error: the key's conversion may throw
}
// an operator on plain primitives converts them with no error
export function plainPrimitives() {
  let xs = [1];
  let n = 1;
  try { consume(xs); const m = 1 + 1; +1; n++; `${1}`; xs = [2]; use(m, n); } finally { use(xs); }  // fine
}
// an object pattern refuses a null or undefined source before any target
declare const anyObj: any;
export function nullishBeforeTarget() {
  let xs = [1];
  try { consume(xs); ({ a: (xs = [2], kept).value } = anyObj); } finally { use(xs); }  // error: anyObj may be null
}
// a class's static initializers run as it is defined, in the enclosing state
export function staticInitializer() {
  let xs = [1];
  try { class C { static n = (consume(xs), getter.value); } xs = [2]; } finally { use(xs); }  // error: the getter may throw after the consume
}
export function staticInitializerOfExpression() {
  let xs = [1];
  try { const K = class { static n = (consume(xs), getter.value); }; xs = [2]; use(K); } finally { use(xs); }  // error
}
// a finally in a static block, while an assignment holds its object
export function staticBlockFinally(ch: Channel<{ n: number }>) {
  let box = { n: 0 };
  box.n = (ch.send(box), box = { n: 1 }, class { static { try {} finally {} } }, 2);  // error: the first box, which was sent, is written
}
// a decorator is applied, which may throw, once the members are defined
declare function dec(...args: any[]): any;
export function classDecorator() {
  let xs = [1];
  try { consume(xs); @dec class C {} xs = [2]; } finally { use(xs); }  // error
}
export function methodDecorator() {
  let xs = [1];
  try { consume(xs); class C { @dec method() {} static n = (xs = [2], 0); } } finally { use(xs); }  // error: before the static field
}
// an object binding pattern refuses a null or undefined source before its keys
export function nullishBindingSource() {
  let xs = [1];
  try { consume(xs); const { [(xs = [2], "a")]: held } = anyObj; use(held); } finally { use(xs); }  // error
}
export function nonNullBindingSource() {
  let xs = [1];
  try { consume(xs); const { [(xs = [2], "a")]: held } = pair; use(held); } finally { use(xs); }  // fine
}
// a nested pattern's source is its parent's part, with its default
declare const src: { a?: any };
declare const solid: { a: { b: string } };
export function nestedBindingSource() {
  let xs = [1];
  try { const { a: { [(xs = [2], "b")]: y } = (consume(xs), null) } = src; use(y); } finally { use(xs); }  // error: the default may be null
}
export function nestedBindingNonNull() {
  let xs = [1];
  try { const { a: { [(xs = [2], "b")]: y } = (consume(xs), { b: "" }) } = solid; use(y); } finally { use(xs); }  // fine
}
export function nestedAssignmentSource() {
  let xs = [1];
  let y: unknown;
  try { ({ a: { [(xs = [2], "b")]: y } = (consume(xs), null as any) } = src); } finally { use(xs, y); }  // error
}
// a class's static members run as it is defined, with the class as `this`
export function staticNotCaptured(ch: Channel<number[]>) {
  const xs = [1];
  const C = class { static done = ch.send(xs); };
  return new C();                                             // fine: done holds nothing of xs
}
export function staticThis(ch: Channel<number[]>) {
  const xs = [1];
  class C { static value: number[]; static { this.value = xs; } }
  ch.send(xs);                                                // fine: the class, not the caller, holds xs
  return C;                                                   // error: C holds xs, which was sent
}
// `==` and `!=` with null convert nothing
declare const someObj: object;
export function looseNullish() {
  let xs = [1];
  try { consume(xs); void (someObj == null); void (someObj != undefined); xs = [2]; } finally { use(xs); }  // fine
}
// an element's key is converted before the value is made
declare const target: Record<string, number>;
export function keyBeforeValue() {
  let xs = [1];
  try { consume(xs); target[anyKey] = (xs = [2], 0); } finally { use(xs); }  // error: the key's conversion may throw
}
// what a branch that cannot reach the write consumed does not count
export function unreachableConsume(flag: boolean) {
  let xs = [8];
  xs[0] = flag ? (use(class { static { consume(xs); throw 0; } }), 0) : 1;  // fine
}
// a derived class is what it extends, and its instances capture its base's
export function derivedStatic(ch: Channel<number[]>) {
  const xs = [1];
  const Base = class { static held = xs; };
  class Derived extends Base {}
  ch.send(xs);
  return Derived;                                             // error: Derived inherits held
}
export function derivedInstance(ch: Channel<number[]>) {
  const xs = [1];
  class Base { items = xs; }
  const Derived = class extends Base {};
  ch.send(xs);
  return new Derived();                                       // error: its base's initializer captures xs
}
// a class's name is the class in its static members
export function staticName(ch: Channel<number[]>) {
  const xs = [1];
  class C { static value: number[]; static { C.value = xs; } }
  ch.send(xs);
  return C;                                                   // error: C holds xs
}
export function staticInnerName(ch: Channel<number[]>) {
  const xs = [1];
  const K = class Inner { static value: number[]; static { Inner.value = xs; } };
  ch.send(xs);
  return K;                                                   // error
}
// each instance is its own
export function separateInstances(ch: Channel<number[]>) {
  class C { items = [1]; }
  const a = new C(), b = new C();
  ch.send(a.items);
  use(b.items);                                               // fine
}
// a default replaces an optional part's undefined
declare const optional: { a?: { b: string } };
export function optionalWithDefault() {
  let xs = [1];
  try { const { a: { [(xs = [2], "b")]: y } = (consume(xs), { b: "" }) } = optional; use(y); } finally { use(xs); }  // fine
}
// instance code that names its class reaches its static state
export function instancesShareStatic(ch: Channel<number[]>) {
  class C { static xs = [1]; items = C.xs; }
  const a = new C(), b = new C();
  ch.send(a.items);
  use(b.items);                                               // error: both are C.xs
}
// `new` makes an instance of the class the name holds now
export function reassignedClass(ch: Channel<number[]>) {
  const xs = [1];
  let C = class { items = [2]; };
  C = class { items = xs; };
  ch.send(xs);
  return new C();                                             // error: its initializer captures xs
}
// `==` and `!=` between objects convert nothing
declare const otherObj: object;
export function looseObjects() {
  let xs = [1];
  try { consume(xs); void (someObj == otherObj); void (someObj != otherObj); xs = [2]; } finally { use(xs); }  // fine
}
// a constructor that may be a local class or another keeps both
export function mixedConstructor(flag: boolean, Borrowed: new () => { items: number[] }, ch: Channel<number[]>) {
  class Fresh { items = [1]; }
  const K = flag ? Fresh : Borrowed;
  ch.send(new K().items);                                     // error: it may be the caller's
}
// a class's name holds the class it is given last
export function reassignedDeclaration(ch: Channel<number[]>) {
  const xs = [1];
  class C { items = [2]; }
  // @ts-expect-error: TypeScript refuses it, JavaScript does not
  C = class { items = xs; };
  ch.send(xs);
  return new C();                                             // error: its initializer captures xs
}
// instance code may reach its class as `this.constructor`
export function implicitStatic(ch: Channel<number[]>) {
  class C { static xs = [1]; items = (this.constructor as typeof C).xs; }
  const a = new C(), b = new C();
  ch.send(a.items);
  use(b.items);                                               // error: both are C.xs
}
// every class a base may be
export function baseAlternatives(flag: boolean, ch: Channel<number[]>) {
  const xs = [1];
  let Base = class { items = [2]; };
  if (flag) Base = class { items = xs; };
  class Derived extends Base {}
  ch.send(xs);
  return new Derived();                                       // error: the second base captures xs
}
// a loop's state says the classes a constructor may be
export function loopLastClass(again: () => boolean, ch: Channel<number[]>) {
  const xs = [1];
  class A { items = [2]; }
  class B { items = xs; }
  use([A, B]);
  let C: typeof A = A;
  for (;;) { if (again()) break; C = B; }
  ch.send(xs);
  return new C();                                             // error: C may be B
}
// so does a finally run's
export function finallyKeepsConstructors(flag: boolean, borrowed: number[], ch: Channel<number[]>) {
  class Fresh { items = [1]; }
  class Borrowing { items = borrowed; }
  let K: typeof Fresh = flag ? Fresh : Borrowing;
  try { mayThrow(); K = flag ? Fresh : Fresh; } finally { ch.send(new K().items); }  // error: K may still be Borrowing
}
// instance code may reach its class as this["constructor"]
export function implicitStaticByKey(ch: Channel<number[]>) {
  class C { static xs = [1]; items = (this["constructor"] as typeof C).xs; }
  const a = new C(), b = new C();
  ch.send(a.items);
  use(b.items);                                               // error: both are C.xs
}
// what a class's prototype holds its instances all reach
export function prototypeState(ch: Channel<number[]>) {
  const C = class { declare items: number[]; };
  C.prototype.items = [1];
  const a = new C(), b = new C();
  ch.send(a.items);
  use(b.items);                                               // error: both are the prototype's
}
// a class keeps what it captured, whatever binding has gone since
export function escapedClass(borrowed: number[], ch: Channel<number[]>) {
  let K: new () => { items: number[] } = class { items: number[] = []; };
  try { const alias = borrowed; K = class { items = alias; }; } finally {}
  ch.send(new K().items);                                     // error: the caller's array
}
// a value that never comes writes nothing
export function abruptValue() {
  const box = { n: 0 };
  box.n = (use(class { static { consume(box); throw 0; } }), 1);  // fine
}
export function abruptCompound() {
  const box = { n: 0 };
  box.n += (use(class { static { consume(box); throw 0; } }), 1);  // fine
}
