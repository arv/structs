// The page: starts the worker pool and runs the two programs on it. The page's own thread never
// blocks; run() resolves when a thread is done.
import "threads/heap"; // first: the shared memory, before anything that uses it loads
import { run, start } from "threads/browser";
import { render, H, W, maxIterations } from "./mandelbrot.js";
import { simulate } from "./nbody.js";

const $ = (id: string) => document.getElementById(id)!;
const results: Record<string, unknown> = {};
(window as unknown as { __results: typeof results }).__results = results;

await start();
$("status").textContent = `${navigator.hardwareConcurrency} workers ready`;

async function runNbody() {
  const body = $("nbody-rows");
  body.textContent = "";
  const runs = [];
  for (const threads of [1, 2, 4, 8, 1, 2, 4, 8]) {
    const r = await run(simulate, threads);
    runs.push(r);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${r.threads}</td><td>${r.ms.toFixed(1)} ms</td><td>${r.energy.toFixed(6)}</td>`;
    body.append(tr);
  }
  results.nbody = runs;
}

async function runMandelbrot() {
  const canvas = $("canvas") as HTMLCanvasElement, ctx = canvas.getContext("2d")!;
  const times = [];
  let rows: number[][] = [];
  for (const threads of [1, 2, 4, 8]) {
    const r = await run(render, threads);
    times.push({ threads: r.threads, ms: r.ms });
    rows = r.rows;
  }
  const cw = canvas.width / W, ch = canvas.height / H;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = rows[y][x], t = v >= maxIterations - 0.5 ? 0 : Math.log(1 + v) / Math.log(maxIterations);
    ctx.fillStyle = t === 0 ? "#000" : `hsl(${260 - 220 * t}, 80%, ${20 + 50 * t}%)`;
    ctx.fillRect(x * cw, y * ch, Math.ceil(cw), Math.ceil(ch));
  }
  $("mandelbrot-times").textContent = times.map(t => `${t.threads} ${t.threads === 1 ? "thread" : "threads"}: ${t.ms.toFixed(0)} ms`).join(" · ");
  results.mandelbrot = { times, checksum: rows.flat().reduce((a, b) => a + b, 0) };
}

$("nbody").addEventListener("click", runNbody);
$("mandelbrot").addEventListener("click", runMandelbrot);
results.ready = true;
