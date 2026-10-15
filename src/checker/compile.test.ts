// compile (compile.ts, transform.ts): what it emits for the corners of the
// lowering (test/emit), the source map back to the original, the types
// stripped, and threads-check compile writing a project.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {decode, encode} from '@jridgewell/sourcemap-codec';
import {API} from 'typescript/sync';
import {afterAll, describe, expect, it} from 'vite-plus/test';
import {compile, composeMaps, toJavaScript} from './compile.ts';
import type {CompiledFile} from './compile.ts';

const checker = fileURLToPath(new URL('.', import.meta.url));
const api = new API({cwd: checker});
afterAll(() => api.close());

const corners = (() => {
  const result = compile(path.join(checker, 'test/emit/tsconfig.json'), {
    runtime: 'threads',
    api,
  });
  return result.files.find(f => f.fileName.endsWith('corners.ts'))!;
})();
const js = toJavaScript(corners).code;
const fixes = (() => {
  const result = compile(path.join(checker, 'test/emit/tsconfig.json'), {
    runtime: 'threads',
    api,
  });
  return toJavaScript(result.files.find(f => f.fileName.endsWith('fixes.ts'))!)
    .code;
})();
// a project of these files, in a directory of its own
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, {recursive: true, force: true});
});
const runtimeTypes = path.join(checker, '../runtime/threads.d.ts');
function project(files: Record<string, string>, options: object = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-compile-'));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'es2022',
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        lib: ['es2022'],
        paths: {threads: [runtimeTypes]},
        ...options,
      },
      include: ['*.ts', '*.js'],
    }),
  );
  for (const [name, text] of Object.entries(files))
    fs.writeFileSync(path.join(dir, name), text);
  return dir;
}
const APP = `import {f64, struct, type Struct} from 'threads';\nconst P = struct({x: f64});\nexport function main(): number {\n  return new P().x;\n}\n`;
// the JavaScript of one function
const fn = (name: string) => {
  const start = js.indexOf(`function ${name}(`);
  return js.slice(start, js.indexOf('\n}\n', start) + 2);
};

describe('compile', () => {
  it('imports the helpers it uses and registers the top-level functions', () => {
    expect(js).toMatch(
      /^import \{ F64 as __F64, I32 as __I32, U8 as __U8, capture as __capture, .*register as __register, .*\} from "threads";$/m,
    );
    expect(js).toMatch(
      /__register\(import\.meta\.url, \{[^}]*\blabeled,[^}]*\breceiveOne\b/,
    );
  });

  it('lays out struct fields and SharedArray elements', () => {
    expect(js).toContain(
      'const Node = __sharedStruct("Node", [\n\t"value",\n\t"next",\n\t"name",\n\t"on"\n], [1], "frsb");',
    );
    const elements = fn('elements');
    // checked, and (in a counting loop over its length) unchecked
    expect(elements).toContain(
      'i >>> 0 === i && i < __I32[nodes + 4 >> 2] ? nodes + 16 + i * 40 : __outOfBounds[i]',
    );
    expect(elements).toContain('t += __F64[(nodes + 16 + j * 40 >> 3) + 1]');
  });

  it('counts references: owned locals released, returns moved, borrows retained', () => {
    const returns = fn('returns');
    expect(returns).toContain('let b = __newStruct(Node);');
    expect(returns).toContain(
      'return which ? (_a = b, b = 0, _a) : (_b = c, c = 0, _b);',
    );
    expect(returns).toMatch(
      /\} finally \{\n\t\t\t__release\(c\);\n\t\t\}\n\t\} finally \{\n\t\t__release\(b\);/,
    );
    expect(fn('logical')).toContain('x || (x = __retain(other));');
    expect(fn('receive')).toContain('finally {\n\t\t\t__release(n);');
    expect(fn('quiescent')).toContain('__quiescent();\n\t\t\tcontinue;');
    expect(fn('moves')).toContain('s.spawn(receiveOne, __countedRef(n));');
    expect(fn('closures')).toContain('__capture(inner, list, head);');
  });

  it('maps what it lowered back to the original', () => {
    const {code, map} = toJavaScript(corners);
    const lines = code.split('\n');
    const at = lines.findIndex(l =>
      l.includes('__storeStr((n >> 2) + 6, "a")'),
    );
    const column = lines[at]!.indexOf('__storeStr');
    const segment = decode(map.mappings)
      [at]!.filter(s => s[0] <= column)
      .at(-1)!;
    const source = map.sourcesContent![0]!.split('\n')[segment[2]!]!;
    expect(source.trim()).toBe("n.name = 'a';");
  });

  it('keeps a column the intermediate code maps to nothing unmapped', () => {
    const map = (mappings: number[][][]) => ({
      version: 3 as const,
      file: 'x.js',
      sources: ['x.ts'],
      sourcesContent: [''],
      names: [],
      mappings: encode(mappings as never),
    });
    // the outer map's columns 4 (to an unmapped column) and 8 (unmapped)
    const composed = composeMaps(
      map([[[0, 0, 0, 0], [4, 0, 0, 4], [8]]]),
      map([[[0, 0, 0, 0], [3]]]),
    );
    expect(decode(composed.mappings)).toEqual([[[0, 0, 0, 0], [4], [8]]]);
  });

  it('leaves a file that does not use the runtime as it is', () => {
    const file: CompiledFile = compile(
      path.join(checker, 'test/emit/tsconfig.json'),
      {runtime: 'not-the-runtime', api},
    ).files[0]!;
    expect(file.changed).toBe(false);
    expect(file.registered).toEqual([]);
  });

  it('strips the types with OXC, and leaves `using` as it is written', () => {
    const file: CompiledFile = {
      fileName: 'x.ts',
      code: 'import type {T} from "t";\nexport function f(x: T): number {\n  using r = x as any;\n  return 1;\n}\n',
      map: {version: 3, sources: ['x.ts'], names: [], mappings: ''},
      changed: false,
      registered: [],
    };
    expect(toJavaScript(file).code).toBe(
      'export function f(x) {\n\tusing r = x;\n\treturn 1;\n}\n',
    );
  });
});

describe('compile, where the fork does not', () => {
  it("runs an owned parameter's default around a concise body that is a closure", () => {
    expect(fixes).toContain(
      'export const later = (p) => {\n\tp = p === void 0 ? __newStruct(Node) : __retain(p);',
    );
  });

  it('runs the defaults left to right when one moves into the body', () => {
    expect(fixes).toContain('export function ordered(a, b) {');
    expect(fixes).toMatch(
      /a = a === void 0 \? __newStruct\(Node\) : __retain\(a\);\n\ttry \{\n\t\tif \(b === void 0\) \{\n\t\t\tb = a;/,
    );
  });

  it('runs a default with temporaries in the body, which declares them', () => {
    expect(fixes).toContain(
      'export function counted(n) {\n\tvar _a, _b;\n\tif (n === void 0) {\n\t\tn = (_b = read(_a = __newStruct(Node)), __release(_a), _b);',
    );
  });

  it('reads an array before the index that assigns it, and holds it', () => {
    expect(fixes).toContain(
      '_a = __retain(a), _c = (_b = a, a = __retain(b), __release(_b), 0), _c >>> 0 === _c && _c < __I32[_a + 4 >> 2] ? __F64[(_a + 16 >> 3) + _c] : __outOfBounds[_c]), __release(_a)',
    );
  });

  it("runs a class's heritage as a full expression, which releases what it holds", () => {
    expect(fixes).toContain(
      'export class Derived extends (_d = (element = (_a = __retain(first),',
    );
    expect(fixes).toContain('Base), __release(_a), _d) {}');
  });

  it('keeps a parameter whose default moves optional, after an optional one', () => {
    expect(fixes).toContain('export function afterOptional(o, p, q) {');
  });

  it("runs a scalar element type's expression", () => {
    expect(fixes).toContain('__newSharedArray((calls++, Number, 8), n)');
  });

  it('puts the import on a line of its own after a directive', () => {
    for (const eol of ['\n', '\r\n']) {
      const dir = project({'app.ts': `"use client"${eol}${APP}`});
      const [file] = compile(path.join(dir, 'tsconfig.json'), {
        runtime: 'threads',
        api,
      }).files;
      expect(file!.code).toMatch(
        new RegExp(
          `^"use client"${eol}\\n?import \\{ [^\\n]* \\} from "threads";\\n`,
        ),
      );
      expect(() => toJavaScript(file!)).not.toThrow();
    }
  });

  it("reports a module kind the runtime's helpers cannot be imported into, and compiles none of its files", () => {
    const dir = project({'app.ts': APP}, {module: 'commonjs'});
    const result = compile(path.join(dir, 'tsconfig.json'), {
      runtime: 'threads',
      api,
    });
    expect(result.diagnostics.map(d => d.code).sort((a, b) => a - b)).toEqual([
      96014, 96039,
    ]);
    expect(result.files).toEqual([]);
  });

  it('reports a CommonJS file, and compiles it not at all', () => {
    const options = {module: 'nodenext', moduleResolution: 'nodenext'};
    const dir = project(
      {
        'app.ts': `import {n} from './tool.cjs';\n${APP}export const m = n;\n`,
        'tool.cts': 'export const n = 1;\n',
        'package.json': '{"type": "module"}\n',
      },
      options,
    );
    const result = compile(path.join(dir, 'tsconfig.json'), {
      runtime: 'threads',
      api,
    });
    expect(
      result.diagnostics.map(d => [path.basename(d.file ?? ''), d.code]),
    ).toEqual([['tool.cts', 96039]]);
    expect(result.files.map(f => path.basename(f.fileName))).toEqual([
      'app.ts',
    ]);
    expect(result.files[0]!.changed).toBe(true);
    // without "type": "module", a .ts is CommonJS too
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
    const commonJS = compile(path.join(dir, 'tsconfig.json'), {
      runtime: 'threads',
      api,
    });
    expect(
      commonJS.diagnostics.map(d => path.basename(d.file ?? '')).sort(),
    ).toEqual(['app.ts', 'tool.cts']);
    expect(commonJS.files).toEqual([]);
  });

  it("reports type errors in the project's declaration files", () => {
    const dir = project({
      'app.ts': APP,
      'globals.d.ts': 'declare const x: MissingType;\n',
    });
    const result = compile(path.join(dir, 'tsconfig.json'), {
      runtime: 'threads',
      api,
      types: true,
    });
    expect(
      result.typeDiagnostics.map(d => [path.basename(d.file ?? ''), d.code]),
    ).toEqual([['globals.d.ts', 2304]]);
  });
});

describe('what the lowering moves, as it runs', () => {
  it('runs defaults in order, reads what they read, keeps functions and closures with their bindings, frees field initializers, and releases what a throwing default leaves', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-moved-'));
    dirs.push(out);
    const compiled = spawnSync(
      process.execPath,
      [
        'cli.ts',
        'compile',
        '-p',
        'test/run',
        '--runtime',
        '@arv/threads',
        '--outDir',
        out,
      ],
      {cwd: checker, encoding: 'utf8', timeout: 60_000},
    );
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    const r = spawnSync(
      process.execPath,
      [
        path.join(checker, '../run.ts'),
        path.join(out, 'moved.js'),
        '--threads=1',
        // no pool: each pool worker loads moved.js too, and adds the block its
        // module makes (Extended's base) to the shared counts when it settles,
        // which may be between main's two heapStats()
        '--pool=0',
      ],
      {encoding: 'utf8', timeout: 60_000},
    );
    expect(r.stdout.trim(), r.stderr).toBe(
      '[0,true,2,1,6,6,10,"object",1,4,10,"Error",1,1,7,2,1] blocks left 0',
    );
  }, 60_000);

  it("emits a package's sources for analysis only", () => {
    const dir = project({
      'app.ts': `import {n} from 'pkg';\n${APP}export const m = n;\n`,
    });
    fs.mkdirSync(path.join(dir, 'node_modules/pkg'), {recursive: true});
    fs.writeFileSync(
      path.join(dir, 'node_modules/pkg/package.json'),
      JSON.stringify({name: 'pkg', type: 'module', exports: './index.ts'}),
    );
    fs.writeFileSync(
      path.join(dir, 'node_modules/pkg/index.ts'),
      'export const n: number = 1;\n',
    );
    const result = compile(path.join(dir, 'tsconfig.json'), {
      runtime: 'threads',
      api,
    });
    expect(result.files.map(f => path.basename(f.fileName))).toEqual([
      'app.ts',
    ]);
  });
});

describe('threads-check compile', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-compile-'));
  afterAll(() => fs.rmSync(out, {recursive: true, force: true}));
  const run = (args: string[]) =>
    spawnSync(process.execPath, ['cli.ts', 'compile', ...args], {
      cwd: checker,
      encoding: 'utf8',
      timeout: 60_000,
    });

  it('writes each file as JavaScript, with a source map', () => {
    const r = run([
      '-p',
      'test/emit',
      '--runtime',
      'threads',
      '--outDir',
      out,
      '--sourceMap',
    ]);
    expect(r.stdout).toBe('');
    expect(r.status).toBe(0);
    const code = fs.readFileSync(path.join(out, 'corners.js'), 'utf8');
    expect(code).toContain('__register(import.meta.url, {');
    expect(code).toMatch(/\/\/# sourceMappingURL=corners\.js\.map\n$/);
    const map = JSON.parse(
      fs.readFileSync(path.join(out, 'corners.js.map'), 'utf8'),
    );
    expect(map.sources).toEqual([
      path.relative(out, path.join(checker, 'test/emit/corners.ts')),
    ]);
  });

  it('writes nothing over an input: a JavaScript file, without an outDir', () => {
    const dir = project(
      {'app.ts': APP, 'tool.js': 'export const n = 1;\n'},
      {allowJs: true},
    );
    const r = run(['-p', dir, '--runtime', 'threads']);
    expect(r.stderr).toMatch(
      /cannot write .*tool\.js: it would overwrite an input of the project\. Name an output directory/,
    );
    expect(r.status).toBe(3);
    expect(fs.readFileSync(path.join(dir, 'tool.js'), 'utf8')).toBe(
      'export const n = 1;\n',
    );
    expect(fs.existsSync(path.join(dir, 'app.js'))).toBe(false);
  });

  it('copies an imported JSON file, and keeps the JSX of a .jsx file', () => {
    const dir = project(
      {
        'app.ts': `import data from './data.json';\nimport {view} from './view.jsx';\n${APP}export const v = [data.value, view];\n`,
        'data.json': '{"value":1}\n',
        'view.jsx': 'export const view = <div />;\n',
      },
      {
        allowJs: true,
        resolveJsonModule: true,
        jsx: 'preserve',
        outDir: 'dist',
      },
    );
    const r = run(['-p', dir, '--runtime', 'threads']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'dist/data.json'), 'utf8')).toBe(
      '{"value":1}\n',
    );
    expect(fs.readFileSync(path.join(dir, 'dist/view.jsx'), 'utf8')).toContain(
      '<div />',
    );
  });

  it('writes nothing for a CommonJS file, and exits 1', () => {
    const dir = project(
      {
        'app.ts': `import {n} from './tool.cjs';\n${APP}export const m = n;\n`,
        'tool.cts': 'export const n = 1;\n',
        'package.json': '{"type": "module"}\n',
      },
      {module: 'nodenext', moduleResolution: 'nodenext', outDir: 'dist'},
    );
    const r = run(['-p', dir, '--runtime', 'threads']);
    expect(r.stdout).toMatch(
      /tool\.cts\(1,1\): error TS96039: 'tool\.cts' is a CommonJS module/,
    );
    expect(r.status).toBe(1);
    expect(fs.existsSync(path.join(dir, 'dist/app.js'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'dist/tool.cjs'))).toBe(false);
  });

  it('reports the ownership errors, exits 1, and writes the files all the same', () => {
    const r = run([
      '-p',
      'test/cases/channels',
      '--runtime',
      'threads',
      '--outDir',
      path.join(out, 'channels'),
    ]);
    expect(r.stdout).toMatch(
      /^test\/cases\/channels\/channels\.ts\(\d+,\d+\): error TS96001/,
    );
    expect(r.status).toBe(1);
    expect(fs.existsSync(path.join(out, 'channels/channels.js'))).toBe(true);
  });
});
