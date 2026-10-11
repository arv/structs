// Mistakes the ownership checker catches. Stock TypeScript accepts this program; `tsgo own check`
// reports each mistake. Run it anyway: the runtime's safety net stops the first one, a use after move.
import { log, scope, share, type Sending, type Shared } from "threads";

type Point = { x: number; y: number };

function randomPoints(n: number): Sending<Point[]> {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const points: Point[] = [];
  for (let i = 0; i < n; i++) points.push({ x: random(), y: random() });
  return points;
}

// runs on a thread: how many points are near the first center
function countNear(points: Sending<Point[]>, centers: Shared<Point[]>): Sending<number> {
  const c = centers[0];
  return points.filter(p => (p.x - c.x) ** 2 + (p.y - c.y) ** 2 < 0.04).length;
}

export function main(threadCounts: readonly number[]) {
  const centers = share([{ x: 0.5, y: 0.5 }]);
  const mine = randomPoints(10);
  scope(s => {
    const points = randomPoints(1000);
    const first = points[0];
    const near = s.spawn(countNear, points, centers); // points moves to the thread
    log(`near the center: ${near.join()} of 1000`);
    log(`the first point: ${first.x}`);               // 1. first is part of points, which moved
    (centers[0] as Point).x = 0;                      // 2. centers is shared, so immutable
    s.spawn(countNear, mine, centers);                // 3. mine is captured from outside the scope
  });
}
