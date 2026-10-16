// Finds the struct declarations in a source (§1.1, §2.2):
//
//   struct Name ClassTail          shared struct Name ClassTail
//   export default struct ClassTail
//
// and spells them as classes, in place: `struct` becomes `class ` and `shared`
// six spaces. Every other character stays where it was, so the result parses
// as TypeScript (or JavaScript), and its positions are the source's.
//
// `struct` and `shared` are not reserved: they are found by a scan of the
// tokens, which skips strings, templates, regular expressions and comments.
// A struct is `struct` at the start of a statement, followed on its line by a
// name and then `{`, `extends`, `implements` or `<` (type parameters); after
// `export default`, also by `{` or `extends`.

export interface StructSite {
  // where `struct` is (now `class `)
  keyword: number;
  // where `shared` is, for a shared struct
  shared?: number;
}

export interface Scan {
  text: string;
  structs: StructSite[];
}

interface Token {
  kind: 'name' | 'punct' | 'literal';
  value: string;
  start: number;
  end: number;
  // a line terminator comes before it
  newline: boolean;
}

// names after which a `/` starts a regular expression
const BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'extends',
]);

const isIdStart = (c: string) => /[\p{ID_Start}$_\\]/u.test(c);
const isIdPart = (c: string) =>
  /[\p{ID_Continue}$\\]/u.test(c) || c === '\u200c' || c === '\u200d';

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  // what each `{` opened: a block or object, or a template's `${`
  const braces: ('{' | '${')[] = [];
  let i = 0,
    newline = false;
  if (text.startsWith('#!'))
    i = text.indexOf('\n') < 0 ? text.length : text.indexOf('\n');
  const push = (kind: Token['kind'], value: string, start: number) => {
    tokens.push({kind, value, start, end: i, newline});
    newline = false;
  };
  const regexAllowed = () => {
    const t = tokens[tokens.length - 1];
    if (!t) return true;
    if (t.kind === 'literal') return false;
    if (t.kind === 'name') return BEFORE_REGEX.has(t.value);
    return !(t.value === ')' || t.value === ']' || t.value === '}');
  };
  // the rest of a template from i (after ` or }), to its end or its next ${
  const template = (start: number) => {
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') i += 2;
      else if (c === '`') {
        i++;
        push('literal', '`', start);
        return;
      } else if (c === '$' && text[i + 1] === '{') {
        i += 2;
        braces.push('${');
        push('literal', '`', start);
        return;
      } else i++;
    }
    push('literal', '`', start);
  };
  while (i < text.length) {
    const c = text[i]!,
      start = i;
    if (c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029') {
      newline = true;
      i++;
    } else if (/\s/.test(c)) i++;
    else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && !/[\n\r\u2028\u2029]/.test(text[i]!)) i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      if (/[\n\r\u2028\u2029]/.test(text.slice(i, stop))) newline = true;
      i = stop;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c && text[i] !== '\n')
        i += text[i] === '\\' ? 2 : 1;
      i++;
      push('literal', c, start);
    } else if (c === '`') {
      i++;
      template(start);
    } else if (c === '/' && regexAllowed()) {
      i++;
      let inClass = false;
      while (i < text.length && text[i] !== '\n') {
        const d = text[i]!;
        if (d === '\\') i++;
        else if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        i++;
      }
      i++;
      while (i < text.length && isIdPart(text[i]!)) i++;
      push('literal', '/', start);
    } else if (isIdStart(c) || c === '#') {
      i++;
      while (i < text.length && isIdPart(text[i]!)) i++;
      push('name', text.slice(start, i), start);
    } else if (
      /[0-9]/.test(c) ||
      (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))
    ) {
      i++;
      while (i < text.length && /[\w.]/.test(text[i]!)) i++;
      push('literal', '0', start);
    } else if (c === '{') {
      i++;
      braces.push('{');
      push('punct', '{', start);
    } else if (c === '}') {
      i++;
      if (braces.pop() === '${') template(start);
      else push('punct', '}', start);
    } else {
      i++;
      push('punct', c, start);
    }
  }
  return tokens;
}

// the tokens a statement may start after
const STATEMENT_START = new Set([';', '{', '}']);

export function scan(text: string): Scan {
  const tokens = tokenize(text);
  const structs: StructSite[] = [];
  let out = text;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind !== 'name' || t.value !== 'struct') continue;
    const next = tokens[k + 1],
      after = tokens[k + 2];
    if (!next || next.newline) continue;
    let shared: Token | undefined = tokens[k - 1];
    if (shared?.kind !== 'name' || shared.value !== 'shared' || t.newline)
      shared = undefined;
    const first = shared ?? t;
    const before = tokens[tokens.indexOf(first) - 1];
    const isDefault = before?.kind === 'name' && before.value === 'default';
    const atStart =
      !before ||
      first.newline ||
      isDefault ||
      (before.kind === 'name' && before.value === 'export') ||
      (before.kind === 'punct' && STATEMENT_START.has(before.value));
    if (!atStart) continue;
    const named =
      next.kind === 'name' &&
      next.value !== 'extends' &&
      after !== undefined &&
      ((after.kind === 'punct' &&
        (after.value === '{' || after.value === '<')) ||
        (after.kind === 'name' &&
          (after.value === 'extends' || after.value === 'implements')));
    const anonymous =
      isDefault &&
      ((next.kind === 'punct' && next.value === '{') ||
        (next.kind === 'name' && next.value === 'extends'));
    if (!named && !anonymous) continue;
    out = out.slice(0, t.start) + 'class ' + out.slice(t.end);
    if (shared)
      out = out.slice(0, shared.start) + '      ' + out.slice(shared.end);
    structs.push(
      shared ? {keyword: t.start, shared: shared.start} : {keyword: t.start},
    );
  }
  return {text: out, structs};
}
