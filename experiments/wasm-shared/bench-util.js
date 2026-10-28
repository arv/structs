// Shared by the microbenchmarks: sizes, and timing best-of-runs in ns/op.

// bump: N get+set pairs on one struct; sum: M passes over LEN structs
export const N = 10_000_000;
export const LEN = 1000;
export const M = 10_000;
const RUNS = 7;

export function report(label, kernels) {
  const out = [label];
  for (const [name, f] of Object.entries(kernels)) {
    const ops = name === 'bump' ? N : M * LEN;
    let best = Infinity,
      r;
    for (let i = 0; i < RUNS; i++) {
      const t = performance.now();
      r = f();
      best = Math.min(best, performance.now() - t);
    }
    out.push(`${name} ${((best * 1e6) / ops).toFixed(2)} ns/op`);
    // (keeps the result alive)
    if (r === -1) console.log(r);
  }
  console.log(out.join('  '));
}
