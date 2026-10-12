// summarizes a DevTools performance trace (chrome.js --trace=...): for each thread that ran
// JS, its sampled CPU time and the functions that took it (self time)
//   node trace-summary.js trace.json [--top=12]
import fs from 'node:fs';

const file = process.argv[2];
const top = Number(
  process.argv.find(a => a.startsWith('--top='))?.split('=')[1] ?? 12,
);
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const events = Array.isArray(raw) ? raw : raw.traceEvents;

const threadName = new Map();
for (const e of events)
  if (e.ph === 'M' && e.name === 'thread_name')
    threadName.set(`${e.pid}:${e.tid}`, e.args.name);

// a CPU profile per isolate: Profile starts it, ProfileChunks carry nodes, samples and time deltas
const profiles = new Map();
for (const e of events) {
  if (e.name === 'Profile')
    profiles.set(`${e.pid}:${e.id}`, {
      thread: `${e.pid}:${e.tid}`,
      nodes: new Map(),
      samples: [],
      deltas: [],
    });
  if (e.name !== 'ProfileChunk') continue;
  const p = profiles.get(`${e.pid}:${e.id}`);
  if (!p) continue;
  const cpu = e.args.data.cpuProfile ?? {};
  for (const n of cpu.nodes ?? []) p.nodes.set(n.id, n.callFrame);
  for (const s of cpu.samples ?? []) p.samples.push(s);
  for (const d of e.args.data.timeDeltas ?? []) p.deltas.push(d);
}

const label = f => {
  if (!f) return '?';
  const where = f.url ? `${f.url.split('/').pop()}:${f.lineNumber + 1}` : '';
  return `${f.functionName || '(anonymous)'}${where ? ` ${where}` : ''}`;
};
const rows = [];
for (const p of profiles.values()) {
  const self = new Map();
  let busy = 0;
  // a sample's weight is the time until the next one
  for (let i = 0; i < p.samples.length; i++) {
    const us = p.deltas[i + 1] ?? 0,
      f = p.nodes.get(p.samples[i]);
    const name = label(f);
    if (
      name.startsWith('(idle)') ||
      name.startsWith('(program)') ||
      name.startsWith('(root)')
    )
      continue;
    busy += us;
    self.set(name, (self.get(name) ?? 0) + us);
  }
  if (busy > 1000)
    rows.push({thread: threadName.get(p.thread) ?? p.thread, busy, self});
}
rows.sort((a, b) => b.busy - a.busy);
for (const r of rows) {
  console.log(`${r.thread}: ${(r.busy / 1000).toFixed(0)} ms busy`);
  for (const [name, us] of [...r.self]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top))
    console.log(
      `  ${(us / 1000).toFixed(1).padStart(8)} ms  ${((100 * us) / r.busy).toFixed(1).padStart(5)}%  ${name}`,
    );
}
