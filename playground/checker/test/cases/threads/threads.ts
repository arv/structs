// The ownership analysis on threads (the fork's ownSharedThreadsErrors, in the plain API): one wrong
// program per kind of error, and one correct program.
import { Barrier, partition, scope, share, Slots, take, type Scope, type Sending, type Shared, type Thread } from "threads";

type Body = { x: number; y: number; z: number; vx: number; vy: number; vz: number; m: number };
type Pos = { x: number; y: number; z: number; m: number };
declare const STEPS: number;
declare function makeBodies(): Sending<Body[]>;
declare function accelerate(mine: Body[], all: readonly Shared<Pos>[]): void;
declare function move(mine: Body[]): void;
declare function energy(bodies: Body[]): number;

function worker(t: number, mine: Sending<Body[]>, board: Slots<Pos[]>, barrier: Barrier): Sending<Body[]> {
  for (let s = 0; s < STEPS; s++) {
    board.set(t, share(mine.map(b => ({ x: b.x, y: b.y, z: b.z, m: b.m }))));
    barrier.wait();
    accelerate(mine, board.flat());
    barrier.wait();
    move(mine);
  }
  return mine;
}

export function simulate(threads: number): number {
  const board = new Slots<Pos[]>(threads), barrier = new Barrier(threads);
  return scope(s => {
    const parts = partition(makeBodies(), threads);
    const ts: Thread<Body[]>[] = [];
    for (let t = 0; t < threads; t++) {
      ts.push(s.spawn(worker, t, take(parts, t), board, barrier));
    }
    return energy(ts.flatMap(th => th.join()));
  });
}

// 1. Use after send, through another variable that shares objects with the sent one.
export function sendHalf(bodies: Sending<Body[]>, s: Scope, board: Slots<Pos[]>, barrier: Barrier) {
  const half = bodies.slice(0, 400);
  s.spawn(worker, 0, half, board, barrier);   // half shares bodies' region: sends it
  bodies[0]!.x = 1;                           // error: 'bodies' shares objects with 'half', which was sent
}

// 1. Use after consume: share() turns its argument into a shared value.
export function snapshot(snap: Sending<Pos[]>) {
  const p = share(snap);
  snap[0]!.x = 2;                             // error: 'snap' was consumed by 'share'
  // 4. Writes through a shared value.
  p[0]!.x = 3;                                // error: p[0] is shared
  p.push({ x: 0, y: 0, z: 0, m: 0 });         // error: p is shared
}

// 1. Sent in one iteration, used in the next.
export function spawnInLoop(s: Scope, board: Slots<Pos[]>, barrier: Barrier) {
  const mine = makeBodies();
  for (let t = 0; t < 4; t++) {
    s.spawn(worker, t, mine, board, barrier); // error on the second iteration: 'mine' may have been sent
  }
}

// 2. Sending a value the caller still references.
export function sendParameter(xs: Body[], s: Scope, board: Slots<Pos[]>, barrier: Barrier) {
  s.spawn(worker, 0, xs, board, barrier);     // error: declare xs 'sending'
}

// 2. Sending a value captured from an outer scope.
const everyone = makeBodies();
export function sendCaptured(s: Scope, board: Slots<Pos[]>, barrier: Barrier) {
  s.spawn(worker, 0, everyone, board, barrier); // error: captured
}

// 3. Returning a caller's value as `Sending`.
export function giveBack(xs: Body[]): Sending<Body[]> {
  return xs;                                  // error: the caller still references xs
}

// No errors: a fresh literal is sent, a map builds fresh objects that are then shared, and a value
// is only used before it is sent.
export function fine(bodies: Body[], s: Scope, board: Slots<Pos[]>, barrier: Barrier) {
  s.spawn(worker, 0, [{ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, m: 1 }], board, barrier);
  const positions = share(bodies.map(b => ({ x: b.x, y: b.y, z: b.z, m: b.m })));
  accelerate(bodies, positions);
  const before = makeBodies();
  move(before);
  s.spawn(worker, 1, before, board, barrier);
}
