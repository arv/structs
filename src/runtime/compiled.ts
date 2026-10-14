// What the Vite plugin (vite-plugin-threads.ts) and the playground's page, which
// compiles with the fork in WebAssembly where there is no dev server, both do
// with a compiled program's text. Plain string work: it runs in node and in a
// browser.

// The runtime helpers the fork's emit imports, by the names the runtime exports
// them as. It imports each under a name of its own, the same with two leading
// underscores (`retain as __retain`), or with a number too where a module
// declares or uses that name itself (`retain as __retain_1`).
export const HELPERS = new Set([
  'F64',
  'I32',
  'U8',
  'box',
  'capture',
  'cellAddress',
  'countedRef',
  'moved',
  'newSharedArray',
  'newStruct',
  'outOfBounds',
  'quiescent',
  'register',
  'release',
  'retain',
  'sharedStruct',
  'store',
  'storeStr',
  'strAt',
  'unbox',
]);

// The local names of the helpers that compiled code imports from `runtime` :
// the specifiers of its first import of nothing but helpers.
export function helpersOf(
  code: string,
  runtime: string,
): Record<string, string> {
  for (const m of code.matchAll(/^import \{ ([^}]*) \} from "([^"]*)";$/gm)) {
    if (m[2] !== runtime) continue;
    const pairs = m[1].split(',').map(s => s.trim().split(/\s+as\s+/));
    if (pairs.every(([name]) => HELPERS.has(name)))
      return Object.fromEntries(
        pairs.map(([name, local]) => [name, local ?? name]),
      );
  }
  return {};
}

// A name like `name` that no identifier in `source` has, as TypeScript makes
// one: name, name_1, ...
export function uniqueName(source: string, name: string) {
  const used = new Set(source.match(/[A-Za-z_$][\w$]*/g));
  let unique = name;
  for (let n = 1; used.has(unique); n++) unique = `${name}_${n}`;
  return unique;
}

// Code that registers its functions (`__register(import.meta.url, { ... })`,
// its last statement, under whatever name it imported register as) with `key`
// in place of import.meta.url.
export function keyRegistration(code: string, runtime: string, key: string) {
  const register = helpersOf(code, runtime).register;
  if (!register) return code;
  const call = `${register}(import.meta.url, {`,
    at = code.lastIndexOf(call);
  if (at < 0) return code;
  return `${code.slice(0, at)}${register}(${JSON.stringify(key)}, {${code.slice(at + call.length)}`;
}

// The functions code the fork emitted registers (in its register call, its
// last statement), or null where it registers none.
export function registeredIn(code: string, runtime: string) {
  const register = helpersOf(code, runtime).register;
  if (!register) return null;
  const call = `${register}(import.meta.url, {`,
    at = code.lastIndexOf(call);
  if (at < 0) return null;
  const list = code.slice(at + call.length, code.indexOf('}', at));
  return list
    .split(',')
    .map(name => name.trim())
    .filter(name => name !== '');
}

// What a program with its types only erased needs at its end: the one line
// that registers its top-level functions, which is how a thread finds the one
// it runs; and how many lines that is. Which functions are the fork's to say,
// as its emit of the program (`compiled`) adds the line itself: the fork's
// parser, which runs wherever this does (in node, and in a browser as
// WebAssembly), knows a declaration at the top level from a function
// anywhere else. Nothing where the fork registers nothing, or emitted
// nothing.
export function registration(
  source: string,
  runtime: string,
  compiled: string | null,
) {
  const names = compiled === null ? null : registeredIn(compiled, runtime);
  if (!names?.length) return {tail: '', added: 0};
  const register = uniqueName(source, 'register'),
    specifier = register === 'register' ? register : `register as ${register}`;
  const tail = `\n// added: the runtime finds a thread's function by module and name\nimport { ${specifier} } from "${runtime}";\n${register}(import.meta.url, { ${names.join(', ')} });\n`;
  return {tail, added: tail.split('\n').length - 2};
}

export type Diagnostic = {
  line: number;
  col: number;
  code: string;
  message: string;
};

// `file(line,col): error TS1234: message` lines, with their indented
// continuations
export function diagnostics(text: string | undefined) {
  const out: Diagnostic[] = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /^[^()\n]*\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
    if (m)
      out.push({
        line: Number(m[1]),
        col: Number(m[2]),
        code: m[3],
        message: m[4],
      });
    else if (out.length !== 0 && /^\s+\S/.test(line))
      out.at(-1)!.message += ` ${line.trim()}`;
  }
  return out;
}
