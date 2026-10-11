// The playground: edit a program, see the JavaScript it compiles to (with the tsgo fork, or with its
// types only erased), and run it on the page's pool of workers. The Vite plugin's dev server compiles
// (POST /__threads/compile); the page imports the result as a module, and so do the workers.
import "threads/heap"; // first: the shared memory, before anything that uses it loads
import { run, start } from "threads/browser";
import "microlighter/themes/github.css";
import { highlightAll } from "microlighter";
import mandelbrotChan from "./programs/mandelbrot-chan.ts?raw";
import mistakes from "./programs/mistakes.ts?raw";
import nbodyChan from "./programs/nbody-chan.ts?raw";
import nbodyChanStruct from "./programs/nbody-chan-struct.ts?raw";
import nbodyStruct from "./programs/nbody-struct.ts?raw";
import nbodyTs from "./programs/nbody-ts.ts?raw";
import pipeline from "./programs/pipeline.ts?raw";
import refcount from "./programs/refcount.ts?raw";
import tutorial from "./programs/tutorial.ts?raw";

type Diagnostic = { line: number; col: number; code: string; message: string };
type Result = {
  key: string;
  compiled: { js: string | null; ms: number; ownership: Diagnostic[]; types: Diagnostic[] };
  erased: { js: string | null; error: string | null; added: number };
};

const PRESETS: [string, string][] = [
  ["N-body: shared structs and a barrier", nbodyStruct],
  ["N-body: shared structs and channels", nbodyChanStruct],
  ["N-body: moving and sharing objects", nbodyTs],
  ["N-body: channels, copying objects", nbodyChan],
  ["Mandelbrot: goroutines and channels", mandelbrotChan],
  ["Nearest centers (the tutorial)", tutorial],
  ["What channels cost", pipeline],
  ["Reference counting under a race", refcount],
  ["Mistakes the checker catches", mistakes],
];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const source = $("source"), js = $("js"), diagnostics = $("diagnostics"), output = $("output");
const status = $("status"), runButton = $<HTMLButtonElement>("run"), preset = $<HTMLSelectElement>("preset");
const threadsInput = $<HTMLInputElement>("threads");

let result: Result | null = null, compiling = 0, running = false, timer = 0, workers = 0;
const ready = () => workers ? `Ready · ${workers} workers` : "Ready";
const mode = () => (document.querySelector('input[name="mode"]:checked') as HTMLInputElement).value as "compiled" | "erased";

const escapeHtml = (s: string) => s.replace(/[&<>]/g, c => c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;");

// the program's text, and a range of it: the editor holds plain text, which editing may split
// into several text nodes
const text = (el: HTMLElement) => el.textContent ?? "";
function textRange(el: HTMLElement, start: number, end: number): Range {
  const range = document.createRange(), walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let at = 0, started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent!.length;
    if (!started && start <= at + length) { range.setStart(node, start - at); started = true; }
    if (started && end <= at + length) { range.setEnd(node, end - at); return range; }
    at += length;
  }
  range.selectNodeContents(el);
  range.collapse(false);
  return range;
}

// syntax colors (microlighter, through the CSS Custom Highlight API: the code stays plain text). a
// pass recolors every block on the page, so passes run one at a time, and a change during one asks
// for another
let highlighting: Promise<unknown> | null = null, highlightAgain = false;
function highlight() {
  if (highlighting) { highlightAgain = true; return; }
  highlighting = highlightAll().finally(() => {
    highlighting = null;
    if (highlightAgain) { highlightAgain = false; highlight(); }
  });
}

// what the compiler added (or, erased, the one line the runtime needs), as a highlight of its own
function markAdded() {
  const ranges: Range[] = [], code = text(js);
  if (result && mode() === "compiled") {
    for (const m of code.matchAll(/\b__[A-Za-z0-9]+\b/g)) ranges.push(textRange(js, m.index, m.index + m[0].length));
  } else if (result?.erased.js) {
    const lines = code.split("\n"), from = lines.length - 1 - result.erased.added;
    let at = 0;
    lines.forEach((line, i) => {
      if (i >= from && line) ranges.push(textRange(js, at, at + line.length));
      at += line.length + 1;
    });
  }
  CSS.highlights.set("threads-added", new Highlight(...ranges));
}

function showJs() {
  if (!result) return;
  if (mode() === "compiled") {
    $("js-title").textContent = "Compiled JavaScript";
    $("js-hint").textContent = `by the tsgo fork in ${result.compiled.ms} ms · highlighted: what the compiler added`;
    js.textContent = result.compiled.js ?? "(nothing emitted)";
  } else {
    $("js-title").textContent = "JavaScript, types erased";
    $("js-hint").textContent = "node's type stripping · highlighted: the one line the runtime needs";
    js.textContent = result.erased.js ?? result.erased.error ?? "";
  }
  markAdded();
  highlight();
  showDiagnostics();
}

function showDiagnostics() {
  if (!result) return;
  const { ownership, types } = result.compiled;
  const count = (n: number) => n === 0 ? "no errors" : `${n} error${n === 1 ? "" : "s"}`;
  const list = (ds: Diagnostic[]) => ds.length === 0 ? "" : `<ul>${ds.map(d =>
    `<li data-line="${d.line}"><span class="where">${d.line}:${d.col}</span> <span class="code">${d.code}</span> ${escapeHtml(d.message)}</li>`).join("")}</ul>`;
  diagnostics.innerHTML =
    `<p class="${ownership.length ? "bad" : "good"}">Ownership (tsgo own check): ${count(ownership.length)}</p>${list(ownership)}` +
    `<p class="${types.length ? "bad" : "good"}">Types (tsc's job): ${count(types.length)}</p>${list(types)}` +
    (mode() === "erased" ? `<p class="note">With the types erased nothing checks ownership before it runs; the runtime still throws on a use after move.</p>` : "");
}

// a diagnostic's line, selected in the editor
diagnostics.addEventListener("click", e => {
  const item = (e.target as HTMLElement).closest("li");
  if (!item) return;
  const n = Number(item.dataset.line), lines = text(source).split("\n");
  let at = 0;
  for (let i = 0; i < n - 1; i++) at += lines[i].length + 1;
  source.focus();
  const selection = getSelection()!;
  selection.removeAllRanges();
  selection.addRange(textRange(source, at, at + (lines[n - 1]?.length ?? 0)));
  const pane = source.parentElement!;
  pane.scrollTop = Math.max(0, (n - 6) * parseFloat(getComputedStyle(source).lineHeight));
});

let compilingNow = false;
async function compile() {
  const id = ++compiling;
  compilingNow = true;
  status.textContent = "Compiling…";
  updateRun();
  try {
    const response = await fetch("/__threads/compile", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: text(source) }),
    });
    if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
    const compiled = await response.json() as Result;
    if (id !== compiling) return;
    result = compiled;
    status.textContent = ready();
    showJs();
  } catch (e) {
    if (id !== compiling) return;
    status.textContent = "The playground compiles on Vite's dev server, which this page could not reach.";
    js.textContent = String(e);
  } finally {
    if (id === compiling) { compilingNow = false; updateRun(); }
  }
}

function updateRun() {
  const code = result && (mode() === "compiled" ? result.compiled.js : result.erased.js);
  runButton.disabled = running || !code || compilingNow;
}

// output: the program's lines, with the 256-color backgrounds Mandelbrot draws with
const BASIC = ["#000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
  "#808080", "#f00", "#0f0", "#ff0", "#00f", "#f0f", "#0ff", "#fff"];
function xterm(n: number): string {
  if (n < 16) return BASIC[n];
  if (n < 232) {
    const c = n - 16, v = (k: number) => k === 0 ? 0 : 55 + k * 40;
    return `rgb(${v(Math.floor(c / 36))},${v(Math.floor(c / 6) % 6)},${v(c % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}
function ansiToHtml(text: string): string {
  let html = "", open = false;
  for (const part of text.split(/(\x1b\[[\d;]*m)/)) {
    const m = /^\x1b\[([\d;]*)m$/.exec(part);
    if (!m) { html += escapeHtml(part); continue; }
    if (open) { html += "</span>"; open = false; }
    const bg = /^48;5;(\d+)$/.exec(m[1]);
    if (bg) { html += `<span style="background:${xterm(Number(bg[1]))}">`; open = true; }
  }
  return open ? `${html}</span>` : html;
}
function print(html: string) {
  output.insertAdjacentHTML("beforeend", html);
  output.scrollTop = output.scrollHeight;
}

runButton.addEventListener("click", async () => {
  if (!result) return;
  const counts = threadsInput.value.split(",").map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
  const erased = mode() === "erased", name = erased ? `${result.key}.erased` : result.key;
  running = true;
  updateRun();
  print(`<div class="run">${erased ? "Types erased" : "Compiled"} · ${preset.selectedOptions[0]?.text ?? "program"} · threads ${counts.join(", ")}</div>`);
  const t0 = performance.now();
  try {
    const program = await import(/* @vite-ignore */ `/@id/virtual:threads/playground/${name}.js`);
    if (typeof program.main !== "function") throw new Error("the program exports no main(threadCounts)");
    await run(program.main, counts);
    print(`<div class="done">done in ${(performance.now() - t0).toFixed(0)} ms</div>`);
  } catch (e) {
    print(`<div class="error">${escapeHtml(String(e))}</div>`);
  } finally {
    running = false;
    updateRun();
  }
});

for (const [name] of PRESETS) preset.add(new Option(name));
preset.addEventListener("change", () => {
  source.textContent = PRESETS[preset.selectedIndex][1];
  source.parentElement!.scrollTop = 0;
  highlight();
  compile();
});
source.addEventListener("input", () => {
  highlight();
  clearTimeout(timer);
  timer = window.setTimeout(compile, 400);
});
source.addEventListener("keydown", e => { // Tab indents, as an edit the editor can undo
  if (e.key !== "Tab") return;
  e.preventDefault();
  document.execCommand("insertText", false, "  ");
});
for (const radio of document.querySelectorAll('input[name="mode"]')) radio.addEventListener("change", () => { showJs(); updateRun(); });
$("clear").addEventListener("click", () => { output.textContent = ""; });

source.textContent = PRESETS[0][1];
highlight();
compile();
start({ onLog: text => print(ansiToHtml(text)) }).then(() => {
  workers = navigator.hardwareConcurrency;
  if (!compilingNow) status.textContent = ready();
});
(window as unknown as { __playground: unknown }).__playground = { get result() { return result; } };
