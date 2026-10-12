// The example of the tutorial: for many random points, count which of a few centers each is nearest
// to, on several threads. The points are owned: each thread gets its own share of them. The centers
// are shared: every thread reads them.
import { log, partition, scope, type Sending, share, type Shared, take, type Thread } from "threads";

type Point = { x: number; y: number };

// a fresh array, which the caller owns
function randomPoints(n: number): Sending<Point[]> {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const points: Point[] = [];
  for (let i = 0; i < n; i++) points.push({ x: random(), y: random() });
  return points;
}

// runs on a thread: how many of its points are nearest to each center
function countNearest(points: Sending<Point[]>, centers: Shared<Point[]>): Sending<number[]> {
  const counts = centers.map(() => 0);
  for (const p of points) {
    let best = 0, bestDistance = Infinity;
    for (let c = 0; c < centers.length; c++) {
      const dx = p.x - centers[c].x, dy = p.y - centers[c].y, d = dx * dx + dy * dy;
      if (d < bestDistance) { bestDistance = d; best = c; }
    }
    counts[best]++;
  }
  return counts;
}

export function main(threadCounts: readonly number[]) {
  const centers = share([{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.25 }, { x: 0.5, y: 0.75 }]);
  for (const threads of threadCounts) {
    const totals = scope(s => {
      const parts = partition(randomPoints(200_000), threads);
      const ts: Thread<number[]>[] = [];
      for (let t = 0; t < threads; t++) ts.push(s.spawn(countNearest, take(parts, t), centers));
      const sums = centers.map(() => 0);
      for (const th of ts) th.join().forEach((n, c) => { sums[c] += n; });
      return sums;
    });
    log(`${threads} threads: ${totals.join(" ")}`);
  }
}
