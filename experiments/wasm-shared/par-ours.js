// Times playground/programs/nbody-parallel.ts (the copy in ts/), compiled, on
// our runtime: main(8) once to warm up, as the playground does, then main(n)
// for n = 1, 2, 4, 8.
//
//   node src/compiler/cli.ts compile -p experiments/wasm-shared/ts/tsconfig.json --outDir experiments/wasm-shared/fast
//   node experiments/wasm-shared/par-ours.js [fast|proxy]

const dir = process.argv[2] ?? 'fast';
const {main} = await import(`./${dir}/nbody-parallel.js`);
await main(8);
const times = [];
for (const n of [1, 2, 4, 8]) {
  const t = performance.now();
  await main(n);
  times.push([n, performance.now() - t]);
}
const base = times[0][1];
console.log(
  `ours (${dir}): ` +
    times
      .map(
        ([n, ms]) => `${n}: ${ms.toFixed(0)} ms (${(base / ms).toFixed(2)}x)`,
      )
      .join('  '),
);
process.exit(0);
