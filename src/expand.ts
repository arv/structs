// expands the access macros in a hand-translated program into the code a
// publish-on-escape transform would emit at each site (see docs/prototype.md):
//   $G(o, key)          o.key
//   $S(o, key, v)       o.key = v
//   $GI(o, i)           o[i]
//   $SI(o, i, v)        o[i] = v
//   $C(o, key, ...a)    o.key(...a), at most 3 arguments
//   $POLL()             a clean point (loop back-edges)
// a named property is plain JS: on a shared object (or a local one that moved
// to the shared heap) it is an accessor of its slot (see runtime.ts), so the
// engine's inline caches tell the two apart. elements, and names an array also
// has (length, push...), check $fwd first: a local array that moved keeps its
// own length and elements, which no accessor can stand in for. o must be an
// identifier, as a transform's temporary would be

const isId: (c: string | undefined) => boolean = c =>
  c !== undefined && /[\w$]/.test(c);
const ident: (s: string) => string = s => {
  if (!/^[A-Za-z_$][\w$]*$/.test(s))
    throw new Error(`expand: expected an identifier, got: ${s}`);
  return s;
};

function skipQuoted(t: string, i: number): number {
  const q = t[i++];
  while (i < t.length) {
    const c = t[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === q) return i + 1;
    if (q === '`' && c === '$' && t[i + 1] === '{') {
      i = matchClose(t, i + 1) + 1;
      continue;
    }
    i++;
  }
  throw new Error('expand: unterminated string');
}

function matchClose(t: string, open: number): number {
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    const c = t[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipQuoted(t, i) - 1;
      continue;
    }
    if (c === '/' && t[i + 1] === '/') {
      i = t.indexOf('\n', i);
      continue;
    }
    if (c === '/' && t[i + 1] === '*') {
      i = t.indexOf('*/', i) + 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return i;
  }
  throw new Error('expand: unbalanced brackets');
}

function splitArgs(t: string, open: number, close: number) {
  const args = [];
  let depth = 0,
    start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = t[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipQuoted(t, i) - 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      args.push(t.slice(start, i));
      start = i + 1;
    }
  }
  const last = t.slice(start, close);
  if (last.trim() !== '' || args.length !== 0) args.push(last);
  return args.map(a => a.trim());
}

const MACROS = ['$POLL', '$GI', '$SI', '$G', '$S', '$C'];
// runtime: the URL of runtime.ts, which the expanded program imports
export interface ExpandOptions {
  atomicPoll?: boolean;
  noPoll?: boolean;
  runtime: string;
}
const ARRAY_KEYS = new Set([
  ...Object.getOwnPropertyNames(Array.prototype),
  'length',
]);

export function expand(
  src: string,
  {atomicPoll = false, noPoll = false, runtime}: ExpandOptions,
) {
  const keys = new Set<string>(),
    stubs: string[] = [];
  let sites = 0;
  const key: (k: string) => string = k => {
    keys.add(ident(k));
    return k;
  };

  const macro = (m: string, a: string[]) => {
    const o = ident(a[0]);
    switch (m) {
      case '$G':
        return ARRAY_KEYS.has(a[1])
          ? `(${o}.$fwd === undefined ? ${o}.${key(a[1])} : $sget(${o}.$fwd, K_${a[1]}))`
          : `${o}.${a[1]}`;
      case '$S':
        return ARRAY_KEYS.has(a[1])
          ? `(${o}.$fwd === undefined ? (${o}.${key(a[1])} = ${a[2]}) : $sset(${o}.$fwd, K_${a[1]}, ${a[2]}))`
          : `(${o}.${a[1]} = ${a[2]})`;
      case '$C': {
        const rest = a.slice(2);
        if (rest.length > 3)
          throw new Error('expand: $C takes at most 3 arguments');
        return ARRAY_KEYS.has(a[1])
          ? `(${o}.$fwd === undefined ? ${o}.${key(a[1])}(${rest.join(', ')}) : $scall(${o}.$fwd, K_${a[1]}${rest.map(x => `, ${x}`).join('')}))`
          : `${o}.${a[1]}(${rest.join(', ')})`;
      }
      case '$GI': {
        // an element of a shared array, and a reference to a block this worker
        // already has a handle for, inline in a stub per site; anything else is
        // $sgeti's
        const site = sites++;
        stubs.push(
          `function $gi${site}(h, i) {\n  if (h[KIND] === 2) {\n    const a = h[ADDR];\n    if (i >= 0 && i < I32[(a + 12) >> 2] && (i | 0) === i) {\n      const b = I32[(a + 8) >> 2];\n      if (i < I32[(b + 4) >> 2]) {\n        const w = F64[(b + 8 + (i << 3)) >> 3];\n        if (w === w) return w;\n        SF[0] = w;\n        if (SI[1] === REF_HI) { const p = SI[0], k = (p >>> 3) & 0xffff; if (HK[k] === p) return HV[k]; }\n        return decBox(w);\n      }\n    }\n  }\n  return $sgeti(h, i);\n}`,
        );
        return `(${o}.$fwd === undefined ? ${o}[${a[1]}] : $gi${site}(${o}.$fwd, ${a[1]}))`;
      }
      case '$SI':
        return `(${o}.$fwd === undefined ? (${o}[${a[1]}] = ${a[2]}) : $sseti(${o}.$fwd, ${a[1]}, ${a[2]}))`;
      case '$POLL':
        return noPoll
          ? '0'
          : atomicPoll
            ? '(Atomics.load($P, 1) !== 0 && $clean())'
            : '($P[1] !== 0 && $clean())';
    }
  };

  const walk: (t: string) => string = t => {
    let out = '',
      i = 0;
    while (i < t.length) {
      const c = t[i];
      if (c === '"' || c === "'") {
        const e = skipQuoted(t, i);
        out += t.slice(i, e);
        i = e;
        continue;
      }
      if (c === '`') {
        let j = i + 1;
        out += '`';
        while (t[j] !== '`') {
          if (t[j] === '\\') {
            out += t.slice(j, j + 2);
            j += 2;
            continue;
          }
          if (t[j] === '$' && t[j + 1] === '{') {
            const e = matchClose(t, j + 1);
            out += '${' + walk(t.slice(j + 2, e)) + '}';
            j = e + 1;
            continue;
          }
          out += t[j++];
        }
        out += '`';
        i = j + 1;
        continue;
      }
      if (c === '/' && t[i + 1] === '/') {
        let e = t.indexOf('\n', i);
        if (e < 0) e = t.length;
        out += t.slice(i, e);
        i = e;
        continue;
      }
      if (c === '/' && t[i + 1] === '*') {
        const e = t.indexOf('*/', i) + 2;
        out += t.slice(i, e);
        i = e;
        continue;
      }
      if (c === '$' && !isId(t[i - 1])) {
        const m = MACROS.find(m => t.startsWith(`${m}(`, i));
        if (m === '$POLL') {
          out += macro(m, ['$P']);
          i = matchClose(t, i + m.length) + 1;
          continue;
        }
        if (m) {
          const open = i + m.length,
            close = matchClose(t, open);
          out += macro(m, splitArgs(t, open, close).map(walk));
          i = close + 1;
          continue;
        }
      }
      out += c;
      i++;
    }
    return out;
  };

  // the runtime's modules by its location: @arv/threads, as the tsgo fork emits
  // a program's import of the API, and @arv/threads/<module> (@arv/threads/own,
  // @arv/threads/runtime) for a module of the runtime itself
  const dir = runtime.replace(/runtime\.ts$/, '');
  const body = walk(src).replace(
    /\bfrom\s*(['"])@arv\/threads(?:\/([\w-]+))?\1/g,
    (_: string, _q: string, module = 'threads') => `from '${dir}${module}.ts'`,
  );
  const head = [
    `import { $sget, $sset, $sgeti, $sseti, $scall, $clean, $key, $ctrl, I32, F64, decBox, SF, SI, REF_HI, HK, HV, ADDR, KIND } from '${runtime}';`,
    'const $P = $ctrl();',
    ...[...keys].map(k => `const K_${k} = $key(${JSON.stringify(k)});`),
  ];
  return head.join('\n') + '\n' + body + '\n' + stubs.join('\n') + '\n';
}
