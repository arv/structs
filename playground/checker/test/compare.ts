// npm test: runs threads-check and the fork's `tsgo own check` on the same projects and compares
// their diagnostics (file, line, column, code and message).
//
// The projects: the cases in test/cases, the playground (with and without programs/mistakes.ts),
// the fork's marker-mode compiler tests, porffor's programs and the scratchpad's mistakes. Projects
// outside this repository are skipped when they are not there. Without the fork (TSGO_FORK, by
// default ~/src/arv/TypeScript), a case of test/cases is compared with its expected output in
// test/expected, which `npm test -- --update` writes from the fork's output.
//
// Only test/cases have stored expectations: the other projects change on their own, and the fork's
// tests come with the fork.
//
// Environment: TSGO_FORK (the fork's repository), PORFFOR_THREADS (porffor's threads/escape-proto),
// MISTAKES (directories, separated by colons, each with a tsconfig.json of programs that import the
// runtime as ./threads.mjs).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { API } from "typescript/sync";
import { check, formatDiagnostic } from "../src/index.ts";

const checkerDir = resolve(import.meta.dirname, "..");
const playground = resolve(checkerDir, "..");
const forkRoot = process.env.TSGO_FORK ?? join(homedir(), "src/arv/TypeScript");
const tsgo = join(forkRoot, "tsc/built/local/tsgo");
const forkTests = join(forkRoot, "tsc/testdata/tests/cases/compiler");
const porffor = process.env.PORFFOR_THREADS ??
  join(homedir(), "src/arv/porffor/.claude/worktrees/js-js-sab-workers-atomics-8a7cd1/threads/escape-proto");
const mistakes = (process.env.MISTAKES ?? "").split(":").filter((dir) => dir !== "");
const update = process.argv.includes("--update");
const haveFork = existsSync(tsgo);

interface Case {
  name: string;
  tsconfig: string;
  runtime: string;
  cwd: string; // diagnostics are printed relative to it
}

// The fork's messages name the `sending` keyword it parses; threads-check's name the plain TypeScript
// type, `Sending<T>`. Otherwise the messages are the same.
function reword(line: string): string {
  return line
    .replace("Declare the parameter 'sending' to take ownership.", "Declare the parameter 'Sending<T>' to take ownership.")
    .replace("cannot be returned as 'sending':", "cannot be returned as 'Sending<T>':");
}

// What threads-check cannot report like the fork, and why.
const knownDifferences: Record<string, { missing: string[]; reason: string }> = {
  "fork/ownLayoutStructUnionsErrors": {
    reason: "stock TypeScript reduces a union of struct types to the supertype (the fork does not), and does not parse `shared struct`",
    missing: [
      "different.mts(14,7): error TS96026: Field 'u' is at different places in the shared structs of this union.",
      "different.mts(15,14): error TS96026: Field 'u' is at different places in the shared structs of this union.",
      "different.mts(20,14): error TS96026: Field 'u' is at different places in the shared structs of this union.",
      "different.mts(30,7): error TS96026: Field 'u' is at different places in the shared structs of this union.",
      "different.mts(38,14): error TS96026: Field 'u' is at different places in the shared structs of this union.",
    ],
  },
};

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "threads-check-")));
const cases: Case[] = [];

// test/cases: marker-mode programs against the playground's runtime/threads.d.mts.
for (const name of readdirSync(join(checkerDir, "test/cases")).sort()) {
  const dir = join(checkerDir, "test/cases", name);
  cases.push({ name: `cases/${name}`, tsconfig: join(dir, "tsconfig.json"), runtime: "threads", cwd: dir });
}

// The playground, as its tsconfig has it and with programs/mistakes.ts.
cases.push({ name: "playground", tsconfig: join(playground, "tsconfig.json"), runtime: "threads", cwd: playground });
const withMistakes = join(scratch, "playground-mistakes");
mkdirSync(withMistakes);
writeFileSync(join(withMistakes, "tsconfig.json"), JSON.stringify({
  extends: join(playground, "tsconfig.json"),
  include: [join(playground, "*.ts"), join(playground, "programs/*.ts")],
  exclude: [],
}, null, 2));
cases.push({ name: "playground-mistakes", tsconfig: join(withMistakes, "tsconfig.json"), runtime: "threads", cwd: playground });

// The fork's marker-mode compiler tests, split into their files.
for (const test of [
  "ownMarkers", "ownMarkersAwait", "ownMarkersErrors", "ownLayoutStructUnions", "ownLayoutStructUnionsErrors", "ownLayoutBooleans", "ownLayoutBooleansErrors",
  "ownLayoutStrings", "ownLayoutStringsErrors", "ownLayoutIntegers", "ownLayoutIntegersErrors", "ownLayoutIntegerStores",
  "ownLayoutChannelFields", "ownLayoutChannelFieldsErrors", "ownAsyncGoroutines", "ownAsyncGoroutinesErrors",
]) {
  const file = join(forkTests, `${test}.ts`);
  if (!existsSync(file)) continue;
  const dir = join(scratch, test);
  const { runtime } = writeCompilerTest(readFileSync(file, "utf8"), dir);
  cases.push({ name: `fork/${test}`, tsconfig: join(dir, "tsconfig.json"), runtime, cwd: dir });
}

if (existsSync(join(porffor, "tsconfig.json"))) {
  cases.push({ name: "porffor", tsconfig: join(porffor, "tsconfig.json"), runtime: "./threads.mjs", cwd: porffor });
}
for (const dir of mistakes) {
  if (existsSync(join(dir, "tsconfig.json"))) {
    cases.push({ name: `mistakes/${basename(dir)}`, tsconfig: join(dir, "tsconfig.json"), runtime: "./threads.mjs", cwd: dir });
  }
}

// A compiler test (`// @option: value` lines, then `// @filename: name` units) as a project.
function writeCompilerTest(text: string, dir: string): { runtime: string } {
  const options: Record<string, unknown> = {};
  const files: string[] = [];
  let runtime = "";
  let current: string[] | undefined;
  let currentName = "";
  const flush = () => {
    if (current) writeFileSync(join(dir, currentName), current.join("\n"));
  };
  mkdirSync(dir, { recursive: true });
  for (const line of text.split(/\r?\n/)) {
    const directive = /^\/\/\s*@(\w+):\s*(.*?)\s*$/.exec(line);
    if (directive) {
      const [, key, value] = directive as unknown as [string, string, string];
      if (key.toLowerCase() === "filename") {
        flush();
        current = [];
        currentName = value;
        files.push(value);
        continue;
      }
      if (!current) {
        if (key === "ownRuntime") runtime = value;
        else options[key] = key === "lib" ? value.split(",").map((s) => s.trim()) : value === "true" ? true : value === "false" ? false : value;
        continue;
      }
    }
    current?.push(line);
  }
  flush();
  options.noEmit = true;
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: options, files }, null, 2));
  return { runtime };
}

function runFork(c: Case): { lines: string[]; ms: number } | undefined {
  if (!haveFork) return undefined;
  const start = performance.now();
  const result = spawnSync(tsgo, ["own", "check", "-p", c.tsconfig, "--ownRuntime", c.runtime, "--pretty", "false"], { cwd: c.cwd, encoding: "utf8" });
  const ms = performance.now() - start;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`${c.name}: the fork's own check failed (${result.status}):\n${result.stdout}${result.stderr}`);
  }
  return { lines: result.stdout.split(/\r?\n/).filter((l) => /error TS96\d\d\d/.test(l)).map(reword), ms };
}

function expectedFile(c: Case): string {
  return join(checkerDir, "test/expected", `${c.name.replaceAll("/", "-")}.txt`);
}

const api = new API({ cwd: playground });
let failures = 0;
let compared = 0;
const rows: string[] = [];
try {
  for (const c of cases) {
    const start = performance.now();
    const actual = check(c.tsconfig, { runtime: c.runtime, api }).map((d) => formatDiagnostic(d, c.cwd));
    const ms = performance.now() - start;
    const fork = runFork(c);
    let expected: string[] | undefined = fork?.lines;
    let source = "fork";
    if (fork && update && c.name.startsWith("cases/")) {
      mkdirSync(dirname(expectedFile(c)), { recursive: true });
      writeFileSync(expectedFile(c), fork.lines.map((l) => l + "\n").join(""));
    }
    if (!expected && c.name.startsWith("cases/") && existsSync(expectedFile(c))) {
      expected = readFileSync(expectedFile(c), "utf8").split("\n").filter((l) => l !== "");
      source = "test/expected";
    }
    if (!expected) {
      rows.push(`  ${c.name}: ${actual.length} diagnostics, nothing to compare with`);
      continue;
    }
    compared++;
    const known = knownDifferences[c.name];
    const missing = expected.filter((l) => !actual.includes(l));
    const extra = actual.filter((l) => !expected.includes(l));
    const unexplained = missing.filter((l) => !known?.missing.includes(l));
    const ok = unexplained.length === 0 && extra.length === 0;
    if (!ok) failures++;
    const timing = fork ? `${ms.toFixed(0)} ms (fork ${fork.ms.toFixed(0)} ms)` : `${ms.toFixed(0)} ms`;
    const explained = missing.length - unexplained.length;
    rows.push(`${ok ? "ok" : "FAIL"} ${c.name}: ${actual.length} diagnostics, as ${source} says${explained ? ` but for ${explained} known differences` : ""}; ${timing}`);
    if (explained) rows.push(`    (${known!.reason})`);
    for (const l of unexplained) rows.push(`    missing: ${l}`);
    for (const l of extra) rows.push(`    extra:   ${l}`);
  }
} finally {
  api.close();
  rmSync(scratch, { recursive: true, force: true });
}
console.log(rows.join("\n"));
if (!haveFork) console.log(`(no fork at ${tsgo}: compared with test/expected)`);
console.log(failures === 0 ? `all ${compared} projects compared agree` : `${failures} of ${compared} projects compared differ`);
process.exitCode = failures === 0 ? 0 : 1;
