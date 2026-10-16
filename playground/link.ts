// A compiled program as a module the page and its workers can import: a
// blob: module, whose imports of the runtime by its path in the repository
// (../../src/runtime/index.ts, emit.ts, agent.ts) read globalThis.__structs
// instead, which a worker run starts sets (src/runtime/agent-worker.ts): a
// blob: module cannot resolve them.

// the specifier, its quote the `n`th group, the module the next
const specifier = (n: number) =>
  `(["'])(?:\\.\\.?\\/)*src\\/runtime\\/(index|emit|agent)\\.ts\\${n}`;
const runtimeModules: Record<string, string> = {
  index: 'structs',
  emit: 'runtime',
  agent: 'agent',
};

export function link(code: string) {
  return code
    .replace(new RegExp(`\\bimport\\s*${specifier(1)}\\s*;?`, 'g'), '')
    .replace(
      new RegExp(
        `\\bimport\\s*(\\{[^}]*\\}|\\*\\s*as\\s+[\\w$]+)\\s*from\\s*${specifier(2)}\\s*;?`,
        'g',
      ),
      (_, what: string, _q: string, module: string) =>
        `const ${
          what.startsWith('*')
            ? what.replace(/^\*\s*as\s+/, '')
            : what.replace(/\bas\b/g, ':')
        } = globalThis.__structs.${runtimeModules[module]};`,
    );
}

// the URL a program is imported by, by its code: one per program, kept, since
// its workers import it too
const urls = new Map<string, string>();
export function programUrl(code: string) {
  let url = urls.get(code);
  if (url === undefined) {
    url = URL.createObjectURL(
      new Blob([link(code)], {type: 'text/javascript'}),
    );
    urls.set(code, url);
  }
  return url;
}
