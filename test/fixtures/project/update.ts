// Compound assignments and updates of shared struct fields, run compiled with
// the fast path and without it (test/compile.test.ts): each case's result is
// the same.

import '@arv/structs';

export shared struct Cell {
  n: number = 0;
  s: string = '';
  big: bigint = 0n;
  v: any = null;
  next: Cell | null = null;
  constructor(n = 0) {
    this.n = n;
    this.n += 1;
    this.n--;
  }
}

// what a case returns: bigints as strings, to compare
const plain = (x: unknown): unknown =>
  typeof x === 'bigint'
    ? `${x}n`
    : Array.isArray(x)
      ? x.map(plain)
      : x;

function arith(c: Cell): unknown[] {
  const out = [c.n++, c.n--, ++c.n, --c.n, (c.n += 2), (c.n -= 1)];
  c.n *= 3;
  c.n **= 2;
  c.n /= 3;
  c.n %= 5;
  c.n <<= 3;
  c.n >>= 1;
  c.n >>>= 1;
  c.n &= 6;
  c.n |= 1;
  c.n ^= 2;
  out.push(c.n);
  return out;
}

// a let that is assigned, and an expression's receiver: no address of their
// own, so evaluated once into a temporary
function receivers(): unknown[] {
  const log: string[] = [];
  const cells = new SharedArray<Cell>(new Cell(1), new Cell(2), new Cell(3));
  let i = 0;
  const pick = (c: Cell) => (log.push(`pick ${c.n}`), c);
  cells[i++]!.n += 10;
  cells[i++]!.n++;
  --cells[i]!.n;
  pick(cells[0]!).n *= 2;
  const k = pick(cells[1]!).n--;
  let c = cells[0]!;
  c.n += ((c = cells[2]!), 100);
  return [log, i, k, cells[0]!.n, cells[1]!.n, cells[2]!.n];
}

// a SharedArray's element: its address from the array's slot, but where that
// is no Cell of the layout
function elements(): unknown[] {
  const cells = new SharedArray<Cell>(new Cell(1), new Cell(2));
  const holes = new SharedArray<Cell>(1);
  const key: any = '1';
  // converted to a key once, as through the Proxy
  let conversions = 0;
  const boxed: any = {
    toString: () => (conversions++, '0'),
    valueOf: () => (conversions++, 0),
  };
  const out: unknown[] = [cells[0]!.n++, (cells[key]!.n *= 5)];
  out.push(cells[boxed]!.n++, conversions);
  const thrown = (f: () => unknown) => {
    try {
      return f();
    } catch (e) {
      return (e as Error).constructor.name;
    }
  };
  out.push(
    thrown(() => cells[2]!.n++),
    thrown(() => (holes[0]!.n += 1)),
    cells[0]!.n,
    cells[1]!.n,
  );
  return out;
}

function strings(): unknown[] {
  const c = new Cell();
  c.s += 'a';
  c.s += 1;
  const s = (c.s += 'b');
  c.v = 1;
  c.v += 'x';
  const v = c.v++;
  return [s, c.s, v, c.v];
}

function bigints(): unknown {
  const c = new Cell();
  c.big += 2n;
  const a = c.big++;
  const b = ++c.big;
  c.big **= 3n;
  c.big >>= 1n;
  const d = c.big--;
  c.v = 5n;
  c.v *= 2n;
  const e = c.v++;
  let threw = false;
  try {
    c.big += 1 as any;
  } catch (err) {
    threw = err instanceof TypeError;
  }
  return plain([a, b, d, c.big, e, c.v, threw]);
}

function logical(): unknown[] {
  const c = new Cell();
  let calls = 0;
  const f = <T>(x: T) => (calls++, x);
  const out = [
    (c.v ??= f('first')),
    (c.v ??= f('second')),
    (c.n ||= f(5)),
    (c.n ||= f(6)),
    (c.n &&= f(7)),
    (c.s &&= f('no')),
    (c.s ||= f('yes')),
    calls,
  ];
  c.next ??= new Cell(9);
  c.next ??= new Cell(10);
  c.next.n += 1;
  out.push(c.next.n);
  return out;
}

// within larger expressions, and within each other
function nested(): unknown[] {
  const a = new Cell(1),
    b = new Cell(10);
  const x = (a.n += 2) * (a.n++ + ++a.n);
  const y = (a.n += b.n += 1);
  // the old value is read before the value is computed
  const z = (a.n += a.n += 1);
  const w = a.n++ + a.n++ + b.n-- * --b.n;
  return [x, y, z, w, a.n, b.n];
}

// a number field that holds no Number: through the runtime
function untyped(): unknown[] {
  const c = new Cell();
  (c as any).n = 'a';
  const a = c.n++;
  (c as any).n = '5';
  c.n += 1;
  const b = c.n;
  (c as any).n = '5';
  const d = c.n--;
  return [a, b, d, c.n];
}

// structurally a Cell, not a Shared Struct: read and written as written
function structural(): unknown {
  const o = {n: 1, s: 'a', big: 1n, v: null, next: null} as unknown as Cell;
  const r = arith(o);
  o.s += 'b';
  o.big++;
  o.v ??= 'set';
  return plain([...r, o.n, o.s, o.big, o.v]);
}

// arrows with an expression body, and functions that keep no views
function arrows(): unknown[] {
  const cells = new SharedArray<Cell>(new Cell(1), new Cell(2));
  const inc = (c: Cell) => c.n++;
  const add = (c: Cell, k: number) => (c.n += k);
  const r = [inc(cells[0]!), add(cells[1]!, 5)];
  const each = (f: (c: Cell) => unknown) => [cells[0]!, cells[1]!].forEach(f);
  each(c => (c.n *= 10));
  r.push(cells[0]!.n, cells[1]!.n);
  return r;
}

async function later(c: Cell): Promise<number> {
  await null;
  c.n += 1;
  return c.n++;
}

function* gen(c: Cell) {
  yield c.n++;
  yield (c.n *= 2);
}

// a SharedArray's element and a field, as addresses: only updated
function addresses(): unknown[] {
  const cells = new SharedArray<Cell>(new Cell(1), new Cell(2));
  let sum = 0;
  for (let i = 0; i < cells.length; i++) {
    const p = cells[i]!;
    p.n += 1;
    sum += p.n++;
  }
  const c = cells[0]!;
  c.next = cells[1]!;
  const nx = c.next!;
  nx.n *= 3;
  return [sum, cells[0]!.n, cells[1]!.n];
}

// where the temporaries have no scope: left to the Proxy
function defaults(c: Cell, k = c.n++): number[] {
  return [k, c.n];
}
class Holder {
  static top = new Cell(4);
  static {
    Holder.top.n *= 2;
  }
  first = Holder.top.n++;
}

// at the top of the module
export const top = new Cell(1);
top.n += 41;
top.n++;
let moving = new Cell(3);
moving.n *= 2;

export const cases: Record<string, () => unknown> = {
  arith: () => {
    const c = new Cell(3);
    return [...arith(c), c.n];
  },
  receivers,
  elements,
  strings,
  bigints,
  logical,
  nested,
  untyped,
  structural,
  arrows,
  later: async () => {
    const c = new Cell(1);
    return [await later(c), c.n];
  },
  gen: () => {
    const c = new Cell(1);
    return [...gen(c), c.n];
  },
  addresses,
  defaults: () => defaults(new Cell(7)),
  holder: () => [new Holder().first, new Holder().first, Holder.top.n],
  top: () => [top.n, moving.n],
};
