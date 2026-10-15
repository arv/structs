import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// the module a program names: a path (such as a module threads-check compiled,
// build/ts/nbody-ts.js), or one in this directory by name (nbody-own)
export const findProgram: (program: string) => string = program =>
  /\.[jt]s$/.test(program) && fs.existsSync(path.resolve(program))
    ? path.resolve(program)
    : (['.ts', '.js']
        .map(ext => path.join(here, `${program}${ext}`))
        .find(f => fs.existsSync(f)) ?? path.join(here, `${program}.ts`));

// a program imports the runtime as @arv/threads (its API) and
// @arv/threads/<module> (@arv/threads/own, @arv/threads/runtime): the runtime's
// modules: the file of the one a specifier names, if it names one
export const runtimeModule: (
  specifier: string,
) => string | null = specifier => {
  const m = /^@arv\/threads(?:\/([\w-]+))?$/.exec(specifier);
  return m ? `${m[1] ?? 'threads'}.ts` : null;
};
