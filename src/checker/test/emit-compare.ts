// vp run compare-emit: compiles the same projects with threads-check's compile
// (transform.ts, its types then stripped by OXC) and with the fork (`tsgo -p
// <tsconfig> --ownRuntime <runtime>`), and compares what each file compiles
// to. Both are normalized first: their imports that nothing uses as a value
// erased (as tsc and OXC both elide them), then printed again by OXC without
// comments, formatting or redundant parentheses. What is left must be the same
// lowering, temporaries and all.
//
// The fork compiles with `--target esnext`: it would lower `using` (and
// whatever else is newer than the tsconfig's target) for es2022, which
// threads-check leaves as written, for Vite or node to run as it is. The
// lowering of layouts and counts does not depend on the target.
//
// The projects: tsconfig.programs.json (the programs the scripts run), the
// playground (its presets, programs/mistakes.ts left out), the checker's cases
// in test/cases (programs with errors, which both compile all the same) and
// the fork's marker-mode compiler tests. Without the fork (TSGO_FORK, a clone
// of arv/threads-checker with tsgo built in it, by default
// ~/src/arv/threads-checker) there is nothing to compare with: it says so and
// passes.

import {spawnSync} from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join, relative, resolve} from 'node:path';
import {minifySync} from 'oxc-minify';
import {transformSync} from 'oxc-transform';
import {API} from 'typescript/sync';
import {compile, toJavaScript} from '../compile.ts';
import {writeCompilerTest} from './projects.ts';

const checkerDir = resolve(import.meta.dirname, '..');
const repo = resolve(checkerDir, '../..');
const forkRoot =
  process.env.TSGO_FORK ?? join(homedir(), 'src/arv/threads-checker');
const tsgo = join(forkRoot, 'built/local/tsgo');
const forkTests = join(forkRoot, 'testdata/tests/cases/compiler');
const verbose = process.argv.includes('--verbose');

interface Project {
  name: string;
  tsconfig: string;
  runtime: string;
  rootDir: string;
}

// Files that compile differently, and why. The key is the project's name and
// the file's path in it. (A CommonJS file, which the fork emits as CommonJS,
// threads-check refuses (96039) and does not compile: there is nothing to
// compare.)
const computedImport =
  "a computed dynamic import, which tsc's rewriteRelativeImportExtensions rewrites at run time with a helper, and OXC leaves as it is (it rewrites literal specifiers only): the type strippers differ, in a file that does not use the runtime";
const markedNotTyped =
  "a struct() field whose type is not its marker's (a number marked i32, a `boolean | undefined` marked bool), an error: the fork lays the field out as its type says (an f64 where the type is no field type), threads-check as its marker says";
const fieldTemporaries =
  "a class field's initializer with temporaries: threads-check gives it temporaries of its own, `(() => { var _a, _b; return ...; })()`, so a construction inside it can't overwrite them; the fork declares them in the module";
const elementAssigned =
  'an inline struct element assigned, an error (96005): the fork prints `CHECK ? A + 16 + I * size : __outOfBounds[I] = g`, which parses as something else, and threads-check `(CHECK ? ... : ...) = g`, which does not parse';
const knownDifferences: Record<string, string> = {
  'cases/counting/counting.ts': fieldTemporaries,
  'run/moved.ts':
    'the program compile.test.ts runs: the defaults, declarations and initializers the lowering moves, which the fork gets wrong (as it runs, its emit gives [0,false,2,1,"ReferenceError","TypeError","ReferenceError","number",1,"TypeError","ReferenceError","Error",1,1,7,2,1] and leaks 5 blocks; threads-check\'s [0,true,2,1,6,6,10,"object",1,4,10,"Error",1,1,7,2,1], leaking none)',
  'emit/fixes.ts':
    "what the fork gets wrong (compile.test.ts tests each): an arrow whose concise body is a closure keeps its owned parameter's default (the fork drops it), defaults after one that moves into the body move too, so they still run left to right, an array that its index assigns is read (and held) before the index, a scalar element type's expression runs (the fork drops it), and a class's `extends` expression is lowered as a full expression (the fork leaves it as it is)",
  'playground/main.ts': computedImport,
  'playground/compiler.ts': computedImport,
  'cases/layout/layout.ts': elementAssigned,
  'cases/threads/threads.ts':
    '`everyone` declared twice (a function and a const), an error: OXC refuses to strip the types of a file that redeclares a name, tsc emits it',
  'fork/ownAsyncGoroutines/replica.mts': markedNotTyped,
  'fork/ownAsyncGoroutinesErrors/blocking.mts': markedNotTyped,
  'fork/ownLayoutBooleansErrors/errors.mts': markedNotTyped,
  'fork/ownLayoutIntegersErrors/errors.mts': markedNotTyped,
  'fork/ownLayoutStringsErrors/errors.mts': markedNotTyped,
  'fork/ownLayoutErrors/errors.mts': elementAssigned,
  'fork/ownLayoutRefCountErrors/errors.mts': fieldTemporaries,
  'fork/ownLayoutRefCount/list.mts':
    'parameters() has a default after an owned parameter: threads-check runs it in a try that releases the owned parameter if it throws (the fork runs it before its try, and leaks)',
  'fork/ownLayoutStructUnionsErrors/different.mts':
    'a field at different places in the structs of a union, an error (96026): the fork reads and writes it through `__box(m).u`, threads-check at its place in the first struct',
};

if (!existsSync(tsgo)) {
  console.log(
    `no fork at ${tsgo} (TSGO_FORK names a clone of arv/threads-checker with tsgo built in it): nothing to compare with`,
  );
  process.exit(0);
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'threads-emit-')));
const projects: Project[] = [
  {
    name: 'programs',
    tsconfig: join(repo, 'tsconfig.programs.json'),
    runtime: '@arv/threads',
    rootDir: join(repo, 'src'),
  },
  {
    name: 'playground',
    tsconfig: join(repo, 'playground/tsconfig.json'),
    runtime: '@arv/threads',
    rootDir: join(repo, 'playground'),
  },
];
// what the lowering moves, as compile.test.ts runs it
projects.push({
  name: 'run',
  tsconfig: join(checkerDir, 'test/run/tsconfig.json'),
  runtime: '@arv/threads',
  rootDir: join(checkerDir, 'test/run'),
});
// corners of the lowering the others reach little
projects.push({
  name: 'emit',
  tsconfig: join(checkerDir, 'test/emit/tsconfig.json'),
  runtime: 'threads',
  rootDir: join(checkerDir, 'test/emit'),
});
for (const name of readdirSync(join(checkerDir, 'test/cases')).sort()) {
  const dir = join(checkerDir, 'test/cases', name);
  projects.push({
    name: `cases/${name}`,
    tsconfig: join(dir, 'tsconfig.json'),
    runtime: 'threads',
    rootDir: dir,
  });
}
if (existsSync(forkTests)) {
  for (const file of readdirSync(forkTests).sort()) {
    if (!/^own.*\.ts$/.test(file)) continue;
    const text = readFileSync(join(forkTests, file), 'utf8');
    // the marker mode's tests: the runtime's API as plain TypeScript (in a
    // threads.d.mts), whose files with the fork's own syntax are skipped
    if (!/@ownRuntime:/.test(text) || !/@filename: threads\.d\.mts/.test(text))
      continue;
    const dir = join(scratch, 'fork', file.replace(/\.ts$/, ''));
    const {runtime} = writeCompilerTest(text, dir);
    if (!runtime) continue;
    projects.push({
      name: `fork/${file.replace(/\.ts$/, '')}`,
      tsconfig: join(dir, 'tsconfig.json'),
      runtime,
      rootDir: dir,
    });
  }
}

// What the fork emits for a project, by source file.
function forkEmit(p: Project, outDir: string): {ms: number} {
  const start = performance.now();
  const r = spawnSync(
    tsgo,
    [
      '-p',
      p.tsconfig,
      '--ownRuntime',
      p.runtime,
      '--outDir',
      outDir,
      '--rootDir',
      p.rootDir,
      '--target',
      'esnext',
      '--noEmit',
      'false',
      '--noEmitOnError',
      'false',
      '--declaration',
      'false',
      '--sourceMap',
      'false',
      '--pretty',
      'false',
    ],
    {encoding: 'utf8'},
  );
  if (r.error) throw r.error;
  return {ms: performance.now() - start};
}

const outputOf = (source: string): string =>
  source
    .replace(/\.mts$/, '.mjs')
    .replace(/\.cts$/, '.cjs')
    .replace(/\.tsx?$/, '.js');

// The same code, whatever prints it: unused imports erased, printed again
// without comments.
function normalize(fileName: string, js: string): string {
  const lang = fileName.endsWith('.tsx') ? 'tsx' : 'ts';
  const stripped = transformSync(`${fileName}.${lang}`, js, {
    lang,
    sourceType: 'module',
    target: 'esnext',
    jsx: 'preserve',
  });
  if (stripped.errors.length > 0)
    throw new Error(
      `${fileName}: ${stripped.errors.map(e => e.message).join('; ')}`,
    );
  const printed = minifySync(`${fileName}.js`, stripped.code, {
    compress: false,
    mangle: false,
    codegen: {removeWhitespace: false},
  });
  return printed.code;
}

function diff(a: string, b: string): string {
  const fa = join(scratch, 'a.js'),
    fb = join(scratch, 'b.js');
  writeFileSync(fa, a);
  writeFileSync(fb, b);
  const r = spawnSync(
    'diff',
    ['-u', '--label', 'fork', '--label', 'threads-check', fa, fb],
    {
      encoding: 'utf8',
    },
  );
  return r.stdout;
}

const api = new API({cwd: repo});
let failures = 0,
  files = 0,
  same = 0,
  known = 0;
const rows: string[] = [];
let forkMs = 0,
  ourMs = 0;
try {
  for (const p of projects) {
    const outDir = join(scratch, 'out', p.name);
    const fork = forkEmit(p, outDir);
    forkMs += fork.ms;
    const start = performance.now();
    const compiled = compile(p.tsconfig, {runtime: p.runtime, api});
    const ms = performance.now() - start;
    ourMs += ms;
    let projectFailures = 0;
    for (const file of compiled.files) {
      const rel = relative(p.rootDir, file.fileName);
      if (rel.startsWith('..')) continue;
      // the fork's syntax (a `shared struct` declaration), which stock
      // TypeScript does not parse
      if (
        /^\s*(export\s+)?shared\s+struct\s+\w+/m.test(
          readFileSync(file.fileName, 'utf8'),
        )
      )
        continue;
      const forkFile = join(outDir, outputOf(rel));
      const key = `${p.name}/${rel}`;
      files++;
      if (!existsSync(forkFile)) {
        rows.push(`FAIL ${key}: the fork emitted nothing`);
        projectFailures++;
        continue;
      }
      let a: string, b: string;
      try {
        a = normalize(rel, readFileSync(forkFile, 'utf8'));
      } catch (e) {
        a = `(the fork's output does not parse: ${(e as Error).message})`;
      }
      try {
        b = normalize(
          rel,
          toJavaScript(file, {
            verbatimModuleSyntax:
              !!compiled.compilerOptions.verbatimModuleSyntax,
            rewriteRelativeImportExtensions:
              !!compiled.compilerOptions.rewriteRelativeImportExtensions,
          }).code,
        );
      } catch (e) {
        b = `(threads-check's output does not parse: ${(e as Error).message})`;
      }
      if (a === b) {
        same++;
        if (knownDifferences[key])
          rows.push(`  ${key}: the same now: drop its known difference`);
        continue;
      }
      if (knownDifferences[key]) {
        known++;
        rows.push(`  ${key}: differs as known: ${knownDifferences[key]}`);
        if (verbose) rows.push(diff(a, b));
        continue;
      }
      projectFailures++;
      rows.push(`FAIL ${key}: differs from the fork's\n${diff(a, b)}`);
    }
    failures += projectFailures;
    rows.push(
      `${projectFailures ? 'FAIL' : 'ok'} ${p.name}: ${compiled.files.length} files in ${ms.toFixed(0)} ms (fork ${fork.ms.toFixed(0)} ms)`,
    );
  }
} finally {
  api.close();
  rmSync(scratch, {recursive: true, force: true});
}
console.log(rows.join('\n'));
console.log(
  `${files} files: ${same} the same, ${known} known differences, ${failures} unexplained; compile ${ourMs.toFixed(0)} ms, the fork's ${forkMs.toFixed(0)} ms`,
);
process.exitCode = failures === 0 ? 0 : 1;
