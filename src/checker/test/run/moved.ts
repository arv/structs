// What the lowering moves, as it runs: parameter defaults that move into the
// body (an owned parameter's, or one with temporaries), the declarations of a
// body around them, function declarations and closures next to an owned
// local, a class field's initializer that constructs its class again, a
// renamed var, a default that throws after an owned parameter, destructured
// defaults, a closure in a default, a labelled loop, a logical assignment and
// a class's extends. main logs each result, and how many blocks are still
// allocated.
import {f64, heapStats, log, struct, type Struct} from '@arv/threads';

const P = struct({x: f64});
type P = Struct<typeof P>;

function read(p: P): number {
  return p.x + 1;
}

// an arrow whose concise body is a closure: the default still runs (0)
const later =
  (p: P = new P()) =>
  () =>
    p.x;

// defaults run left to right (true)
function ordered(a: P = new P(), b: P = a): boolean {
  return a === b;
}

// a destructured default after one that moved reads it (2)
function pattern(a: P = new P(), {x} = {x: a.x + 2}): number {
  return x;
}

// a default with temporaries (1)
function counted(n = read(new P())): number {
  return n;
}

// a moved default reads the outer read, not the body's (1 + 5)
function shadowed(n = read(new P())): number {
  const read = () => 5;
  return n + read();
}

// ... nor the body's var (1 + 5)
function shadowedVar(n = read(new P())): number {
  // eslint-disable-next-line no-var
  var read = () => 5;
  return n + read();
}

// a function declaration next to an owned local reads a const after it (7 + 3)
function hoisted(): number {
  const p = new P();
  p.x = 3;
  const k = 7;
  function get() {
    return k;
  }
  return get() + p.x;
}

// a field initializer whose call constructs another C (1 each, nothing left)
let depth = 0;
function make(p: P): number {
  if (depth++ < 3) new C();
  return p.x + 1;
}
class C {
  value = make(new P());
}

// a body var renamed apart from what a moved default reads still moves its
// count out (4, nothing left)
function fresh(): P {
  return new P();
}
function renamedResult(p: P = fresh()): P {
  // eslint-disable-next-line no-var
  var fresh = new P();
  fresh.x = p.x + 4;
  return fresh;
}

// a closure before an owned local reads a const after it (7 + 3)
function closureFirst(): number {
  const read = () => n;
  const p = new P();
  p.x = 3;
  const n = 7;
  return read() + p.x;
}

// an owned parameter is released when a default after it throws (nothing
// left)
function fail(): number {
  throw new Error('fail');
}
function throwsAfter(a: P = new P(), b = fail()): number {
  return a.x + b;
}

// a destructured default frees what it allocates, in a parameter and in a
// local (1 each, nothing left)
function destructured({x = read(new P())}: {x?: number} = {}): number {
  return x;
}
function destructuredLocal(o: {x?: number}): number {
  const {x = read(new P())} = o;
  return x;
}

// a closure in an earlier default sees a pattern's binding after it (7)
function patternSeen(
  get = () => x,
  a: P = new P(),
  {x} = {x: 7 + a.x},
): number {
  return get();
}

// a loop under two labels, continued by the outer one (2)
function labelled(): number {
  let n = 0;
  outer: for (const p = new P(); p.x < 2; p.x++) {
    n++;
    continue outer;
  }
  return n;
}

// a logical assignment's skipped right side releases nothing (1, nothing
// left)
function logical(): number {
  let n = 0;
  for (let i = 0; i < 3; i++) n ||= read(new P());
  return n;
}

// a class's `extends` expression is converted as any other: a struct passed
// as unknown is boxed ('object')
let received: unknown;
function base(value: unknown) {
  received = value;
  return class {};
}
class Extended extends base(new P()) {}

// a result, or the error it throws (the fork's emit throws for some)
function attempt(f: () => unknown): unknown {
  try {
    return f();
  } catch (e) {
    return (e as Error).name;
  }
}

export function main() {
  const results = [
    attempt(() => later()()),
    attempt(ordered),
    attempt(pattern),
    attempt(counted),
    attempt(shadowed),
    attempt(shadowedVar),
    attempt(hoisted),
    attempt(() => (new Extended(), typeof received)),
  ];
  // the closure later() made holds its p until it is collected: the blocks
  // are counted from here. heapStats() counts every worker's blocks, so this
  // runs with no other worker (compile.test.ts)
  const before = heapStats();
  results.push(attempt(() => new C().value));
  results.push(attempt(() => renamedResult().x));
  results.push(attempt(closureFirst));
  results.push(attempt(throwsAfter));
  results.push(attempt(destructured));
  results.push(attempt(() => destructuredLocal({})));
  results.push(attempt(patternSeen));
  results.push(attempt(labelled));
  results.push(attempt(logical));
  const after = heapStats();
  log(
    `${JSON.stringify(results)} blocks left ${after.allocated - before.allocated - (after.freed - before.freed)}`,
  );
}
