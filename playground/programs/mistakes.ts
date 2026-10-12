// Mistakes the ownership checker catches. Stock TypeScript accepts this
// program; `tsgo own check` reports each mistake. Run it anyway: the first goes
// through unnoticed, and the runtime's safety net stops the second, a use after
// move.
import {
  f64,
  log,
  scope,
  share,
  struct,
  type Sending,
  type Shared,
  u8,
} from 'threads';

type Point = {x: number; y: number};
const Pixel = struct({brightness: f64, gray: u8});

function randomPoints(n: number): Sending<Point[]> {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const points: Point[] = [];
  for (let i = 0; i < n; i++) points.push({x: random(), y: random()});
  return points;
}

// runs on a thread: how many points are near the first center
function countNear(
  points: Sending<Point[]>,
  centers: Shared<Point[]>,
): Sending<number> {
  const c = centers[0];
  return points.filter(p => (p.x - c.x) ** 2 + (p.y - c.y) ** 2 < 0.04).length;
}

export function main(threadCounts: readonly number[]) {
  const pixel = new Pixel();
  pixel.brightness = 0.9;
  // 1. 229.5 into a u8: stored as 229, silently
  pixel.gray = pixel.brightness * 255;
  log(`gray: ${pixel.gray}`);
  const centers = share([{x: 0.5, y: 0.5}]);
  const mine = randomPoints(10);
  scope(s => {
    const points = randomPoints(1000);
    const first = points[0];
    // points moves to the thread
    const near = s.spawn(countNear, points, centers);
    log(`near the center: ${near.join()} of 1000`);
    // 2. first is part of points, which moved
    log(`the first point: ${first.x}`);
    (centers[0] as Point).x = 0; // 3. centers is shared, so immutable
    // 4. mine is captured from outside the scope
    s.spawn(countNear, mine, centers);
  });
}
