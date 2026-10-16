// @arv/structs/register: Node runs the proposal's syntax.
//
//   node --import @arv/structs/register main.js
//
// A module whose source has a struct declaration is compiled as it loads
// (transpile: one file at a time, no type checking), in this thread and in
// the workers it starts, which inherit the flag.

import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
import {formatDiagnostic, transpile} from './compiler/index.ts';

const RUNTIME = new URL('./runtime/emit.ts', import.meta.url).href;

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith('file:') || !/\.[cm]?[jt]s$/.test(url)) return result;
    const raw = result.source;
    const source =
      typeof raw === 'string'
        ? raw
        : raw
          ? new TextDecoder().decode(raw as ArrayBufferView | ArrayBuffer)
          : '';
    if (!/\bstruct\b/.test(source)) return result;
    const fileName = fileURLToPath(url);
    const out = transpile(source, {fileName, runtime: RUNTIME});
    if (out.diagnostics.length > 0)
      throw new SyntaxError(out.diagnostics.map(formatDiagnostic).join('\n'));
    if (out.code === source) return result;
    const map = Buffer.from(JSON.stringify(out.map)).toString('base64');
    return {
      format: 'module',
      source: `${out.code}\n//# sourceMappingURL=data:application/json;base64,${map}\n`,
      shortCircuit: true,
    };
  },
});
