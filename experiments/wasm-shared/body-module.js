// A hand-encoded Wasm module of n-body's Body as a Wasm GC struct, shared
// (shared-everything threads: V8's --experimental-wasm-shared) or not, with
// the same accessors either way, so the two can be told apart by sharedness
// alone. No toolchain here knows the shared encoding yet, so this writes the
// binary itself.
//
//   type 0  Body   = (shared? (struct (field (mut f64)) x7))   x y z vx vy vz mass
//   type 1  Bodies = (shared? (array (mut (ref null Body))))
//   type 2  Box    = (shared? (struct (field (mut (ref null (shared? extern))))))
//
// Exports: new_body(x, y, z, vx, vy, vz, mass), get_<f>(b), set_<f>(b, v)
// for each field, new_bodies(n), bodies_get(a, i), bodies_set(a, i, b), the
// same on externrefs (xget_<f>, xset_<f>, xbodies_get), and n-body itself in
// Wasm, the same arithmetic as examples/nbody/nbody.ts and
// playground/programs/nbody-parallel.ts: advance(a, dt, n), energy(a, n),
// accelerate(a, i, n, dt, softening).

export const FIELDS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'mass'];

// ---- encoding

const uleb = n => {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
};
const sleb = n => {
  const out = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
};
const str = s => {
  const b = [...new TextEncoder().encode(s)];
  return [...uleb(b.length), ...b];
};
const vec = items => [...uleb(items.length), ...items.flat()];
const section = (id, body) => [id, ...uleb(body.length), ...body];
const f64 = v => [...new Uint8Array(new Float64Array([v]).buffer)];

const SHARED = 0x65;
const F64 = 0x7c,
  I32 = 0x7f;
const refNull = t => [0x63, ...sleb(t)];
const ref = t => [0x64, ...sleb(t)];

// instructions
const get = i => [0x20, ...uleb(i)];
const set = i => [0x21, ...uleb(i)];
const tee = i => [0x22, ...uleb(i)];
const gc = (op, ...imm) => [0xfb, ...uleb(op), ...imm.flatMap(uleb)];
const structGet = f => gc(2, BODY, f);
const structSet = f => gc(5, BODY, f);
const arrayGet = () => gc(11, BODIES);
const I32_CONST = n => [0x41, ...sleb(n)];
const F64_CONST = v => [0x44, ...f64(v)];
const [ADD, SUB, MUL, DIV, SQRT] = [[0xa0], [0xa1], [0xa2], [0xa3], [0x9f]];
const I32_ADD = [0x6a],
  I32_LT_S = [0x48],
  I32_GE_S = [0x4e];
const BLOCK = [0x02, 0x40],
  LOOP = [0x03, 0x40],
  END = [0x0b];
const BR = d => [0x0c, ...uleb(d)],
  BR_IF = d => [0x0d, ...uleb(d)];

const BODY = 0,
  BODIES = 1,
  BOX = 2;

// for (i = from; i < n; i++) body — `from` an instruction sequence
const forLoop = (i, from, n, body) => [
  ...from,
  ...set(i),
  ...BLOCK,
  ...LOOP,
  ...get(i),
  ...get(n),
  ...I32_GE_S,
  ...BR_IF(1),
  ...body,
  ...get(i),
  ...I32_CONST(1),
  ...I32_ADD,
  ...set(i),
  ...BR(0),
  ...END,
  ...END,
];

export function bodyModule({shared}) {
  const comp = c => (shared ? [SHARED, ...c] : c);
  const fld = FIELDS.map(() => [F64, 0x01]);
  const types = [
    comp([0x5f, ...vec(fld)]), // 0 Body
    comp([0x5e, ...refNull(BODY), 0x01]), // 1 Bodies
    comp([0x5f, ...vec([[...(shared ? [0x63, SHARED, 0x6f] : [0x6f]), 0x01]])]), // 2 Box
  ];
  const sig = (params, results) => {
    types.push([0x60, ...vec(params), ...vec(results)]);
    return types.length - 1;
  };
  const funcs = [];
  const fn = (name, type, locals, body) =>
    funcs.push({name, type, locals, body});

  fn(
    'new_body',
    sig(
      FIELDS.map(() => [F64]),
      [ref(BODY)],
    ),
    [],
    [...FIELDS.flatMap((_, i) => get(i)), ...gc(0, BODY)],
  );
  FIELDS.forEach((f, i) => {
    fn(
      `get_${f}`,
      sig([refNull(BODY)], [[F64]]),
      [],
      [...get(0), ...structGet(i)],
    );
    fn(
      `set_${f}`,
      sig([refNull(BODY), [F64]], []),
      [],
      [...get(0), ...get(1), ...structSet(i)],
    );
  });
  fn(
    'new_bodies',
    sig([[I32]], [ref(BODIES)]),
    [],
    [...get(0), ...gc(7, BODIES)],
  );
  fn(
    'bodies_get',
    sig([refNull(BODIES), [I32]], [refNull(BODY)]),
    [],
    [...get(0), ...get(1), ...arrayGet()],
  );
  fn(
    'bodies_set',
    sig([refNull(BODIES), [I32], refNull(BODY)], []),
    [],
    [...get(0), ...get(1), ...get(2), ...gc(14, BODIES)],
  );

  // Controls for inlining into JS (inline.js): a function of numbers alone,
  // and get_x taking the struct as an abstract anyref and casting it
  // (ref.cast null: 0xfb 23).
  const anyref = shared ? [0x63, SHARED, 0x6e] : [0x6e];
  const externref = shared ? [0x63, SHARED, 0x6f] : [0x6f];
  const cast = t => [...gc(23), ...sleb(t)];
  fn('add1', sig([[F64]], [[F64]]), [], [...get(0), ...F64_CONST(1), ...ADD]);
  fn(
    'any_get_x',
    sig([anyref], [[F64]]),
    [],
    [...get(0), ...cast(BODY), ...structGet(0)],
  );

  // And the accessors again, x-prefixed, on externrefs (shared ones, for
  // shared types): V8 inlines a JS-to-Wasm call only if its signature is of
  // numbers and externrefs. Each converts (any.convert_extern: 0xfb 26;
  // extern.convert_any: 0xfb 27) and casts.
  const unwrap = (i, t) => [...get(i), ...gc(26), ...cast(t)];
  FIELDS.forEach((f, i) => {
    fn(
      `xget_${f}`,
      sig([externref], [[F64]]),
      [],
      [...unwrap(0, BODY), ...structGet(i)],
    );
    fn(
      `xset_${f}`,
      sig([externref, [F64]], []),
      [],
      [...unwrap(0, BODY), ...get(1), ...structSet(i)],
    );
  });
  // (interop.js: what a JS value becomes as an externref of this sharedness,
  // and a Box of one, which share.js reads on another agent)
  fn('xid', sig([externref], [externref]), [], get(0));
  fn('new_box', sig([externref], [ref(BOX)]), [], [...get(0), ...gc(0, BOX)]);
  fn(
    'box_get',
    sig([refNull(BOX)], [externref]),
    [],
    [...get(0), ...gc(2, BOX, 0)],
  );
  fn(
    'box_set',
    sig([refNull(BOX), externref], []),
    [],
    [...get(0), ...get(1), ...gc(5, BOX, 0)],
  );
  fn(
    'xbodies_get',
    sig([externref, [I32]], [externref]),
    [],
    [...unwrap(0, BODIES), ...get(1), ...arrayGet(), ...gc(27)],
  );

  // advance(bodies, dt, n): params 0 bodies, 1 dt, 2 n (V8 13.6 fails to
  // validate array.len on a shared array, so the length is passed); locals 3 i, 4 j, 5 a, 6 b,
  // 7 dx, 8 dy, 9 dz, 10 d2, 11 mag, 12 am, 13 bm
  {
    const [B, DT, N, Ii, J, A, Bb, DX, DY, DZ, D2, MAG, AM, BM] = [
      ...Array(14).keys(),
    ];
    const fa = (o, f) => [...get(o), ...structGet(FIELDS.indexOf(f))];
    const diff = (out, f) => [...fa(A, f), ...fa(Bb, f), ...SUB, ...set(out)];
    // o.f = o.f op (d * m)
    const kick = (o, f, op, d, m) => [
      ...get(o),
      ...fa(o, f),
      ...get(d),
      ...get(m),
      ...MUL,
      ...op,
      ...structSet(FIELDS.indexOf(f)),
    ];
    const inner = [
      ...get(B),
      ...get(J),
      ...arrayGet(),
      ...set(Bb),
      ...diff(DX, 'x'),
      ...diff(DY, 'y'),
      ...diff(DZ, 'z'),
      ...get(DX),
      ...get(DX),
      ...MUL,
      ...get(DY),
      ...get(DY),
      ...MUL,
      ...ADD,
      ...get(DZ),
      ...get(DZ),
      ...MUL,
      ...ADD,
      ...set(D2),
      ...get(DT),
      ...get(D2),
      ...get(D2),
      ...SQRT,
      ...MUL,
      ...DIV,
      ...set(MAG),
      ...fa(A, 'mass'),
      ...get(MAG),
      ...MUL,
      ...set(AM),
      ...fa(Bb, 'mass'),
      ...get(MAG),
      ...MUL,
      ...set(BM),
      ...kick(A, 'vx', SUB, DX, BM),
      ...kick(A, 'vy', SUB, DY, BM),
      ...kick(A, 'vz', SUB, DZ, BM),
      ...kick(Bb, 'vx', ADD, DX, AM),
      ...kick(Bb, 'vy', ADD, DY, AM),
      ...kick(Bb, 'vz', ADD, DZ, AM),
    ];
    const outer = [
      ...get(B),
      ...get(Ii),
      ...arrayGet(),
      ...set(A),
      ...forLoop(J, [...get(Ii), ...I32_CONST(1), ...I32_ADD], N, inner),
    ];
    // b.f = b.f + dt * b.v
    const drift = (f, v) => [
      ...get(A),
      ...fa(A, f),
      ...get(DT),
      ...fa(A, v),
      ...MUL,
      ...ADD,
      ...structSet(FIELDS.indexOf(f)),
    ];
    const move = [
      ...get(B),
      ...get(Ii),
      ...arrayGet(),
      ...set(A),
      ...drift('x', 'vx'),
      ...drift('y', 'vy'),
      ...drift('z', 'vz'),
    ];
    fn(
      'advance',
      sig([refNull(BODIES), [F64], [I32]], []),
      [
        [2, I32],
        [2, refNull(BODY)],
        [7, F64],
      ].map(([c, t]) => [...uleb(c), ...[t].flat()]),
      [
        ...forLoop(Ii, I32_CONST(0), N, outer),
        ...forLoop(Ii, I32_CONST(0), N, move),
      ],
    );
  }

  // accelerate(bodies, i, n, dt, softening): nbody-parallel's per-body
  // velocity update, in Wasm. params 0 bodies, 1 i, 2 n, 3 dt, 4 soft; locals
  // 5 j, 6 a, 7 b, 8 ax, 9 ay, 10 az, 11 dx, 12 dy, 13 dz, 14 d2, 15 f
  {
    const [B, Ii, N, DT, SOFT, J, A, Bb, AX, AY, AZ, DX, DY, DZ, D2, F] = [
      ...Array(16).keys(),
    ];
    const fa = (o, f) => [...get(o), ...structGet(FIELDS.indexOf(f))];
    const diff = (out, f) => [...fa(Bb, f), ...fa(A, f), ...SUB, ...set(out)];
    const acc = (s, d) => [
      ...get(s),
      ...get(d),
      ...get(F),
      ...MUL,
      ...ADD,
      ...set(s),
    ];
    const inner = [
      ...get(B),
      ...get(J),
      ...arrayGet(),
      ...set(Bb),
      ...diff(DX, 'x'),
      ...diff(DY, 'y'),
      ...diff(DZ, 'z'),
      ...get(DX),
      ...get(DX),
      ...MUL,
      ...get(DY),
      ...get(DY),
      ...MUL,
      ...ADD,
      ...get(DZ),
      ...get(DZ),
      ...MUL,
      ...ADD,
      ...get(SOFT),
      ...ADD,
      ...set(D2),
      ...fa(Bb, 'mass'),
      ...get(D2),
      ...get(D2),
      ...SQRT,
      ...MUL,
      ...DIV,
      ...set(F),
      ...acc(AX, DX),
      ...acc(AY, DY),
      ...acc(AZ, DZ),
    ];
    const kick = (f, s) => [
      ...get(A),
      ...fa(A, f),
      ...get(s),
      ...get(DT),
      ...MUL,
      ...ADD,
      ...structSet(FIELDS.indexOf(f)),
    ];
    fn(
      'accelerate',
      sig([refNull(BODIES), [I32], [I32], [F64], [F64]], []),
      [
        [1, I32],
        [2, refNull(BODY)],
        [9, F64],
      ].map(([c, t]) => [...uleb(c), ...[t].flat()]),
      [
        ...get(B),
        ...get(Ii),
        ...arrayGet(),
        ...set(A),
        ...forLoop(J, I32_CONST(0), N, inner),
        ...kick('vx', AX),
        ...kick('vy', AY),
        ...kick('vz', AZ),
      ],
    );
  }

  // energy(bodies, n)
  {
    const [B, N, Ii, J, A, Bb, E, DX, DY, DZ] = [...Array(10).keys()];
    const fa = (o, f) => [...get(o), ...structGet(FIELDS.indexOf(f))];
    const sq = (o, f) => [...fa(o, f), ...fa(o, f), ...MUL];
    const diff = (out, f) => [...fa(A, f), ...fa(Bb, f), ...SUB, ...set(out)];
    const inner = [
      ...get(B),
      ...get(J),
      ...arrayGet(),
      ...set(Bb),
      ...diff(DX, 'x'),
      ...diff(DY, 'y'),
      ...diff(DZ, 'z'),
      ...get(E),
      ...fa(A, 'mass'),
      ...fa(Bb, 'mass'),
      ...MUL,
      ...get(DX),
      ...get(DX),
      ...MUL,
      ...get(DY),
      ...get(DY),
      ...MUL,
      ...ADD,
      ...get(DZ),
      ...get(DZ),
      ...MUL,
      ...ADD,
      ...SQRT,
      ...DIV,
      ...SUB,
      ...set(E),
    ];
    const outer = [
      ...get(B),
      ...get(Ii),
      ...arrayGet(),
      ...set(A),
      ...get(E),
      ...F64_CONST(0.5),
      ...fa(A, 'mass'),
      ...MUL,
      ...sq(A, 'vx'),
      ...sq(A, 'vy'),
      ...ADD,
      ...sq(A, 'vz'),
      ...ADD,
      ...MUL,
      ...ADD,
      ...set(E),
      ...forLoop(J, [...get(Ii), ...I32_CONST(1), ...I32_ADD], N, inner),
    ];
    fn(
      'energy',
      sig([refNull(BODIES), [I32]], [[F64]]),
      [
        [2, I32],
        [2, refNull(BODY)],
        [4, F64],
      ].map(([c, t]) => [...uleb(c), ...[t].flat()]),
      [...forLoop(Ii, I32_CONST(0), N, outer), ...get(E)],
    );
  }

  const code = funcs.map(f => {
    const body = [...vec(f.locals), ...f.body, ...END];
    return [...uleb(body.length), ...body];
  });
  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(1, vec(types)),
    ...section(3, vec(funcs.map(f => uleb(f.type)))),
    ...section(7, vec(funcs.map((f, i) => [...str(f.name), 0x00, ...uleb(i)]))),
    ...section(10, vec(code)),
  ]);
}

export const instantiate = opts =>
  new WebAssembly.Instance(new WebAssembly.Module(bodyModule(opts))).exports;
