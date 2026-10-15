// The Vite plugin on small projects, built with threads-check (its sources in
// src/checker) and with the tsgo fork: a tsconfig as create-vite writes it, a
// thread module the compiler never sees, a .tsx one, Vite's own queries, and
// what a changed file compiles again. The fork is TSGO_FORK's (a clone of
// arv/threads-checker with tsgo built in it, by default
// ~/src/arv/threads-checker), as for compare.ts; without it its tests skip
import fs from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  build,
  createServer,
  type InlineConfig,
  type Plugin,
  type ViteDevServer,
} from 'vite-plus';
import {afterAll, beforeEach, describe, expect, it} from 'vite-plus/test';
import {registeredIn} from './compiled.ts';
import threads, {type Options} from './vite-plugin-threads.ts';

const TSGO = path.join(
  process.env.TSGO_FORK ?? path.join(homedir(), 'src/arv/threads-checker'),
  'built/local/tsgo',
);
const missing = fs.existsSync(TSGO)
  ? null
  : `no tsgo fork at ${TSGO} (TSGO_FORK names a clone of arv/threads-checker with tsgo built in it)`;
const RUNTIME = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(RUNTIME, '../checker/index.ts');

// the two compilers: threads-check (by default), and the fork (`tsgo`)
const compilers = [
  {
    name: 'threads-check',
    command: 'threads-check',
    options: {checker: CHECKER},
    missing: null,
  },
  {name: 'the tsgo fork', command: 'tsgo', options: {tsgo: TSGO}, missing},
] as const;

// a project of these files, in a directory of its own
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, {recursive: true, force: true});
});
function project(files: Record<string, string>) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(tmpdir(), 'threads-vite-')),
  );
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), {recursive: true});
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

// the tsconfig create-vite writes (vanilla-ts), which emits nothing, with the
// runtime's types
const tsconfig = (options: object = {}) =>
  JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      lib: ['ES2022', 'DOM'],
      skipLibCheck: true,
      moduleResolution: 'bundler',
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: true,
      moduleDetection: 'force',
      noEmit: true,
      strict: true,
      paths: Object.fromEntries(
        ['', '/heap', '/browser'].map(sub => [
          `@arv/threads${sub}`,
          [path.join(RUNTIME, `${sub.slice(1) || 'threads'}.d.ts`)],
        ]),
      ),
      ...options,
    },
    include: ['src'],
  });
// a page that runs main, from a module of its own, on a thread
const INDEX =
  '<!doctype html><script type="module" src="/src/main.ts"></script>\n';
const page = (app: string) =>
  `import '@arv/threads/heap';\nimport {run} from '@arv/threads/browser';\nimport {main} from '${app}';\n\nconsole.log(await run(main, 21));\n`;
const APP = `import {log} from '@arv/threads';\n\nexport function main(n: number): number {\n  log('main', n);\n  return n * 2;\n}\n`;

// Vite's config for a project: the plugin, and the runtime from its sources
let compiler: Options = {};
const config = (
  root: string,
  options: Omit<Options, 'tsgo'> = {},
  alias: {find: RegExp; replacement: string}[] = [],
): InlineConfig => ({
  root,
  configFile: false,
  logLevel: 'silent',
  cacheDir: path.join(root, '.vite'),
  plugins: [threads({...compiler, ...options})],
  resolve: {
    alias: [
      {find: /^@arv\/threads$/, replacement: path.join(RUNTIME, 'threads.ts')},
      {
        find: /^@arv\/threads\/(heap|browser)$/,
        replacement: path.join(RUNTIME, '$1.ts'),
      },
      ...alias,
    ],
  },
  build: {target: 'es2022', minify: false},
});
// the project built: its bundles' JavaScript, the page's and the workers'
async function bundle(...args: Parameters<typeof config>) {
  const root = args[0];
  await build(config(...args));
  const assets = path.join(root, 'dist/assets');
  return fs
    .readdirSync(assets)
    .map(name => fs.readFileSync(path.join(assets, name), 'utf8'))
    .join('\n');
}
// a dev server for a project, which the fork compiles as it starts, with no
// port, websocket or watcher of its own
const serve = (root: string, options: Omit<Options, 'tsgo'> = {}) =>
  createServer({
    ...config(root, options),
    server: {middlewareMode: true, ws: false, watch: null},
  });
// a change to a file, as the dev server's watcher tells the plugin of it
const change = async (
  server: ViteDevServer,
  type: 'create' | 'update' | 'delete',
  file: string,
) => {
  const plugin = server.config.plugins.find(p => p.name === 'threads')!;
  const hotUpdate = plugin.hotUpdate as Extract<Plugin['hotUpdate'], Function>;
  await hotUpdate.call({environment: server.environments.client} as any, {
    type,
    file,
    timestamp: Date.now(),
    modules: [],
    read: () => '',
    server,
  });
};
// main registered, by its module's key
const registered = (key: string) =>
  new RegExp(
    String.raw`register\w*\("${key.replace(/\./g, '\\.')}", \{ main \}\)`,
  );

// how many times a server's plugin compiled the project
const compiles = (server: ViteDevServer) =>
  (
    server.config.plugins.find(p => p.name === 'threads')!.api as {
      compiles: number;
    }
  ).compiles;

for (const {name, command, options, missing} of compilers)
  describe(`the Vite plugin, compiling with ${name}`, () => {
    const fork = command === 'tsgo';
    beforeEach(context => {
      if (missing) context.skip(missing);
      compiler = options;
    });

    it('lowers a struct program, with a source map from its TypeScript', async () => {
      const root = project({
        'index.html': INDEX,
        'tsconfig.json': tsconfig(),
        'src/main.ts': page('./app.ts'),
        'src/app.ts': `import {f64, struct, SharedArray} from '@arv/threads';\n\nconst P = struct({x: f64});\n\nexport function main(n: number): number {\n  const ps = new SharedArray(P, n);\n  for (let i = 0; i < n; i++) ps[i].x = i;\n  return ps[n - 1].x;\n}\n`,
      });
      const server = await serve(root);
      try {
        const result =
          await server.environments.client.transformRequest('/src/app.ts');
        expect(result?.code).toMatch(/__newSharedArray\(P, n\)/);
        expect(result?.code).toMatch(/__F64\[/);
        expect(result?.code).toMatch(registered('src/app.ts'));
        expect(result?.code).not.toContain(': number');
        const map = result?.map as {sources: string[]} | null;
        expect(map?.sources).toEqual([expect.stringMatching(/app\.ts$/)]);
      } finally {
        await server.close();
      }
    });

    it('compiles a project whose tsconfig emits nothing, type errors and all', async () => {
      const root = project({
        'index.html': INDEX,
        'tsconfig.json': tsconfig(),
        'src/main.ts': page('./app.ts'),
        'src/app.ts': APP,
        'src/wrong.ts': `export const n: number = 'one';\n`,
      });
      expect(await bundle(root)).toMatch(registered('src/app.ts'));
    });

    it('compiles a project whose tsconfig says noEmitOnError, as the errors are tsc’s to report', async () => {
      // the type error's, and the fork's of an emit with
      // allowImportingTsExtensions (TS5096)
      const root = project({
        'index.html': INDEX,
        'tsconfig.json': tsconfig({noEmitOnError: true}),
        'src/main.ts': page('./app.ts'),
        'src/app.ts': APP,
        'src/wrong.ts': `export const n: number = 'one';\n`,
      });
      expect(await bundle(root)).toMatch(registered('src/app.ts'));
    });

    it.skipIf(!fork)(
      'reports the errors that stopped an incremental emit, but the options’',
      async () => {
        // a file the tsconfig names is missing: the fork writes its build info,
        // and no JavaScript
        const root = project({
          'index.html': INDEX,
          'tsconfig.json': JSON.stringify({
            ...JSON.parse(tsconfig({incremental: true})),
            include: undefined,
            files: ['src/missing.ts'],
          }),
          'src/main.ts': page('./app.ts'),
          'src/app.ts': APP,
        });
        const error = await bundle(root).then(
          () => null,
          (e: Error) => e.message,
        );
        expect(error).toMatch(
          /tsgo emitted nothing for .*tsconfig\.json:\nerror TS6053: File '.*missing\.ts' not found/,
        );
        expect(error).not.toContain('TS5096');
      },
    );

    it('says to name the app’s tsconfig where tsconfig.json only references others', async () => {
      const root = project({
        'index.html': INDEX,
        'tsconfig.json': JSON.stringify({
          files: [],
          references: [{path: './tsconfig.app.json'}],
        }),
        'tsconfig.app.json': tsconfig(),
        'src/main.ts': page('./app.ts'),
        'src/app.ts': APP,
      });
      await expect(bundle(root)).rejects.toThrow(
        /(tsgo emitted|threads-check compiled) nothing for .*tsconfig\.json, and reported no error: a solution-style tsconfig .* Name the app's \(tsconfig\.app\.json, say\) with the plugin's tsconfig option/,
      );
      expect(await bundle(root, {tsconfig: 'tsconfig.app.json'})).toMatch(
        registered('src/app.ts'),
      );
    });

    it('compiles everything each time where the build is incremental', async () => {
      // the build info kept apart from what the fork emits, which goes as
      // each compile starts
      const root = project({
        'index.html': INDEX,
        'tsconfig.json': tsconfig({
          incremental: true,
          tsBuildInfoFile: './node_modules/.tmp/tsconfig.tsbuildinfo',
        }),
        'src/main.ts': page('./app.ts'),
        'src/app.ts': APP,
      });
      for (const _ of [1, 2]) {
        const server = await serve(root);
        try {
          expect(
            (await server.environments.client.transformRequest('/src/app.ts'))
              ?.code,
          ).toMatch(registered('src/app.ts'));
        } finally {
          await server.close();
        }
      }
    });

    it('refuses a thread module the fork did not compile', async () => {
      // lib/ is outside the tsconfig's include, reached through an alias. its
      // import of the runtime, or export from it, in each form the fork
      // registers a module's functions for: one with a comment in it, a
      // side effect's, types only, an empty one, all of it
      const MAIN = `export function main(n: number): number {\n  return n * 2;\n}\n`;
      for (const app of [
        APP.replace('from ', 'from /* the runtime */ '),
        `import '@arv/threads';\n${MAIN}`,
        `import type {Shared} from '@arv/threads';\n${MAIN}`,
        `export {} from '@arv/threads';\n${MAIN}`,
        `export * as threads from '@arv/threads';\n${MAIN}`,
      ]) {
        const root = project({
          'index.html': INDEX,
          'tsconfig.json': tsconfig(),
          'src/main.ts': page('~lib/app.ts'),
          'lib/app.ts': app,
        });
        await expect(
          bundle(root, {}, [{find: /^~lib\//, replacement: `${root}/lib/`}]),
          app,
        ).rejects.toThrow(
          `threads: lib/app.ts was not compiled by ${command} -p tsconfig.json: add it to the tsconfig's include or files (or mirror the alias in paths)`,
        );
      }
    });

    it('lets a module the fork did not compile be, where it does not import the runtime', async () => {
      // an import in a comment, or in a string, is none
      const root = project({
        'index.html': INDEX,
        'tsconfig.json': tsconfig(),
        'src/main.ts': `import '~lib/note.ts';\n${page('./app.ts')}`,
        'src/app.ts': APP,
        'lib/note.ts': `// import {log} from '@arv/threads';\nexport const note: string = "import '@arv/threads'";\n`,
      });
      expect(
        await bundle(root, {}, [
          {find: /^~lib\//, replacement: `${root}/lib/`},
        ]),
      ).toMatch(registered('src/app.ts'));
    });

    for (const jsx of ['react-jsx', 'preserve'])
      it(`compiles a .tsx thread module (jsx: ${jsx})`, async () => {
        const root = project({
          'index.html': INDEX,
          'tsconfig.json': tsconfig({jsx}),
          'src/main.ts': page('./app.tsx'),
          'src/app.tsx': APP,
        });
        expect(await bundle(root)).toMatch(registered('src/app.tsx'));
      });

    it('tells a .tsx thread module from a .ts of its name', async () => {
      // both compiled, to app.js and app.jsx (jsx: preserve)
      const OTHER = `import {log} from '@arv/threads';\n\nexport function other() {\n  log('other');\n}\n`;
      const both = project({
        'index.html': INDEX,
        'tsconfig.json': tsconfig({jsx: 'preserve'}),
        'src/main.ts': page('./app.tsx'),
        'src/app.tsx': APP,
        'src/app.ts': OTHER,
      });
      expect(await bundle(both)).toMatch(registered('src/app.tsx'));
      // the .ts left out, the .tsx compiled to app.js (jsx: react-jsx)
      const one = project({
        'index.html': INDEX,
        'tsconfig.json': JSON.stringify({
          ...JSON.parse(tsconfig({jsx: 'react-jsx'})),
          include: undefined,
          files: ['src/main.ts', 'src/app.tsx'],
        }),
        'src/main.ts': page('./app.tsx'),
        'src/app.tsx': APP,
        'src/app.ts': OTHER,
      });
      const js = await bundle(one);
      expect(js).toMatch(registered('src/app.tsx'));
      expect(js).not.toContain('"src/app.ts"');
    });

    it('gives a module what each of its imports names, a .ts or a .js of its name', async () => {
      const root = project({
        'index.html': INDEX,
        'tsconfig.json': tsconfig(),
        'src/main.ts': `import {js} from './app.js';\n${page('./app.ts')}console.log(js, (await import(\`./app.js\`)).js);\n`,
        'src/app.ts': APP,
        'src/app.js': `export const js = 'the JavaScript beside it';\n`,
      });
      const js = await bundle(root);
      expect(js).toMatch(registered('src/app.ts'));
      expect(js).toContain('the JavaScript beside it');
    });

    it('bundles what a dynamic import of a template may import', async () => {
      // Vite's to make out of the import, as written
      const root = project({
        'index.html': INDEX,
        'tsconfig.json': tsconfig(),
        'src/main.ts': `const name: string = location.hash.slice(1) || 'a';\nconsole.log((await import(\`./jobs/\${name}.ts\`)).job);\n`,
        'src/jobs/a.ts': `export const job: string = 'job a';\n`,
        'src/jobs/b.ts': `export const job: string = 'job b';\n`,
      });
      const js = await bundle(root);
      expect(js).toContain('job a');
      expect(js).toContain('job b');
    });

    it('leaves ?raw, ?url and ?worker to Vite', async () => {
      const root = project({
        'index.html': INDEX,
        'tsconfig.json': tsconfig(),
        'src/main.ts': `import text from './w.ts?raw';\nimport url from './w.ts?url';\nimport W from './w.ts?worker';\n\nconsole.log(text, url, new W());\n`,
        'src/w.ts': `const n: number = 1;\npostMessage(n);\n`,
      });
      const js = await bundle(root);
      expect(js).toContain('"const n: number = 1;');
      expect(js).toContain('new Worker(');
    });

    it('erases a playground program’s types, registering what the fork registers', async () => {
      const root = project({
        'index.html': INDEX,
        'tsconfig.json': tsconfig(),
        'src/main.ts': page('./app.ts'),
        'src/app.ts': APP,
      });
      const server = await createServer({
        ...config(root, {playground: true}),
        server: {ws: false, watch: null},
      });
      await server.listen();
      try {
        const response = await fetch(
          new URL('__threads/compile', server.resolvedUrls!.local[0]),
          {
            method: 'POST',
            // functions a scan of the text takes for declarations at the top
            // level, and one it misses
            body: JSON.stringify({
              source: `import {log} from '@arv/threads';
if (true) /[{]/.test('');
export function main(): void {
function* gen() {
  yield 1;
}
  log(String([...gen()]));
}
const fn =
  function named() {};
/*
export function example() {}
*/
export default function last() {}
`,
            }),
          },
        );
        const {compiled, erased} = (await response.json()) as {
          compiled: {js: string};
          erased: {js: string};
        };
        expect(registeredIn(compiled.js, '@arv/threads')).toEqual([
          'main',
          'last',
        ]);
        expect(registeredIn(erased.js, '@arv/threads')).toEqual([
          'main',
          'last',
        ]);
      } finally {
        await server.close();
      }
    });

    it.skipIf(fork)(
      'gives no JavaScript for a playground program that does not parse, and its errors',
      async () => {
        const root = project({
          'index.html': INDEX,
          'tsconfig.json': tsconfig(),
          'src/main.ts': page('./app.ts'),
          'src/app.ts': APP,
        });
        const server = await createServer({
          ...config(root, {playground: true}),
          server: {ws: false, watch: null},
        });
        await server.listen();
        try {
          const response = await fetch(
            new URL('__threads/compile', server.resolvedUrls!.local[0]),
            {
              method: 'POST',
              body: JSON.stringify({
                source: `export function main(): void {\n  const x = ;\n}\n`,
              }),
            },
          );
          const {compiled} = (await response.json()) as {
            compiled: {
              js: string | null;
              ownership: {message: string}[];
              types: {line: number; code: string}[];
            };
          };
          expect(compiled.js).toBeNull();
          expect(compiled.types).toContainEqual(
            expect.objectContaining({line: 2, code: 'TS1109'}),
          );
          expect(compiled.ownership).toEqual([]);
        } finally {
          await server.close();
        }
      },
    );

    it('compiles again for a change only to a source the fork compiled or Vite loaded', async () => {
      const root = project({
        'index.html': INDEX,
        'tsconfig.json': tsconfig(),
        'src/main.ts': page('./app.ts'),
        'src/app.ts': APP,
        'src/extra.ts': APP,
        'scripts/tool.ts': `export const tool: number = 1;\n`,
      });
      const server = await serve(root);
      try {
        const client = server.environments.client;
        expect((await client.transformRequest('/src/app.ts'))?.code).toMatch(
          registered('src/app.ts'),
        );
        // whether the plugin compiled again
        const compilesAgain = async (
          type: 'create' | 'update' | 'delete',
          file: string,
        ) => {
          const before = compiles(server);
          await change(
            server,
            type,
            path.isAbsolute(file) ? file : path.join(root, file),
          );
          return compiles(server) > before;
        };
        expect(await compilesAgain('update', 'scripts/tool.ts')).toBe(false);
        expect(await compilesAgain('update', 'src/app.ts')).toBe(true);
        expect(await compilesAgain('create', 'scripts/new.ts')).toBe(true);
        // the path as it comes, not as path.join would make it
        expect(await compilesAgain('update', `${root}/src/./app.ts`)).toBe(
          true,
        );
        // a thread module the workers' table names, which nothing loaded
        fs.rmSync(path.join(root, 'src/extra.ts'));
        expect(await compilesAgain('delete', 'src/extra.ts')).toBe(true);
      } finally {
        await server.close();
      }
    });

    it.skipIf(!fork)(
      'compiles again for any change after a compile that failed',
      async () => {
        // noEmitOnError asked for (and allowImportingTsExtensions, whose error
        // with an emit would stop every one, not): a type error in a source
        // nothing imports stops the emit
        const root = project({
          'index.html': INDEX,
          'tsconfig.json': tsconfig({allowImportingTsExtensions: false}),
          'src/main.ts': page('./app'),
          'src/app.ts': APP,
          'src/unused.ts': `export const n: number = 1;\n`,
        });
        const server = await serve(root, {args: ['--noEmitOnError', 'true']});
        try {
          const unused = path.join(root, 'src/unused.ts');
          fs.writeFileSync(unused, `export const n: number = 'one';\n`);
          await expect(change(server, 'update', unused)).rejects.toThrow(
            /unused\.ts\(1,14\): error TS2322/,
          );
          fs.writeFileSync(unused, `export const n: number = 1;\n`);
          await change(server, 'update', unused);
          expect(
            fs.existsSync(path.join(root, '.vite/threads/page/src/app.js')),
          ).toBe(true);
        } finally {
          await server.close();
        }
      },
    );
  });
