// What test/gc.test.ts runs on workers: allocates `mb` megabytes of shared
// objects, a round at a time, and lets go of each round as the next begins.

export async function churn(keep: any, me: number, mb: number) {
  let total = 0;
  while (total < mb << 20) {
    // a ring of arrays of a megabyte each, and small ones on each
    const first = new SharedArray<any>(2);
    let last = first;
    for (let i = 0; i < 16; i++) {
      const a = new SharedArray<any>(1 << 16);
      a[0] = last;
      a[1] = new SharedArray<any>('churn', i, a);
      last = a;
    }
    first[0] = last;
    total += 16 << 20;
    // the turn ends: what it made is let go of
    await new Promise(resolve => setImmediate(resolve));
  }
  // and one that stays, held by `keep`
  keep[me] = new SharedArray<any>(me, 'kept', new SharedArray<any>(me * 2));
  return total;
}
