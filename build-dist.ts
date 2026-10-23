// @arv/structs as npm installs it, in dist/ (pnpm pack builds it first, as
// prepack): the runtime compiled to JavaScript with its declarations
// (tsconfig.dist.json), and the declarations of its API, written by hand
// (api.d.ts for "@arv/structs", agent-api.d.ts for "@arv/structs/agent").
//   node build-dist.ts
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');

fs.rmSync(dist, {recursive: true, force: true});
const tsc = path.join(
  path.dirname(
    createRequire(import.meta.url).resolve('typescript/package.json'),
  ),
  'bin',
  'tsc',
);
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.dist.json'], {
  cwd: root,
  stdio: 'inherit',
});
for (const file of ['api.d.ts', 'agent-api.d.ts'])
  fs.copyFileSync(
    path.join(root, 'src', 'runtime', file),
    path.join(dist, file),
  );
// the pool's worker script, which the agent module starts by URL: tsc
// rewrites imports' extensions, not a URL's
const agent = path.join(dist, 'agent.js');
const text = fs.readFileSync(agent, 'utf8');
if (!text.includes("'./agent-worker.ts'"))
  throw new Error('dist/agent.js starts no ./agent-worker.ts');
fs.writeFileSync(
  agent,
  text.replaceAll("'./agent-worker.ts'", "'./agent-worker.js'"),
);
console.log(`dist/: ${fs.readdirSync(dist).sort().join(' ')}`);
