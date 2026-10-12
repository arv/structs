// SharedMap and SharedSet: Map and Set in shared memory, with their methods and
// semantics, insertion order included. Threads count the words of a text into
// one map, whose values are structs with an i32 count that atomic.add bumps,
// and gather the words into one set. getOrInsertComputed is atomic: when two
// threads meet a new word at once, both get the one counter.
//
// Each call takes the map's lock for a moment, so every thread counting into
// one map is contended: a map suits shared lookups and occasional changes,
// while a thread doing a lot of counting counts locally and merges once.
import {
  atomic,
  i32,
  log,
  scope,
  SharedMap,
  SharedSet,
  struct,
  type Struct,
} from '@arv/threads';

const Count = struct({n: i32});
type Count = Struct<typeof Count>;
const WORDS = 200_000;

// word i of the text: a thousand words, a few of them far more common
function word(i: number): string {
  let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  const r = (x >>> 0) / 2 ** 32;
  return `w${Math.floor(1000 * r * r * r)}`;
}

// counts words [lo, hi) into counts, and adds them to seen
function count(
  counts: SharedMap<string, Count>,
  seen: SharedSet<string>,
  lo: number,
  hi: number,
) {
  for (let i = lo; i < hi; i++) {
    const w = word(i);
    atomic.add(
      counts.getOrInsertComputed(w, () => new Count()),
      'n',
      1,
    );
    seen.add(w);
  }
}

// the same, into a Map of this thread's own, merged into counts once
function countLocally(
  counts: SharedMap<string, Count>,
  lo: number,
  hi: number,
) {
  const mine = new Map<string, number>();
  for (let i = lo; i < hi; i++) {
    const w = word(i);
    mine.set(w, (mine.get(w) ?? 0) + 1);
  }
  for (const [w, n] of mine)
    atomic.add(
      counts.getOrInsertComputed(w, () => new Count()),
      'n',
      n | 0,
    );
}

export function main(threadCounts: readonly number[]) {
  // insertion order, as a Map keeps it
  const order = new SharedMap<string, number>([
    ['one', 1],
    ['two', 2],
    ['three', 3],
  ]);
  order.set('one', 11).delete('two');
  order.set('two', 22);
  log(`insertion order: ${[...order.keys()].join(', ')}`);

  for (const threads of threadCounts) {
    for (const local of [false, true]) {
      const counts = new SharedMap<string, Count>(),
        seen = new SharedSet<string>(),
        t0 = performance.now();
      scope(s => {
        for (let t = 0; t < threads; t++) {
          const lo = Math.floor((WORDS * t) / threads),
            hi = Math.floor((WORDS * (t + 1)) / threads);
          if (local) s.spawn(countLocally, counts, lo, hi);
          else s.spawn(count, counts, seen, lo, hi);
        }
      });
      const ms = performance.now() - t0;
      let total = 0;
      const top: [string, number][] = [];
      counts.forEach((c, w) => {
        total += c.n;
        top.push([w, c.n]);
      });
      top.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      log(
        `threads ${threads}${local ? ', counting locally' : ''}: ${total} words, ` +
          `${counts.size} distinct${local ? '' : ` (the set: ${seen.size})`}, ` +
          `${ms.toFixed(0)} ms; most common: ` +
          top
            .slice(0, 3)
            .map(([w, n]) => `${w} ${n}`)
            .join(', '),
      );
    }
  }
}
